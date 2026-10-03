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
export type {
  SessionEntry,
  MessageEntry,
  CommandEntry,
  CompactionEntry,
  BranchSummaryEntry,
  SessionMetadataEntry,
  CreateSessionOptions,
  MutableSessionFields,
  MutableSessionChanges,
  AutoCompactionCallback,
  AutoCompactionPolicy,
} from './sessions/session-manager.js';
export {
  serializeSession,
  deserializeSession,
  redactProviderConfig,
} from './sessions/serialization.js';
export type {
  SerializedMessage,
  SerializedShellCommand,
  SerializedSession,
} from './sessions/serialization.js';
export {
  CompactionService,
  TokenEstimator,
} from './sessions/compaction.js';
export type { CompactionConfig, CompactionResult } from './sessions/compaction.js';

// Agent execution shared by CLI and server
export { runToolLoop, AgentAbortError } from './agent/tool-loop.js';
export type { ToolLoopOptions, ToolExecutionResult } from './agent/tool-loop.js';
export { AgentRuntime } from './agent/runtime.js';
export type { AgentRuntimeOptions, StartAgentRunRequest } from './agent/runtime.js';
export { AgentEventJournal, AGENT_EVENT_PROTOCOL_VERSION } from './agent/events.js';
export type {
  AgentPhase,
  AgentEventType,
  AgentEvent,
  AgentRunSnapshot,
  AgentRetrySnapshot,
  ActiveToolSnapshot,
  ExtensionInteractionSnapshot,
  AgentStateSnapshot,
  AgentEventReplay,
  QueuedAgentMessage,
} from './agent/events.js';

// Shared coding tools
export * from './tools/index.js';

// Extensions
export * from './extensions/index.js';

// Shared workspace security (explicit exports keep browser type-only imports tree-shakeable)
export { ProjectTrustManager, WorkspaceManager, WorkspacePathError } from './security/index.js';
export type { WorkspaceDescriptor, DirectoryEntry, GitWorktree, WorkspacePathKind } from './security/index.js';

// Utils
export * from './utils/index.js';
