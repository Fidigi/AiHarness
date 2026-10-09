// ============================================================
// Core Package - Main Entry Point
// ============================================================

// Public contract versions and types
export {
  AI_HARNESS_CORE_API_VERSION,
  AI_HARNESS_EXTENSION_API_VERSION,
} from './public-api-version.js';
export * from './types/index.js';

// Providers
export * from './providers/specialized-models.js';
export {
  AiProvider,
  ProviderFactory,
  OpenAiProvider,
  OpenAiResponsesProvider,
  getOpenAiResponsesTransportStats,
  resetOpenAiResponsesTransportStats,
  AnthropicProvider,
  GeminiProvider,
  VertexGeminiProvider,
  BedrockProvider,
  LocalProvider,
  MockProvider,
  normalizeProviderUsage,
} from './providers/index.js';

export {
  acquireProviderWebSocket,
  closeProviderNetworkDispatchers,
  createProviderNetworkScope,
  fetchProviderResponse,
  PROVIDER_NETWORK_SCOPE,
  ProviderNetworkError,
} from './providers/provider-network.js';
export type {
  AcquireProviderWebSocketOptions,
  ProviderFetchOptions,
  ProviderNetworkScope,
  ProviderWebSocket,
  ProviderWebSocketFactory,
  ProviderWebSocketLease,
} from './providers/provider-network.js';
export {
  CredentialRedactor,
  ProviderCredentialError,
  ProviderCredentialService,
  providerCredentialEnvironmentKeys,
  redactCredentialText,
} from './providers/credentials.js';
export type {
  CredentialRedactionStream,
  ProviderApiKeyCredential,
  ProviderCredential,
  ProviderCredentialDescriptor,
  ProviderCredentialServiceOptions,
  ProviderCredentialSource,
  ProviderOAuthCredential,
  ProviderOAuthRefreshConfig,
  ResolvedProviderCredential,
  ResolveProviderCredentialOptions,
} from './providers/credentials.js';

export type {
  ChatResponse,
  OpenAiResponsesTransportStats,
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
  resolveAgentProviderNetworkSettings,
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
  AgentProviderNetworkSettings,
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
  isValidSessionId,
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
export { AgentMessageQueue, parseAgentQueueMode } from './agent/message-queue.js';
export type {
  AgentMessageQueueBatch,
  AgentMessageQueueKind,
  AgentMessageQueueOptions,
  AgentMessageQueueSnapshot,
  ClearedAgentMessages,
} from './agent/message-queue.js';
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

// Shared coding tools, MCP configuration inventory, and prompt inputs
export * from './tools/index.js';
export * from './mcp/index.js';
export * from './prompts/index.js';

// Extensions and package resources
export * from './extensions/index.js';
export * from './plugins/index.js';
export * from './resources/index.js';
export * from './themes/index.js';

// Shared workspace security (explicit exports keep browser type-only imports tree-shakeable)
export {
  atomicWriteStableFile,
  CredentialStoreError,
  EncryptedCredentialStore,
  credentialValuesEqual,
  FRESH_PROJECT_SCAN_DEPTH,
  FRESH_PROJECT_SCAN_MAX_DIRECTORIES,
  inspectProjectTrustResources,
  openStableDirectoryHandle,
  ProjectTrustManager,
  readStableDirectoryEntries,
  readStableDirectorySnapshot,
  resolveProjectTrust,
  StableFileError,
  WORKSPACE_BROWSE_ENTRY_LIMIT,
  WorkspaceManager,
  WorkspacePathError,
} from './security/index.js';
export type {
  AtomicStableFileOptions,
  EncryptedCredentialStoreOptions,
  DirectoryEntry,
  FreshProjectTrustBlockReason,
  FreshProjectTrustBreadth,
  FreshProjectTrustBreadthKind,
  FreshProjectTrustOptions,
  FreshProjectTrustStatus,
  FreshProjectTrustWriteResult,
  GitWorktree,
  ProjectTrustDecision,
  ProjectTrustDecisionEntry,
  ProjectTrustDefault,
  ProjectTrustInspection,
  ProjectTrustInspectionOptions,
  ProjectTrustPromptChoice,
  ProjectTrustPromptRequest,
  ProjectTrustResource,
  ProjectTrustStatus,
  ProjectTrustUpdate,
  ResolvedProjectTrust,
  ResolveProjectTrustOptions,
  StableDirectoryListing,
  StableDirectorySnapshot,
  StableDirectorySnapshotEntry,
  StableFileErrorCode,
  WorkspaceDescriptor,
  WorkspacePathKind,
} from './security/index.js';

// Host desktop integration
export * from './system/index.js';

// Utils
export * from './utils/index.js';
