import type { AgentEvent, AgentEventReplay, AgentRunSnapshot, AgentStateSnapshot, QueuedAgentMessage } from '../agent/events.js';
import type { AgentRuntimeOptions, StartAgentRunRequest } from '../agent/runtime.js';
import type { ExtensionInteractionResponse, ExtensionRegistry } from '../extensions/extension-registry.js';
import type { AiProvider } from '../providers/index.js';
import type { CredentialRedactor, ProviderCredential, ProviderCredentialDescriptor } from '../providers/credentials.js';
import type { ModelCatalogEntry, ProviderConfig, Session, Message } from '../types/index.js';
import type { AutoCompactionCallback, AutoCompactionPolicy, CreateSessionOptions, SessionEntry, SessionManager } from '../sessions/session-manager.js';
import type { SerializedSession } from '../sessions/serialization.js';
import type { AgentResourceLoader } from './resource-loader.js';
import type { ResourceInventoryItem } from '../resources/resource-manager.js';
import type { SessionStore } from './session-store.js';

export type AgentModel = ModelCatalogEntry;
export type AgentCredential = ProviderCredential;
export type AgentAuthDescriptor = ProviderCredentialDescriptor;

export type AgentBuiltinProvider = 'openai' | 'anthropic' | 'google' | 'azure' | 'vertex' | 'bedrock' | 'local' | 'mock';
export type AgentProviderConfig = ProviderConfig & { type: AgentBuiltinProvider };
export type AgentProvider =
  | { kind: 'config'; config: AgentProviderConfig }
  | { kind: 'instance'; name: string; provider: AiProvider };

/** No implicit environment/command/store credential resolution or OAuth login. */
export interface AgentAuthOptions {
  /** Borrowed, shared Core redactor. Recommended when sharing stores/providers. */
  redactor?: CredentialRedactor;
  /** Known instance/config/header secrets, registered before session creation. */
  secrets?: readonly string[];
}

export interface CreateAgentSessionOptions {
  /** Required workspace boundary. Canonicalized through Core WorkspaceManager. */
  cwd: string;
  allowedRoots?: string[];
  /** Explicit built-in config (lazy construction), or borrowed prebuilt provider. */
  provider: AgentProvider;
  /** Omitted = genuinely process-local SessionManager; no disabled disk store. */
  store?: SessionStore;
  session?:
    | { kind: 'new'; options?: Omit<CreateSessionOptions, 'cwd'> }
    | { kind: 'resume'; id: string };
  /** Fresh decision before every run/resource load; default denies all execution. */
  isProjectTrusted?: AgentRuntimeOptions['isProjectTrusted'];
  auth?: AgentAuthOptions;
  /** Borrowed. Never auto-load executable extensions, tools, packages or MCP. */
  extensionRegistry?: ExtensionRegistry;
  /** Borrowed. Explicit reload/expansion only; absent means no discovery. */
  resourceLoader?: AgentResourceLoader;
  /** Shared runtime knobs; per-prompt overrides use the same Core contract. */
  runDefaults?: AgentPromptOptions;
  /** Detached, redacted accounting; only the returned cost changes runtime usage. */
  onUsage?: AgentRuntimeOptions['onUsage'];
  /** Callback inputs/results are detached and redacted; AbortSignal remains live. */
  compaction?: {
    settings?: Parameters<SessionManager['setCompactionSettings']>[0];
    summarize?: AutoCompactionCallback;
    policy?: AutoCompactionPolicy;
  };
}

export type AgentPromptOptions = Omit<StartAgentRunRequest,
  'sessionId' | 'cwd' | 'workspaceId' | 'provider' | 'input' | 'persistSettings'>;
export type AgentCompactionTarget = ReturnType<SessionManager['requestCompaction']>;
export type AgentCompactionDetails = Parameters<SessionManager['applyCompaction']>[3];

export interface AgentSessionCapabilities {
  coreApiVersion: 1;
  persistence: 'memory' | 'caller-store';
  conversation: true;
  eventProtocolVersion: 1;
  stop: 'acknowledge-then-wait';
  history: 'active-and-raw';
  fork: 'copy-user-entry';
  branch: 'before-user-entry';
  clone: 'active-projection';
  compaction: 'caller-summary';
  automaticCompaction: boolean;
  resources: 'explicit-loader' | 'none';
  /** These are not silently synthesized by this facade. */
  executableLoading: false;
  modelDiscovery: false;
  oauthLogin: false;
  mcpHosting: false;
}

export interface AgentSessionOwnership {
  runtime: 'sdk';
  manager: 'sdk';
  provider: 'sdk' | 'caller';
  store: 'caller' | 'none';
  registry: 'sdk' | 'caller';
  resourceLoader: 'caller' | 'none';
  /** Fork/clone handles share the group; last dispose closes owned transports. */
  cleanup: 'last-handle';
}

/** Reads return detached snapshots. Idle mutations reject during durable settlement. */
export interface AgentSession {
  readonly id: string;
  readonly cwd: string;
  readonly capabilities: Readonly<AgentSessionCapabilities>;
  readonly ownership: Readonly<AgentSessionOwnership>;
  snapshot(): Session;
  state(): AgentStateSnapshot;
  messages(): Message[];
  effectiveContext(): SessionEntry[];
  history(): Promise<SessionEntry[]>;
  exportSession(): SerializedSession;
  /** Snapshots options at admission. Terminal phases/events do NOT replace wait. */
  prompt(input: string, options?: AgentPromptOptions): Promise<AgentRunSnapshot>;
  promptAndWait(input: string, options?: AgentPromptOptions): Promise<AgentRunSnapshot>;
  wait(): Promise<AgentRunSnapshot | undefined>;
  /** Cancellation acknowledgement only. Await wait() for durable accounting. */
  stop(): Promise<AgentRunSnapshot | undefined>;
  steer(content: string, blocks?: Message['blocks']): AgentRunSnapshot;
  followUp(content: string, blocks?: Message['blocks']): AgentRunSnapshot;
  clearQueue(kind?: QueuedAgentMessage['kind']): AgentRunSnapshot;
  respondToInteraction(requestId: string, response: ExtensionInteractionResponse): AgentRunSnapshot;
  /** Listener exceptions/rejected Promises cannot break persistence or execution. */
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  events(after?: number): AgentEventReplay;
  rename(title: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setThinking(thinking: Session['thinking']): Promise<void>;
  /** Existing copy fork: durable user entries only, optional empty prefix. */
  fork(entryId: string, options?: { title?: string; before?: boolean }): Promise<AgentSession>;
  branchBefore(entryId: string): Promise<Message>;
  clone(title?: string): Promise<AgentSession>;
  compactionTarget(): AgentCompactionTarget;
  /** Applies an explicit summary using Core; it does not call a model. */
  applyCompaction(summary: string, firstKeptEntryId: string, details?: AgentCompactionDetails): Promise<void>;
  reloadResources(): Promise<ResourceInventoryItem[]>;
  resources(): ResourceInventoryItem[];
  resourceDiagnostics(): readonly string[];
  /** Fresh explicit load + expansion; returns text, never sends automatically. */
  expandPrompt(name: string, args: string[]): Promise<string>;
  invokeSkill(name: string, request?: string): Promise<string>;
  /** Idempotent stop + durable wait + unsubscribe. Never deletes stored sessions. */
  dispose(): Promise<void>;
}
