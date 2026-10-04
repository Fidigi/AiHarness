import {
  describeMcpConfigEntry,
  type McpConfigScope,
  type McpExposure,
  type McpTransportKind,
  type McpVariableReference,
} from './config-inventory.js';
import { splitMcpShellWords } from './import-shell.js';

/** Paste bodies are intentionally smaller than configuration files. */
export const MCP_IMPORT_MAX_BYTES = 256 * 1024;
/** One preview remains readable and cannot amplify a compact request indefinitely. */
export const MCP_IMPORT_MAX_SERVERS = 20;
export const MCP_IMPORT_MAX_FIELDS = 128;

/** Server-owning credentials must never be delegated to an imported server. */
export const MCP_RESERVED_VARIABLE_NAMES = [
  'AI_HARNESS_ADMIN_TOKEN',
  'AI_HARNESS_AUTH_TOKEN',
  'AI_HARNESS_MASTER_KEY',
] as const;

export type McpImportSyntax = 'foreign' | 'aiharness';

export type McpImportSource =
  | 'url'
  | 'command-line'
  | 'aiharness-command'
  | 'claude-command'
  | 'codex-command'
  | 'gemini-command'
  | 'vscode-command'
  | 'mcp-json'
  | 'vscode-json'
  | 'zed-json'
  | 'opencode-json'
  | 'server-object'
  | 'server-map'
  | 'cursor-install-link'
  | 'vscode-install-link'
  | 'visual-studio-install-link'
  | 'copilot-app-install-link';

export type McpImportNoteSeverity = 'error' | 'warning' | 'info';

export type McpImportNoteCode =
  | 'command-value'
  | 'dropped-properties'
  | 'empty-input'
  | 'host-variable-confirmation'
  | 'insecure-http'
  | 'input-too-large'
  | 'install-link-invalid'
  | 'invalid-entry'
  | 'invalid-json'
  | 'literal-escaped'
  | 'literal-secret'
  | 'management-command'
  | 'missing-value'
  | 'missing-variable'
  | 'name-derived'
  | 'name-sanitized'
  | 'name-taken'
  | 'no-server'
  | 'reserved-variable'
  | 'too-deep'
  | 'too-many-fields'
  | 'too-many-servers'
  | 'unrecognized-input'
  | 'unsafe-shell'
  | 'unsupported-reference'
  | 'unsupported-scheme'
  | 'unsupported-transport'
  | 'userinfo-moved';

const NOTE_SEVERITY: Record<McpImportNoteCode, McpImportNoteSeverity> = {
  'command-value': 'warning',
  'dropped-properties': 'warning',
  'empty-input': 'error',
  'host-variable-confirmation': 'warning',
  'insecure-http': 'warning',
  'input-too-large': 'error',
  'install-link-invalid': 'error',
  'invalid-entry': 'error',
  'invalid-json': 'error',
  'literal-escaped': 'info',
  'literal-secret': 'warning',
  'management-command': 'error',
  'missing-value': 'warning',
  'missing-variable': 'warning',
  'name-derived': 'info',
  'name-sanitized': 'info',
  'name-taken': 'warning',
  'no-server': 'error',
  'reserved-variable': 'error',
  'too-deep': 'error',
  'too-many-fields': 'error',
  'too-many-servers': 'error',
  'unrecognized-input': 'error',
  'unsafe-shell': 'error',
  'unsupported-reference': 'warning',
  'unsupported-scheme': 'error',
  'unsupported-transport': 'error',
  'userinfo-moved': 'info',
};

export interface McpImportNote {
  code: McpImportNoteCode;
  severity: McpImportNoteSeverity;
  /** Technical field label only; source values and excerpts are never returned. */
  field?: string;
  count?: number;
}

export interface McpImportFieldPreview {
  id: string;
  field: string;
  kind: 'secret' | 'text';
  required: boolean;
  /** Only resolved env/header/OAuth secret values can safely store a reference. */
  canReference: boolean;
}

export type McpImportVariableAvailability = 'available' | 'missing' | 'reserved';

export interface McpImportVariablePreview {
  field: string;
  name: string;
  availability: McpImportVariableAvailability;
  /** Headers and OAuth client secrets send a host value to another endpoint. */
  remote: boolean;
  confirmationRequired: boolean;
}

export interface McpImportPersistedPreview {
  valid: boolean;
  enabled: boolean;
  exposure: McpExposure;
  transport?: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  envNames: string[];
  headerNames: string[];
  oauthFields: string[];
  commandFields: string[];
  variableReferences: McpVariableReference[];
  masked: boolean;
}

export type McpImportScopeBlockReason =
  | 'config-unavailable'
  | 'invalid-entry'
  | 'literal-secret'
  | 'name-taken'
  | 'no-project'
  | 'reserved-variable'
  | 'trust-required'
  | 'trust-unavailable';

export type McpImportScopeConfirmation = 'literal-secret' | 'remote-host-variable';

export interface McpImportScopePreview {
  allowed: boolean;
  reasons: McpImportScopeBlockReason[];
  /** A future write must obtain these explicit confirmations for this scope. */
  confirmations: McpImportScopeConfirmation[];
}

export interface McpImportEntryPreview {
  name: string;
  source: McpImportSource;
  scopeHint?: McpConfigScope;
  complete: boolean;
  persisted: McpImportPersistedPreview;
  fields: McpImportFieldPreview[];
  variables: McpImportVariablePreview[];
  literalSecretFields: string[];
  scopes: Record<McpConfigScope, McpImportScopePreview>;
  notes: McpImportNote[];
}

export interface McpImportPreview {
  ok: boolean;
  entries: McpImportEntryPreview[];
  notes: McpImportNote[];
}

export interface McpImportScopeContext {
  available: boolean;
  unavailableReason?: Extract<
    McpImportScopeBlockReason,
    'config-unavailable' | 'no-project' | 'trust-required' | 'trust-unavailable'
  >;
  names?: Iterable<string>;
}

export interface PreviewMcpImportOptions {
  syntax?: McpImportSyntax;
  /** Names only. Core never needs environment values to produce a preview. */
  availableVariableNames?: Iterable<string>;
  scopes?: Partial<Record<McpConfigScope, McpImportScopeContext>>;
}

interface ImportCandidate {
  source: McpImportSource;
  name?: string;
  config: Record<string, unknown>;
  grammar: ValueGrammar;
  scopeHint?: McpConfigScope;
  fields: McpImportFieldPreview[];
  notes: McpImportNote[];
}

type ValueGrammar = 'aiharness' | 'foreign' | 'gemini' | 'shell';

type ReadResult =
  | { candidates: ImportCandidate[]; notes: McpImportNote[] }
  | { error: McpImportNote };

const MAX_DEPTH = 64;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_COLLECTION_ENTRIES = 128;
const CONTROL_OR_HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u;
const PASTE_UNSAFE_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const IMPORT_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const RESERVED_VARIABLES = new Set<string>(MCP_RESERVED_VARIABLE_NAMES);

function note(code: McpImportNoteCode, details: Omit<McpImportNote, 'code' | 'severity'> = {}): McpImportNote {
  return { code, severity: NOTE_SEVERITY[code], ...details };
}

function addNote(notes: McpImportNote[], value: McpImportNote): void {
  const existing = notes.find(item => item.code === value.code && item.field === value.field);
  if (existing && value.code === 'dropped-properties') {
    existing.count = (existing.count ?? 1) + (value.count ?? 1);
    return;
  }
  if (!existing || existing.count !== value.count) notes.push(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string'
    && !CONTROL_OR_HIDDEN.test(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES;
}

function safeNamePart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '')
    .slice(0, 64)
    .replace(/[-_]+$/gu, '');
}

function normalizePaste(text: string): string {
  let input = text.replace(/^\ufeff/u, '').replace(/\u00a0/gu, ' ').trim();
  const fenced = /```[^\n]*\n([\s\S]*?)(?:```|$)/u.exec(input);
  if (fenced) input = fenced[1]!.trim();
  else if (/^`[^`\n]+`$/u.test(input)) input = input.slice(1, -1).trim();
  const markdownLink = input.startsWith('[') ? /\]\(([^()\s]+)\)\s*$/u.exec(input) : null;
  if (markdownLink) input = markdownLink[1]!;
  if (/^<\S+>$/u.test(input)) input = input.slice(1, -1);
  return input;
}

function normalizeCommandLine(text: string): string {
  return text
    .replace(/^(?:\$|%|>|❯|PS [^\n>]*>)[ \t]+/u, '')
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/gu, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/gu, "'")
    .replace(/(^|\s)[\u2013\u2014](?=\S)/gu, '$1--')
    .replace(/(^|\s)[\u2013\u2014](?=\s|$)/gu, '$1--');
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
    if (character === '"') inString = true;
    else if (character === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      lineComment = true;
      index++;
    } else if (character === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      blockComment = true;
      index++;
    } else if (character === '{' || character === '[') {
      depth++;
      if (depth > MAX_DEPTH) tooDeep = true;
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
    let cursor = index + 1;
    while (cursor < output.length && /\s/u.test(output[cursor]!)) cursor++;
    if (output[cursor] === '}' || output[cursor] === ']') output[index] = ' ';
  }
  return { normalized: output.join(''), tooDeep };
}

function jsonBoundProblem(value: unknown): McpImportNoteCode | undefined {
  if (typeof value === 'string') return boundedString(value) ? undefined : 'invalid-entry';
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ENTRIES) return 'too-many-fields';
    for (const item of value) {
      const problem = jsonBoundProblem(item);
      if (problem) return problem;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_COLLECTION_ENTRIES) return 'too-many-fields';
  for (const [key, item] of entries) {
    if (!boundedString(key)) return 'invalid-entry';
    const problem = jsonBoundProblem(item);
    if (problem) return problem;
  }
  return undefined;
}

function parseJson(text: string): { value?: unknown; error?: McpImportNote } {
  const jsonc = normalizeJsonc(text);
  if (jsonc.tooDeep) return { error: note('too-deep') };
  try {
    const value = JSON.parse(jsonc.normalized ?? '') as unknown;
    const bounds = jsonBoundProblem(value);
    return bounds ? { error: note(bounds) } : { value };
  } catch {
    return { error: note('invalid-json') };
  }
}

function transportType(value: unknown): 'stdio' | 'http' | 'sse' | 'ws' | 'unknown' | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return 'unknown';
  switch (value.toLowerCase().replace(/[-_]/gu, '')) {
    case 'stdio':
    case 'local': return 'stdio';
    case 'http':
    case 'streamablehttp':
    case 'remote': return 'http';
    case 'sse': return 'sse';
    case 'ws':
    case 'wss':
    case 'websocket': return 'ws';
    default: return 'unknown';
  }
}

function sourceGrammar(source: McpImportSource, syntax: McpImportSyntax, entry: Record<string, unknown>): ValueGrammar {
  if (source === 'aiharness-command' || syntax === 'aiharness') return 'aiharness';
  if (source === 'gemini-command' || ['httpUrl', 'includeTools', 'excludeTools', 'trust'].some(key => key in entry)) {
    return 'gemini';
  }
  if (source === 'command-line') return 'shell';
  return 'foreign';
}

function executableName(value: string): string {
  return (value.trim().split(/[\\/]/u).pop() ?? '').replace(/\.(?:bat|cmd|exe|ps1)$/iu, '').toLowerCase();
}

/** Refuse command strings whose eventual direct spawn would delegate parsing to a shell evaluator. */
function usesShellEvaluator(config: Record<string, unknown>): boolean {
  if (typeof config.command !== 'string') return false;
  const args = Array.isArray(config.args)
    ? config.args.filter((value): value is string => typeof value === 'string')
    : [];
  const inline = config.command.trim().split(/\s+/u);
  const words = inline.length > 1 && [
    'bash', 'cmd', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh',
  ].includes(executableName(inline[0]!))
    ? [...inline, ...args]
    : [config.command, ...args];
  for (let index = 0; index < words.length; index++) {
    const executable = executableName(words[index]!);
    const rawRest = words.slice(index + 1);
    const rest = rawRest.map(value => value.toLowerCase());
    if (executable === 'env' && rawRest.some(value => value === '-S'
      || value === '--split-string' || value.startsWith('--split-string='))) return true;
    if (['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'].includes(executable)
      && rest.some(value => value === '--command' || value.startsWith('--command=')
        || /^-[a-z]*c[a-z]*$/iu.test(value))) return true;
    if (executable === 'cmd' && rest.some(value => /^\/[ck]/iu.test(value))) return true;
    if (['powershell', 'pwsh'].includes(executable) && rest.some(value => {
      const normalized = value.replace(/^\//u, '-');
      if (!normalized.startsWith('-')) return false;
      const option = normalized.replace(/[=:][\s\S]*$/u, '');
      const name = option.replace(/^-{1,2}/u, '');
      return name.length > 0
        && ('command'.startsWith(name) || 'commandwithargs'.startsWith(name)
          || 'encodedcommand'.startsWith(name));
    })) return true;
  }
  return false;
}

function usesMcpManagementCommand(config: Record<string, unknown>): boolean {
  if (typeof config.command !== 'string') return false;
  const args = Array.isArray(config.args)
    ? config.args.filter((value): value is string => typeof value === 'string')
    : [];
  const inline = config.command.trim().split(/\s+/u);
  const words = inline.length > 1 ? [...inline, ...args] : [config.command, ...args];
  const clientWords = clientCommandWords(words);
  const program = executableName(clientWords[0] ?? '');
  if (['code', 'code-insiders', 'codium', 'cursor'].includes(program)
    && clientWords.some(word => word === '--add-mcp' || word.startsWith('--add-mcp='))) return true;
  return ['claude', 'codex', 'gemini', 'ai-harness', 'aih'].includes(program)
    && clientWords[1] === 'mcp';
}

function commandBackedProblem(value: string): 'management-command' | 'unsafe-shell' | undefined {
  if (!value.startsWith('!')) return undefined;
  const split = splitMcpShellWords(value.slice(1).trim());
  if (!split.ok || split.words.length === 0) return 'unsafe-shell';
  const config = {
    command: split.words[0],
    ...(split.words.length > 1 ? { args: split.words.slice(1) } : {}),
  };
  if (usesShellEvaluator(config)) return 'unsafe-shell';
  return usesMcpManagementCommand(config) ? 'management-command' : undefined;
}

function stringMap(value: unknown): { entries: Array<[string, string]>; dropped: number; invalid: boolean } {
  if (value === undefined) return { entries: [], dropped: 0, invalid: false };
  if (!isRecord(value) || Object.keys(value).length > MAX_COLLECTION_ENTRIES) {
    return { entries: [], dropped: 0, invalid: true };
  }
  const entries: Array<[string, string]> = [];
  let dropped = 0;
  for (const [key, item] of Object.entries(value)) {
    if (!key || Buffer.byteLength(key, 'utf8') > 256 || CONTROL_OR_HIDDEN.test(key)) {
      dropped++;
      continue;
    }
    if (boundedString(item)) entries.push([key, item]);
    else if (typeof item === 'number' || typeof item === 'boolean') entries.push([key, String(item)]);
    else dropped++;
  }
  return { entries, dropped, invalid: false };
}

function stringArray(value: unknown): { values: string[]; invalid: boolean } {
  if (value === undefined) return { values: [], invalid: false };
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ENTRIES || !value.every(boundedString)) {
    return { values: [], invalid: true };
  }
  return { values: value as string[], invalid: false };
}

function mappedCandidate(
  name: string | undefined,
  rawEntry: unknown,
  source: McpImportSource,
  syntax: McpImportSyntax,
): ImportCandidate | McpImportNote {
  if (!isRecord(rawEntry)) return note('invalid-entry');
  const entry = rawEntry;
  const notes: McpImportNote[] = [];
  const fields: McpImportFieldPreview[] = [];
  const used = new Set<string>();
  const take = (key: string): unknown => {
    used.add(key);
    return entry[key];
  };
  const ownName = take('name');
  const candidateName = name ?? (typeof ownName === 'string' ? ownName : undefined);
  const rawType = [take('type'), take('transportType'), take('transport')]
    .find(value => value !== undefined);
  if ('tcp' in entry) {
    take('tcp');
    return note('unsupported-transport');
  }
  const type = transportType(rawType);
  const rawCommand = take('command');
  const rawUrl = [take('httpUrl'), take('url'), take('serverUrl')]
    .find((value): value is string => boundedString(value));
  const commandPresent = boundedString(rawCommand) || Array.isArray(rawCommand) || isRecord(rawCommand);
  const urlPresent = rawUrl !== undefined;
  if (type === 'sse' || type === 'ws' || type === 'unknown') return note('unsupported-transport');
  if (commandPresent && urlPresent && type === undefined) return note('invalid-entry');
  const selected = type ?? (urlPresent ? 'http' : commandPresent ? 'stdio' : undefined);
  if (selected === 'stdio' && urlPresent) addNote(notes, note('dropped-properties', { count: 1 }));
  if (selected === 'http' && commandPresent) addNote(notes, note('dropped-properties', { count: 1 }));
  if (!selected || (selected === 'http' && !urlPresent) || (selected === 'stdio' && !commandPresent)) {
    return note('no-server');
  }

  const config: Record<string, unknown> = {};
  if (selected === 'stdio') {
    let command: string | undefined;
    let argsSource = take('args');
    let envSource = source === 'opencode-json' ? take('environment') : take('env');
    if (source === 'opencode-json' && envSource === undefined) envSource = take('env');
    if (boundedString(rawCommand)) command = rawCommand;
    else if (Array.isArray(rawCommand) && rawCommand.length > 0 && rawCommand.every(boundedString)) {
      command = rawCommand[0] as string;
      argsSource = [...rawCommand.slice(1), ...(Array.isArray(argsSource) ? argsSource : [])];
    } else if (isRecord(rawCommand)) {
      command = boundedString(rawCommand.path) ? rawCommand.path : undefined;
      if (argsSource === undefined) argsSource = rawCommand.args;
      if (envSource === undefined) envSource = rawCommand.env;
      const dropped = Object.keys(rawCommand).filter(key => !['path', 'args', 'env'].includes(key)).length;
      if (dropped) addNote(notes, note('dropped-properties', { count: dropped }));
    }
    if (!command?.trim()) return note('invalid-entry');
    config.command = command;
    const args = stringArray(argsSource);
    if (args.invalid) return note('invalid-entry');
    if (args.values.length) config.args = args.values;
    const env = stringMap(envSource);
    if (env.invalid) return note('invalid-entry');
    if (env.entries.length) config.env = Object.fromEntries(env.entries);
    if (env.dropped) addNote(notes, note('dropped-properties', { count: env.dropped }));
    const cwd = take('cwd');
    if (boundedString(cwd) && cwd) config.cwd = cwd;
    else if (cwd !== undefined && cwd !== '') addNote(notes, note('dropped-properties', { count: 1 }));
    for (const key of ['headers', 'oauth', 'auth']) {
      if (key in entry) {
        take(key);
        addNote(notes, note('dropped-properties', { count: 1 }));
      }
    }
  } else {
    config.url = rawUrl!;
    const headers = stringMap(take('headers'));
    if (headers.invalid) return note('invalid-entry');
    if (headers.entries.length) config.headers = Object.fromEntries(headers.entries);
    if (headers.dropped) addNote(notes, note('dropped-properties', { count: headers.dropped }));
    const oauthSource = take('oauth');
    const legacyAuth = take('auth');
    const oauthInput = isRecord(oauthSource) ? oauthSource : isRecord(legacyAuth) ? legacyAuth : undefined;
    if (oauthInput) {
      const oauth: Record<string, unknown> = {};
      const clientId = oauthInput.clientId ?? oauthInput.CLIENT_ID;
      const clientSecret = oauthInput.clientSecret ?? oauthInput.CLIENT_SECRET;
      const scopes = oauthInput.scopes ?? oauthInput.scope;
      if (boundedString(clientId)) oauth.clientId = clientId;
      if (boundedString(clientSecret)) oauth.clientSecret = clientSecret;
      if (Array.isArray(scopes) && scopes.length <= MAX_COLLECTION_ENTRIES && scopes.every(boundedString)) {
        oauth.scopes = scopes;
      } else if (boundedString(scopes)) {
        const values = scopes.split(/\s+/u).filter(Boolean);
        if (values.length > MAX_COLLECTION_ENTRIES) return note('too-many-fields');
        oauth.scopes = values;
      }
      const known = new Set(['clientId', 'CLIENT_ID', 'clientSecret', 'CLIENT_SECRET', 'scopes', 'scope']);
      const dropped = Object.keys(oauthInput).filter(key => !known.has(key)).length;
      if (dropped) addNote(notes, note('dropped-properties', { count: dropped }));
      if (Object.keys(oauth).length) config.oauth = oauth;
    } else if (oauthSource !== undefined || legacyAuth !== undefined) {
      addNote(notes, note('dropped-properties', { count: 1 }));
    }
    for (const key of ['args', 'env', 'environment', 'cwd']) {
      if (key in entry) {
        take(key);
        addNote(notes, note('dropped-properties', { count: 1 }));
      }
    }
  }

  const enabled = take('enabled');
  const disabled = take('disabled');
  if (enabled === false || disabled === true) config.enabled = false;
  else if ((enabled !== undefined && typeof enabled !== 'boolean')
    || (disabled !== undefined && typeof disabled !== 'boolean')) {
    addNote(notes, note('dropped-properties', { count: 1 }));
  }
  const exposure = take('exposure');
  if (exposure === 'direct' || exposure === 'codemode' || exposure === 'deferred') config.exposure = exposure;
  else if (exposure !== undefined) addNote(notes, note('dropped-properties', { count: 1 }));
  const description = take('description');
  if (boundedString(description)) config.description = description;
  else if (description !== undefined) addNote(notes, note('dropped-properties', { count: 1 }));

  const dropped = Object.keys(entry).filter(key => !used.has(key)).length;
  if (dropped) addNote(notes, note('dropped-properties', { count: dropped }));
  return {
    source,
    ...(candidateName ? { name: candidateName } : {}),
    config,
    grammar: sourceGrammar(source, syntax, entry),
    fields,
    notes,
  };
}

function objectEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).slice(0, MCP_IMPORT_MAX_SERVERS + 1);
}

function readJsonValue(value: unknown, syntax: McpImportSyntax, forcedSource?: McpImportSource, forcedName?: string): ReadResult {
  const notes: McpImportNote[] = [];
  const map = (
    entries: Array<[string | undefined, unknown]>,
    source: McpImportSource,
  ): ReadResult => {
    if (entries.length > MCP_IMPORT_MAX_SERVERS) return { error: note('too-many-servers') };
    const candidates: ImportCandidate[] = [];
    const refused: McpImportNote[] = [];
    for (const [name, entry] of entries) {
      const mapped = mappedCandidate(forcedName ?? name, entry, forcedSource ?? source, syntax);
      if ('severity' in mapped) {
        refused.push(mapped);
        continue;
      }
      candidates.push(mapped);
    }
    if (refused.length) {
      addNote(notes, note('invalid-entry', { count: refused.length }));
      for (const refusal of refused) addNote(notes, refusal);
    }
    return candidates.length ? { candidates, notes } : { error: refused[0] ?? note('no-server') };
  };

  if (forcedSource && isRecord(value)) return map([[forcedName, value]], forcedSource);
  if (Array.isArray(value)) return map(value.map(entry => [undefined, entry]), 'server-object');
  if (!isRecord(value)) return { error: note('no-server') };
  if (isRecord(value.mcpServers)) return map(objectEntries(value.mcpServers), 'mcp-json');
  if (isRecord(value.servers)) return map(objectEntries(value.servers), 'vscode-json');
  if (isRecord(value.context_servers)) return map(objectEntries(value.context_servers), 'zed-json');
  if (isRecord(value.mcp)) {
    const servers = isRecord(value.mcp.servers) ? value.mcp.servers : value.mcp;
    return map(objectEntries(servers), isRecord(value.mcp.servers) ? 'vscode-json' : 'opencode-json');
  }
  const looksLikeServer = ['command', 'url', 'httpUrl', 'serverUrl'].some(key => key in value);
  if (looksLikeServer) return map([[undefined, value]], 'server-object');
  const entries = objectEntries(value);
  if (entries.length > 0 && entries.some(([, entry]) => isRecord(entry)
    && ['command', 'url', 'httpUrl', 'serverUrl'].some(key => key in entry))) {
    return map(entries, 'server-map');
  }
  return { error: note('no-server') };
}

function readJsonPaste(input: string, syntax: McpImportSyntax): ReadResult {
  let parsed = parseJson(input);
  if (parsed.error) {
    const fragment = parseJson(`{${input.replace(/,\s*$/u, '')}}`);
    if (!fragment.error) parsed = fragment;
  }
  if (parsed.error) return { error: parsed.error };
  return readJsonValue(parsed.value, syntax);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function queryParams(search: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of search.replace(/^\?/u, '').split('&')) {
    if (!part) continue;
    const equals = part.indexOf('=');
    const key = equals < 0 ? part : part.slice(0, equals);
    const value = equals < 0 ? '' : part.slice(equals + 1);
    result.set(safeDecode(key), safeDecode(value));
  }
  return result;
}

function decodeBase64Utf8(value: string): string | undefined {
  let normalized = value.trim().replace(/ /gu, '+').replace(/-/gu, '+').replace(/_/gu, '/').replace(/=+$/u, '');
  if (!/^[A-Za-z0-9+/]+$/u.test(normalized) || normalized.length % 4 === 1) return undefined;
  normalized += '='.repeat((4 - normalized.length % 4) % 4);
  try {
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length > MCP_IMPORT_MAX_BYTES) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeJson(value: string): unknown {
  let current = value.trim();
  for (let attempt = 0; attempt < 4; attempt++) {
    if (Buffer.byteLength(current, 'utf8') > MCP_IMPORT_MAX_BYTES) return undefined;
    const parsed = parseJson(current);
    if (!parsed.error) return parsed.value;
    const decoded = safeDecode(current);
    if (decoded === current) return undefined;
    current = decoded.trim();
  }
  return undefined;
}

function installJson(value: unknown, source: McpImportSource, forcedName?: string): ReadResult {
  if (!isRecord(value)) return { error: note('install-link-invalid') };
  if (isRecord(value.config)) {
    const name = forcedName ?? (typeof value.name === 'string' ? value.name : undefined);
    return readJsonValue(value.config, 'foreign', source, name);
  }
  return readJsonValue(value, 'foreign', source, forcedName);
}

function cursorInstall(url: URL, source: McpImportSource = 'cursor-install-link'): ReadResult {
  const params = queryParams(url.search);
  const encoded = params.get('config');
  if (!encoded) return { error: note('install-link-invalid') };
  const json = encoded.trim().startsWith('{') ? encoded : decodeBase64Utf8(encoded);
  const value = json === undefined ? undefined : decodeJson(json);
  return installJson(value, source, params.get('name') || undefined);
}

function readInstallOrUrl(input: string, depth = 0): ReadResult {
  if (depth > 3) return { error: note('install-link-invalid') };
  if (Buffer.byteLength(input, 'utf8') > MAX_STRING_BYTES) return { error: note('invalid-entry') };
  let url: URL;
  try {
    url = new URL(input.replace(/&amp;/gu, '&'));
  } catch {
    if (/^https?:\/\/\S+$/iu.test(input)) {
      return {
        candidates: [{ source: 'url', config: { url: input }, grammar: 'foreign', fields: [], notes: [] }],
        notes: [],
      };
    }
    return { error: note('unrecognized-input') };
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === 'cursor:' && /\/mcp\/install\/?$/u.test(url.pathname)) return cursorInstall(url);
  if (scheme === 'vscode:' || scheme === 'vscode-insiders:' || scheme === 'code-oss:') {
    const opaque = input.slice(input.indexOf('?') + 1);
    return installJson(decodeJson(opaque), 'vscode-install-link');
  }
  if (scheme === 'vsweb+mcp:') {
    return installJson(decodeJson(input.slice(input.indexOf('?') + 1)), 'visual-studio-install-link');
  }
  if (scheme === 'ghapp:' && /^ghapp:\/\/mcp\/install/iu.test(input)) {
    return installJson(decodeJson(input.slice(input.indexOf('?') + 1)), 'copilot-app-install-link');
  }
  if (scheme === 'ws:' || scheme === 'wss:') return { error: note('unsupported-transport') };
  if (scheme !== 'http:' && scheme !== 'https:') return { error: note('unsupported-scheme') };
  const host = url.hostname.toLowerCase().replace(/^www\./u, '');
  if ((host === 'cursor.com' || host === 'lmstudio.ai') && /\/install-mcp\/?$/u.test(url.pathname)) {
    return cursorInstall(url);
  }
  if ((host === 'vscode.dev' || host === 'insiders.vscode.dev') && /^\/redirect\/?$/u.test(url.pathname)) {
    const nested = queryParams(url.search).get('url');
    return nested ? readInstallOrUrl(nested, depth + 1) : { error: note('install-link-invalid') };
  }
  if ((host === 'vscode.dev' || host === 'insiders.vscode.dev') && /^\/redirect\/mcp\/install\/?$/u.test(url.pathname)) {
    const params = queryParams(url.search);
    return installJson(decodeJson(params.get('config') ?? ''), 'vscode-install-link', params.get('name') || undefined);
  }
  if (host === 'aka.ms' && /^\/vs\/mcp-install\/?$/iu.test(url.pathname)) {
    return installJson(decodeJson(url.search.slice(1)), 'visual-studio-install-link');
  }
  if (host === 'github.com' && /^\/copilot\/app\/launch\/?$/u.test(url.pathname)) {
    const nested = queryParams(url.search).get('open');
    return nested ? readInstallOrUrl(nested, depth + 1) : { error: note('install-link-invalid') };
  }
  const notes: McpImportNote[] = [];
  if (scheme === 'http:' && !LOOPBACK.has(url.hostname)) notes.push(note('insecure-http'));
  if (/\/sse\/?$/u.test(url.pathname)) return { error: note('unsupported-transport') };
  const config: Record<string, unknown> = { url: input };
  if (url.username || url.password) {
    const username = safeDecode(url.username);
    const password = safeDecode(url.password);
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    url.username = '';
    url.password = '';
    config.url = url.toString();
    config.headers = { Authorization: authorization };
    notes.push(note('userinfo-moved'));
  }
  return {
    candidates: [{ source: 'url', config, grammar: 'foreign', fields: [], notes }],
    notes: [],
  };
}

function pair(value: string, separator: '=' | ':'): [string, string] | undefined {
  const index = value.indexOf(separator);
  const key = index < 0 ? '' : value.slice(0, index).trim();
  return key ? [key, value.slice(index + 1).trim()] : undefined;
}

function optionValue(words: string[], index: number): { value?: string; next: number; inlineName?: string } {
  const word = words[index]!;
  const equals = word.startsWith('--') ? word.indexOf('=') : -1;
  if (equals > 0) return { value: word.slice(equals + 1), next: index, inlineName: word.slice(0, equals) };
  return { value: words[index + 1], next: index + 1 };
}

function parseAiHarnessAdd(words: string[]): ReadResult {
  const args = words.slice(3);
  let name: string | undefined;
  let url: string | undefined;
  let cwd: string | undefined;
  let exposure: McpExposure | undefined;
  let scopeHint: McpConfigScope | undefined;
  const env: Array<[string, string]> = [];
  const headers: Array<[string, string]> = [];
  const oauth: Record<string, unknown> = {};
  const command: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (word === '--') {
      command.push(...args.slice(index + 1));
      break;
    }
    if (!word.startsWith('-')) {
      if (!name) name = word;
      else command.push(word);
      continue;
    }
    const read = optionValue(args, index);
    const option = read.inlineName ?? word;
    if (option === '--local') {
      if (read.inlineName) return { error: note('invalid-entry') };
      scopeHint = 'project';
      continue;
    }
    if (!read.value) return { error: note('invalid-entry') };
    index = read.next;
    switch (option) {
      case '--scope':
        if (read.value !== 'global' && read.value !== 'project') return { error: note('invalid-entry') };
        scopeHint = read.value;
        break;
      case '--url': url = read.value; break;
      case '--cwd': cwd = read.value; break;
      case '--env': {
        const parsed = pair(read.value, '=');
        if (!parsed) return { error: note('invalid-entry') };
        env.push(parsed);
        break;
      }
      case '--header': {
        const parsed = pair(read.value, '=') ?? pair(read.value, ':');
        if (!parsed) return { error: note('invalid-entry') };
        headers.push(parsed);
        break;
      }
      case '--exposure':
        if (read.value !== 'direct' && read.value !== 'codemode' && read.value !== 'deferred') {
          return { error: note('invalid-entry') };
        }
        exposure = read.value;
        break;
      case '--oauth-client-id': oauth.clientId = read.value; break;
      case '--oauth-client-secret': oauth.clientSecret = read.value; break;
      default: return { error: note('invalid-entry') };
    }
  }
  if (!name || (Boolean(url) === Boolean(command.length))) return { error: note('invalid-entry') };
  const config: Record<string, unknown> = url
    ? { url, ...(headers.length ? { headers: Object.fromEntries(headers) } : {}), ...(Object.keys(oauth).length ? { oauth } : {}) }
    : { command: command[0], ...(command.length > 1 ? { args: command.slice(1) } : {}), ...(env.length ? { env: Object.fromEntries(env) } : {}), ...(cwd ? { cwd } : {}) };
  if (exposure) config.exposure = exposure;
  const notes: McpImportNote[] = [];
  const dropped = url ? env.length + (cwd ? 1 : 0) : headers.length + Object.keys(oauth).length;
  if (dropped) notes.push(note('dropped-properties', { count: dropped }));
  return {
    candidates: [{
      source: 'aiharness-command', name, config, grammar: 'aiharness', scopeHint,
      fields: [], notes,
    }],
    notes: [],
  };
}

interface ExternalOptions {
  transport?: string;
  scope?: string;
  url?: string;
  env: Array<[string, string]>;
  headers: Array<[string, string]>;
  positional: string[];
  afterDash: string[];
  bearerVariable?: string;
  oauthClientId?: string;
  description?: string;
  clientSecretPrompt: boolean;
  dropped: number;
}

function externalOptions(words: string[], cli: 'claude' | 'codex' | 'gemini'): ExternalOptions | undefined {
  const parsed: ExternalOptions = {
    env: [], headers: [], positional: [], afterDash: [], clientSecretPrompt: false, dropped: 0,
  };
  for (let index = 3; index < words.length; index++) {
    const word = words[index]!;
    if (word === '--') {
      parsed.afterDash = words.slice(index + 1);
      break;
    }
    if (!word.startsWith('-')) {
      parsed.positional.push(word);
      continue;
    }
    const read = optionValue(words, index);
    const option = read.inlineName ?? word;
    if (option === '--client-secret' && cli === 'claude') {
      parsed.clientSecretPrompt = true;
      continue;
    }
    if (option === '--trust' || option === '--no-browser') continue;
    if (!read.value) return undefined;
    index = read.next;
    switch (option) {
      case '-t':
      case '--type':
      case '--transport': parsed.transport = read.value; break;
      case '-s':
      case '--scope': parsed.scope = read.value; break;
      case '--url': parsed.url = read.value; break;
      case '-e':
      case '--env': {
        const value = pair(read.value, '=');
        if (!value) return undefined;
        parsed.env.push(value);
        break;
      }
      case '-H':
      case '--header': {
        const value = pair(read.value, ':') ?? pair(read.value, '=');
        if (!value) return undefined;
        parsed.headers.push(value);
        break;
      }
      case '--bearer-token-env-var': parsed.bearerVariable = read.value; break;
      case '--oauth-client-id':
      case '--client-id': parsed.oauthClientId = read.value; break;
      case '--description': parsed.description = read.value; break;
      case '--timeout':
      case '--include-tools':
      case '--exclude-tools':
      case '--oauth-resource':
      case '--config':
      case '-c': parsed.dropped++; break;
      default: return undefined;
    }
  }
  return parsed;
}

function parseExternalAdd(words: string[], cli: 'claude' | 'codex' | 'gemini'): ReadResult {
  const parsed = externalOptions(words, cli);
  if (!parsed) return { error: note('invalid-entry') };
  const [name, target, ...rest] = parsed.positional;
  let command: string[] = parsed.afterDash;
  let url = parsed.url;
  if (cli === 'codex') {
    if (!name) return { error: note('invalid-entry') };
    if (!command.length && !url && target) command = [target, ...rest];
  } else {
    if (!name || !target) return { error: note('invalid-entry') };
    const requested = parsed.transport?.toLowerCase();
    const remote = requested === 'http' || requested === 'streamable-http' || (!requested && /^https?:\/\//iu.test(target));
    if (requested && !['http', 'streamable-http', 'stdio'].includes(requested)) {
      return { error: note('unsupported-transport') };
    }
    if (remote) url = target;
    else command = [target, ...rest, ...parsed.afterDash];
  }
  if (!name || (Boolean(url) === Boolean(command.length))) return { error: note('invalid-entry') };
  if (parsed.scope && !['project', 'local', 'user', 'global'].includes(parsed.scope)) {
    return { error: note('invalid-entry') };
  }
  if (parsed.bearerVariable && !VARIABLE_NAME.test(parsed.bearerVariable)) {
    return { error: note('invalid-entry') };
  }
  const config: Record<string, unknown> = {};
  const fields: McpImportFieldPreview[] = [];
  if (url) {
    config.url = url;
    const headers = [...parsed.headers];
    if (parsed.bearerVariable && VARIABLE_NAME.test(parsed.bearerVariable)) {
      headers.push(['Authorization', `Bearer \${${parsed.bearerVariable}}`]);
    }
    if (headers.length) config.headers = Object.fromEntries(headers);
    const oauth: Record<string, unknown> = {};
    if (parsed.oauthClientId) oauth.clientId = parsed.oauthClientId;
    if (parsed.clientSecretPrompt) {
      oauth.clientSecret = '';
      fields.push({
        id: 'oauth.clientSecret', field: 'oauth.clientSecret', kind: 'secret', required: true, canReference: true,
      });
    }
    if (Object.keys(oauth).length) config.oauth = oauth;
    parsed.dropped += parsed.env.length;
  } else {
    config.command = command[0];
    if (command.length > 1) config.args = command.slice(1);
    if (parsed.env.length) config.env = Object.fromEntries(parsed.env);
    parsed.dropped += parsed.headers.length
      + (parsed.bearerVariable ? 1 : 0)
      + (parsed.oauthClientId ? 1 : 0)
      + (parsed.clientSecretPrompt ? 1 : 0);
  }
  if (parsed.description) config.description = parsed.description;
  const scopeHint = parsed.scope === 'project' || parsed.scope === 'local'
    ? 'project' : parsed.scope === 'user' || parsed.scope === 'global' ? 'global' : undefined;
  return {
    candidates: [{
      source: `${cli}-command`, name, config,
      // Every add command was read as shell words, so bare $NAME is a
      // reference only in fields the MCP runtime actually resolves.
      grammar: 'shell',
      ...(scopeHint ? { scopeHint } : {}),
      fields,
      notes: parsed.dropped ? [note('dropped-properties', { count: parsed.dropped })] : [],
    }],
    notes: [],
  };
}

function readCodeCommand(words: string[]): ReadResult {
  const index = words.findIndex(word => word === '--add-mcp' || word.startsWith('--add-mcp='));
  if (index < 0) return { error: note('unrecognized-input') };
  const inline = words[index]!.startsWith('--add-mcp=') ? words[index]!.slice('--add-mcp='.length) : words[index + 1];
  if (!inline) return { error: note('invalid-entry') };
  const parsed = parseJson(inline);
  if (parsed.error || !isRecord(parsed.value)) return { error: note('invalid-json') };
  return readJsonValue(parsed.value, 'foreign', 'vscode-command');
}

function readGenericCommand(words: string[], syntax: McpImportSyntax): ReadResult {
  let index = 0;
  const env: Array<[string, string]> = [];
  while (index < words.length) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u.exec(words[index]!);
    if (!assignment) break;
    env.push([assignment[1]!, assignment[2]!]);
    index++;
  }
  if (words[index] === 'env') index++;
  while (index < words.length) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u.exec(words[index]!);
    if (!assignment) break;
    env.push([assignment[1]!, assignment[2]!]);
    index++;
  }
  const command = words[index];
  if (!command || command.startsWith('-')) return { error: note('no-server') };
  const executable = (command.split(/[\\/]/u).pop() ?? '').replace(/\.(?:cmd|exe)$/iu, '').toLowerCase();
  const commandArgs = words.slice(index + 1);
  const shellEvaluation = ['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'].includes(executable)
    ? commandArgs.some(argument => argument === '-c' || argument === '-lc')
    : executable === 'cmd'
      ? commandArgs.some(argument => ['/c', '/k'].includes(argument.toLowerCase()))
      : ['powershell', 'pwsh'].includes(executable)
        && commandArgs.some(argument => ['-c', '-command', '-encodedcommand'].includes(argument.toLowerCase()));
  if (shellEvaluation) return { error: note('unsafe-shell') };
  const config: Record<string, unknown> = { command };
  if (commandArgs.length) config.args = commandArgs;
  if (env.length) config.env = Object.fromEntries(env);
  return {
    candidates: [{
      source: 'command-line',
      config,
      grammar: syntax === 'aiharness' ? 'aiharness' : 'shell',
      fields: [],
      notes: [],
    }],
    notes: [],
  };
}

function packageName(value: string): string {
  if (!value.startsWith('@')) return value.split('@', 1)[0] ?? value;
  const slash = value.indexOf('/');
  const version = slash < 0 ? -1 : value.indexOf('@', slash);
  return version < 0 ? value : value.slice(0, version);
}

function clientCommandWords(words: string[]): string[] {
  let start = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=[\s\S]*$/u.test(words[start] ?? '')) start++;
  if (executableName(words[start] ?? '') === 'env') {
    start++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=[\s\S]*$/u.test(words[start] ?? '')) start++;
  }
  const direct = words.slice(start);
  const runner = executableName(direct[0] ?? '');
  if (!['bunx', 'npx', 'pnpx'].includes(runner)) return direct;
  let packageIndex = 1;
  while (['--', '-y', '--yes', '-q', '--quiet'].includes(direct[packageIndex] ?? '')) packageIndex++;
  const clients: Record<string, string> = {
    '@ai-harness/cli': 'ai-harness',
    '@anthropic-ai/claude-code': 'claude',
    '@google/gemini-cli': 'gemini',
    '@openai/codex': 'codex',
  };
  const client = clients[packageName(direct[packageIndex] ?? '')];
  return client ? [client, ...direct.slice(packageIndex + 1)] : direct;
}

function readCommandPaste(input: string, syntax: McpImportSyntax): ReadResult {
  const split = splitMcpShellWords(normalizeCommandLine(input));
  if (!split.ok) return { error: note('unsafe-shell') };
  const words = split.words;
  if (!words.length) return { error: note('empty-input') };
  const clientWords = clientCommandWords(words);
  const program = executableName(clientWords[0] ?? '');
  if (['claude', 'codex', 'gemini', 'ai-harness', 'aih'].includes(program) && clientWords[1] === 'mcp') {
    if (clientWords[2] !== 'add') return { error: note('management-command') };
    if (program === 'ai-harness' || program === 'aih') return parseAiHarnessAdd(clientWords);
    return parseExternalAdd(clientWords, program as 'claude' | 'codex' | 'gemini');
  }
  if (['code', 'code-insiders', 'codium', 'cursor'].includes(program)) return readCodeCommand(clientWords);
  return readGenericCommand(words, syntax);
}

function looksLikeJson(input: string): boolean {
  return input.startsWith('{') || input.startsWith('[') || /^"[^"\n]+"\s*:/u.test(input);
}

function looksLikeLink(input: string): boolean {
  return !/\s/u.test(input)
    && !/^[A-Za-z]:[\\/]/u.test(input)
    && /^[A-Za-z][A-Za-z0-9+.-]+:/u.test(input);
}

function readPaste(input: string, syntax: McpImportSyntax): ReadResult {
  if (looksLikeJson(input)) return readJsonPaste(input, syntax);
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]\S*)?$/iu.test(input)) {
    return readInstallOrUrl(`http://${input}`);
  }
  return looksLikeLink(input) ? readInstallOrUrl(input) : readCommandPaste(input, syntax);
}

function escapeLiteral(value: string, atStart: boolean): string {
  const escaped = value.replace(/\$/gu, '$$$$');
  return atStart && escaped.startsWith('!') ? `$${escaped}` : escaped;
}

interface NormalizedValue {
  value: string;
  references: string[];
  escaped: boolean;
  command: boolean;
}

const FOREIGN_REFERENCE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|%([A-Za-z_][A-Za-z0-9_]*)%|\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu;

function normalizeResolvedValue(value: string, grammar: ValueGrammar): NormalizedValue {
  if (grammar === 'aiharness') {
    const references = configReferences(value);
    return { value, references, escaped: false, command: value.startsWith('!') };
  }
  const allowBare = grammar === 'gemini' || grammar === 'shell';
  let cursor = 0;
  let output = '';
  let changed = false;
  const references: string[] = [];
  FOREIGN_REFERENCE.lastIndex = 0;
  for (let match = FOREIGN_REFERENCE.exec(value); match; match = FOREIGN_REFERENCE.exec(value)) {
    if (match.index > 0 && value[match.index - 1] === '$') continue;
    const bare = match[4];
    if (bare && !allowBare) continue;
    const name = match[1] ?? match[2] ?? match[3] ?? bare;
    if (!name) continue;
    const literal = value.slice(cursor, match.index);
    const encoded = escapeLiteral(literal, output.length === 0);
    output += encoded;
    output += `\${${name}}`;
    changed ||= encoded !== literal || match[0] !== `\${${name}}`;
    if (references.length < MAX_COLLECTION_ENTRIES && !references.includes(name)) references.push(name);
    cursor = match.index + match[0].length;
  }
  const tail = value.slice(cursor);
  const encodedTail = escapeLiteral(tail, output.length === 0);
  output += encodedTail;
  changed ||= encodedTail !== tail;
  return { value: output, references, escaped: changed, command: false };
}

function configReferences(value: string): string[] {
  if (value.startsWith('!')) return [];
  const names: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '$') continue;
    const next = value[index + 1];
    if (next === '$' || next === '!') {
      index++;
      continue;
    }
    if (next === '{') {
      const end = value.indexOf('}', index + 2);
      if (end < 0) continue;
      const name = value.slice(index + 2, end);
      if (VARIABLE_NAME.test(name) && names.length < MAX_COLLECTION_ENTRIES && !names.includes(name)) names.push(name);
      index = end;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(value.slice(index + 1));
    if (match) {
      if (names.length < MAX_COLLECTION_ENTRIES && !names.includes(match[0])) names.push(match[0]);
      index += match[0].length;
    }
  }
  return names;
}

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function isSecretName(name: string): boolean {
  const words = nameWords(name);
  const qualifiers = new Set(['file', 'path', 'dir', 'url', 'uri', 'endpoint', 'id', 'name', 'type', 'header', 'env', 'var']);
  if (words.length > 1 && qualifiers.has(words.at(-1)!)) return false;
  const secret = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'passphrase', 'pwd', 'credential', 'credentials', 'authorization', 'bearer', 'jwt', 'cookie', 'signature', 'pat']);
  return words.some(word => secret.has(word)
    || ['token', 'secret', 'password', 'passwd', 'apikey'].some(suffix => word.length > suffix.length && word.endsWith(suffix)));
}

function isSecretParameterName(name: string): boolean {
  return isSecretName(name) || nameWords(safeDecode(name)).some(word => ['auth', 'sig', 'code', 'pw'].includes(word));
}

function isReferenceOnly(value: string): boolean {
  if (value.startsWith('!')) return false;
  const stripped = value
    .replace(/^(?:bearer|basic|token)\s+/iu, '')
    .replace(/\$\$|\$!/gu, 'x')
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/gu, '');
  return configReferences(value).length > 0 && /^[^A-Za-z0-9]*$/u.test(stripped);
}

function looksLikeSecretValue(value: string): boolean {
  if (/\s/u.test(value) || isReferenceOnly(value)) return false;
  if (/^(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})/u.test(value)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/u.test(value)) return true;
  if (value.length < 24 || !/^[A-Za-z0-9_+\-/=.~]+$/u.test(value)) return false;
  if (/^[./~]/u.test(value) || value.split('/').length > 2 || !/\d/u.test(value) || !/[A-Za-z]/u.test(value)) return false;
  return (/[a-z]/u.test(value) && /[A-Z]/u.test(value)) || /^[0-9a-f]{24,}$/iu.test(value);
}

function embeddedLiteralSecret(value: string): boolean {
  if (!value || value.startsWith('!') || isReferenceOnly(value)) return false;
  const authorization = /^(?:bearer|basic|token)\s+([\s\S]+)$/iu.exec(value);
  if (authorization) return !isReferenceOnly(authorization[1]!);
  const header = /^([A-Za-z0-9_-]+):\s*([\s\S]+)$/u.exec(value);
  if (header && isSecretName(header[1]!)) return !isReferenceOnly(header[2]!);
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]+)$/u.exec(value);
  if (assignment && isSecretName(assignment[1]!)) return !isReferenceOnly(assignment[2]!);
  if (value.includes(';')) {
    for (const segment of value.split(';')) {
      const part = /^\s*([A-Za-z][A-Za-z0-9 _.-]*)=([\s\S]+)$/u.exec(segment);
      if (part && isSecretName(part[1]!) && !isReferenceOnly(part[2]!)) return true;
    }
  }
  return looksLikeSecretValue(value);
}

function literalSecretFields(config: Record<string, unknown>): string[] {
  const fields: string[] = [];
  const add = (field: string) => { if (!fields.includes(field)) fields.push(field); };
  const env = isRecord(config.env) ? config.env : {};
  const headers = isRecord(config.headers) ? config.headers : {};
  for (const [name, raw] of Object.entries(env)) {
    if (typeof raw !== 'string' || raw === '' || raw.startsWith('!') || isReferenceOnly(raw)) continue;
    if (isSecretName(name) || embeddedLiteralSecret(raw)) add(`env.${name}`);
  }
  for (const [name, raw] of Object.entries(headers)) {
    if (typeof raw !== 'string' || raw === '' || raw.startsWith('!') || isReferenceOnly(raw)) continue;
    if (isSecretName(name) || embeddedLiteralSecret(raw)) add(`headers.${name}`);
  }
  if (isRecord(config.oauth) && typeof config.oauth.clientSecret === 'string'
    && config.oauth.clientSecret !== '' && !config.oauth.clientSecret.startsWith('!')
    && !isReferenceOnly(config.oauth.clientSecret)) add('oauth.clientSecret');

  if (typeof config.url === 'string') {
    try {
      const url = new URL(config.url);
      if (url.username || url.password) add('url');
      for (const [name, value] of url.searchParams) {
        if (value && (isSecretParameterName(name) || looksLikeSecretValue(value))) add('url');
      }
      if (url.pathname.split('/').some(segment => looksLikeSecretValue(safeDecode(segment)))) add('url');
      const fragment = url.hash.slice(1);
      if (fragment && (looksLikeSecretValue(safeDecode(fragment))
        || fragment.split(/[&;]/u).some(part => {
          const [name, value = ''] = part.split('=', 2);
          return Boolean(value) && isSecretParameterName(name ?? '');
        }))) add('url');
    } catch {
      // Validation reports the invalid URL; no source detail is retained.
    }
  }
  if (typeof config.command === 'string' && embeddedLiteralSecret(config.command)) add('command');
  if (typeof config.description === 'string' && embeddedLiteralSecret(config.description)) add('description');
  const args = Array.isArray(config.args) ? config.args.filter((value): value is string => typeof value === 'string') : [];
  let secretNext = false;
  args.forEach((argument, index) => {
    if (secretNext) {
      if (!isReferenceOnly(argument)) add(`args[${index}]`);
      secretNext = false;
      return;
    }
    const assignment = /^(--?[A-Za-z][A-Za-z0-9_.-]*|[A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u.exec(argument);
    if (assignment && assignment[2] && (isSecretName(assignment[1]!) || looksLikeSecretValue(assignment[2]))) {
      if (!isReferenceOnly(assignment[2])) add(`args[${index}]`);
      return;
    }
    if (/^--?[A-Za-z][A-Za-z0-9_.-]*$/u.test(argument)) {
      const flag = argument.replace(/^-+/u, '');
      secretNext = argument === '-k' || flag.toLowerCase() === 'auth' || isSecretName(flag);
      return;
    }
    if (/^(?:bearer|basic|token)$/iu.test(argument)) {
      secretNext = true;
      return;
    }
    if (embeddedLiteralSecret(argument)) add(`args[${index}]`);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(argument)) {
      try {
        const url = new URL(argument);
        if (url.username || url.password || [...url.searchParams].some(([name, value]) => value && isSecretParameterName(name))) {
          add(`args[${index}]`);
        }
      } catch {
        // It remains a normal argument for validation.
      }
    }
  });
  return fields;
}

const PLACEHOLDER = /\$\{input:[^}\n]{1,80}\}|<[A-Za-z][^<>\n]{0,80}>|\{\{\s*[A-Za-z_][\w.-]*\s*\}\}|\bYOUR[_-][A-Za-z0-9_.-]+|\bMY_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PAT)\b|\b(?:REPLACE[_-]?ME|CHANGE[_-]?ME|PLACEHOLDER|REDACTED)\b|\b[xX]{6,}\b/gu;
const UNSUPPORTED_REFERENCE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)[^}\n]*\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}|%([A-Za-z_][A-Za-z0-9_]*)%|\$([A-Za-z_][A-Za-z0-9_]*)/gu;

function addField(fields: McpImportFieldPreview[], field: string, kind: 'secret' | 'text', canReference: boolean): void {
  if (fields.length >= MCP_IMPORT_MAX_FIELDS || fields.some(item => item.field === field)) return;
  fields.push({ id: field, field, kind, required: true, canReference });
}

function containsPlaceholder(value: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(value) || /^(?:\.\.\.|…|\*{3,}|TODO|FIXME|changeme)$/iu.test(value.trim());
}

function unsupportedReferences(value: string): string[] {
  const names: string[] = [];
  const protectedValue = value.replace(/\$\$|\$!/gu, 'xx');
  UNSUPPORTED_REFERENCE.lastIndex = 0;
  for (let match = UNSUPPORTED_REFERENCE.exec(protectedValue); match; match = UNSUPPORTED_REFERENCE.exec(protectedValue)) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (name && names.length < MAX_COLLECTION_ENTRIES && !names.includes(name)) names.push(name);
  }
  return names;
}

function previewSafeConfig(config: Record<string, unknown>, fields: readonly McpImportFieldPreview[]): Record<string, unknown> {
  const copy = structuredClone(config);
  const fieldNames = new Set(fields.map(field => field.field));
  if (typeof copy.url === 'string' && fieldNames.has('url')) {
    copy.url = 'https://placeholder.invalid/mcp';
  }
  if (typeof copy.command === 'string' && fieldNames.has('command')) copy.command = 'configured-command';
  if (Array.isArray(copy.args)) {
    copy.args = copy.args.map((value, index) => fieldNames.has(`args[${index}]`) ? 'configured-value' : value);
  }
  return copy;
}

function inferName(config: Record<string, unknown>): string {
  if (typeof config.url === 'string') {
    try {
      const host = new URL(config.url.replace(PLACEHOLDER, 'placeholder')).hostname;
      if (LOOPBACK.has(host)) return 'local';
      const labels = host.split('.').filter(Boolean);
      if (labels.length > 1) labels.pop();
      const noise = new Set(['www', 'api', 'app', 'mcp', 'server', 'gateway']);
      return labels.filter(label => !noise.has(label.toLowerCase())).at(-1) ?? labels.at(-1) ?? '';
    } catch {
      return 'server';
    }
  }
  const command = typeof config.command === 'string' ? config.command.split(/[\\/]/u).at(-1) ?? '' : '';
  const args = Array.isArray(config.args) ? config.args.filter((value): value is string => typeof value === 'string') : [];
  let source = command.replace(/\.(?:cmd|exe|bat|ps1)$/iu, '');
  if (['npx', 'bunx', 'pnpx', 'uvx'].includes(source.toLowerCase())) {
    source = args.find(value => !value.startsWith('-')) ?? source;
  } else if (source.toLowerCase() === 'docker') {
    source = args.filter(value => !value.startsWith('-')).at(-1) ?? source;
  }
  const scoped = /^@([^/]+)\/(.+)$/u.exec(source);
  const scopeName = scoped?.[1] ?? '';
  source = (scoped?.[2] ?? source).replace(/@[^@]+$/u, '');
  const cleaned = source.replace(/^(?:mcp[-_]?server[-_]?|server[-_]?|mcp[-_]?)/iu, '')
    .replace(/(?:[-_]?mcp[-_]?server|[-_]?server|[-_]?mcp)$/iu, '');
  return cleaned || scopeName;
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${name}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function scopePreview(
  scope: McpConfigScope,
  name: string,
  literalSecrets: readonly string[],
  valid: boolean,
  reserved: boolean,
  remoteHostVariable: boolean,
  context: McpImportScopeContext,
): McpImportScopePreview {
  const reasons: McpImportScopeBlockReason[] = [];
  if (!context.available) reasons.push(context.unavailableReason
    ?? (scope === 'project' ? 'no-project' : 'config-unavailable'));
  if (!valid) reasons.push('invalid-entry');
  if (new Set(context.names ?? []).has(name)) reasons.push('name-taken');
  if (scope === 'project' && literalSecrets.length) reasons.push('literal-secret');
  if (reserved) reasons.push('reserved-variable');
  const confirmations: McpImportScopeConfirmation[] = [];
  if (scope === 'global' && literalSecrets.length) confirmations.push('literal-secret');
  if (remoteHostVariable) confirmations.push('remote-host-variable');
  return { allowed: reasons.length === 0, reasons, confirmations };
}

function normalizedCandidate(
  candidate: ImportCandidate,
  usedNames: Set<string>,
  options: PreviewMcpImportOptions,
): McpImportEntryPreview {
  const config = structuredClone(candidate.config);
  const notes = [...candidate.notes];
  const fields = [...candidate.fields];
  const references: Array<{ field: string; name: string }> = [];
  let reservedReference = false;
  let unsafeCommandValue = false;
  const addReference = (field: string, name: string): void => {
    if (references.length >= MAX_COLLECTION_ENTRIES
      || references.some(reference => reference.field === field && reference.name === name)) return;
    references.push({ field, name });
  };
  const normalizeMap = (key: 'env' | 'headers') => {
    if (!isRecord(config[key])) return;
    const output: Array<[string, string]> = [];
    for (const [name, raw] of Object.entries(config[key])) {
      if (typeof raw !== 'string') continue;
      const field = `${key}.${name}`;
      const normalized = normalizeResolvedValue(raw, candidate.grammar);
      output.push([name, normalized.value]);
      if (normalized.escaped) addNote(notes, note('literal-escaped', { field }));
      const sourceReferences = candidate.grammar === 'aiharness' ? unsupportedReferences(raw) : [];
      if (sourceReferences.some(variable => RESERVED_VARIABLES.has(variable.toUpperCase()))) {
        reservedReference = true;
        addNote(notes, note('reserved-variable', { field }));
      }
      if (normalized.command) {
        addNote(notes, note('command-value', { field }));
        const problem = commandBackedProblem(raw);
        if (problem) {
          unsafeCommandValue = true;
          addNote(notes, note(problem, { field }));
        }
      }
      const unsupportedNative = normalized.command
        ? []
        : sourceReferences.filter(variable => !normalized.references.includes(variable));
      if (unsupportedNative.length) {
        addField(fields, field, isSecretName(name) ? 'secret' : 'text', true);
        addNote(notes, note('unsupported-reference', { field, count: unsupportedNative.length }));
      }
      for (const variable of normalized.references) addReference(field, variable);
      if (raw === '' || containsPlaceholder(raw)) {
        addField(fields, field, isSecretName(name) ? 'secret' : 'text', true);
      }
    }
    config[key] = Object.fromEntries(output);
  };
  normalizeMap('env');
  normalizeMap('headers');
  if (isRecord(config.oauth) && typeof config.oauth.clientSecret === 'string') {
    const rawClientSecret = config.oauth.clientSecret;
    const normalized = normalizeResolvedValue(rawClientSecret, candidate.grammar);
    config.oauth = { ...config.oauth, clientSecret: normalized.value };
    if (normalized.escaped) addNote(notes, note('literal-escaped', { field: 'oauth.clientSecret' }));
    const sourceReferences = candidate.grammar === 'aiharness'
      ? unsupportedReferences(rawClientSecret)
      : [];
    if (sourceReferences.some(variable => RESERVED_VARIABLES.has(variable.toUpperCase()))) {
      reservedReference = true;
      addNote(notes, note('reserved-variable', { field: 'oauth.clientSecret' }));
    }
    if (normalized.command) {
      addNote(notes, note('command-value', { field: 'oauth.clientSecret' }));
      const problem = commandBackedProblem(rawClientSecret);
      if (problem) {
        unsafeCommandValue = true;
        addNote(notes, note(problem, { field: 'oauth.clientSecret' }));
      }
    }
    const unsupportedNative = normalized.command
      ? []
      : sourceReferences.filter(variable => !normalized.references.includes(variable));
    if (unsupportedNative.length) {
      addField(fields, 'oauth.clientSecret', 'secret', true);
      addNote(notes, note('unsupported-reference', {
        field: 'oauth.clientSecret', count: unsupportedNative.length,
      }));
    }
    for (const variable of normalized.references) addReference('oauth.clientSecret', variable);
    if (rawClientSecret === '' || containsPlaceholder(rawClientSecret)) {
      addField(fields, 'oauth.clientSecret', 'secret', true);
    }
  }

  const rawFields: Array<{ field: string; value: string; secret: boolean }> = [];
  if (typeof config.command === 'string') rawFields.push({ field: 'command', value: config.command, secret: false });
  if (typeof config.cwd === 'string') rawFields.push({ field: 'cwd', value: config.cwd, secret: false });
  if (typeof config.url === 'string') rawFields.push({ field: 'url', value: config.url, secret: false });
  if (typeof config.description === 'string') {
    rawFields.push({ field: 'description', value: config.description, secret: false });
  }
  if (isRecord(config.oauth)) {
    if (typeof config.oauth.clientId === 'string') {
      rawFields.push({ field: 'oauth.clientId', value: config.oauth.clientId, secret: false });
    }
    if (Array.isArray(config.oauth.scopes)) config.oauth.scopes.forEach((value, index) => {
      if (typeof value === 'string') rawFields.push({
        field: `oauth.scopes[${index}]`, value, secret: false,
      });
    });
  }
  if (Array.isArray(config.args)) config.args.forEach((value, index) => {
    if (typeof value === 'string') rawFields.push({
      field: `args[${index}]`, value,
      secret: index > 0 && typeof config.args === 'object'
        && isSecretName(String((config.args as unknown[])[index - 1]).replace(/^-+/u, '')),
    });
  });
  for (const item of rawFields) {
    if ((item.field === 'command' || item.field === 'url' || item.field === 'oauth.clientId')
      && item.value.trim() === '') {
      addField(fields, item.field, item.secret ? 'secret' : 'text', false);
    }
    const unsupported = unsupportedReferences(item.value);
    if (unsupported.length) {
      addField(fields, item.field, item.secret ? 'secret' : 'text', false);
      addNote(notes, note('unsupported-reference', { field: item.field, count: unsupported.length }));
      if (unsupported.some(name => RESERVED_VARIABLES.has(name.toUpperCase()))) {
        reservedReference = true;
        addNote(notes, note('reserved-variable', { field: item.field }));
      }
    }
    if (containsPlaceholder(item.value)) {
      addField(fields, item.field, item.secret || item.field === 'url' && /(?:key|token|secret|password|auth)/iu.test(item.value)
        ? 'secret' : 'text', false);
    }
  }
  for (const field of fields) addNote(notes, note('missing-value', { field: field.field }));

  let requestedName = candidate.name?.trim() ?? '';
  if (!requestedName) {
    requestedName = inferName(config) || 'server';
    addNote(notes, note('name-derived'));
  }
  let name = IMPORT_NAME.test(requestedName) ? requestedName : safeNamePart(requestedName) || 'server';
  if (name !== requestedName) addNote(notes, note('name-sanitized'));
  const unique = uniqueName(name, usedNames);
  if (unique !== name) {
    name = unique;
    addNote(notes, note('name-sanitized'));
  }
  usedNames.add(name);

  const literalSecrets = literalSecretFields(config);
  for (const field of literalSecrets) addNote(notes, note('literal-secret', { field }));
  const availableNames = new Set(options.availableVariableNames ?? []);
  const variables: McpImportVariablePreview[] = [];
  for (const reference of references) {
    if (variables.some(item => item.field === reference.field && item.name === reference.name)) continue;
    const reserved = RESERVED_VARIABLES.has(reference.name.toUpperCase());
    const availability: McpImportVariableAvailability = reserved
      ? 'reserved' : availableNames.has(reference.name) ? 'available' : 'missing';
    const remote = reference.field.startsWith('headers.') || reference.field === 'oauth.clientSecret';
    variables.push({
      field: reference.field,
      name: reference.name,
      availability,
      remote,
      confirmationRequired: remote && availability === 'available',
    });
    if (reserved) addNote(notes, note('reserved-variable', { field: reference.field }));
    else if (availability === 'missing') addNote(notes, note('missing-variable', { field: reference.field }));
    else if (remote) addNote(notes, note('host-variable-confirmation', { field: reference.field }));
  }
  const reserved = reservedReference || variables.some(variable => variable.availability === 'reserved');
  const remoteHostVariable = variables.some(variable => variable.confirmationRequired);
  const described = describeMcpConfigEntry(name, previewSafeConfig(config, fields));
  const valid = described.valid && !unsafeCommandValue;
  if (!valid) addNote(notes, note('invalid-entry'));
  const oauthFields = isRecord(config.oauth)
    ? Object.keys(config.oauth).filter(key => ['clientId', 'clientSecret', 'scopes'].includes(key))
    : [];
  const globalContext = options.scopes?.global ?? { available: true, names: [] };
  const projectContext = options.scopes?.project ?? { available: false, unavailableReason: 'no-project', names: [] };
  if (new Set(globalContext.names ?? []).has(name) || new Set(projectContext.names ?? []).has(name)) {
    addNote(notes, note('name-taken'));
  }
  return {
    name,
    source: candidate.source,
    ...(candidate.scopeHint ? { scopeHint: candidate.scopeHint } : {}),
    complete: valid && fields.length === 0 && !reserved,
    persisted: {
      valid,
      enabled: described.enabled,
      exposure: described.exposure,
      ...(described.transport ? { transport: described.transport } : {}),
      ...(described.command ? { command: described.command } : {}),
      // Preserve argument arity only. Even harmless-looking flags remain source literals.
      ...(described.args ? { args: described.args.map(() => '•••') } : {}),
      ...(described.url ? { url: described.url } : {}),
      envNames: described.envNames,
      headerNames: described.headerNames,
      oauthFields,
      commandFields: described.commandFields,
      variableReferences: described.variableReferences,
      masked: described.masked || Boolean(described.args?.length),
    },
    fields,
    variables,
    literalSecretFields: literalSecrets,
    scopes: {
      global: scopePreview('global', name, literalSecrets, valid, reserved, remoteHostVariable, globalContext),
      project: scopePreview('project', name, literalSecrets, valid, reserved, remoteHostVariable, projectContext),
    },
    notes,
  };
}

/**
 * Parse and redact an MCP paste without reading files, resolving environment
 * values, executing command-backed values, spawning processes, contacting a
 * URL, initializing OAuth, or opening a credential store. The returned value
 * contains structural names and masks only; the normalized literal config is
 * deliberately not part of the public contract.
 */
function candidateFieldCount(candidate: ImportCandidate): number {
  const fields = new Set(candidate.fields.map(field => field.field));
  const add = (field: string, present: boolean) => { if (present) fields.add(field); };
  for (const field of ['command', 'url', 'cwd', 'description', 'enabled', 'exposure']) {
    add(field, candidate.config[field] !== undefined);
  }
  if (Array.isArray(candidate.config.args)) {
    candidate.config.args.forEach((_value, index) => fields.add(`args[${index}]`));
  }
  for (const key of ['env', 'headers', 'oauth'] as const) {
    if (!isRecord(candidate.config[key])) continue;
    for (const name of Object.keys(candidate.config[key])) fields.add(`${key}.${name}`);
  }
  return fields.size;
}

export function previewMcpImport(text: string, options: PreviewMcpImportOptions = {}): McpImportPreview {
  try {
    if (typeof text !== 'string' || text.includes('\0')) {
      return { ok: false, entries: [], notes: [note('unrecognized-input')] };
    }
    if (Buffer.byteLength(text, 'utf8') > MCP_IMPORT_MAX_BYTES) {
      return { ok: false, entries: [], notes: [note('input-too-large')] };
    }
    const withoutBom = text.replace(/^\ufeff/u, '');
    if (PASTE_UNSAFE_CHARACTER.test(withoutBom)) {
      return { ok: false, entries: [], notes: [note('unsafe-shell')] };
    }
    const input = normalizePaste(withoutBom);
    if (!input) return { ok: false, entries: [], notes: [note('empty-input')] };
    const result = readPaste(input, options.syntax ?? 'foreign');
    if ('error' in result) return { ok: false, entries: [], notes: [result.error] };
    if (result.candidates.length > MCP_IMPORT_MAX_SERVERS) {
      return { ok: false, entries: [], notes: [note('too-many-servers')] };
    }
    if (result.candidates.reduce((count, candidate) => count + candidateFieldCount(candidate), 0) > MCP_IMPORT_MAX_FIELDS) {
      return { ok: false, entries: [], notes: [note('too-many-fields')] };
    }
    const refusals = result.candidates.map(candidate => usesShellEvaluator(candidate.config)
      ? 'unsafe-shell' as const
      : usesMcpManagementCommand(candidate.config) ? 'management-command' as const : undefined);
    const candidates = result.candidates.filter((_candidate, index) => refusals[index] === undefined);
    const refusedCount = result.candidates.length - candidates.length;
    if (refusedCount > 0) {
      const refusalCodes = [...new Set(refusals.filter((code): code is 'unsafe-shell' | 'management-command' => Boolean(code)))];
      if (candidates.length === 0) return { ok: false, entries: [], notes: [note(refusalCodes[0]!)] };
      addNote(result.notes, note('invalid-entry', { count: refusedCount }));
      for (const code of refusalCodes) {
        addNote(result.notes, note(code, { count: refusals.filter(item => item === code).length }));
      }
    }
    const usedNames = new Set<string>();
    const entries = candidates.map(candidate => normalizedCandidate(candidate, usedNames, options));
    return { ok: entries.length > 0, entries, notes: result.notes };
  } catch {
    // A route re-runs this function on attacker-controlled input. Parsing is a
    // typed refusal rather than a source-bearing 500 under every circumstance.
    return { ok: false, entries: [], notes: [note('unrecognized-input')] };
  }
}
