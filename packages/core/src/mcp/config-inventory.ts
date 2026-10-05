import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectTrustManager } from '../security/project-trust.js';

/** Configuration bodies are bounded before parsing, including user-owned global configuration. */
export const MCP_CONFIG_MAX_BYTES = 1024 * 1024;
/** A bounded response prevents a repository from expanding a small file into a very large inventory. */
export const MCP_CONFIG_MAX_SERVERS = 200;
const MCP_CONFIG_MAX_DEPTH = 64;
const MCP_CONFIG_MAX_STRING_BYTES = 16 * 1024;
const MCP_CONFIG_MAX_COLLECTION_ENTRIES = 128;
export const MCP_CONFIG_MAX_MUTATIONS = 100;
const MCP_CONFIG_LOCK_TIMEOUT_MS = 2_000;
const MCP_CONFIG_LOCK_STALE_MS = 30_000;
const MCP_CONFIG_LOCK_HEARTBEAT_MS = 5_000;
/** Per-process key makes browser revisions useful for equality but not offline secret guessing. */
const MCP_CONFIG_REVISION_KEY = randomBytes(32);
const CONTROL_OR_HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u;
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
  /** Opaque keyed digest of exact bytes. Missing files and unreadable bodies omit it. */
  revision?: string;
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
  mode?: number;
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

function contentRevision(bytes: Uint8Array): string {
  return createHmac('sha256', MCP_CONFIG_REVISION_KEY).update(bytes).digest('hex');
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
    info.revision = contentRevision(bytes);
    return { info, text, mode: opened.mode & 0o777 };
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
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '$') continue;
    const next = value[index + 1];
    if (next === '$' || next === '!') {
      index++;
      continue;
    }
    let name: string | undefined;
    if (next === '{') {
      const end = value.indexOf('}', index + 2);
      if (end < 0) continue;
      const candidate = value.slice(index + 2, end);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(candidate)) name = candidate;
      index = end;
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(value.slice(index + 1));
      if (match) {
        name = match[0];
        index += match[0].length;
      }
    }
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

/**
 * Validate and redact one in-memory entry with the same schema used by the
 * file inventory. Import preview uses this internal Core contract so an
 * adapter can never drift into accepting or exposing a different shape.
 */
export function describeMcpConfigEntry(
  name: string,
  value: unknown,
): McpServerInventoryEntry {
  return describeEntry(name, value, 'global', '').info;
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

export type McpConfigMutationErrorCode =
  | 'invalid-request'
  | 'trust-required'
  | 'trust-unavailable'
  | 'unsafe-path'
  | 'invalid-config'
  | 'stale-revision'
  | 'target-not-found'
  | 'target-invalid'
  | 'target-conflict'
  | 'import-invalid'
  | 'fields-incomplete'
  | 'confirmation-required'
  | 'scope-blocked'
  | 'reserved-variable'
  | 'lock-timeout'
  | 'write-failed';

/** A fixed, value-free error safe for adapters to classify and present. */
export class McpConfigMutationError extends Error {
  readonly code: McpConfigMutationErrorCode;
  readonly uncertain: boolean;

  constructor(code: McpConfigMutationErrorCode, message: string, uncertain = false) {
    super(message);
    this.name = 'McpConfigMutationError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

export interface McpConfigMutationTarget {
  agentDir: string;
  scope: McpConfigScope;
  cwd?: string;
  trustManager?: ProjectTrustManager;
  /** Null means the caller observed no file. Existing files use the exact inventory revision. */
  expectedRevision: string | null;
}

export interface McpServerActivationMutation extends McpConfigMutationTarget {
  names: string[];
  enabled: boolean;
}

export type McpServerMutationOutcomeStatus = 'changed' | 'unchanged' | 'missing' | 'invalid';

export interface McpServerMutationOutcome {
  name: string;
  status: McpServerMutationOutcomeStatus;
}

export interface McpServerActivationResult {
  revision: string | null;
  changed: boolean;
  outcomes: McpServerMutationOutcome[];
}

export interface McpServerExposureMutation extends McpConfigMutationTarget {
  name: string;
  exposure: McpExposure;
}

export interface McpServerExposureResult {
  revision: string | null;
  changed: boolean;
}

export interface McpServerRemovalMutation extends McpConfigMutationTarget {
  name: string;
}

/** Internal insertion input used by Core import policy after it rebuilds an entry from pasted text. */
export interface McpServerInsertionMutation extends McpConfigMutationTarget {
  name: string;
  entry: unknown;
}

export interface McpServerInsertionResult {
  revision: string;
}

/** Internal replacement input used only after Core import policy rebuilds pasted text. */
export interface McpServerReplacementMutation extends McpServerInsertionMutation {
  targetName: string;
}

export interface McpServerReplacementResult {
  revision: string;
  changed: boolean;
}

/** Server-only undo material. Adapters must never serialize entry to an untrusted client. */
export interface McpRemovedServerRecord {
  scope: McpConfigScope;
  cwd?: string;
  name: string;
  index: number;
  entry: unknown;
  expectedRevision: string | null;
}

export interface McpServerRemovalResult {
  revision: string;
  removed: McpRemovedServerRecord;
}

export interface RestoreMcpServerOptions {
  agentDir: string;
  trustManager?: ProjectTrustManager;
  record: McpRemovedServerRecord;
}

export interface McpServerRestoreResult {
  revision: string;
}

interface MutationPath {
  scope: McpConfigScope;
  cwd?: string;
  directory: string;
  filePath: string;
}

interface MutableConfig {
  root: Record<string, unknown>;
  servers: Record<string, unknown>;
  indentation: string;
  eol: '\n' | '\r\n';
  mode?: number;
}

interface MutationResult<T> {
  target: MutationPath;
  revision: string | null;
  changed: boolean;
  value: T;
}

function mutationError(
  code: McpConfigMutationErrorCode,
  message: string,
  uncertain = false,
): McpConfigMutationError {
  return new McpConfigMutationError(code, message, uncertain);
}

function validateExpectedRevision(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) {
    throw mutationError('invalid-request', 'The MCP configuration revision is invalid.');
  }
}

function validateMutationName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !validName(value)) {
    throw mutationError('invalid-request', 'The MCP server selector is invalid.');
  }
}

async function canonicalExistingDirectory(input: string): Promise<string> {
  try {
    const canonical = await realpath(path.resolve(input));
    const info = await lstat(canonical);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw mutationError('unsafe-path', 'The MCP project root is not a safe directory.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof McpConfigMutationError) throw error;
    throw mutationError('unsafe-path', 'The MCP project root is not a safe directory.');
  }
}

async function canonicalAgentDirectory(input: string): Promise<string> {
  const resolved = path.resolve(input);
  try {
    const canonical = await realpath(resolved);
    const info = await lstat(canonical);
    if (!info.isDirectory()) throw mutationError('unsafe-path', 'The MCP data root is not a safe directory.');
    return canonical;
  } catch (error) {
    if (error instanceof McpConfigMutationError) throw error;
    if (errorCode(error) !== 'ENOENT') {
      throw mutationError('unsafe-path', 'The MCP data root is not a safe directory.');
    }
  }

  try {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const canonical = await realpath(resolved);
    const info = await lstat(canonical);
    if (!info.isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw mutationError('unsafe-path', 'The MCP data root cannot be created safely.');
  }
}

async function requireProjectMutationTrust(
  cwd: string,
  trustManager: ProjectTrustManager | undefined,
): Promise<void> {
  if (!trustManager) {
    throw mutationError('trust-unavailable', 'Project trust is unavailable for this MCP mutation.');
  }
  let status: Awaited<ReturnType<ProjectTrustManager['getStatus']>>;
  try {
    status = await trustManager.getStatus(cwd, { includeContextFiles: false });
  } catch {
    throw mutationError('trust-unavailable', 'Project trust is unavailable for this MCP mutation.');
  }
  if (status.decisionError) {
    throw mutationError('trust-unavailable', 'Project trust is unavailable for this MCP mutation.');
  }
  if (status.decision !== true) {
    throw mutationError('trust-required', 'A persisted project allow is required for this MCP mutation.');
  }
}

async function ensureMutationDirectory(directory: string, project: boolean): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw mutationError('unsafe-path', 'The MCP configuration directory is not safe.');
    }
    return;
  } catch (error) {
    if (error instanceof McpConfigMutationError) throw error;
    if (errorCode(error) !== 'ENOENT') {
      throw mutationError('unsafe-path', 'The MCP configuration directory is not safe.');
    }
  }

  try {
    await mkdir(directory, { recursive: !project, mode: project ? 0o755 : 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe directory');
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw mutationError('unsafe-path', 'The MCP configuration directory cannot be created safely.');
    }
    const info = await lstat(directory).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      throw mutationError('unsafe-path', 'The MCP configuration directory is not safe.');
    }
  }
}

async function resolveMutationPath(options: McpConfigMutationTarget): Promise<MutationPath> {
  if (options.scope !== 'global' && options.scope !== 'project') {
    throw mutationError('invalid-request', 'The MCP configuration scope is invalid.');
  }
  validateExpectedRevision(options.expectedRevision);

  if (options.scope === 'global') {
    const directory = await canonicalAgentDirectory(options.agentDir);
    await ensureMutationDirectory(directory, false);
    return { scope: 'global', directory, filePath: path.join(directory, 'mcp.json') };
  }
  if (typeof options.cwd !== 'string' || !options.cwd) {
    throw mutationError('invalid-request', 'A project is required for this MCP mutation.');
  }
  const cwd = await canonicalExistingDirectory(options.cwd);
  await requireProjectMutationTrust(cwd, options.trustManager);
  const directory = path.join(cwd, '.ai-harness');
  await ensureMutationDirectory(directory, true);
  return { scope: 'project', cwd, directory, filePath: path.join(directory, 'mcp.json') };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function acquireMcpConfigLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + MCP_CONFIG_LOCK_TIMEOUT_MS;

  while (true) {
    let candidateHandle;
    let candidateIdentity: { dev: number; ino: number } | undefined;
    try {
      const handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600);
      candidateHandle = handle;
      const opened = await handle.stat();
      candidateIdentity = opened;
      await handle.writeFile(`${process.pid}:${randomUUID()}\n`, 'utf8');
      await handle.sync();
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => undefined);
      }, MCP_CONFIG_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        const current = await lstat(lockPath).catch(() => undefined);
        await handle.close().catch(() => undefined);
        if (current && !current.isSymbolicLink() && sameIdentity(opened, current)) {
          await unlink(lockPath).catch(() => undefined);
        }
      };
    } catch (error) {
      if (candidateHandle) {
        await candidateHandle.close().catch(() => undefined);
        const current = await lstat(lockPath).catch(() => undefined);
        if (candidateIdentity && current && !current.isSymbolicLink()
          && sameIdentity(candidateIdentity, current)) {
          await unlink(lockPath).catch(() => undefined);
        }
      }
      if (errorCode(error) !== 'EEXIST') {
        throw mutationError('lock-timeout', 'The MCP configuration lock cannot be acquired.');
      }
      const existing = await lstat(lockPath).catch(() => undefined);
      if (!existing || existing.isSymbolicLink() || !existing.isFile()) {
        throw mutationError('unsafe-path', 'The MCP configuration lock path is not safe.');
      }
      if (Date.now() - existing.mtimeMs > MCP_CONFIG_LOCK_STALE_MS) {
        const current = await lstat(lockPath).catch(() => undefined);
        if (current && !current.isSymbolicLink() && sameIdentity(existing, current)) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw mutationError('lock-timeout', 'The MCP configuration is busy.');
      }
      await sleep(20 + Math.floor(Math.random() * 20));
    }
  }
}

function parseMutableConfig(text: string | undefined, mode: number | undefined): MutableConfig {
  if (text === undefined) {
    const servers: Record<string, unknown> = {};
    return { root: { version: 1, mcpServers: servers }, servers, indentation: '  ', eol: '\n' };
  }

  const jsonc = normalizeJsonc(text);
  if (jsonc.tooDeep) {
    throw mutationError('invalid-config', 'The MCP configuration exceeds its nesting limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonc.normalized ?? '') as unknown;
  } catch {
    throw mutationError('invalid-config', 'The MCP configuration is not valid JSON or JSONC.');
  }
  if (!isRecord(parsed) || (parsed.version !== undefined && parsed.version !== 1)) {
    throw mutationError('invalid-config', 'The MCP configuration shape is invalid.');
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw mutationError('invalid-config', 'The MCP server collection is invalid.');
  }
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  if (Object.keys(servers).length > MCP_CONFIG_MAX_SERVERS) {
    throw mutationError('invalid-config', 'The MCP configuration contains too many servers.');
  }
  if (parsed.mcpServers === undefined) parsed.mcpServers = servers;
  const indentationMatch = text.match(/(?:^|\r?\n)([\t ]{1,10})"/u);
  return {
    root: parsed,
    servers,
    indentation: indentationMatch?.[1] ?? '  ',
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    ...(mode === undefined ? {} : { mode }),
  };
}

function serializeMutableConfig(config: MutableConfig): Buffer {
  const serialized = `${JSON.stringify(config.root, null, config.indentation).replace(/\n/gu, config.eol)}${config.eol}`;
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length > MCP_CONFIG_MAX_BYTES) {
    throw mutationError('invalid-config', 'The MCP configuration would exceed its size limit.');
  }
  return bytes;
}

async function assertDirectoryIdentity(
  directory: string,
  expected: { dev: number; ino: number },
): Promise<void> {
  const current = await lstat(directory).catch(() => undefined);
  if (!current || current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(expected, current)) {
    throw mutationError('unsafe-path', 'The MCP configuration directory changed during the mutation.');
  }
}

async function atomicWriteMcpConfig(
  target: MutationPath,
  parentIdentity: { dev: number; ino: number },
  bytes: Buffer,
  existingMode: number | undefined,
): Promise<string> {
  const mode = target.scope === 'global' ? 0o600 : (existingMode ?? 0o644);
  const temporaryPath = path.join(target.directory, `.mcp.json.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let renameAttempted = false;
  let renameCompleted = false;
  try {
    handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    const temporaryIdentity = await handle.stat();
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await assertDirectoryIdentity(target.directory, parentIdentity);
    renameAttempted = true;
    await rename(temporaryPath, target.filePath);
    renameCompleted = true;
    const committed = await lstat(target.filePath);
    const openedAfterRename = await handle.stat();
    if (committed.isSymbolicLink() || !committed.isFile()
      || !sameIdentity(temporaryIdentity, openedAfterRename)
      || !sameIdentity(temporaryIdentity, committed)) {
      throw mutationError('write-failed', 'The MCP atomic replacement identity could not be verified.', true);
    }
    await handle.close();
    handle = undefined;
    const directoryHandle = await open(target.directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await assertDirectoryIdentity(target.directory, parentIdentity);
    return contentRevision(bytes);
  } catch (error) {
    if (error instanceof McpConfigMutationError && !renameCompleted) throw error;
    throw mutationError(
      'write-failed',
      'The MCP configuration could not be committed atomically.',
      renameAttempted || renameCompleted,
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function classifyReadFailure(file: McpConfigFileInventory): McpConfigMutationError {
  if (file.problems.some(item => item.reason === 'unsafe-link' || item.reason === 'not-regular')) {
    return mutationError('unsafe-path', 'The MCP configuration path is not safe to mutate.');
  }
  return mutationError('invalid-config', 'The MCP configuration cannot be mutated safely.');
}

async function mutateMcpConfig<T>(
  options: McpConfigMutationTarget,
  apply: (config: MutableConfig) => { changed: boolean; value: T },
): Promise<MutationResult<T>> {
  const target = await resolveMutationPath(options);
  const release = await acquireMcpConfigLock(target.filePath);
  try {
    if (target.scope === 'project') {
      await requireProjectMutationTrust(target.cwd!, options.trustManager);
    }
    const parent = await lstat(target.directory);
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw mutationError('unsafe-path', 'The MCP configuration directory is not safe.');
    }
    const read = await readRegularFile(target.filePath, target.scope, {
      dev: parent.dev,
      ino: parent.ino,
      path: target.directory,
    });
    if (read.info.problems.length > 0) throw classifyReadFailure(read.info);
    const currentRevision = read.info.revision ?? null;
    if (currentRevision !== options.expectedRevision) {
      throw mutationError('stale-revision', 'The MCP configuration changed; reload it before retrying.');
    }
    const config = parseMutableConfig(read.text, read.mode);
    const outcome = apply(config);
    if (!outcome.changed) {
      return { target, revision: currentRevision, changed: false, value: outcome.value };
    }
    if (target.scope === 'project') {
      await requireProjectMutationTrust(target.cwd!, options.trustManager);
    }
    const bytes = serializeMutableConfig(config);
    const revision = await atomicWriteMcpConfig(target, parent, bytes, config.mode);
    return { target, revision, changed: true, value: outcome.value };
  } finally {
    await release();
  }
}

/** Enable or disable one bounded set in one lock and at most one atomic file replacement. */
export async function setMcpServersEnabled(
  options: McpServerActivationMutation,
): Promise<McpServerActivationResult> {
  if (typeof options.enabled !== 'boolean' || !Array.isArray(options.names)
    || options.names.length < 1 || options.names.length > MCP_CONFIG_MAX_MUTATIONS) {
    throw mutationError('invalid-request', 'The MCP activation request is invalid or too large.');
  }
  const names = new Set<string>();
  for (const name of options.names) {
    validateMutationName(name);
    if (names.has(name)) throw mutationError('invalid-request', 'MCP server selectors must be unique.');
    names.add(name);
  }

  const result = await mutateMcpConfig(options, config => {
    let changed = false;
    const outcomes: McpServerMutationOutcome[] = [];
    for (const name of names) {
      if (!Object.hasOwn(config.servers, name)) {
        outcomes.push({ name, status: 'missing' });
        continue;
      }
      const entry = config.servers[name];
      if (!describeEntry(name, entry, options.scope, '').info.valid || !isRecord(entry)) {
        outcomes.push({ name, status: 'invalid' });
        continue;
      }
      const currentlyEnabled = entry.enabled !== false;
      if (currentlyEnabled === options.enabled) {
        outcomes.push({ name, status: 'unchanged' });
        continue;
      }
      if (options.enabled) delete entry.enabled;
      else entry.enabled = false;
      changed = true;
      outcomes.push({ name, status: 'changed' });
    }
    return { changed, value: outcomes };
  });
  return { revision: result.revision, changed: result.changed, outcomes: result.value };
}

/** Change one valid entry's local tool exposure without resolving or executing it. */
export async function setMcpServerExposure(
  options: McpServerExposureMutation,
): Promise<McpServerExposureResult> {
  validateMutationName(options.name);
  if (options.exposure !== 'direct' && options.exposure !== 'codemode'
    && options.exposure !== 'deferred') {
    throw mutationError('invalid-request', 'The MCP server exposure is invalid.');
  }

  const result = await mutateMcpConfig(options, config => {
    if (!Object.hasOwn(config.servers, options.name)) {
      throw mutationError('target-not-found', 'The MCP server no longer exists.');
    }
    const entry = config.servers[options.name];
    if (!isRecord(entry) || !describeEntry(options.name, entry, options.scope, '').info.valid) {
      throw mutationError('target-invalid', 'The MCP server entry is invalid and was not changed.');
    }
    const current = entry.exposure === 'codemode' || entry.exposure === 'deferred'
      ? entry.exposure
      : 'direct';
    if (current === options.exposure) {
      return { changed: false, value: undefined };
    }
    if (options.exposure === 'direct') delete entry.exposure;
    else entry.exposure = options.exposure;
    return { changed: true, value: undefined };
  });
  return { revision: result.revision, changed: result.changed };
}

/**
 * Append one already-policy-checked Core entry under the same lock and atomic
 * replacement as every other local mutation. This helper is intentionally
 * not re-exported from the public MCP barrel: import callers must go through
 * config-import's text re-parse and confirmation policy.
 */
export async function insertMcpServerEntry(
  options: McpServerInsertionMutation,
): Promise<McpServerInsertionResult> {
  validateMutationName(options.name);
  if (!isRecord(options.entry)
    || !describeEntry(options.name, options.entry, options.scope, '').info.valid) {
    throw mutationError('invalid-request', 'The MCP server to import is invalid.');
  }
  const entry = structuredClone(options.entry);
  const result = await mutateMcpConfig(options, config => {
    if (Object.hasOwn(config.servers, options.name)) {
      throw mutationError('target-conflict', 'The MCP server name is already configured.');
    }
    const entries = Object.entries(config.servers);
    if (entries.length >= MCP_CONFIG_MAX_SERVERS) {
      throw mutationError('target-conflict', 'The MCP server collection is full.');
    }
    entries.push([options.name, entry]);
    const inserted = Object.fromEntries(entries);
    config.root.mcpServers = inserted;
    config.servers = inserted;
    return { changed: true, value: undefined };
  });
  if (!result.revision) throw mutationError('write-failed', 'The MCP configuration revision is unavailable.', true);
  return { revision: result.revision };
}

/**
 * Replace one valid entry in place after import policy has rebuilt and checked
 * its successor. This helper remains outside the public MCP barrel so callers
 * cannot bypass text re-parsing, secret policy, or confirmation checks.
 */
export async function replaceMcpServerEntry(
  options: McpServerReplacementMutation,
): Promise<McpServerReplacementResult> {
  validateMutationName(options.targetName);
  validateMutationName(options.name);
  if (!isRecord(options.entry)
    || !describeEntry(options.name, options.entry, options.scope, '').info.valid) {
    throw mutationError('invalid-request', 'The replacement MCP server is invalid.');
  }
  const entry = structuredClone(options.entry);
  const result = await mutateMcpConfig(options, config => {
    if (!Object.hasOwn(config.servers, options.targetName)) {
      throw mutationError('target-not-found', 'The MCP server no longer exists.');
    }
    const existing = config.servers[options.targetName];
    if (!isRecord(existing)
      || !describeEntry(options.targetName, existing, options.scope, '').info.valid) {
      throw mutationError('target-invalid', 'The MCP server entry is invalid and was not replaced.');
    }
    if (options.name !== options.targetName && Object.hasOwn(config.servers, options.name)) {
      throw mutationError('target-conflict', 'The MCP server name is already configured.');
    }
    if (options.name === options.targetName && JSON.stringify(existing) === JSON.stringify(entry)) {
      return { changed: false, value: undefined };
    }
    const replaced = Object.fromEntries(Object.entries(config.servers).map(([name, value]) => (
      name === options.targetName ? [options.name, entry] : [name, value]
    )));
    config.root.mcpServers = replaced;
    config.servers = replaced;
    return { changed: true, value: undefined };
  });
  if (!result.revision) throw mutationError('write-failed', 'The MCP configuration revision is unavailable.', true);
  return { revision: result.revision, changed: result.changed };
}

/** Remove one literal entry. The returned raw record is server-only undo material. */
export async function removeMcpServer(
  options: McpServerRemovalMutation,
): Promise<McpServerRemovalResult> {
  validateMutationName(options.name);
  const result = await mutateMcpConfig(options, config => {
    if (!Object.hasOwn(config.servers, options.name)) {
      throw mutationError('target-not-found', 'The MCP server no longer exists.');
    }
    const entries = Object.entries(config.servers);
    const index = entries.findIndex(([name]) => name === options.name);
    const entry = config.servers[options.name];
    if (!isRecord(entry) || !describeEntry(options.name, entry, options.scope, '').info.valid) {
      throw mutationError('target-invalid', 'The MCP server entry is invalid and was not removed.');
    }
    delete config.servers[options.name];
    return { changed: true, value: { entry, index } };
  });
  if (!result.revision) throw mutationError('write-failed', 'The MCP configuration revision is unavailable.', true);
  return {
    revision: result.revision,
    removed: {
      scope: options.scope,
      ...(result.target.scope === 'project' && result.target.cwd ? { cwd: result.target.cwd } : {}),
      name: options.name,
      index: result.value.index,
      entry: result.value.entry,
      expectedRevision: result.revision,
    },
  };
}

/** Restore a one-time server-side removal record at its bounded original position. */
export async function restoreMcpServer(
  options: RestoreMcpServerOptions,
): Promise<McpServerRestoreResult> {
  const record = options.record;
  validateMutationName(record.name);
  if (!Number.isSafeInteger(record.index) || record.index < 0
    || (record.scope !== 'global' && record.scope !== 'project')) {
    throw mutationError('invalid-request', 'The MCP restoration record is invalid.');
  }
  const target: McpConfigMutationTarget = {
    agentDir: options.agentDir,
    scope: record.scope,
    expectedRevision: record.expectedRevision,
    ...(record.scope === 'project' && record.cwd ? { cwd: record.cwd } : {}),
    ...(options.trustManager ? { trustManager: options.trustManager } : {}),
  };
  const result = await mutateMcpConfig(target, config => {
    if (Object.hasOwn(config.servers, record.name)) {
      throw mutationError('target-conflict', 'The MCP server name is already configured.');
    }
    const entries = Object.entries(config.servers);
    if (entries.length >= MCP_CONFIG_MAX_SERVERS) {
      throw mutationError('target-conflict', 'The MCP server collection is full.');
    }
    entries.splice(Math.min(record.index, entries.length), 0, [record.name, record.entry]);
    const restored = Object.fromEntries(entries);
    // Replace the collection rather than assigning attacker-controlled names such as "__proto__".
    config.root.mcpServers = restored;
    config.servers = restored;
    return { changed: true, value: undefined };
  });
  if (!result.revision) throw mutationError('write-failed', 'The MCP configuration revision is unavailable.', true);
  return { revision: result.revision };
}
