// ============================================================
// Core Types for AiHarness
// ============================================================

/** Message role in a conversation */
export type Role = 'user' | 'assistant' | 'system';

/** A single message in a conversation */
export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: Date;
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
  LOCAL = 'local',
  CUSTOM = 'custom',
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

/** Web server configuration */
export interface WebConfig {
  port: number;
  host?: string;
  corsOrigins?: string[];
}
