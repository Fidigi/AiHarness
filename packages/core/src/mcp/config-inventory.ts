import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectTrustManager } from '../security/project-trust.js';

/** Configuration bodies are bounded before parsing, including user-owned global configuration. */
export const MCP_CONFIG_MAX_BYTES = 1024 * 1024;
/** A bounded response prevents a repository from expanding a small file into a very large inventory. */
export const MCP_CONFIG_MAX_SERVERS = 200;
const MCP_CONFIG_MAX_DEPTH = 64;
const MCP_CONFIG_MAX_STRING_BYTES = 16 * 1024;
const MCP_CONFIG_MAX_COLLECTION_ENTRIES = 128;
const CONTROL_OR_HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u;
const VARIABLE_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const VARIABLE_ONLY = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;
const SAFE_COMMAND_NAMES = new Set([
  'bash', 'bun', 'cmd', 'deno', 'docker', 'java', 'node', 'npx', 'powershell', 'pwsh', 'python', 'python3', 'sh', 'uvx',
]);

export type McpConfigScope = 'global' | 'project';
export type McpTransportKind = 'stdio' | 'http';
export type McpExposure = 'direct' | 'codemode' | 'deferred';

export type McpConfigProblemReason =
  | 'invalid-shape'
  | 'invalid-syntax'
  | 'not-regular'
  | 'too-deep'
  | 'too-large'
  | 'too-many-servers'
  | 'trust-required'
  | 'trust-unavailable'
  | 'unsafe-link'
  | 'unreadable';

export interface McpConfigProblem {
  reason: McpConfigProblemReason;
  /** Fixed diagnostic text. It never includes configuration source text or a literal value. */
  message: string;
}

export interface McpConfigFileInventory {
  scope: McpConfigScope;
  path: string;
  exists: boolean;
  /** False means that no configuration body was opened or parsed. */
  contentRead: boolean;
  problems: McpConfigProblem[];
}

export interface McpVariableReference {
  field: string;
  names: string[];
}

export interface McpServerInventoryEntry {
  name: string;
  scope: McpConfigScope;
  sourcePath: string;
  valid: boolean;
  enabled: boolean;
  exposure: McpExposure;
  transport?: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  envNames: string[];
  headerNames: string[];
  commandFields: string[];
  variableReferences: McpVariableReference[];
  masked: boolean;
  shadowedByProject: boolean;
  replacesGlobal: boolean;
  problems: string[];
}

export interface McpProjectInventory {
  cwd: string;
  /** Project content is readable only after an effective persisted allow decision. */
  contentTrusted: boolean;
  requiresTrust: boolean;
  decision: boolean | null;
  decisionPath?: string;
  inherited: boolean;
  trustError: boolean;
}

export interface McpConfigInventory {
  files: McpConfigFileInventory[];
  servers: McpServerInventoryEntry[];
  project?: McpProjectInventory;
}

export interface InspectMcpConfigOptions {
  agentDir: string;
  cwd?: string;
  trustManager?: ProjectTrustManager;
}

interface ParsedEntry {
  rawName: string;
  info: McpServerInventoryEntry;
}

interface FileReadResult {
  info: McpConfigFileInventory;
  text?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problem(reason: McpConfigProblemReason, message: string): McpConfigProblem {
  return { reason, message };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function escapedDisplay(value: string, maxCodePoints = 256): string {
  const points = Array.from(value);
  const bounded = points.length > maxCodePoints ? [...points.slice(0, maxCodePoints), '…'] : points;
  return bounded.map(character => {
    const codePoint = character.codePointAt(0)!;
    if (CONTROL_OR_HIDDEN.test(character)) {
      return codePoint <= 0xffff
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : `\\u{${codePoint.toString(16)}}`;
    }
    return character;
  }).join('');
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MCP_CONFIG_MAX_STRING_BYTES;
}

async function readRegularFile(
  filePath: string,
  scope: McpConfigScope,
  parentIdentity?: { dev: number; ino: number; path: string },
): Promise<FileReadResult> {
  const info: McpConfigFileInventory = {
    scope,
    path: filePath,
    exists: false,
    contentRead: false,
    problems: [],
  };
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { info };
    info.problems.push(problem('unreadable', 'The configuration file metadata cannot be read.'));
    return { info };
  }
  info.exists = true;
  if (before.isSymbolicLink()) {
    info.problems.push(problem('unsafe-link', 'Symbolic links are not accepted for MCP configuration files.'));
    return { info };
  }
  if (!before.isFile()) {
    info.problems.push(problem('not-regular', 'The MCP configuration path is not a regular file.'));
    return { info };
  }
  if (before.size > MCP_CONFIG_MAX_BYTES) {
    info.problems.push(problem('too-large', `The MCP configuration exceeds ${MCP_CONFIG_MAX_BYTES} bytes.`));
    return { info };
  }

  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      info.problems.push(problem('unreadable', 'The MCP configuration changed while it was being opened.'));
      return { info };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MCP_CONFIG_MAX_BYTES + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MCP_CONFIG_MAX_BYTES) {
        info.problems.push(problem('too-large', `The MCP configuration exceeds ${MCP_CONFIG_MAX_BYTES} bytes.`));
        return { info };
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (!sameIdentity(opened, after) || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      info.problems.push(problem('unreadable', 'The MCP configuration changed while it was being read.'));
      return { info };
    }
    if (parentIdentity) {
      let parentAfter;
      try {
        parentAfter = await lstat(parentIdentity.path);
      } catch {
        info.problems.push(problem('unreadable', 'The project configuration directory changed while it was being read.'));
        return { info };
      }
      if (parentAfter.isSymbolicLink() || !parentAfter.isDirectory()
        || !sameIdentity(parentIdentity, parentAfter)) {
        info.problems.push(problem('unreadable', 'The project configuration directory changed while it was being read.'));
        return { info };
      }
    }

    const bytes = Buffer.concat(chunks, total);
    if (bytes.includes(0)) {
      info.problems.push(problem('invalid-syntax', 'The MCP configuration is not valid UTF-8 JSON or JSONC.'));
      return { info };
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '');
    } catch {
      info.problems.push(problem('invalid-syntax', 'The MCP configuration is not valid UTF-8 JSON or JSONC.'));
      return { info };
    }
    info.contentRead = true;
    return { info, text };
  } catch (error) {
    info.problems.push(problem(
      errorCode(error) === 'ELOOP' ? 'unsafe-link' : 'unreadable',
      errorCode(error) === 'ELOOP'
        ? 'Symbolic links are not accepted for MCP configuration files.'
        : 'The MCP configuration file cannot be read safely.',
    ));
    return { info };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readProjectFile(
  cwd: string,
  contentTrusted: boolean,
  trustError: boolean,
): Promise<FileReadResult> {
  const configDirectory = path.join(cwd, '.ai-harness');
  const filePath = path.join(configDirectory, 'mcp.json');
  let directory;
  try {
    directory = await lstat(configDirectory);
  } catch (error) {
    const info: McpConfigFileInventory = {
      scope: 'project', path: filePath, exists: false, contentRead: false, problems: [],
    };
    if (errorCode(error) !== 'ENOENT') {
      info.problems.push(problem('unreadable', 'The project configuration directory metadata cannot be read.'));
    }
    return { info };
  }
  if (directory.isSymbolicLink()) {
    return {
      info: {
        scope: 'project', path: filePath, exists: false, contentRead: false,
        problems: [problem('unsafe-link', 'Symbolic links are not accepted for the project configuration directory.')],
      },
    };
  }
  if (!directory.isDirectory()) {
    return {
      info: {
        scope: 'project', path: filePath, exists: false, contentRead: false,
        problems: [problem('not-regular', 'The project configuration path is not a directory.')],
      },
    };
  }

  if (!contentTrusted) {
    const info: McpConfigFileInventory = {
      scope: 'project', path: filePath, exists: false, contentRead: false, problems: [],
    };
    try {
      const file = await lstat(filePath);
      info.exists = true;
      if (file.isSymbolicLink()) {
        info.problems.push(problem('unsafe-link', 'Symbolic links are not accepted for MCP configuration files.'));
      } else if (!file.isFile()) {
        info.problems.push(problem('not-regular', 'The MCP configuration path is not a regular file.'));
      } else {
        info.problems.push(problem(
          trustError ? 'trust-unavailable' : 'trust-required',
          trustError
            ? 'Project MCP configuration is locked because project trust is unavailable.'
            : 'Trust this project before its MCP configuration can be read.',
        ));
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        info.problems.push(problem('unreadable', 'The project MCP configuration metadata cannot be read.'));
      }
    }
    return { info };
  }

  return readRegularFile(filePath, 'project', {
    dev: directory.dev,
    ino: directory.ino,
    path: configDirectory,
  });
}

function normalizeJsonc(text: string): { normalized?: string; tooDeep: boolean } {
  const output = text.split('');
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  let tooDeep = false;

  for (let index = 0; index < output.length; index++) {
    const character = output[index];
    const next = output[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      else output[index] = ' ';
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        blockComment = false;
        index++;
      } else if (character !== '\n' && character !== '\r') output[index] = ' ';
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      lineComment = true;
      index++;
      continue;
    }
    if (character === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      blockComment = true;
      index++;
      continue;
    }
    if (character === '{' || character === '[') {
      depth++;
      if (depth > MCP_CONFIG_MAX_DEPTH) tooDeep = true;
    } else if (character === '}' || character === ']') depth--;
  }
  if (blockComment) return { tooDeep };

  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index++) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== ',') continue;
    let lookahead = index + 1;
    while (lookahead < output.length && /\s/u.test(output[lookahead])) lookahead++;
    if (output[lookahead] === '}' || output[lookahead] === ']') output[index] = ' ';
  }
  return { normalized: output.join(''), tooDeep };
}

function parseConfig(file: McpConfigFileInventory, text: string): Array<[string, unknown]> {
  const jsonc = normalizeJsonc(text);
  if (jsonc.tooDeep) {
    file.problems.push(problem('too-deep', `The MCP configuration exceeds the nesting limit of ${MCP_CONFIG_MAX_DEPTH}.`));
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonc.normalized ?? '') as unknown;
  } catch {
    file.problems.push(problem('invalid-syntax', 'The MCP configuration contains invalid JSON or JSONC syntax.'));
    return [];
  }
  if (!isRecord(parsed)) {
    file.problems.push(problem('invalid-shape', 'The MCP configuration must be an object.'));
    return [];
  }
  if (Object.keys(parsed).some(key => key !== 'mcpServers' && key !== 'version')) {
    file.problems.push(problem('invalid-shape', 'The MCP configuration contains unsupported root properties.'));
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    file.problems.push(problem('invalid-shape', 'The MCP configuration version must be 1.'));
  }
  if (parsed.mcpServers === undefined) return [];
  if (!isRecord(parsed.mcpServers)) {
    file.problems.push(problem('invalid-shape', 'The mcpServers property must be an object.'));
    return [];
  }
  const entries = Object.entries(parsed.mcpServers);
  if (entries.length > MCP_CONFIG_MAX_SERVERS) {
    file.problems.push(problem(
      'too-many-servers',
      `The MCP configuration declares more than ${MCP_CONFIG_MAX_SERVERS} servers.`,
    ));
    return [];
  }
  return entries;
}

function validName(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 256
    && !CONTROL_OR_HIDDEN.test(value);
}

function validateStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > MCP_CONFIG_MAX_COLLECTION_ENTRIES) return false;
  return Object.entries(value).every(([key, entry]) => validName(key) && boundedString(entry));
}

function fieldReferences(field: string, value: string): McpVariableReference | undefined {
  const names: string[] = [];
  for (const match of value.matchAll(VARIABLE_REFERENCE)) {
    const name = match[1] ?? match[2];
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= MCP_CONFIG_MAX_COLLECTION_ENTRIES) break;
  }
  return names.length ? { field, names } : undefined;
}

function maskedCommand(value: string): { value: string; masked: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { value: '[invalid command]', masked: true };
  if (VARIABLE_ONLY.test(trimmed)) return { value: escapedDisplay(trimmed), masked: false };
  if (!/^[A-Za-z0-9_@+./\\:-]+$/u.test(trimmed)) return { value: '[configured command]', masked: true };
  const base = trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed;
  if (!SAFE_COMMAND_NAMES.has(base.toLocaleLowerCase())) {
    return { value: '[configured command]', masked: true };
  }
  return { value: escapedDisplay(base), masked: base !== trimmed };
}

function maskedArgument(value: string): { value: string; masked: boolean } {
  if (VARIABLE_ONLY.test(value)) return { value: escapedDisplay(value), masked: false };
  const assignment = value.match(/^(--?[A-Za-z0-9][A-Za-z0-9_-]*)=/u);
  if (assignment) return { value: `${assignment[1]}=•••`, masked: true };
  if (/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) return { value, masked: false };
  return { value: value.startsWith('!') ? '!•••' : '•••', masked: true };
}

function maskedUrl(value: string): { value: string; masked: boolean; valid: boolean } {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { value: '[invalid URL]', masked: true, valid: false };
    }
    const hasPath = url.pathname !== '' && url.pathname !== '/';
    const masked = Boolean(url.username || url.password || hasPath || url.search || url.hash);
    return {
      value: `${url.protocol}//${url.host}${hasPath ? '/•••' : ''}${url.search ? '?•••' : ''}${url.hash ? '#•••' : ''}`,
      masked,
      valid: true,
    };
  } catch {
    return { value: '[invalid URL]', masked: true, valid: false };
  }
}

function describeEntry(
  rawName: string,
  value: unknown,
  scope: McpConfigScope,
  sourcePath: string,
): ParsedEntry {
  const problems: string[] = [];
  const config = isRecord(value) ? value : {};
  if (!isRecord(value)) problems.push('The server entry must be an object.');
  if (!validName(rawName)) problems.push('The server name is empty, too long, or contains hidden characters.');

  const knownFields = new Set([
    'args', 'command', 'cwd', 'description', 'enabled', 'env', 'exposure', 'headers', 'oauth', 'type', 'url',
  ]);
  if (Object.keys(config).some(key => !knownFields.has(key))) {
    problems.push('The server entry contains unsupported properties.');
  }

  const commandPresent = Object.hasOwn(config, 'command');
  const urlPresent = Object.hasOwn(config, 'url');
  if (commandPresent === urlPresent) problems.push('The server entry must define exactly one command or URL.');
  if (commandPresent && (!boundedString(config.command) || !config.command.trim())) {
    problems.push('The command must be a non-empty bounded string.');
  }
  const url = typeof config.url === 'string' ? maskedUrl(config.url) : undefined;
  if (urlPresent && (!boundedString(config.url) || !url?.valid)) {
    problems.push('The URL must be a bounded HTTP or HTTPS URL.');
  }

  const inferredTransport: McpTransportKind | undefined = commandPresent ? 'stdio' : urlPresent ? 'http' : undefined;
  if (config.type !== undefined && config.type !== 'stdio' && config.type !== 'http'
    && config.type !== 'streamable-http') {
    problems.push('The transport type is unsupported.');
  } else if (inferredTransport === 'stdio' && config.type !== undefined && config.type !== 'stdio') {
    problems.push('The transport type does not match the command transport.');
  } else if (inferredTransport === 'http' && config.type !== undefined
    && config.type !== 'http' && config.type !== 'streamable-http') {
    problems.push('The transport type does not match the URL transport.');
  }

  const argsValid = config.args === undefined || (
    Array.isArray(config.args)
    && config.args.length <= MCP_CONFIG_MAX_COLLECTION_ENTRIES
    && config.args.every(boundedString)
  );
  if (!argsValid) problems.push('Arguments must be a bounded array of strings.');
  if (config.cwd !== undefined && !boundedString(config.cwd)) problems.push('The working directory must be a bounded string.');
  if (config.description !== undefined && !boundedString(config.description)) {
    problems.push('The description must be a bounded string.');
  }
  const envValid = config.env === undefined || validateStringMap(config.env);
  const headersValid = config.headers === undefined || validateStringMap(config.headers);
  if (!envValid) problems.push('Environment entries must be a bounded string map.');
  if (!headersValid) problems.push('Header entries must be a bounded string map.');
  if (inferredTransport === 'stdio' && (config.headers !== undefined || config.oauth !== undefined)) {
    problems.push('Standard-input servers cannot declare HTTP headers or OAuth settings.');
  }
  if (inferredTransport === 'http'
    && (config.args !== undefined || config.cwd !== undefined || config.env !== undefined)) {
    problems.push('HTTP servers cannot declare command arguments, a working directory, or process environment.');
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') problems.push('Enabled must be a boolean.');
  if (config.exposure !== undefined && config.exposure !== 'direct'
    && config.exposure !== 'codemode' && config.exposure !== 'deferred') {
    problems.push('Exposure must be direct, codemode, or deferred.');
  }

  let oauthValid = true;
  if (config.oauth !== undefined) {
    oauthValid = isRecord(config.oauth)
      && Object.keys(config.oauth).length <= 3
      && Object.keys(config.oauth).every(key => ['clientId', 'clientSecret', 'scopes'].includes(key))
      && (config.oauth.clientId === undefined || boundedString(config.oauth.clientId))
      && (config.oauth.clientSecret === undefined || boundedString(config.oauth.clientSecret))
      && (config.oauth.scopes === undefined || (
        Array.isArray(config.oauth.scopes)
        && config.oauth.scopes.length <= MCP_CONFIG_MAX_COLLECTION_ENTRIES
        && config.oauth.scopes.every(boundedString)
      ));
    if (!oauthValid) problems.push('OAuth settings do not match the supported schema.');
  }

  const command = typeof config.command === 'string' ? maskedCommand(config.command) : undefined;
  const rawArgs = argsValid && Array.isArray(config.args) ? config.args as string[] : [];
  const args = rawArgs.map(maskedArgument);
  const env = envValid && isRecord(config.env) ? config.env as Record<string, string> : {};
  const headers = headersValid && isRecord(config.headers) ? config.headers as Record<string, string> : {};
  const resolvedFields = [
    ...Object.entries(env).map(([name, fieldValue]) => ({ field: `env.${escapedDisplay(name)}`, value: fieldValue })),
    ...Object.entries(headers).map(([name, fieldValue]) => ({ field: `headers.${escapedDisplay(name)}`, value: fieldValue })),
    ...(oauthValid && isRecord(config.oauth) && typeof config.oauth.clientSecret === 'string'
      ? [{ field: 'oauth.clientSecret', value: config.oauth.clientSecret }]
      : []),
  ];
  const commandFields = resolvedFields
    .filter(field => field.value.startsWith('!'))
    .map(field => field.field);
  const variableReferences = resolvedFields
    .filter(field => !field.value.startsWith('!'))
    .map(field => fieldReferences(field.field, field.value))
    .filter((entry): entry is McpVariableReference => Boolean(entry));

  return {
    rawName,
    info: {
      name: escapedDisplay(rawName),
      scope,
      sourcePath,
      valid: problems.length === 0,
      enabled: config.enabled !== false,
      exposure: config.exposure === 'codemode' || config.exposure === 'deferred'
        ? config.exposure
        : 'direct',
      ...(inferredTransport ? { transport: inferredTransport } : {}),
      ...(command ? { command: command.value } : {}),
      ...(rawArgs.length ? { args: args.map(item => item.value) } : {}),
      ...(url ? { url: url.value } : {}),
      envNames: Object.keys(env).map(name => escapedDisplay(name)),
      headerNames: Object.keys(headers).map(name => escapedDisplay(name)),
      commandFields,
      variableReferences,
      masked: Boolean(command?.masked || url?.masked || args.some(item => item.masked)),
      shadowedByProject: false,
      replacesGlobal: false,
      problems,
    },
  };
}

async function canonicalDirectory(input: string): Promise<string> {
  const resolved = path.resolve(input);
  try {
    const canonical = await realpath(resolved);
    const info = await lstat(canonical);
    if (!info.isDirectory()) throw new Error('MCP inventory roots must be directories.');
    return canonical;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return resolved;
    throw error;
  }
}

/**
 * Build a file-only MCP inventory. This function never expands environment
 * variables, executes command-backed values, creates credential stores, or
 * opens a transport. Project content stays closed until a persisted allow is
 * effective; a decision-free empty project is deliberately not sufficient.
 */
export async function inspectMcpConfig(
  options: InspectMcpConfigOptions,
): Promise<McpConfigInventory> {
  const agentDir = await canonicalDirectory(options.agentDir);
  const globalRead = await readRegularFile(path.join(agentDir, 'mcp.json'), 'global');
  const globalEntries = globalRead.text === undefined
    ? []
    : parseConfig(globalRead.info, globalRead.text)
      .map(([name, value]) => describeEntry(name, value, 'global', globalRead.info.path));

  let projectRead: FileReadResult | undefined;
  let projectEntries: ParsedEntry[] = [];
  let project: McpProjectInventory | undefined;
  if (options.cwd !== undefined) {
    const cwd = await canonicalDirectory(options.cwd);
    let status: Awaited<ReturnType<ProjectTrustManager['getStatus']>> | undefined;
    try {
      status = options.trustManager
        ? await options.trustManager.getStatus(cwd, { includeContextFiles: false })
        : undefined;
    } catch {
      status = undefined;
    }
    const trustError = !status || Boolean(status.decisionError);
    const contentTrusted = Boolean(status && !status.decisionError && status.decision === true);
    project = {
      cwd,
      contentTrusted,
      requiresTrust: status?.requiresTrust ?? true,
      decision: status?.decision ?? null,
      ...(status?.decisionPath ? { decisionPath: status.decisionPath } : {}),
      inherited: status?.inherited ?? false,
      trustError,
    };
    const currentProjectRead = await readProjectFile(cwd, contentTrusted, trustError);
    projectRead = currentProjectRead;
    projectEntries = currentProjectRead.text === undefined
      ? []
      : parseConfig(currentProjectRead.info, currentProjectRead.text)
        .map(([name, value]) => describeEntry(name, value, 'project', currentProjectRead.info.path));
  }

  const validProjectNames = new Set(projectEntries.filter(entry => entry.info.valid).map(entry => entry.rawName));
  const globalNames = new Set(globalEntries.map(entry => entry.rawName));
  for (const entry of globalEntries) entry.info.shadowedByProject = validProjectNames.has(entry.rawName);
  for (const entry of projectEntries) entry.info.replacesGlobal = globalNames.has(entry.rawName) && entry.info.valid;

  return {
    files: [globalRead.info, ...(projectRead ? [projectRead.info] : [])]
      .map(file => ({ ...file, path: escapedDisplay(file.path, 4_096) })),
    servers: [...globalEntries, ...projectEntries]
      .map(entry => ({ ...entry.info, sourcePath: escapedDisplay(entry.info.sourcePath, 4_096) })),
    ...(project ? { project } : {}),
  };
}
