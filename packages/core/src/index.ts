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
  normalizeProviderUsage,
} from './providers/index.js';

export type {
  ChatResponse,
  StreamEvent,
  StreamChunkCallback,
  ChatOptions,
  ChatToolDefinition,
  ThinkingLevel,
} from './providers/index.js';
export {
  PUBLISHED_MODEL_METADATA_VERSION,
  PUBLISHED_THINKING_LEVELS,
  getPublishedProviders,
  getPublishedModels,
  getPublishedModelMetadata,
  calculatePublishedModelCost,
  getSupportedThinkingLevels,
  clampPublishedThinkingLevel,
  inferModelCapabilities,
} from './providers/model-metadata.js';
export type {
  PublishedModelMetadata,
  PublishedThinkingLevel,
  PricedTokenUsage,
} from './providers/model-metadata.js';
export {
  loadAgentSettings,
  mergeAgentSettings,
  resolveAgentCompactionSettings,
  resolveAgentDefaultTools,
  resolveAgentResourcePaths,
  resolveAgentSettingsPath,
  selectAgentResourcePaths,
  resolveAgentThinkingLevel,
} from './config/agent-settings.js';
export type {
  LoadAgentSettingsOptions,
  AgentCacheWarmingMode,
  AgentCompactionModelOverride,
  AgentCompactionSettings,
  AgentPackageSource,
  AgentPackageSourceObject,
  AgentQueueMode,
  AgentResourcePathField,
  AgentRetrySettings,
  AgentSettingProvenance,
  AgentSettings,
  AgentSettingsDiagnostic,
  AgentSettingsScope,
  AgentTuiMode,
  ResolvedAgentSettings,
} from './config/agent-settings.js';
export {
  buildProviderModelCatalog,
  collectProviderModelCatalog,
  createProtocolModelDescriptor,
  discoverProviderModelIds,
  filterModels,
  flattenModelCatalog,
  isValidModelId,
  resolveModelReference,
  resolveModelScope,
  toProtocolModelDescriptor,
} from './providers/model-catalog.js';
export type {
  CollectModelCatalogOptions,
  ModelDiscoveryOptions,
  ModelIdentity,
  ModelScopeDiagnostic,
  ModelScopeResult,
  ProtocolModelDescriptor,
  ProviderModelState,
  ResolvedModel,
  ScopedModel,
} from './providers/model-catalog.js';

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
  AutoCompactionResult,
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
export { streamProviderTurn } from './agent/provider-turn.js';
export type { StreamProviderTurnOptions } from './agent/provider-turn.js';
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

// Shared coding tools and prompt inputs
export * from './tools/index.js';
export * from './prompts/index.js';

// Extensions
export * from './extensions/index.js';

// Shared workspace security (explicit exports keep browser type-only imports tree-shakeable)
export { ProjectTrustManager, WorkspaceManager, WorkspacePathError } from './security/index.js';
export type { WorkspaceDescriptor, DirectoryEntry, GitWorktree, WorkspacePathKind } from './security/index.js';

// Utils
export * from './utils/index.js';
