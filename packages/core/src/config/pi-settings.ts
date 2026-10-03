import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ThinkingLevel } from '../providers/index.js';
import { resolvePiAgentDirectory } from '../prompts/instruction-context.js';

export type PiSettingsScope = 'global' | 'project';
export type PiTuiMode = 'regular' | 'fullscreen';
export type PiQueueMode = 'all' | 'one-at-a-time';
export type PiCacheWarmingMode = 'off' | 'streaming' | 'idle';

export interface PiCompactionModelOverride {
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface PiCompactionSettings {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
  modelOverrides?: Record<string, PiCompactionModelOverride>;
}

export interface PiRetrySettings {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxAgentDelayMs?: number;
  provider?: {
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs?: number;
  };
}

export interface PiPackageSourceObject {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

export type PiPackageSource = string | PiPackageSourceObject;

/** Validated subset of Pi 1.0 settings.json, including all documented settings. */
export interface PiSettings {
  lastChangelogVersion?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingLevels?: Record<string, ThinkingLevel>;
  thinkingBudgets?: Partial<Record<'minimal' | 'low' | 'medium' | 'high', number>>;
  enabledModels?: string[];
  hideThinkingBlock?: boolean;
  showCacheMissNotices?: boolean;
  cacheWarming?: PiCacheWarmingMode;
  steeringMode?: PiQueueMode;
  followUpMode?: PiQueueMode;
  externalEditor?: string;
  doubleEscapeAction?: 'tree' | 'fork' | 'none';
  treeFilterMode?: 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all';
  defaultProjectTrust?: 'ask' | 'always' | 'never';
  defaultTools?: string[];
  codemode?: { mode?: 'on' | 'only'; inlineBudget?: number };
  sessionDir?: string;
  compaction?: PiCompactionSettings;
  branchSummary?: { reserveTokens?: number; skipPrompt?: boolean };
  theme?: string;
  quietStartup?: boolean | 'header';
  tuiMode?: PiTuiMode;
  fullscreenExitOutput?: 'transcript' | 'resume-hint';
  fullscreenScrollbar?: 'auto' | 'always' | 'hidden';
  fullscreenCopyOnSelect?: boolean;
  fullscreenWheelScrollLines?: 'auto' | number;
  editorPaddingX?: number;
  outputPad?: 0 | 1;
  autocompleteMaxVisible?: number;
  showHardwareCursor?: boolean;
  terminal?: {
    showImages?: boolean;
    imageWidthCells?: number;
    clearOnShrink?: boolean;
    showTerminalProgress?: boolean;
    hyperlinks?: boolean | 'auto';
    images?: 'kitty' | 'iterm2' | 'auto' | false;
    trueColor?: boolean | 'auto';
  };
  images?: { autoResize?: boolean; blockImages?: boolean };
  markdown?: { codeBlockIndent?: string; mermaid?: 'off' | 'final' | 'streaming' };
  transport?: 'auto' | 'sse' | 'websocket' | 'websocket-cached';
  httpProxy?: string;
  httpIdleTimeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  retry?: PiRetrySettings;
  shellPath?: string;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  packages?: PiPackageSource[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  enableSkillCommands?: boolean;
  collapseChangelog?: boolean;
  enableInstallTelemetry?: boolean;
  enableAnalytics?: boolean;
  trackingId?: string;
  deviceId?: string;
  warnings?: { anthropicExtraUsage?: boolean };
}

export interface PiSettingsDiagnostic {
  scope: PiSettingsScope;
  path: string;
  setting?: string;
  message: string;
}

export interface PiSettingProvenance {
  scopes: PiSettingsScope[];
  paths: string[];
}

export interface ResolvedPiSettings {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  paths: Record<PiSettingsScope, string>;
  globalSettings: PiSettings;
  projectSettings: PiSettings;
  settings: PiSettings;
  /** Effective leaf setting to contributing files. Keys use dotted paths. */
  provenance: Record<string, PiSettingProvenance>;
  diagnostics: PiSettingsDiagnostic[];
}

export interface LoadPiSettingsOptions {
  cwd: string;
  agentDir?: string;
  homeDir?: string;
  projectTrusted?: boolean;
  /** Pi reads project sessionDir before trust so it can locate sessions. */
  includeUntrustedProjectSessionDir?: boolean;
  maxFileBytes?: number;
}

type Schema =
  | { kind: 'string'; nonEmpty?: boolean; maxLength?: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly unknown[] }
  | { kind: 'integer'; minimum?: number; maximum?: number }
  | { kind: 'array'; item: Schema; maxItems?: number }
  | { kind: 'object'; fields: Record<string, Schema>; required?: readonly string[]; maxProperties?: number }
  | { kind: 'record'; value: Schema; maxEntries?: number; maxKeyLength?: number }
  | { kind: 'union'; variants: readonly Schema[] };

const DEFAULT_MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_DIAGNOSTICS = 128;
const INVALID = Symbol('invalid-setting');
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const RESOURCE_FIELDS = ['packages', 'extensions', 'skills', 'prompts', 'themes'] as const;
const GLOBAL_ONLY_FIELDS = ['cacheWarming', 'defaultProjectTrust', 'httpProxy', 'deviceId'] as const;

const text = (maxLength = 4_096, nonEmpty = false): Schema => ({ kind: 'string', maxLength, nonEmpty });
const bool: Schema = { kind: 'boolean' };
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Schema => ({
  kind: 'integer', minimum, maximum,
});
const enumeration = (...values: readonly unknown[]): Schema => ({ kind: 'enum', values });
const list = (item: Schema, maxItems = 256): Schema => ({ kind: 'array', item, maxItems });
const object = (
  fields: Record<string, Schema>,
  required: readonly string[] = [],
): Schema => ({ kind: 'object', fields, required, maxProperties: Math.max(32, Object.keys(fields).length + 8) });
const record = (value: Schema, maxEntries = 512, maxKeyLength = 500): Schema => ({
  kind: 'record', value, maxEntries, maxKeyLength,
});
const union = (...variants: readonly Schema[]): Schema => ({ kind: 'union', variants });

const pathList = list(text(4_096, true));
const packageSource = union(
  text(4_096, true),
  object({
    source: text(4_096, true),
    autoload: bool,
    extensions: pathList,
    skills: pathList,
    prompts: pathList,
    themes: pathList,
  }, ['source']),
);
const compactionModelOverride = object({ reserveTokens: integer(), keepRecentTokens: integer() });
const settingsSchema = object({
  lastChangelogVersion: text(128, true),
  defaultProvider: text(128, true),
  defaultModel: text(500, true),
  defaultThinkingLevel: enumeration(...THINKING_LEVELS),
  modelThinkingLevels: record(enumeration(...THINKING_LEVELS)),
  thinkingBudgets: object({ minimal: integer(), low: integer(), medium: integer(), high: integer() }),
  enabledModels: list(text(500, true)),
  hideThinkingBlock: bool,
  showCacheMissNotices: bool,
  cacheWarming: enumeration('off', 'streaming', 'idle'),
  steeringMode: enumeration('all', 'one-at-a-time'),
  followUpMode: enumeration('all', 'one-at-a-time'),
  externalEditor: text(4_096, true),
  doubleEscapeAction: enumeration('tree', 'fork', 'none'),
  treeFilterMode: enumeration('default', 'no-tools', 'user-only', 'labeled-only', 'all'),
  defaultProjectTrust: enumeration('ask', 'always', 'never'),
  defaultTools: list(text(128, true)),
  codemode: object({ mode: enumeration('on', 'only'), inlineBudget: integer() }),
  sessionDir: text(4_096, true),
  compaction: object({
    enabled: bool,
    reserveTokens: integer(),
    keepRecentTokens: integer(),
    modelOverrides: record(compactionModelOverride),
  }),
  branchSummary: object({ reserveTokens: integer(), skipPrompt: bool }),
  theme: text(4_096, true),
  quietStartup: union(bool, enumeration('header')),
  tuiMode: enumeration('regular', 'fullscreen'),
  fullscreenExitOutput: enumeration('transcript', 'resume-hint'),
  fullscreenScrollbar: enumeration('auto', 'always', 'hidden'),
  fullscreenCopyOnSelect: bool,
  fullscreenWheelScrollLines: union(enumeration('auto'), integer(1, 100)),
  editorPaddingX: integer(0, 3),
  outputPad: enumeration(0, 1),
  autocompleteMaxVisible: integer(3, 20),
  showHardwareCursor: bool,
  terminal: object({
    showImages: bool,
    imageWidthCells: integer(1, 1_000),
    clearOnShrink: bool,
    showTerminalProgress: bool,
    hyperlinks: union(bool, enumeration('auto')),
    images: union(enumeration('kitty', 'iterm2', 'auto'), enumeration(false)),
    trueColor: union(bool, enumeration('auto')),
  }),
  images: object({ autoResize: bool, blockImages: bool }),
  markdown: object({ codeBlockIndent: text(128), mermaid: enumeration('off', 'final', 'streaming') }),
  transport: enumeration('auto', 'sse', 'websocket', 'websocket-cached'),
  httpProxy: text(4_096, true),
  httpIdleTimeoutMs: integer(),
  websocketConnectTimeoutMs: integer(),
  retry: object({
    enabled: bool,
    maxRetries: integer(0, 10),
    baseDelayMs: integer(),
    maxAgentDelayMs: integer(),
    provider: object({ timeoutMs: integer(), maxRetries: integer(0, 10), maxRetryDelayMs: integer() }),
  }),
  shellPath: text(4_096, true),
  shellCommandPrefix: text(100_000),
  npmCommand: list(text(4_096, true), 64),
  packages: list(packageSource),
  extensions: pathList,
  skills: pathList,
  prompts: pathList,
  themes: pathList,
  enableSkillCommands: bool,
  collapseChangelog: bool,
  enableInstallTelemetry: bool,
  enableAnalytics: bool,
  trackingId: text(256, true),
  deviceId: text(256, true),
  warnings: object({ anthropicExtraUsage: bool }),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesSchema(value: unknown, schema: Schema): boolean {
  switch (schema.kind) {
    case 'string': return typeof value === 'string'
      && (!schema.nonEmpty || value.trim().length > 0)
      && (schema.maxLength === undefined || value.length <= schema.maxLength);
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return schema.values.some(candidate => Object.is(candidate, value));
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
      && value >= (schema.minimum ?? Number.MIN_SAFE_INTEGER)
      && value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
    case 'array': return Array.isArray(value)
      && value.length <= (schema.maxItems ?? Number.MAX_SAFE_INTEGER)
      && value.every(item => matchesSchema(item, schema.item));
    case 'object': return isObject(value)
      && Object.keys(value).length <= (schema.maxProperties ?? Number.MAX_SAFE_INTEGER)
      && (schema.required ?? []).every(key => Object.hasOwn(value, key))
      && Object.entries(value).every(([key, item]) => schema.fields[key] !== undefined
        && matchesSchema(item, schema.fields[key]!));
    case 'record': return isObject(value)
      && Object.keys(value).length <= (schema.maxEntries ?? Number.MAX_SAFE_INTEGER)
      && Object.entries(value).every(([key, item]) => key.length <= (schema.maxKeyLength ?? Number.MAX_SAFE_INTEGER)
        && matchesSchema(item, schema.value));
    case 'union': return schema.variants.some(variant => matchesSchema(value, variant));
  }
}

function schemaDescription(schema: Schema): string {
  switch (schema.kind) {
    case 'string': return schema.nonEmpty ? 'a non-empty string' : 'a string';
    case 'boolean': return 'a boolean';
    case 'enum': return `one of ${schema.values.map(value => JSON.stringify(value)).join(', ')}`;
    case 'integer': return `a safe integer from ${schema.minimum ?? Number.MIN_SAFE_INTEGER} to ${schema.maximum ?? Number.MAX_SAFE_INTEGER}`;
    case 'array': return 'an array with valid entries';
    case 'object': return 'an object with documented fields';
    case 'record': return 'an object with valid entries';
    case 'union': return schema.variants.map(schemaDescription).join(' or ');
  }
}

function addDiagnostic(
  diagnostics: PiSettingsDiagnostic[],
  diagnostic: PiSettingsDiagnostic,
): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
}

function validateValue(
  value: unknown,
  schema: Schema,
  setting: string,
  scope: PiSettingsScope,
  filePath: string,
  diagnostics: PiSettingsDiagnostic[],
): unknown | typeof INVALID {
  const invalid = (): typeof INVALID => {
    addDiagnostic(diagnostics, {
      scope,
      path: filePath,
      ...(setting ? { setting } : {}),
      message: `Invalid setting "${setting || '<root>'}": expected ${schemaDescription(schema)}.`,
    });
    return INVALID;
  };

  if (schema.kind === 'object') {
    if (!isObject(value) || Object.keys(value).length > (schema.maxProperties ?? Number.MAX_SAFE_INTEGER)
      || !(schema.required ?? []).every(key => Object.hasOwn(value, key))) return invalid();
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const childSetting = setting ? `${setting}.${key}` : key;
      const childSchema = schema.fields[key];
      if (!childSchema) {
        addDiagnostic(diagnostics, {
          scope,
          path: filePath,
          setting: childSetting,
          message: `Unknown setting "${childSetting}" was ignored.`,
        });
        continue;
      }
      const validated = validateValue(item, childSchema, childSetting, scope, filePath, diagnostics);
      if (validated !== INVALID) result[key] = validated;
    }
    return result;
  }
  if (schema.kind === 'record') {
    if (!isObject(value) || Object.keys(value).length > (schema.maxEntries ?? Number.MAX_SAFE_INTEGER)) return invalid();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      if (key.length > (schema.maxKeyLength ?? Number.MAX_SAFE_INTEGER)) {
        addDiagnostic(diagnostics, {
          scope,
          path: filePath,
          setting,
          message: `Invalid setting "${setting}": a key exceeds the configured length limit.`,
        });
        continue;
      }
      const validated = validateValue(item, schema.value, `${setting}.${key}`, scope, filePath, diagnostics);
      if (validated !== INVALID) Object.defineProperty(result, key, {
        value: validated, enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  }
  if (schema.kind === 'union') {
    const variant = schema.variants.find(candidate => matchesSchema(value, candidate));
    return variant ? validateValue(value, variant, setting, scope, filePath, diagnostics) : invalid();
  }
  if (!matchesSchema(value, schema)) return invalid();
  if (schema.kind === 'array') return structuredClone(value);
  return value;
}

function migrateSettings(input: Record<string, unknown>): Record<string, unknown> {
  const settings = { ...input };
  if (settings.steeringMode === undefined && settings.queueMode !== undefined) {
    settings.steeringMode = settings.queueMode;
  }
  delete settings.queueMode;
  if (settings.transport === undefined && typeof settings.websockets === 'boolean') {
    settings.transport = settings.websockets ? 'websocket' : 'sse';
  }
  delete settings.websockets;
  if (isObject(settings.skills) && !Array.isArray(settings.skills)) {
    const legacy = settings.skills;
    if (settings.enableSkillCommands === undefined && legacy.enableSkillCommands !== undefined) {
      settings.enableSkillCommands = legacy.enableSkillCommands;
    }
    settings.skills = Array.isArray(legacy.customDirectories) ? legacy.customDirectories : undefined;
  }
  if (isObject(settings.retry) && typeof settings.retry.maxDelayMs === 'number') {
    const retry = { ...settings.retry };
    const provider = isObject(retry.provider) ? { ...retry.provider } : {};
    if (provider.maxRetryDelayMs === undefined) provider.maxRetryDelayMs = retry.maxDelayMs;
    delete retry.maxDelayMs;
    retry.provider = provider;
    settings.retry = retry;
  }
  return settings;
}

function validateSettings(
  input: Record<string, unknown>,
  scope: PiSettingsScope,
  filePath: string,
  diagnostics: PiSettingsDiagnostic[],
): PiSettings {
  const migrated = migrateSettings(input);
  const validated = validateValue(migrated, settingsSchema, '', scope, filePath, diagnostics);
  return validated === INVALID ? {} : validated as PiSettings;
}

async function readBoundedSettingsFile(filePath: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Settings source must be a regular file and cannot be a symbolic link.');
  }
  if (before.size > maxBytes) throw new Error(`Settings source exceeds the ${maxBytes} byte limit.`);

  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error('Settings source changed while it was being opened.');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Settings source exceeds the ${maxBytes} byte limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Settings source changed while it was being read.');
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.includes(0)) throw new Error('Settings source must be UTF-8 text, not binary data.');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    } catch {
      throw new Error('Settings source is not valid UTF-8 text.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { throw new Error('Settings source is not valid JSON.'); }
    if (!isObject(parsed)) throw new Error('Settings source root must be a JSON object.');
    return parsed;
  } finally {
    await handle.close();
  }
}

async function loadLayer(
  scope: PiSettingsScope,
  filePath: string,
  maxBytes: number,
  diagnostics: PiSettingsDiagnostic[],
): Promise<PiSettings> {
  try {
    const parsed = await readBoundedSettingsFile(filePath, maxBytes);
    return parsed ? validateSettings(parsed, scope, filePath, diagnostics) : {};
  } catch (error) {
    addDiagnostic(diagnostics, {
      scope,
      path: filePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...cloneValue(base) };
  for (const [key, value] of Object.entries(overrides)) {
    const inherited = Object.hasOwn(result, key) ? result[key] : undefined;
    Object.defineProperty(result, key, {
      value: isObject(inherited) && isObject(value)
        ? deepMerge(inherited, value)
        : cloneValue(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function onlyToolModifiers(entries: readonly string[]): boolean {
  return entries.every(entry => entry.startsWith('+') || entry.startsWith('-'));
}

/** Merge validated global/project layers using Pi object and resource-list rules. */
export function mergePiSettings(globalSettings: PiSettings, projectSettings: PiSettings): PiSettings {
  const merged = deepMerge(
    globalSettings as Record<string, unknown>,
    projectSettings as Record<string, unknown>,
  ) as PiSettings;
  for (const field of RESOURCE_FIELDS) {
    const globalValue = globalSettings[field];
    const projectValue = projectSettings[field];
    if (globalValue !== undefined || projectValue !== undefined) {
      Object.assign(merged, { [field]: [...(globalValue ?? []), ...(projectValue ?? [])] });
    }
  }
  if (projectSettings.defaultTools !== undefined) {
    merged.defaultTools = onlyToolModifiers(projectSettings.defaultTools)
      ? [...(globalSettings.defaultTools ?? []), ...projectSettings.defaultTools]
      : [...projectSettings.defaultTools];
  }
  return merged;
}

function hasOwnPath(value: unknown, segments: readonly string[]): boolean {
  let current = value;
  for (const segment of segments) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function collectLeafPaths(value: unknown, prefix: string[] = [], output: string[][] = []): string[][] {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) collectLeafPaths(child, [...prefix, key], output);
  } else {
    output.push(prefix);
  }
  return output;
}

function buildProvenance(
  settings: PiSettings,
  globalSettings: PiSettings,
  projectSettings: PiSettings,
  paths: Record<PiSettingsScope, string>,
): Record<string, PiSettingProvenance> {
  const provenance: Record<string, PiSettingProvenance> = {};
  for (const segments of collectLeafPaths(settings)) {
    if (!segments.length) continue;
    const top = segments[0]! as keyof PiSettings;
    const global = hasOwnPath(globalSettings, segments);
    const project = hasOwnPath(projectSettings, segments);
    const mergedList = (RESOURCE_FIELDS as readonly string[]).includes(top)
      || (top === 'defaultTools' && projectSettings.defaultTools !== undefined
        && onlyToolModifiers(projectSettings.defaultTools));
    const scopes: PiSettingsScope[] = mergedList
      ? [...(global ? ['global' as const] : []), ...(project ? ['project' as const] : [])]
      : project ? ['project'] : global ? ['global'] : [];
    if (scopes.length) {
      provenance[segments.join('.')] = { scopes, paths: scopes.map(scope => paths[scope]) };
    }
  }
  return provenance;
}

/**
 * Load bounded Pi settings without creating files. Project values are trust-gated,
 * except sessionDir, which Pi needs before selecting the session and resolving trust.
 */
export async function loadPiSettings(options: LoadPiSettingsOptions): Promise<ResolvedPiSettings> {
  const cwd = path.resolve(options.cwd);
  const homeDir = options.homeDir ?? os.homedir();
  const agentDir = resolvePiAgentDirectory(options.agentDir, homeDir);
  const projectTrusted = options.projectTrusted === true;
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_SETTINGS_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('maxFileBytes must be a positive safe integer.');
  }
  const paths = {
    global: path.join(agentDir, 'settings.json'),
    project: path.join(cwd, '.pi', 'settings.json'),
  };
  const diagnostics: PiSettingsDiagnostic[] = [];
  const globalSettings = await loadLayer('global', paths.global, maxBytes, diagnostics);
  let projectSettings: PiSettings = {};
  if (projectTrusted) {
    projectSettings = await loadLayer('project', paths.project, maxBytes, diagnostics);
    for (const field of GLOBAL_ONLY_FIELDS) {
      if (projectSettings[field] !== undefined) {
        delete projectSettings[field];
        addDiagnostic(diagnostics, {
          scope: 'project',
          path: paths.project,
          setting: field,
          message: `Project setting "${field}" was ignored because it is global-only.`,
        });
      }
    }
  } else if (options.includeUntrustedProjectSessionDir !== false) {
    try {
      const parsed = await readBoundedSettingsFile(paths.project, maxBytes);
      if (parsed && Object.hasOwn(parsed, 'sessionDir')) {
        const validated = validateValue(parsed.sessionDir, settingsSchema.kind === 'object'
          ? settingsSchema.fields.sessionDir! : text(), 'sessionDir', 'project', paths.project, diagnostics);
        if (validated !== INVALID) projectSettings.sessionDir = validated as string;
      }
    } catch (error) {
      addDiagnostic(diagnostics, {
        scope: 'project',
        path: paths.project,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const settings = mergePiSettings(globalSettings, projectSettings);
  return {
    agentDir,
    cwd,
    projectTrusted,
    paths,
    globalSettings: cloneValue(globalSettings),
    projectSettings: cloneValue(projectSettings),
    settings: cloneValue(settings),
    provenance: buildProvenance(settings, globalSettings, projectSettings, paths),
    diagnostics,
  };
}

/** Resolve Pi defaultTools modifiers against the built-in default declaration. */
export function resolvePiDefaultTools(
  entries: readonly string[] | undefined,
  defaults: readonly string[],
): string[] | undefined {
  if (entries === undefined) return undefined;
  const plain = entries.filter(entry => !entry.startsWith('+') && !entry.startsWith('-'));
  const selected = plain.length > 0 || entries.length === 0 ? [...plain] : [...defaults];
  for (const entry of entries) {
    const operation = entry[0];
    if (operation !== '+' && operation !== '-') continue;
    const name = entry.slice(1);
    if (!name) continue;
    const index = selected.indexOf(name);
    if (operation === '+' && index < 0) selected.push(name);
    if (operation === '-' && index >= 0) selected.splice(index, 1);
  }
  return selected;
}

export function resolvePiCompactionSettings(
  settings: PiSettings,
  provider?: string,
  model?: string,
): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
  const override = provider && model ? settings.compaction?.modelOverrides?.[`${provider}/${model}`] : undefined;
  return {
    enabled: settings.compaction?.enabled ?? true,
    reserveTokens: override?.reserveTokens ?? settings.compaction?.reserveTokens ?? 16_384,
    keepRecentTokens: override?.keepRecentTokens ?? settings.compaction?.keepRecentTokens ?? 20_000,
  };
}

export function resolvePiThinkingLevel(
  settings: PiSettings,
  provider?: string,
  model?: string,
): ThinkingLevel | undefined {
  return (provider && model ? settings.modelThinkingLevels?.[`${provider}/${model}`] : undefined)
    ?? settings.defaultThinkingLevel;
}

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  return value;
}

/** Resolve one configured session directory relative to cwd, as Pi documents. */
export function resolvePiSettingsPath(value: string, cwd: string, homeDir = os.homedir()): string {
  return path.resolve(cwd, expandHome(value, homeDir));
}

export type PiResourcePathField = 'extensions' | 'skills' | 'prompts' | 'themes';

function resolveResourceEntry(entry: string, base: string, homeDir: string): string {
  const marker = entry[0] === '+' || entry[0] === '-' || entry[0] === '!' ? entry[0] : '';
  const value = marker ? entry.slice(1) : entry;
  if (value.startsWith('builtin:')) return entry;
  const resolved = path.resolve(base, expandHome(value, homeDir));
  return `${marker}${resolved}`;
}

/** Apply Pi's ordered exact/glob exclusions to already resolved resource entries. */
export function selectPiResourcePaths(entries: readonly string[]): string[] {
  const selected: string[] = [];
  for (const entry of entries) {
    const marker = entry[0] === '+' || entry[0] === '-' || entry[0] === '!' ? entry[0] : '';
    const value = marker ? entry.slice(1) : entry;
    if (!value) continue;
    if (marker === '-' || marker === '!') {
      for (let index = selected.length - 1; index >= 0; index--) {
        const candidate = selected[index]!;
        let matches = marker === '-' ? candidate === value : false;
        if (marker === '!') {
          try { matches = path.matchesGlob(candidate, value); }
          catch { matches = false; }
        }
        if (matches) selected.splice(index, 1);
      }
    } else if (!selected.includes(value)) {
      selected.push(value);
    }
  }
  return selected;
}

/** Resolve resource paths from their layer-specific base directories without crossing trust. */
export function resolvePiResourcePaths(
  resolved: ResolvedPiSettings,
  field: PiResourcePathField,
  homeDir = os.homedir(),
  scope: PiSettingsScope | 'all' = 'all',
): string[] {
  return [
    ...(scope !== 'project' ? (resolved.globalSettings[field] ?? []).map(entry => (
      resolveResourceEntry(entry, resolved.agentDir, homeDir)
    )) : []),
    ...(scope !== 'global' && resolved.projectTrusted ? (resolved.projectSettings[field] ?? []).map(entry => (
      resolveResourceEntry(entry, path.join(resolved.cwd, '.pi'), homeDir)
    )) : []),
  ];
}
