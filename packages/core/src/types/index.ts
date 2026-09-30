// ============================================================
// Core Types for AiHarness
// ============================================================

/** Message role in a conversation */
export type Role = 'user' | 'assistant' | 'system' | 'tool';

/** A normalized model-requested tool call. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** A single message in a conversation */
export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: Date;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
}

/** Configuration for an AI provider */
export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  [key: string]: unknown;
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

/** A session represents a conversation thread */
export interface Session {
  id: string;
  title?: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  providerConfig?: ProviderConfig;
  metadata?: Record<string, unknown>;
  parentId?: string; // For tree/fork structure
  branchId?: string; // Group related sessions (e.g., forks of same conversation)
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
