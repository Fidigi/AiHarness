import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import type {
  ExtensionRuntimeContext,
  ExtensionToolResult,
} from '../extensions/extension-registry.js';
import type { ExtensionRegistry } from '../extensions/extension-registry.js';
import type { WorkspaceManager } from '../security/workspace-manager.js';
import {
  DEFAULT_GREP_LINE_LENGTH,
  DEFAULT_TOOL_MAX_BYTES,
  DEFAULT_TOOL_MAX_LINES,
  formatToolBytes,
  truncateToolHead,
  truncateToolLine,
  truncateToolTail,
  type ToolTruncation,
} from './truncation.js';

const MAX_INPUT_PATH = 20_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_SEARCH_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_FILES = 100_000;
const MAX_PROCESS_CAPTURE = 10 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const PROCESS_KILL_GRACE_MS = 500;

/** Pi-compatible default names. grep/find/ls are registered but are not part of this default selection. */
export const DEFAULT_CODING_TOOL_NAMES = ['read', 'bash', 'edit', 'write'] as const;
export const READ_ONLY_CODING_TOOL_NAMES = ['read', 'grep', 'find', 'ls'] as const;

export interface WorkspaceToolOptions {
  /** Registry owner used for lifecycle and policy filtering. */
  extensionId?: string;
  /** Safety ceiling applied even when a model omits the optional shell timeout. */
  commandTimeoutMs?: number;
}

interface ProcessResult {
  output: string;
  exitCode: number;
  durationMs: number;
  captureTruncated: boolean;
  timedOut: boolean;
}

interface SearchFile {
  absolutePath: string;
  relativePath: string;
}

type ToolExecutor = (
  input: unknown,
  context: ExtensionRuntimeContext,
  signal?: AbortSignal,
) => Promise<ExtensionToolResult>;

const mutationQueues = new Map<string, Promise<void>>();

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Tool input must be an object.');
  }
  return input as Record<string, unknown>;
}

function stringInput(
  input: Record<string, unknown>,
  key: string,
  options: { max?: number; allowEmpty?: boolean } = {},
): string {
  const value = input[key];
  const max = options.max ?? MAX_INPUT_PATH;
  if (typeof value !== 'string' || value.length > max || (!options.allowEmpty && !value.trim())) {
    throw new Error(`Tool parameter "${key}" is invalid.`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string, max = MAX_INPUT_PATH): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error(`Tool parameter "${key}" is invalid.`);
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Tool parameter "${name}" must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation aborted.');
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${nodePath.sep}`);
}

async function workspaceRoot(
  workspaceManager: WorkspaceManager,
  context: ExtensionRuntimeContext,
): Promise<string> {
  if (!context.cwd) throw new Error('The active workspace is missing from the tool context.');
  return workspaceManager.resolve(context.cwd, { kind: 'directory' });
}

async function workspacePath(
  workspaceManager: WorkspaceManager,
  context: ExtensionRuntimeContext,
  input: string,
  options: { mustExist?: boolean; kind?: 'file' | 'directory' | 'any' } = {},
): Promise<string> {
  const cwd = await workspaceRoot(workspaceManager, context);
  const resolved = await workspaceManager.resolve(input, {
    base: cwd,
    mustExist: options.mustExist,
    kind: options.kind,
  });
  if (!inside(cwd, resolved)) throw new Error('Path is outside the active workspace.');
  return resolved;
}

function requireTrust(context: ExtensionRuntimeContext): void {
  if (!context.projectTrusted) {
    throw new Error('Trust the active workspace before using a mutating or command tool.');
  }
}

function relativeDisplay(root: string, target: string): string {
  return nodePath.relative(root, target).split(nodePath.sep).join('/') || '.';
}

async function withMutationQueue<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(filePath) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  mutationQueues.set(filePath, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(filePath) === current) mutationQueues.delete(filePath);
  }
}

function terminateProcess(child: ReturnType<typeof spawn>, detached: boolean): NodeJS.Timeout | undefined {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  try {
    if (detached && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* Process already exited. */ }
  }
  const force = setTimeout(() => {
    try {
      if (detached && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* Process already exited. */ }
  }, PROCESS_KILL_GRACE_MS);
  force.unref();
  return force;
}

async function executeProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  detached?: boolean;
  maxCapture?: number;
}): Promise<ProcessResult> {
  throwIfAborted(input.signal);
  const startedAt = Date.now();
  const maxCapture = input.maxCapture ?? MAX_PROCESS_CAPTURE;
  return new Promise((resolve, reject) => {
    const detached = Boolean(input.detached && process.platform !== 'win32');
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      detached,
      windowsHide: true,
      env: { ...process.env, AI_HARNESS_AGENT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let captureTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.length > maxCapture) {
        output = output.slice(-maxCapture);
        captureTruncated = true;
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      input.signal?.removeEventListener('abort', abort);
    };
    const abort = (): void => {
      aborted = true;
      forceKill ??= terminateProcess(child, detached);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      forceKill ??= terminateProcess(child, detached);
    }, input.timeoutMs);
    timeout.unref();
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(new Error('Operation aborted.'));
        return;
      }
      resolve({
        output,
        exitCode: timedOut ? 124 : code ?? 1,
        durationMs: Date.now() - startedAt,
        captureTruncated,
        timedOut,
      });
    });
  });
}

function processOutput(result: ProcessResult, empty = '(no output)'): {
  content: string;
  details: Record<string, unknown>;
} {
  const truncation = truncateToolTail(result.output);
  let content = truncation.content || empty;
  const notices: string[] = [];
  if (result.captureTruncated) notices.push('Process output exceeded the capture limit; the beginning was discarded');
  if (truncation.truncated) {
    notices.push(`Showing the last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)} limit)`);
  }
  if (result.timedOut) notices.push('Command timed out');
  if (result.exitCode !== 0 && !result.timedOut) notices.push(`Command exited with code ${result.exitCode}`);
  if (notices.length) content += `\n\n[${notices.join('. ')}]`;
  return {
    content,
    details: {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.captureTruncated || truncation.truncated,
      ...(truncation.truncated ? { truncation } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
    },
  };
}

function headOutput(content: string): { content: string; truncation?: ToolTruncation } {
  const truncation = truncateToolHead(content);
  if (!truncation.truncated) return { content };
  if (truncation.firstLineExceedsLimit) {
    return {
      content: `[The first line exceeds the ${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)} output limit.]`,
      truncation,
    };
  }
  return {
    content: `${truncation.content}\n\n[Output truncated at ${truncation.outputLines} lines / ${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)}.]`,
    truncation,
  };
}

async function gitAwareFiles(
  root: string,
  signal?: AbortSignal,
): Promise<SearchFile[] | undefined> {
  try {
    const result = await executeProcess({
      executable: 'git',
      args: ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      cwd: root,
      signal,
      timeoutMs: 10_000,
      maxCapture: MAX_PROCESS_CAPTURE,
    });
    if (result.exitCode !== 0 || result.captureTruncated) return undefined;
    const files: SearchFile[] = [];
    for (const relative of result.output.split('\0').filter(Boolean)) {
      throwIfAborted(signal);
      if (files.length >= MAX_SEARCH_FILES || relative.includes('\0')) break;
      const absolutePath = nodePath.resolve(root, relative);
      if (!inside(root, absolutePath)) continue;
      try {
        const info = await lstat(absolutePath);
        if (!info.isFile() || info.isSymbolicLink()) continue;
      } catch { continue; }
      files.push({ absolutePath, relativePath: relative.split(nodePath.sep).join('/') });
    }
    return files;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

async function walkedFiles(root: string, signal?: AbortSignal): Promise<SearchFile[]> {
  const files: SearchFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    throwIfAborted(signal);
    if (files.length >= MAX_SEARCH_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      throwIfAborted(signal);
      if (files.length >= MAX_SEARCH_FILES) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolutePath = nodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push({ absolutePath, relativePath: relativeDisplay(root, absolutePath) });
    }
  };
  await visit(root);
  return files;
}

async function searchFiles(
  workspaceManager: WorkspaceManager,
  context: ExtensionRuntimeContext,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<{ root: string; isSingleFile: boolean; files: SearchFile[] }> {
  const target = await workspacePath(workspaceManager, context, requestedPath, { kind: 'any' });
  const info = await stat(target);
  if (info.isFile()) {
    return {
      root: nodePath.dirname(target),
      isSingleFile: true,
      files: [{ absolutePath: target, relativePath: nodePath.basename(target) }],
    };
  }
  if (!info.isDirectory()) throw new Error('Search path must be a regular file or directory.');
  const files = await gitAwareFiles(target, signal) ?? await walkedFiles(target, signal);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { root: target, isSingleFile: false, files };
}

function globMatches(relativePath: string, pattern: string): boolean {
  try {
    const candidate = pattern.includes('/') ? relativePath : nodePath.posix.basename(relativePath);
    return nodePath.posix.matchesGlob(candidate, pattern);
  } catch {
    throw new Error(`Invalid glob pattern: ${pattern}`);
  }
}

function normalizeEditInput(raw: unknown): { path: string; edits: Array<{ oldText: string; newText: string }> } {
  const input = objectInput(raw);
  const filePath = stringInput(input, 'path');
  let rawEdits = input.edits;
  if (typeof rawEdits === 'string') {
    try { rawEdits = JSON.parse(rawEdits) as unknown; }
    catch { throw new Error('Tool parameter "edits" is not valid JSON.'); }
  }
  if (rawEdits && typeof rawEdits === 'object' && !Array.isArray(rawEdits)) rawEdits = [rawEdits];
  if (!Array.isArray(rawEdits) || rawEdits.length === 0 || rawEdits.length > 100) {
    throw new Error('Tool parameter "edits" must contain from 1 to 100 replacements.');
  }
  const edits = rawEdits.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Edit ${index + 1} is invalid.`);
    }
    const values = entry as Record<string, unknown>;
    if (typeof values.oldText !== 'string' || !values.oldText || typeof values.newText !== 'string') {
      throw new Error(`Edit ${index + 1} must contain non-empty oldText and string newText.`);
    }
    if (values.oldText.length > MAX_WRITE_BYTES || values.newText.length > MAX_WRITE_BYTES) {
      throw new Error(`Edit ${index + 1} is too large.`);
    }
    return { oldText: values.oldText, newText: values.newText };
  });
  return { path: filePath, edits };
}

function applyExactEdits(
  original: string,
  edits: Array<{ oldText: string; newText: string }>,
  displayPath: string,
): string {
  const bom = original.startsWith('\ufeff') ? '\ufeff' : '';
  const withoutBom = bom ? original.slice(1) : original;
  const lineEnding = withoutBom.includes('\r\n') ? '\r\n' : '\n';
  const normalized = withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const located = edits.map((edit, index) => {
    const oldText = edit.oldText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const newText = edit.newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const start = normalized.indexOf(oldText);
    const duplicate = start < 0 ? -1 : normalized.indexOf(oldText, start + oldText.length);
    if (start < 0) throw new Error(`Edit ${index + 1} did not match ${displayPath}.`);
    if (duplicate >= 0) throw new Error(`Edit ${index + 1} oldText is not unique in ${displayPath}.`);
    return { start, end: start + oldText.length, newText, index };
  }).sort((left, right) => left.start - right.start || left.end - right.end);

  for (let index = 1; index < located.length; index++) {
    if (located[index].start < located[index - 1].end) {
      throw new Error(`Edits ${located[index - 1].index + 1} and ${located[index].index + 1} overlap.`);
    }
  }

  let result = normalized;
  for (const edit of [...located].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
  }
  return bom + (lineEnding === '\r\n' ? result.replace(/\n/g, '\r\n') : result);
}

/**
 * Register the workspace-scoped coding tools shared by the CLI and detached Web runtime.
 * Every path is canonicalized against the active context cwd at execution time.
 */
export async function registerWorkspaceTools(
  registry: ExtensionRegistry,
  workspaceManager: WorkspaceManager,
  options: WorkspaceToolOptions = {},
): Promise<void> {
  const extensionId = options.extensionId ?? 'builtin:workspace-tools';
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1_000 || commandTimeoutMs > 30 * 60_000) {
    throw new Error('Workspace tool command timeout is invalid.');
  }

  await registry.load(extensionId, api => {
    const readParameters = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read (relative or absolute).' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed).' },
        limit: { type: 'number', description: 'Maximum number of lines to read.' },
      },
      required: ['path'],
      additionalProperties: false,
    };
    const executeRead: ToolExecutor = async (raw, context, signal) => {
      throwIfAborted(signal);
      const input = objectInput(raw);
      const requestedPath = stringInput(input, 'path');
      const offset = boundedInteger(input.offset, 1, 1, Number.MAX_SAFE_INTEGER, 'offset');
      const limit = input.limit === undefined
        ? undefined
        : boundedInteger(input.limit, DEFAULT_TOOL_MAX_LINES, 1, 100_000, 'limit');
      const filePath = await workspacePath(workspaceManager, context, requestedPath, { kind: 'file' });
      const info = await stat(filePath);
      if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${formatToolBytes(MAX_FILE_BYTES)} read limit.`);
      const bytes = await readFile(filePath);
      throwIfAborted(signal);
      if (bytes.subarray(0, 8_192).includes(0)) {
        throw new Error('Binary and image tool results are not supported by this runtime yet.');
      }
      const lines = bytes.toString('utf8').split('\n');
      const start = offset - 1;
      if (start >= lines.length) throw new Error(`Offset ${offset} is beyond the end of the file (${lines.length} lines).`);
      const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
      const selected = lines.slice(start, end).join('\n');
      const truncation = truncateToolHead(selected);
      let content = truncation.content;
      if (truncation.firstLineExceedsLimit) {
        content = `[Line ${offset} exceeds the ${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)} limit.]`;
      } else if (truncation.truncated) {
        const lastLine = offset + truncation.outputLines - 1;
        content += `\n\n[Showing lines ${offset}-${lastLine} of ${lines.length}. Use offset=${lastLine + 1} to continue.]`;
      } else if (end < lines.length) {
        content += `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
      }
      return {
        content,
        details: {
          path: relativeDisplay(await workspaceRoot(workspaceManager, context), filePath),
          offset,
          lines: end - start,
          ...(truncation.truncated ? { truncation } : {}),
        },
      };
    };
    api.registerTool({
      name: 'read',
      description: `Read a text file. Output is truncated to ${DEFAULT_TOOL_MAX_LINES} lines or ${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)}. Use offset/limit to continue.`,
      parameters: readParameters,
      execute: executeRead,
    });

    const writeParameters = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to create or overwrite.' },
        content: { type: 'string', description: 'Complete file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    };
    const executeWrite: ToolExecutor = async (raw, context, signal) => {
      requireTrust(context);
      const input = objectInput(raw);
      const requestedPath = stringInput(input, 'path');
      const content = stringInput(input, 'content', { max: MAX_WRITE_BYTES, allowEmpty: true });
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        throw new Error(`Content exceeds the ${formatToolBytes(MAX_WRITE_BYTES)} write limit.`);
      }
      const filePath = await workspacePath(workspaceManager, context, requestedPath, { mustExist: false, kind: 'file' });
      const root = await workspaceRoot(workspaceManager, context);
      return withMutationQueue(filePath, async () => {
        throwIfAborted(signal);
        await mkdir(nodePath.dirname(filePath), { recursive: true });
        throwIfAborted(signal);
        await writeFile(filePath, content, 'utf8');
        throwIfAborted(signal);
        return { content: `Successfully wrote ${relativeDisplay(root, filePath)}.` };
      });
    };
    api.registerTool({
      name: 'write',
      description: "Create or overwrite a text file and create missing parent directories. Requires a trusted workspace.",
      parameters: writeParameters,
      execute: executeWrite,
    });

    const editParameters = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the existing file to edit.' },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact unique text from the original file.' },
              newText: { type: 'string', description: 'Replacement text.' },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    };
    const executeEdit: ToolExecutor = async (raw, context, signal) => {
      requireTrust(context);
      const input = normalizeEditInput(raw);
      const filePath = await workspacePath(workspaceManager, context, input.path, { kind: 'file' });
      const root = await workspaceRoot(workspaceManager, context);
      return withMutationQueue(filePath, async () => {
        throwIfAborted(signal);
        const info = await stat(filePath);
        if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${formatToolBytes(MAX_FILE_BYTES)} edit limit.`);
        const original = await readFile(filePath, 'utf8');
        throwIfAborted(signal);
        const updated = applyExactEdits(original, input.edits, relativeDisplay(root, filePath));
        if (Buffer.byteLength(updated, 'utf8') > MAX_WRITE_BYTES) {
          throw new Error(`Edited file exceeds the ${formatToolBytes(MAX_WRITE_BYTES)} write limit.`);
        }
        await writeFile(filePath, updated, 'utf8');
        throwIfAborted(signal);
        return {
          content: `Successfully replaced ${input.edits.length} block(s) in ${relativeDisplay(root, filePath)}.`,
          details: { path: relativeDisplay(root, filePath), replacements: input.edits.length },
        };
      });
    };
    api.registerTool({
      name: 'edit',
      description: 'Edit one file using exact, unique, non-overlapping replacements against the original content. Requires a trusted workspace.',
      parameters: editParameters,
      execute: executeEdit,
    });

    const lsParameters = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list (default: current workspace).' },
        limit: { type: 'number', description: 'Maximum entries (default: 500).' },
      },
      additionalProperties: false,
    };
    const executeLs: ToolExecutor = async (raw, context, signal) => {
      const input = objectInput(raw);
      const limit = boundedInteger(input.limit, 500, 1, 5_000, 'limit');
      const directory = await workspacePath(workspaceManager, context, optionalString(input, 'path') ?? '.', { kind: 'directory' });
      throwIfAborted(signal);
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase()));
      const limited = entries.slice(0, limit).map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
      const bounded = headOutput(limited.join('\n') || '(empty directory)');
      const reachedLimit = entries.length > limit;
      return {
        content: `${bounded.content}${reachedLimit ? `\n\n[${limit} entries limit reached.]` : ''}`,
        details: {
          entries: limited.length,
          ...(reachedLimit ? { entryLimitReached: limit } : {}),
          ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
        },
      };
    };
    api.registerTool({
      name: 'ls',
      description: `List a directory alphabetically, including dotfiles. Output is bounded to 500 entries or ${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)} by default.`,
      parameters: lsParameters,
      execute: executeLs,
    });

    const findParameters = {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob such as '*.ts' or 'src/**/*.spec.ts'." },
        path: { type: 'string', description: 'Directory to search (default: current workspace).' },
        limit: { type: 'number', description: 'Maximum results (default: 1000).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    };
    const executeFind: ToolExecutor = async (raw, context, signal) => {
      const input = objectInput(raw);
      const pattern = stringInput(input, 'pattern', { max: 1_000 });
      const limit = boundedInteger(input.limit, 1_000, 1, 5_000, 'limit');
      // Validate before walking a potentially large tree.
      globMatches('validation-path', pattern);
      const source = await searchFiles(workspaceManager, context, optionalString(input, 'path') ?? '.', signal);
      const matches: string[] = [];
      for (const file of source.files) {
        throwIfAborted(signal);
        if (!globMatches(file.relativePath, pattern)) continue;
        matches.push(file.relativePath);
        if (matches.length >= limit) break;
      }
      if (!matches.length) return { content: 'No files found matching pattern.' };
      matches.sort((left, right) => left.localeCompare(right));
      const bounded = headOutput(matches.join('\n'));
      const reachedLimit = matches.length >= limit;
      return {
        content: `${bounded.content}${reachedLimit ? `\n\n[${limit} results limit reached.]` : ''}`,
        details: {
          results: matches.length,
          ...(reachedLimit ? { resultLimitReached: limit } : {}),
          ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
        },
      };
    };
    api.registerTool({
      name: 'find',
      description: `Find files by glob pattern. Git repositories respect .gitignore. Results are bounded to 1000 paths or ${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)} by default.`,
      parameters: findParameters,
      execute: executeFind,
    });

    const grepParameters = {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression or literal search text.' },
        path: { type: 'string', description: 'File or directory to search (default: current workspace).' },
        glob: { type: 'string', description: "Optional file glob such as '*.ts'." },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search.' },
        literal: { type: 'boolean', description: 'Treat pattern as literal text.' },
        context: { type: 'number', description: 'Context lines before and after each match.' },
        limit: { type: 'number', description: 'Maximum matches (default: 100).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    };
    const executeGrep: ToolExecutor = async (raw, context, signal) => {
      const input = objectInput(raw);
      const pattern = stringInput(input, 'pattern', { max: 20_000, allowEmpty: true });
      const glob = optionalString(input, 'glob', 1_000);
      if (glob) globMatches('validation-path', glob);
      const ignoreCase = input.ignoreCase === true;
      const literal = input.literal === true;
      const contextLines = boundedInteger(input.context, 0, 0, 20, 'context');
      const limit = boundedInteger(input.limit, 100, 1, 5_000, 'limit');
      let expression: RegExp | undefined;
      if (!literal) {
        try { expression = new RegExp(pattern, ignoreCase ? 'i' : undefined); }
        catch (error) { throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const literalPattern = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
      const source = await searchFiles(workspaceManager, context, optionalString(input, 'path') ?? '.', signal);
      const output: string[] = [];
      let matches = 0;
      let linesTruncated = false;
      for (const file of source.files) {
        throwIfAborted(signal);
        if (glob && !globMatches(file.relativePath, glob)) continue;
        const safeFile = await workspacePath(workspaceManager, context, file.absolutePath, { kind: 'file' });
        const info = await stat(safeFile);
        if (info.size > MAX_SEARCH_FILE_BYTES) continue;
        const bytes = await readFile(safeFile);
        if (bytes.subarray(0, 8_192).includes(0)) continue;
        const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        for (let index = 0; index < lines.length; index++) {
          const candidate = ignoreCase ? lines[index].toLocaleLowerCase() : lines[index];
          if (expression ? !expression.test(lines[index]) : !candidate.includes(literalPattern)) continue;
          matches++;
          const start = Math.max(0, index - contextLines);
          const end = Math.min(lines.length - 1, index + contextLines);
          for (let lineIndex = start; lineIndex <= end; lineIndex++) {
            const truncated = truncateToolLine(lines[lineIndex]);
            linesTruncated ||= truncated.truncated;
            const separator = lineIndex === index ? ':' : '-';
            output.push(`${file.relativePath}${separator}${lineIndex + 1}${separator} ${truncated.content}`);
          }
          if (matches >= limit) break;
        }
        if (matches >= limit) break;
      }
      if (!matches) return { content: 'No matches found.' };
      const bounded = headOutput(output.join('\n'));
      const notices: string[] = [];
      if (matches >= limit) notices.push(`${limit} matches limit reached`);
      if (linesTruncated) notices.push(`Some lines were truncated to ${DEFAULT_GREP_LINE_LENGTH} characters`);
      return {
        content: `${bounded.content}${notices.length ? `\n\n[${notices.join('. ')}.]` : ''}`,
        details: {
          matches,
          ...(matches >= limit ? { matchLimitReached: limit } : {}),
          ...(linesTruncated ? { linesTruncated: true } : {}),
          ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
        },
      };
    };
    api.registerTool({
      name: 'grep',
      description: `Search text files with a regex or literal string. Git repositories respect .gitignore. Results are bounded to 100 matches or ${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)} by default.`,
      parameters: grepParameters,
      execute: executeGrep,
    });

    const shellParameters = {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        timeout: { type: 'number', description: `Optional timeout in seconds (maximum ${commandTimeoutMs / 1_000}).` },
      },
      required: ['command'],
      additionalProperties: false,
    };
    const shellExecutor = (shell: 'default' | 'powershell'): ToolExecutor => async (raw, context, signal) => {
      requireTrust(context);
      const input = objectInput(raw);
      const command = stringInput(input, 'command', { max: 100_000 });
      const requestedTimeout = input.timeout === undefined
        ? commandTimeoutMs
        : Number(input.timeout) * 1_000;
      if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0 || requestedTimeout > commandTimeoutMs) {
        throw new Error(`Tool parameter "timeout" must be greater than zero and at most ${commandTimeoutMs / 1_000} seconds.`);
      }
      const cwd = await workspaceRoot(workspaceManager, context);
      const powershell = shell === 'powershell' || process.platform === 'win32';
      const startedAt = Date.now();
      let result: ProcessResult;
      try {
        result = await executeProcess({
          executable: powershell ? 'powershell.exe' : '/bin/sh',
          args: powershell
            ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
            : ['-lc', command],
          cwd,
          signal,
          timeoutMs: requestedTimeout,
          detached: true,
        });
      } catch (error) {
        if (context.currentSessionId) {
          await context.sessionManager.addCommand(context.currentSessionId, {
            command,
            cwd,
            status: signal?.aborted ? 'cancelled' : 'failed',
            output: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
            excludedFromContext: true,
          });
        }
        throw error;
      }
      const formatted = processOutput(result);
      if (context.currentSessionId) {
        await context.sessionManager.addCommand(context.currentSessionId, {
          command,
          cwd,
          status: result.exitCode === 0 ? 'completed' : 'failed',
          output: formatted.content,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          excludedFromContext: true,
          truncated: Boolean(formatted.details.truncated),
        });
      }
      return {
        content: formatted.content,
        isError: result.exitCode !== 0,
        details: formatted.details,
      };
    };
    const executeBash = shellExecutor('default');
    api.registerTool({
      name: 'bash',
      description: `Execute a shell command in the trusted workspace. Combined output is bounded to the last ${DEFAULT_TOOL_MAX_LINES} lines or ${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)}.`,
      parameters: shellParameters,
      execute: executeBash,
    });
    if (process.platform === 'win32') {
      api.registerTool({
        name: 'powershell',
        description: 'Execute a PowerShell command in the trusted workspace.',
        parameters: shellParameters,
        execute: shellExecutor('powershell'),
      });
    }
  });
}
