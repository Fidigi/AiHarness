// ============================================================
// Core Package - Main Entry Point
// ============================================================

// Types
export * from './types/index.js';

// Providers
export {
  AiProvider,
  ProviderFactory,
  OpenAiProvider,
  AnthropicProvider,
  GeminiProvider,
  VertexGeminiProvider,
  BedrockProvider,
  LocalProvider,
  MockProvider,
} from './providers/index.js';

export type { ChatResponse, StreamEvent, ChatOptions, ChatToolDefinition, ThinkingLevel } from './providers/index.js';

// Sessions
export {
  SessionManager,
  JsonlSessionStore,
} from './sessions/session-manager.js';
export type { SessionEntry } from './sessions/session-manager.js';
export {
  CompactionService,
  TokenEstimator,
} from './sessions/compaction.js';
export type { CompactionConfig, CompactionResult } from './sessions/compaction.js';

// Extensions
export * from './extensions/index.js';

// Utils
export * from './utils/index.js';
