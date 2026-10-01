// ============================================================
// Core Types for AiHarness
// ============================================================

/** Message role in a conversation */
export type Role = 'user' | 'assistant' | 'system' | 'tool';

/** Current on-disk and API session schema. Legacy JSONL entries have no version. */
export const SESSION_SCHEMA_VERSION = 2 as const;

/** A normalized model-requested tool call. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Normalized token and cost accounting. All counters are optional when unavailable. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

/** Rich message blocks. `Message.content` remains the plain-text compatibility view. */
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; durationMs?: number }
  | {
      type: 'image';
      mediaType: string;
      name?: string;
      size?: number;
      /** A data URL or server-managed attachment URL. */
      url: string;
      width?: number;
      height?: number;
    }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolCallId: string;
      name?: string;
      content: string;
      /** Complete result retained when `content` was bounded for the model context. */
      fullContent?: string;
      isError?: boolean;
      truncated?: boolean;
      downloadUrl?: string;
    }
  | {
      type: 'command';
      command: string;
      cwd: string;
      output?: string;
      status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
      exitCode?: number;
      durationMs?: number;
      excludedFromContext?: boolean;
      truncated?: boolean;
      downloadUrl?: string;
    };

/** A command persisted independently from chat messages. */
export interface ShellCommandRecord {
  id: string;
  command: string;
  cwd: string;
  timestamp: Date;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  output?: string;
  exitCode?: number;
  durationMs?: number;
  excludedFromContext?: boolean;
  truncated?: boolean;
  downloadPath?: string;
}

/** A single message in a conversation. */
export interface Message {
  id: string;
  role: Role;
  /** Plain-text compatibility representation used by providers and legacy clients. */
  content: string;
  timestamp: Date;
  blocks?: MessageContentBlock[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
  provider?: string;
  model?: string;
  usage?: TokenUsage;
  durationMs?: number;
  parentMessageId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/** Configuration for an AI provider */
export interface ProviderConfig {
  /** Built-in provider type or an operator-defined provider id. */
  type: ProviderType | string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  [key: string]: unknown;
}

/** Capabilities advertised by a model catalogue entry. */
export interface ModelCapabilities {
  reasoning: boolean;
  imageInput: boolean;
  toolCalls: boolean;
}

export interface ModelPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export type ProviderDialect = 'openai-completions' | 'openai-responses' | 'anthropic' | 'google';

/** Public metadata for an operator-managed provider. Header values and credentials never cross the API. */
export interface CustomProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
  dialect: ProviderDialect;
  configured: boolean;
  headerNames: string[];
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ProviderAuthMethod = 'none' | 'api-key' | 'environment' | 'oauth';

export interface ProviderAuthStatus {
  type: string;
  name: string;
  configured: boolean;
  connected: boolean;
  method: ProviderAuthMethod;
  environmentVariable?: string;
  reconnectSupported: boolean;
  disconnectSupported: boolean;
  usage?: {
    requests?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  lastCheckedAt?: string;
  error?: string;
}

export interface CustomModelDefinition {
  key: string;
  provider: string;
  id: string;
  name: string;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
  compatibility?: Record<string, boolean | number | string>;
  createdAt: string;
  updatedAt: string;
}

export type ModelCatalogSource = 'published' | 'configured' | 'discovered' | 'custom';

/** A non-secret model descriptor returned by the server catalogue. */
export interface ModelCatalogEntry {
  /** Stable provider-qualified identifier used by enabled-model settings. */
  key: string;
  provider: string;
  id: string;
  name: string;
  available: boolean;
  enabled: boolean;
  source: ModelCatalogSource;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
  compatibility?: Record<string, boolean | number | string>;
}

export interface ProviderModelCatalog {
  provider: string;
  configured: boolean;
  models: ModelCatalogEntry[];
}

export interface ModelCatalog {
  updatedAt: string;
  enabledScope: ConfigurationScope | 'default' | 'environment';
  enabledSource: string;
  providers: ProviderModelCatalog[];
}

export type SkillCatalogScope = 'global' | 'project' | 'path' | 'package';

/** Non-secret metadata for a discovered Agent Skills specification document. */
export interface SkillCatalogEntry {
  key: string;
  name: string;
  description: string;
  version?: string;
  scope: SkillCatalogScope;
  source: string;
  filePath: string;
  trusted: boolean;
  defaultModelInvocable: boolean;
  modelInvocable: boolean;
}

export interface SkillDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface SkillCatalog {
  updatedAt: string;
  projectId: string;
  cwd: string;
  projectTrusted: boolean;
  enabledScope: ConfigurationScope | 'default' | 'environment';
  enabledSource: string;
  skills: SkillCatalogEntry[];
  errorCount: number;
  diagnostics?: SkillDiagnostic[];
}

export interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  downloadUrl: string;
  sha256: string;
  homepage?: string;
  installed?: { scope: 'global' | 'project'; version?: string; updateAvailable: boolean };
}

export interface SkillRegistry {
  source: string;
  updatedAt: string;
  entries: SkillRegistryEntry[];
  error?: string;
}

export type PluginScope = 'global' | 'project';
export type PluginSourceType = 'npm' | 'git' | 'path';
export type PluginResourceKind = 'extension' | 'skill' | 'prompt' | 'theme';

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

/** Public plugin diagnostics never contain command output, credentials, or resource contents. */
export interface PluginDiagnostic {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  /** Safe display path; package resource contents are never returned by the catalogue. */
  path: string;
  relativePath: string;
}

export interface PluginPackageInfo {
  key: string;
  source: string;
  sourceType: PluginSourceType;
  scope: PluginScope;
  enabled: boolean;
  trusted: boolean;
  canCheckForUpdates: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  description?: string;
  installedRevision?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  diagnostics: PluginDiagnostic[];
  status: 'active' | 'installed' | 'missing' | 'disabled' | 'error';
  /** Executable extension changes cannot be applied by a metadata-only resource reload. */
  restartRequired: boolean;
  installedAt: string;
  updatedAt: string;
}

export interface PluginStandaloneExtensionInfo extends PluginResourceInfo {
  kind: 'extension';
  scope: PluginScope;
  enabled: boolean;
  trusted: boolean;
}

export interface PluginCatalog {
  updatedAt: string;
  generation: number;
  cwd: string;
  projectId: string;
  projectTrusted: boolean;
  projectResourcesLoaded: boolean;
  packages: PluginPackageInfo[];
  standaloneExtensions: PluginStandaloneExtensionInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
}

export type PluginUpdateState = 'update-available' | 'up-to-date' | 'unsupported' | 'error';

export interface PluginUpdateResult {
  key: string;
  source: string;
  scope: PluginScope;
  displayName: string;
  type: PluginSourceType;
  state: PluginUpdateState;
  installedVersion?: string;
  availableVersion?: string;
  message?: string;
}

export interface PluginReloadResult {
  reloadedAt: string;
  generation: number;
  sessionId?: string;
  resourceCounts: PluginResourceCounts;
  restartRequired: boolean;
  message: string;
}

export type SubagentProfileKind = 'explore' | 'general' | 'plan' | 'custom';

/** A reusable, non-secret execution policy for a child agent. */
export interface SubagentProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  kind: SubagentProfileKind;
  enabled: boolean;
  builtIn: boolean;
  tools: string[];
  skills: string[];
  extensions: string[];
  model?: string;
  thinking?: Session['thinking'];
  maxTurns: number;
  inheritContext: boolean;
  background: boolean;
}

export interface SubagentConfiguration {
  updatedAt: string;
  projectId?: string;
  cwd?: string;
  scope: 'global' | 'project';
  source: string;
  engineEnabled: boolean;
  maxConcurrency: number;
  profiles: SubagentProfile[];
}

export type SubagentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

/** Public state for one child-agent execution. */
export interface SubagentRunSnapshot {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  workspaceId?: string;
  profileId: string;
  profileName: string;
  task: string;
  provider: string;
  model?: string;
  status: SubagentRunStatus;
  phase: string;
  background: boolean;
  attention: boolean;
  turn: number;
  maxTurns: number;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
}

/** Supported AI provider types */
export enum ProviderType {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  AZURE = 'azure',
  BEDROCK = 'bedrock',
  VERTEX = 'vertex',
  LOCAL = 'local',
  CUSTOM = 'custom',
  MOCK = 'mock',
}

/** A session represents a conversation thread. Optional fields preserve v1 callers. */
export interface Session {
  id: string;
  schemaVersion?: typeof SESSION_SCHEMA_VERSION;
  title?: string;
  messages: Message[];
  commands?: ShellCommandRecord[];
  createdAt: Date;
  updatedAt: Date;
  providerConfig?: ProviderConfig;
  metadata?: Record<string, unknown>;
  parentId?: string; // For tree/fork structure
  branchId?: string; // Group related sessions (e.g., forks of same conversation)
  activeLeafId?: string;
  parentAgentId?: string;
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
  gitBranch?: string;
  model?: string;
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  toolPreset?: 'configured' | 'chat-only' | 'read-only' | 'default' | 'full';
  /** Explicit per-session override. Undefined inherits the effective scoped policy. */
  autoCompaction?: boolean;
  usage?: TokenUsage;
}

/** Prompt template for reuse */
export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  content: string;
  variables?: string[];
}

/** Skill definition */
export interface Skill {
  id: string;
  name: string;
  version: string;
  description?: string;
  entryPoint: string;
  configSchema?: Record<string, unknown>;
}

/** Extension hook point */
export interface ExtensionHook {
  name: string;
  priority?: number;
  handler: (context: unknown) => Promise<unknown> | unknown;
}

export type ConfigurationScope = 'global' | 'project' | 'session';

/** Non-secret settings that can be layered by scope. */
export interface ScopedConfigurationValues {
  provider?: string;
  model?: string;
  thinking?: Session['thinking'];
  toolPreset?: Session['toolPreset'];
  autoCompaction?: boolean;
  enabledModels?: string[];
  enabledSkills?: string[];
  enabledPlugins?: string[];
  enabledTools?: string[];
  powershellEnabled?: boolean;
  systemPrompt?: string;
}

export interface ConfigurationProvenance<T = unknown> {
  value: T;
  scope: ConfigurationScope | 'default' | 'environment';
  source: string;
}

export interface EffectiveConfiguration {
  values: ScopedConfigurationValues;
  provenance: Partial<Record<keyof ScopedConfigurationValues, ConfigurationProvenance>>;
}

export interface ToolSettingsEntry {
  name: string;
  description: string;
  extensionId: string;
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
}

export interface ToolSettings {
  scope: ConfigurationScope | 'default' | 'environment';
  source: string;
  preset: Session['toolPreset'];
  powershellAvailable: boolean;
  powershellEnabled: boolean;
  tools: ToolSettingsEntry[];
}

/** Configuration for the entire application */
export interface AppConfig {
  defaultProvider: ProviderConfig;
  sessionsDir: string;
  theme?: 'dark' | 'light';
  terminal?: TerminalConfig;
  web?: WebConfig;
}

/** CLI-specific configuration */
export interface TerminalConfig {
  theme?: string;
  keybindingsPath?: string;
  autoSaveInterval?: number; // milliseconds
}

/** A single keyboard shortcut definition */
export interface KeyBinding {
  /** Unique identifier for the binding */
  id: string;
  /** The key sequence (e.g., 'ctrl+c', 'alt+d') */
  keys: string[];
  /** Description of what this binding does */
  description?: string;
  /** Application action identifier resolved at runtime. */
  action?: string;
  /** Whether to prevent default browser/terminal behavior */
  preventDefault?: boolean;
}

/** Runtime context passed to a keybinding handler. */
export interface KeyBindingContext {
  event?: unknown;
  currentInput?: string;
  isStreaming: boolean;
}

/** Registry entry for a keybinding handler */
export interface KeyBindingHandler {
  /** The key sequence to match (e.g., 'ctrl+c') */
  keys: string[];
  /** Human-readable action description. */
  description?: string;
  /** Handler function that receives the event context */
  handler: (context: KeyBindingContext) => void | Promise<void>;
  /** Optional condition for when this binding is active */
  when?: () => boolean;
}

/** Web server configuration */
export interface WebConfig {
  port: number;
  host?: string;
  corsOrigins?: string[];
}
