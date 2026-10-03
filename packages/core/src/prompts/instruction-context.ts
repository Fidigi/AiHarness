import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CONTEXT_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
] as const;

export const DEFAULT_CODING_SYSTEM_PROMPT =
  'You are an expert coding assistant operating inside AiHarness, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CONTEXT_FILES = 64;

export interface InstructionFile {
  path: string;
  content: string;
  scope: 'agent' | 'ancestor';
}

export interface InstructionSource {
  kind: 'default' | 'literal' | 'file';
  path?: string;
}

export interface InstructionDiagnostic {
  path: string;
  message: string;
}

export interface ResolveInstructionPromptOptions {
  cwd: string;
  /** Defaults to PI_CODING_AGENT_DIR, then ~/.pi/agent. */
  agentDir?: string;
  /** Gates all project/ancestor instruction sources; user-level agent-directory files remain independent. */
  projectTrusted?: boolean;
  noContextFiles?: boolean;
  /** CLI-compatible text-or-existing-file replacement. */
  systemPromptInput?: string;
  /** Literal replacement used by API/configuration callers; never interpreted as a host path. */
  systemPromptText?: string;
  /** CLI-compatible repeatable text-or-existing-file additions. Presence replaces discovered APPEND_SYSTEM.md. */
  appendSystemPromptInputs?: readonly string[];
  /** Literal additions used by API/configuration callers. Presence replaces discovered APPEND_SYSTEM.md. */
  appendSystemPromptTexts?: readonly string[];
  defaultSystemPrompt?: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxContextFiles?: number;
}

export interface ResolvedInstructionPrompt {
  systemPrompt: string;
  agentDir: string;
  contextFiles: InstructionFile[];
  systemPromptSource: InstructionSource;
  appendSystemPromptSources: InstructionSource[];
  diagnostics: InstructionDiagnostic[];
}

interface LoadedTextFile {
  path: string;
  content: string;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive safe integer.`);
  return resolved;
}

function expandHome(input: string, homeDir = os.homedir()): string {
  if (input === '~') return homeDir;
  if (input.startsWith(`~${path.sep}`) || (path.sep === '\\' && input.startsWith('~/'))) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

/** Resolve Pi's agent-directory convention without creating or mutating it. */
export function resolvePiAgentDirectory(
  configured = process.env.PI_CODING_AGENT_DIR,
  homeDir = os.homedir(),
): string {
  const selected = configured?.trim() || path.join(homeDir, '.pi', 'agent');
  return path.resolve(expandHome(selected, homeDir));
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizedPromptText(value: string): string {
  return value.startsWith('\ufeff') ? value.slice(1) : value;
}

async function readBoundedUtf8(filePath: string, maxBytes: number): Promise<string> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Instruction source must be a regular file and cannot be a symbolic link.');
  }
  if (before.size > maxBytes) throw new Error(`Instruction source exceeds the ${maxBytes} byte file limit.`);

  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Instruction source changed while it was being opened.');
    }
    if (opened.size > maxBytes) throw new Error(`Instruction source exceeds the ${maxBytes} byte file limit.`);

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Instruction source exceeds the ${maxBytes} byte file limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Instruction source changed while it was being read.');
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.includes(0)) throw new Error('Instruction source must be UTF-8 text, not binary data.');
    try {
      return normalizedPromptText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error('Instruction source is not valid UTF-8 text.');
    }
  } finally {
    await handle.close();
  }
}

async function optionalInstructionFile(
  filePath: string,
  maxBytes: number,
  diagnostics: InstructionDiagnostic[],
): Promise<LoadedTextFile | undefined> {
  try {
    return { path: filePath, content: await readBoundedUtf8(filePath, maxBytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    diagnostics.push({
      path: filePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function contextFileFromDirectory(
  directory: string,
  maxBytes: number,
  diagnostics: InstructionDiagnostic[],
): Promise<LoadedTextFile | undefined> {
  for (const name of CONTEXT_FILE_NAMES) {
    const loaded = await optionalInstructionFile(path.join(directory, name), maxBytes, diagnostics);
    if (loaded) return loaded;
  }
  return undefined;
}

function ancestorDirectories(cwd: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    directories.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

async function loadContextFiles(
  cwd: string,
  agentDir: string,
  maxBytes: number,
  maxFiles: number,
  diagnostics: InstructionDiagnostic[],
  includeProjectFiles: boolean,
): Promise<InstructionFile[]> {
  const files: InstructionFile[] = [];
  const seen = new Set<string>();
  const add = (loaded: LoadedTextFile | undefined, scope: InstructionFile['scope']): void => {
    if (!loaded) return;
    const key = path.resolve(loaded.path);
    if (seen.has(key)) return;
    if (files.length >= maxFiles) throw new Error(`Context-file discovery exceeds the ${maxFiles} file limit.`);
    seen.add(key);
    files.push({ ...loaded, scope });
  };

  add(await contextFileFromDirectory(agentDir, maxBytes, diagnostics), 'agent');
  if (includeProjectFiles) {
    for (const directory of ancestorDirectories(cwd)) {
      add(await contextFileFromDirectory(directory, maxBytes, diagnostics), 'ancestor');
    }
  }
  return files;
}

async function firstInstructionFile(
  candidates: readonly string[],
  maxBytes: number,
  diagnostics: InstructionDiagnostic[],
): Promise<LoadedTextFile | undefined> {
  for (const candidate of candidates) {
    const loaded = await optionalInstructionFile(candidate, maxBytes, diagnostics);
    if (loaded) return loaded;
  }
  return undefined;
}

async function resolveTextOrFile(
  input: string,
  cwd: string,
  maxBytes: number,
): Promise<{ content: string; source: InstructionSource }> {
  if (Buffer.byteLength(input, 'utf8') > maxBytes) {
    throw new Error(`Inline instruction exceeds the ${maxBytes} byte file limit.`);
  }
  const couldBePath = input.length <= 4_096 && !/[\r\n\0]/.test(input);
  if (couldBePath) {
    const candidate = path.resolve(cwd, expandHome(input));
    try {
      await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: normalizedPromptText(input), source: { kind: 'literal' } };
      }
      throw error;
    }
    return { content: await readBoundedUtf8(candidate, maxBytes), source: { kind: 'file', path: candidate } };
  }
  return { content: normalizedPromptText(input), source: { kind: 'literal' } };
}

export function composeInstructionSystemPrompt(input: {
  cwd: string;
  basePrompt?: string;
  defaultSystemPrompt?: string;
  appendSystemPrompts?: readonly string[];
  contextFiles?: readonly Pick<InstructionFile, 'path' | 'content'>[];
}): string {
  const base = input.basePrompt?.trim()
    ? input.basePrompt
    : input.defaultSystemPrompt ?? DEFAULT_CODING_SYSTEM_PROMPT;
  const sections = [base];
  const append = (input.appendSystemPrompts ?? []).filter(value => value.trim()).join('\n\n');
  if (append) sections.push(`<addendum>\n${append}\n</addendum>`);
  if (input.contextFiles?.length) {
    const rendered = input.contextFiles.map(file => (
      `<project_instructions path="${xmlAttribute(file.path.replace(/\\/g, '/'))}">\n${file.content}\n</project_instructions>`
    ));
    sections.push(`<project_context>\nProject-specific instructions and guidelines:\n\n${rendered.join('\n\n')}\n</project_context>`);
  }
  sections.push(`<cwd>\n${path.resolve(input.cwd).replace(/\\/g, '/')}\n</cwd>`);
  return sections.filter(value => value.length > 0).join('\n\n');
}

/**
 * Resolve Pi-compatible context and system-prompt inputs through one bounded,
 * non-secret contract shared by CLI and server runtimes.
 */
export async function resolveInstructionPrompt(
  options: ResolveInstructionPromptOptions,
): Promise<ResolvedInstructionPrompt> {
  if (options.systemPromptInput !== undefined && options.systemPromptText !== undefined) {
    throw new Error('systemPromptInput and systemPromptText cannot be combined.');
  }
  if (options.appendSystemPromptInputs !== undefined && options.appendSystemPromptTexts !== undefined) {
    throw new Error('append system prompt inputs and texts cannot be combined.');
  }

  const maxFileBytes = positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
  const maxTotalBytes = positiveLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes');
  const maxContextFiles = positiveLimit(options.maxContextFiles, DEFAULT_MAX_CONTEXT_FILES, 'maxContextFiles');
  const cwd = path.resolve(options.cwd);
  const agentDir = resolvePiAgentDirectory(options.agentDir);
  const diagnostics: InstructionDiagnostic[] = [];
  const contextFiles = options.noContextFiles
    ? []
    : await loadContextFiles(
      cwd,
      agentDir,
      maxFileBytes,
      maxContextFiles,
      diagnostics,
      options.projectTrusted === true,
    );

  let basePrompt: string | undefined;
  let systemPromptSource: InstructionSource = { kind: 'default' };
  if (options.systemPromptInput !== undefined) {
    const explicit = await resolveTextOrFile(options.systemPromptInput, cwd, maxFileBytes);
    basePrompt = explicit.content;
    systemPromptSource = explicit.source;
  } else if (options.systemPromptText !== undefined) {
    if (Buffer.byteLength(options.systemPromptText, 'utf8') > maxFileBytes) {
      throw new Error(`Inline instruction exceeds the ${maxFileBytes} byte file limit.`);
    }
    basePrompt = normalizedPromptText(options.systemPromptText);
    systemPromptSource = { kind: 'literal' };
  } else {
    const discovered = await firstInstructionFile([
      ...(options.projectTrusted ? [path.join(cwd, '.pi', 'SYSTEM.md')] : []),
      path.join(agentDir, 'SYSTEM.md'),
    ], maxFileBytes, diagnostics);
    if (discovered) {
      basePrompt = discovered.content;
      systemPromptSource = { kind: 'file', path: discovered.path };
    }
  }

  const appendSystemPrompts: string[] = [];
  const appendSystemPromptSources: InstructionSource[] = [];
  if (options.appendSystemPromptInputs !== undefined) {
    for (const input of options.appendSystemPromptInputs) {
      const explicit = await resolveTextOrFile(input, cwd, maxFileBytes);
      appendSystemPrompts.push(explicit.content);
      appendSystemPromptSources.push(explicit.source);
    }
  } else if (options.appendSystemPromptTexts !== undefined) {
    for (const text of options.appendSystemPromptTexts) {
      if (Buffer.byteLength(text, 'utf8') > maxFileBytes) {
        throw new Error(`Inline instruction exceeds the ${maxFileBytes} byte file limit.`);
      }
      appendSystemPrompts.push(normalizedPromptText(text));
      appendSystemPromptSources.push({ kind: 'literal' });
    }
  } else {
    const discovered = await firstInstructionFile([
      ...(options.projectTrusted ? [path.join(cwd, '.pi', 'APPEND_SYSTEM.md')] : []),
      path.join(agentDir, 'APPEND_SYSTEM.md'),
    ], maxFileBytes, diagnostics);
    if (discovered) {
      appendSystemPrompts.push(discovered.content);
      appendSystemPromptSources.push({ kind: 'file', path: discovered.path });
    }
  }

  const contentBytes = [
    basePrompt ?? options.defaultSystemPrompt ?? DEFAULT_CODING_SYSTEM_PROMPT,
    ...appendSystemPrompts,
    ...contextFiles.map(file => file.content),
  ].reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
  if (contentBytes > maxTotalBytes) {
    throw new Error(`Resolved instructions exceed the ${maxTotalBytes} byte total limit.`);
  }

  return {
    systemPrompt: composeInstructionSystemPrompt({
      cwd,
      basePrompt,
      defaultSystemPrompt: options.defaultSystemPrompt,
      appendSystemPrompts,
      contextFiles,
    }),
    agentDir,
    contextFiles,
    systemPromptSource,
    appendSystemPromptSources,
    diagnostics,
  };
}
