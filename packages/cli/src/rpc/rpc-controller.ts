import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { resolveVirtualModelFallback } from '@ai-harness/core';
import {
  AgentMessageQueue,
  retainAgentWork,
  AgentAbortError,
  SessionBranchCancelledError,
  type AgentMessageQueueKind,
  type AgentQueueMode,
  buildProviderModelCatalog,
  calculatePublishedModelCost,
  getSessionAccounting,
  prepareCompactionContext,
  assertCompactionTranscript,
  getSummaryModelMessages,
  copyCompactionResponse,
  compactionMessagesFromEntries,
  clampPublishedThinkingLevel,
  cleanupExpiredProcessOutputs,
  createProtocolModelDescriptor,
  createProviderBranchSummarizer,
  createTemporaryProcessOutput,
  discoverProviderModelIds,
  getPublishedModelMetadata,
  getProviderPublishedModel,
  getProviderPublishedModels,
  getSupportedThinkingLevels,
  prepareMessageImages,
  resolveRoutedImageTarget,
  normalizeProviderUsage,
  resolveAgentCompactionContextWindow,
  resolveAgentCompactionSettings,
  resolveModelScope as resolveSharedModelScope,
  toProtocolModelDescriptor,
  truncateToolTail,
} from '@ai-harness/core';
import type {
  AgentSettings,
  AiProvider,
  ChatToolDefinition,
  CredentialRedactionStream,
  McpRetainedContent,
  ExtensionRegistry,
  ExtensionRuntimeContext,
  ExtensionToolResult,
  Message,
  MessageContentBlock,
  Session,
  SessionManager,
  SessionEntry,
  ShellCommandRecord,
  ThinkingLevel,
  TokenUsage,
  ToolCall,
} from '@ai-harness/core';
import { runToolLoop } from '../agent/tool-loop.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { JsonEventStream, toJsonProtocolMessage } from '../cli/json-output.js';
import { renderSessionHtml, sanitizeFilename } from '../utils/session-export.js';
import { EXPORT_PRIVACY_WARNING } from '../security/privacy-warnings.js';
import { parseResourceCommandLine, type ResourceManager } from '../resources/resource-manager.js';

const FOREGROUND_SAFE_COMMANDS = new Set([
  'abort', 'abort_retry', 'get_state', 'get_session_stats', 'get_entries', 'get_tree',
  'get_messages', 'get_fork_messages', 'get_last_assistant_text', 'get_commands',
  'get_available_thinking_levels',
]);

export interface RpcDynamicTools {
  tools: ChatToolDefinition[];
  /** Refresh declarations after a discovery tool activates matches. */
  resolveTools?(): ChatToolDefinition[];
  execute(
    name: string,
    input: unknown,
    context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): ExtensionToolResult | Promise<ExtensionToolResult>;
  /** Hosted tools need the registry hook adapter; registry-owned deferred tools do not. */
  isHosted?(name: string): boolean;
  getActivatedTools?(name: string, result: ExtensionToolResult): string[] | undefined;
  getToolResultMetadata?(name: string, result: ExtensionToolResult): Record<string, unknown> | undefined;
  release?(): void | Promise<void>;
}

export interface RpcControllerContext {
  provider: AiProvider;
  /** Configured providers available to model-list and model-switch RPC commands. */
  providers?: Map<string, AiProvider>;
  sessionManager: SessionManager;
  sessionId: string;
  sessionDir?: string;
  extensionRegistry: ExtensionRegistry;
  resourceManager?: ResourceManager;
  toolContext: ExtensionRuntimeContext;
  providerName: string;
  model?: string;
  systemPrompt?: string;
  /** Trusted settings snapshot used when the active model changes. */
  agentSettings?: () => AgentSettings;
  /** Passive preparation; the returned privileged host callback publishes synchronously. */
  prepareContextSettingsReload?(signal: AbortSignal): Promise<() => void>;
  tools?: ChatToolDefinition[];
  /** Resolve session-scoped tools (for example persistent MCP tools) before each prompt. */
  prepareDynamicTools?(sessionId: string, signal: AbortSignal): Promise<RpcDynamicTools>;
  /** Explicit operator read of a process-local, session-owned MCP binary reference. */
  readMcpContent?(sessionId: string, reference: string): Promise<McpRetainedContent | undefined>;
  hooks?: { emit(event: string, data: Record<string, unknown>): Promise<void> };
  thinking?: ThinkingLevel;
  providerModels?: () => unknown[] | Promise<unknown[]>;
  /** Use published/configured models without discovery or supplied-catalogue callbacks. */
  offline?: boolean;
  steeringMode?: AgentQueueMode;
  followUpMode?: AgentQueueMode;
  retryEnabled?: boolean;
  retryMaxRetries?: number;
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
  enableSkillCommands?: boolean;
  summarizationRetryDelayMs?: number;
  /** Retention for private full-output files. Defaults to 24 hours. */
  fullOutputRetentionMs?: number;
  /** Cache duration for provider model discovery. Defaults to 30 seconds. */
  modelDiscoveryCacheMs?: number;
  /** Optional resolved model scope used by cycle_model. */
  scopedModels?: Array<{ provider: string; id: string; thinkingLevel?: ThinkingLevel }>;
  /** CLI model ID/name globs resolved against each refreshed catalogue. */
  scopedModelPatterns?: string[];
  /** Process-local credential scrubber for JSON/RPC events and persisted tool output. */
  redactText?: (value: string) => string;
  redactJson?: <T>(value: T) => T;
  createTextRedactor?: () => CredentialRedactionStream;
}

export interface RpcCommandRequest {
  type: string;
  id?: string;
  /** get_session_stats: opt into active/history accounting without changing legacy framing. */
  includeAccounting?: boolean;
  [key: string]: unknown;
}

export interface RpcCommandResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

type RpcThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface RpcImage {
  type: 'image';
  data: string;
  mimeType: string;
}

interface PreparedPrompt {
  content: string;
  blocks: MessageContentBlock[];
  images: RpcImage[];
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

interface ActiveBash {
  controller: AbortController;
  done: Promise<void>;
}

interface RpcTreeNode {
  entry: Record<string, unknown> & { id: string };
  children: RpcTreeNode[];
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RPC_BASH_CAPTURE_BYTES = 10 * 1024 * 1024;
const DEFAULT_FULL_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;
const BASH_OUTPUT_DIRECTORY_PREFIX = 'ai-harness-bash-';
const THINKING_LEVELS: RpcThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function fullOutputRetentionMs(context: RpcControllerContext): number {
  const retentionMs = context.fullOutputRetentionMs ?? DEFAULT_FULL_OUTPUT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) {
    throw new Error('fullOutputRetentionMs must be a positive safe integer.');
  }
  return retentionMs;
}

function success(id: string | undefined, command: string, data?: unknown): RpcCommandResponse {
  return {
    ...(id === undefined ? {} : { id }),
    type: 'response',
    command,
    success: true,
    ...(data === undefined ? {} : { data }),
  };
}

function failure(id: string | undefined, command: string, error: string): RpcCommandResponse {
  return {
    ...(id === undefined ? {} : { id }),
    type: 'response',
    command,
    success: false,
    error,
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  return value;
}

function optionalImages(value: unknown): RpcImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('images must be an array.');
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`images[${index}] must be an image object.`);
    }
    const image = candidate as Record<string, unknown>;
    if (image.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string') {
      throw new Error(`images[${index}] must contain type, data, and mimeType.`);
    }
    if (!/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)) throw new Error(`images[${index}] has an invalid MIME type.`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 === 1) {
      throw new Error(`images[${index}] is not valid base64.`);
    }
    if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) {
      throw new Error(`images[${index}] exceeds the ${MAX_IMAGE_BYTES} byte limit.`);
    }
    return { type: 'image', data: image.data, mimeType: image.mimeType };
  });
}

function imageBlocks(images: RpcImage[]): MessageContentBlock[] {
  return images.map(image => ({
    type: 'image',
    mediaType: image.mimeType,
    size: Buffer.byteLength(image.data, 'base64'),
    url: `data:${image.mimeType};base64,${image.data}`,
  }));
}

function entryMessage(entry: SessionEntry): Message | undefined {
  if (entry.type !== 'message') return undefined;
  return {
    id: entry.id,
    role: entry.role,
    content: entry.content,
    timestamp: new Date(entry.timestamp),
    blocks: entry.blocks,
    toolCalls: entry.toolCalls,
    toolCallId: entry.toolCallId,
    name: entry.name,
    isError: entry.isError,
    provider: entry.provider,
    model: entry.model,
    usage: entry.usage,
    durationMs: entry.durationMs,
    parentMessageId: entry.parentMessageId,
    agentId: entry.agentId,
    metadata: entry.metadata,
  };
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    timestamp: new Date(message.timestamp),
    blocks: message.blocks?.map(block => ({ ...block })),
    toolCalls: message.toolCalls?.map(call => ({ ...call })),
    usage: message.usage ? { ...message.usage } : undefined,
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

function toRpcBashMessage(command: ShellCommandRecord): Record<string, unknown> {
  return {
    role: 'bashExecution',
    command: command.command,
    output: command.output ?? '',
    exitCode: command.exitCode,
    cancelled: command.status === 'cancelled',
    truncated: command.truncated ?? false,
    ...(command.downloadPath ? { fullOutputPath: command.downloadPath } : {}),
    ...(command.excludedFromContext !== undefined ? { excludeFromContext: command.excludedFromContext } : {}),
    timestamp: command.timestamp.getTime(),
  };
}

function protocolUsage(
  provider: string,
  model: string | undefined,
  usage: TokenUsage | undefined,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const pricing = model ? getPublishedModelMetadata(provider, model)?.pricing : undefined;
  const calculatedTotal = model ? calculatePublishedModelCost(provider, model, usage) : undefined;
  const cost = {
    ...(pricing?.inputPerMillion === undefined ? {} : { input: input * pricing.inputPerMillion / 1_000_000 }),
    ...(pricing?.outputPerMillion === undefined ? {} : { output: output * pricing.outputPerMillion / 1_000_000 }),
    ...(pricing?.cacheReadPerMillion === undefined ? {} : { cacheRead: cacheRead * pricing.cacheReadPerMillion / 1_000_000 }),
    ...(pricing?.cacheWritePerMillion === undefined ? {} : { cacheWrite: cacheWrite * pricing.cacheWritePerMillion / 1_000_000 }),
    ...(usage.costUsd === undefined && calculatedTotal === undefined
      ? {}
      : { total: usage.costUsd ?? calculatedTotal }),
  };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
    ...(Object.keys(cost).length ? { cost } : {}),
  };
}

function supportedThinkingLevels(provider: string, model: string | undefined, registry: ExtensionRegistry, source: AiProvider): RpcThinkingLevel[] {
  return getSupportedThinkingLevels(provider, model, registry.virtualModels, source);
}

function clampThinkingLevel(
  level: RpcThinkingLevel,
  available: RpcThinkingLevel[],
): RpcThinkingLevel {
  return clampPublishedThinkingLevel(level, available);
}

function coreThinkingLevel(level: RpcThinkingLevel): ThinkingLevel {
  return level;
}

function rpcThinkingLevel(level: RpcThinkingLevel | ThinkingLevel | Session['thinking'] | undefined): RpcThinkingLevel {
  return level ?? 'off';
}

const summaryAbortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function summaryAborted(signal: AbortSignal): boolean { return summaryAbortState.call(signal) === true; }

async function waitForRetry(delayMs: number, signal: AbortSignal, cancelled: Promise<never>): Promise<void> {
  if (summaryAborted(signal)) throw Object.assign(new Error('Retry aborted.'), { name: 'AbortError' });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>(resolve => { timer = setTimeout(resolve, delayMs); }),
      cancelled.catch(() => { throw Object.assign(new Error('Retry aborted.'), { name: 'AbortError' }); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function awaitSummary<T>(operation: Promise<T>, signal: AbortSignal, cancelled: Promise<never>): Promise<T> {
  const result = await Promise.race([operation, cancelled]);
  // Fulfillment can win the microtask race even though cancellation already happened.
  if (summaryAborted(signal)) throw new DOMException('Compaction cancelled', 'AbortError');
  return result;
}

/**
 * Stateful RPC command controller. It keeps protocol and queue concerns in the
 * CLI while delegating provider calls, persistence, tools, and hooks to the
 * same runtime primitives used by interactive and JSON modes.
 */
export class RpcController {
  private readonly events: JsonEventStream;
  private currentSessionId: string;
  private model: string | undefined;
  private thinking: RpcThinkingLevel;
  private readonly messageQueue: AgentMessageQueue<PreparedPrompt>;
  private autoRetryEnabled = true;
  private retryActive = false;
  private retryAbortController?: AbortController;
  private summarizationAbortController?: AbortController;
  private compacting = false;
  private activeCompaction?: ActiveRun;
  private activeNavigation?: ActiveRun;
  private activeContextReload?: ActiveRun;
  private navigationRetired = false;
  private activeRun?: ActiveRun;
  private promptAdmission?: ActiveRun;
  private runFailure?: unknown;
  private runAccepting = false;
  private activeBash?: ActiveBash;
  private modelSources?: ReadonlyMap<string, AiProvider>;
  private modelCache?: {
    expiresAt: number;
    models: Array<Record<string, unknown> & { provider: string; id: string }>;
  };
  private modelDiscovery?: Promise<Array<Record<string, unknown> & { provider: string; id: string }>>;
  private eventTail: Promise<void> = Promise.resolve();
  private eventFailure: unknown;

  constructor(
    private readonly context: RpcControllerContext,
    private readonly emitRaw: (record: Record<string, unknown>) => void | Promise<void>,
  ) {
    this.currentSessionId = context.sessionId;
    this.model = context.model;
    this.thinking = rpcThinkingLevel(context.thinking);
    this.messageQueue = new AgentMessageQueue({
      steeringMode: context.steeringMode,
      followUpMode: context.followUpMode,
    });
    this.autoRetryEnabled = context.retryEnabled ?? true;
    this.events = new JsonEventStream(
      record => this.emit(record),
      context.redactText,
    );
  }

  async initialize(): Promise<void> {
    await cleanupExpiredProcessOutputs({
      prefix: BASH_OUTPUT_DIRECTORY_PREFIX,
      retentionMs: fullOutputRetentionMs(this.context),
    });
    let session: Session | null | undefined = this.context.sessionManager.get(this.currentSessionId);
    if (!session) session = await this.context.sessionManager.loadFromStore(this.currentSessionId);
    if (!session) {
      this.thinking = clampThinkingLevel(
        this.thinking,
        supportedThinkingLevels(this.context.providerName, this.model, this.context.extensionRegistry, this.context.provider),
      );
      await this.context.sessionManager.create({
        id: this.currentSessionId,
        cwd: this.context.toolContext.cwd,
        model: this.model,
        thinking: coreThinkingLevel(this.thinking),
      });
    } else {
      this.model = this.model ?? session.model;
      this.thinking = clampThinkingLevel(
        rpcThinkingLevel(session.thinking ?? this.thinking),
        supportedThinkingLevels(this.context.providerName, this.model, this.context.extensionRegistry, this.context.provider),
      );
    }

    this.refreshCompactionSettings(true);
    this.context.sessionManager.setAutoCompactionCallback(async (_sessionId, toCompact, _keptEntries, signal) => {
      assertCompactionTranscript(toCompact);
      const messages = getSummaryModelMessages(compactionMessagesFromEntries(toCompact));
      assertCompactionTranscript(messages);
      const provider = this.context.provider, chat = this.directChat(provider);
      const providerName = this.context.providerName, model = this.model, thinking = coreThinkingLevel(this.thinking);
      const rawResponse = await this.summarizeWithRetry('threshold', retrySignal => chat([
        ...messages,
        {
          id: '__auto_compact__',
          role: 'user',
          content: 'Summarize the earlier conversation while preserving decisions, unresolved work, and concrete results.',
          timestamp: new Date(),
        },
      ], {
        model,
        thinking,
        systemPrompt: 'Produce a concise context summary for future assistant turns.',
        tools: [], maxTokens: 4096,
        signal: retrySignal,
      }), signal);
      const content = Object.getOwnPropertyDescriptor(rawResponse, 'content');
      if (content && 'value' in content && typeof content.value === 'string' && !content.value.trim()) {
        throw new Error('Automatic compaction produced an empty summary.');
      }
      const response = copyCompactionResponse(rawResponse);
      return {
        summary: response.content,
        provider: response.provider ?? providerName,
        model: response.model ?? model,
        usage: normalizeProviderUsage(response.usage),
      };
    });
    this.context.sessionManager.on('compaction:start', async event => {
      if (event.automatic && event.sessionId === this.currentSessionId) {
        this.compacting = true;
        await this.events.compactionStart('threshold');
      }
    });
    this.context.sessionManager.on('compaction:end', async event => {
      if (!event.automatic || event.sessionId !== this.currentSessionId) return;
      const compacted = this.session();
      const compaction = [...await this.context.sessionManager.getRawEntries(event.sessionId)].reverse().find(
        (entry): entry is Extract<SessionEntry, { type: 'compaction' }> => entry.type === 'compaction',
      );
      this.compacting = false;
      await this.events.compactionEnd('threshold', {
        result: {
          summary: typeof compacted.metadata?.compactionSummary === 'string'
            ? compacted.metadata.compactionSummary : '',
          firstKeptEntryId: compacted.messages[0]?.id,
          tokensBefore: event.tokensBefore,
          estimatedTokensAfter: event.tokensAfter,
          ...(compaction?.usage ? {
            usage: protocolUsage(
              compaction.provider ?? this.context.providerName,
              compaction.model,
              compaction.usage,
            ),
          } : {}),
          details: {},
        },
      });
    });
    this.context.sessionManager.on('compaction:error', async event => {
      if (event.automatic && event.sessionId === this.currentSessionId) {
        this.compacting = false;
        await this.events.compactionEnd('threshold', { aborted: event.cancelled, error: event.error });
      }
    });
  }

  /** Let accepted work finish on clean JSONL EOF without turning EOF into cancellation. */
  async drain(timeoutMs = 30_000): Promise<void> {
    const work = [this.activeBash?.done, this.activeRun?.done, this.activeCompaction?.done].filter(
      (item): item is Promise<void> => item !== undefined,
    );
    if (work.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(work).then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('RPC shutdown drain timed out.')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** EOF retires even requests whose awaited admission has not resumed yet. */
  abortNavigation(): void {
    this.navigationRetired = true;
    this.promptAdmission?.controller.abort();
    this.activeNavigation?.controller.abort();
    this.activeContextReload?.controller.abort();
    this.activeCompaction?.controller.abort();
  }

  async close(): Promise<void> {
    const navigation = this.activeNavigation;
    const contextReload = this.activeContextReload;
    const compaction = this.activeCompaction;
    const admission = this.promptAdmission;
    this.abortNavigation();
    if (admission) await admission.done;
    this.retryAbortController?.abort();
    this.summarizationAbortController?.abort();
    const activeBash = this.activeBash;
    activeBash?.controller.abort();
    if (activeBash) await activeBash.done;
    if (this.activeRun) {
      this.activeRun.controller.abort();
      await this.activeRun.done;
    }
    if (navigation) await navigation.done;
    if (contextReload) await contextReload.done;
    if (compaction) await compaction.done;
    await this.eventTail;
    if (this.eventFailure) throw this.eventFailure;
    if (this.runFailure) throw this.runFailure;
  }

  async handle(request: RpcCommandRequest): Promise<RpcCommandResponse | undefined> {
    // Extension commands are independent host callbacks (including UI replies),
    // not ordinary prompt admission; retain their native concurrent command path.
    if (request.type === 'prompt' && typeof request.message === 'string' && this.isExtensionCommand(request.message)) return this.handleCommand(request);
    if (!['prompt', 'steer', 'follow_up'].includes(request.type)) return this.handleCommand(request);
    if (this.navigationRetired || this.promptAdmission || (this.activeRun && !this.runAccepting)) return failure(request.id, request.type,
      'Prompt admission is closed or another foreground operation is processing.');
    let finish!: () => void;
    const admission = { controller: new AbortController(), done: new Promise<void>(resolve => { finish = resolve; }) };
    this.promptAdmission = admission;
    const releaseWork = retainAgentWork();
    try { return await this.handleCommand(request, admission.controller.signal); }
    finally {
      if (this.promptAdmission === admission) this.promptAdmission = undefined;
      finish();
      releaseWork();
    }
  }

  private async handleCommand(request: RpcCommandRequest, signal?: AbortSignal): Promise<RpcCommandResponse | undefined> {
    const id = typeof request.id === 'string' ? request.id : undefined;
    const command = request.type;
    try {
      if (this.eventFailure) throw this.eventFailure;
      if (!FOREGROUND_SAFE_COMMANDS.has(command)) {
        if (this.promptAdmission && this.promptAdmission.controller.signal !== signal) throw new Error(`${command} is not available while prompt admission is processing.`);
        if (this.activeNavigation) throw new Error(`${command} is not available while navigating the session tree.`);
        if (this.activeCompaction) throw new Error(`${command} is not available while compacting the session.`);
        this.assertNoContextReload(command);
      }
      switch (command) {
        case 'prompt': {
          const rawMessage = requiredString(request.message, 'message');
          const message = this.context.redactText?.(rawMessage) ?? rawMessage;
          if (await this.executeExtensionCommand(message)) {
            if (signal?.aborted) throw new AgentAbortError();
            return success(id, command, { disposition: 'handled' });
          }
          const prompt = await this.preparePrompt(message, request.images, signal!);
          this.assertNoContextReload(command);
          if (this.activeRun && !this.runAccepting) throw new Error('Agent is settling; await agent_settled before prompting.');
          if (this.activeNavigation) throw new Error('prompt is not available while navigating the session tree.');
          if (this.activeRun) {
            if (request.streamingBehavior === 'steer') this.messageQueue.enqueue('steer', prompt);
            else if (request.streamingBehavior === 'followUp') this.messageQueue.enqueue('follow-up', prompt);
            else throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
            await this.emitQueueUpdate();
            return success(id, command, { disposition: 'queued' });
          }
          this.start(prompt, this.promptAdmission!.controller);
          return success(id, command, { disposition: 'started' });
        }
        case 'steer': {
          const message = requiredString(request.message, 'message');
          if (this.isExtensionCommand(message)) throw new Error('Extension commands are not allowed in steer; use prompt instead.');
          const prompt = await this.preparePrompt(message, request.images, signal!);
          this.assertNoContextReload(command);
          this.messageQueue.enqueue('steer', prompt);
          await this.emitQueueUpdate();
          return success(id, command, { disposition: 'queued' });
        }
        case 'follow_up': {
          const message = requiredString(request.message, 'message');
          if (this.isExtensionCommand(message)) throw new Error('Extension commands are not allowed in follow_up; use prompt instead.');
          const prompt = await this.preparePrompt(message, request.images, signal!);
          this.assertNoContextReload(command);
          this.messageQueue.enqueue('follow-up', prompt);
          await this.emitQueueUpdate();
          return success(id, command, { disposition: 'queued' });
        }
        case 'abort': {
          const navigation = this.activeNavigation;
          const contextReload = this.activeContextReload;
          const compaction = this.activeCompaction;
          navigation?.controller.abort();
          contextReload?.controller.abort();
          compaction?.controller.abort();
          this.promptAdmission?.controller.abort();
          // Abort acknowledges withdrawal. agent_settled/close retain physical ownership.
          this.runAccepting = false;
          this.activeRun?.controller.abort();
          if (navigation) await navigation.done;
          if (contextReload) await contextReload.done;
          if (compaction) await compaction.done;
          return success(id, command);
        }
        case 'clear_queue': {
          const cleared = this.messageQueue.clear();
          await this.emitQueueUpdate();
          return success(id, command, {
            steering: cleared.steering.map(item => item.content),
            followUp: cleared.followUp.map(item => item.content),
          });
        }
        case 'new_session': {
          await this.ensureIdle(command);
          const parentSession = typeof request.parentSession === 'string' ? request.parentSession : undefined;
          const session = await this.context.sessionManager.create({
            parentId: parentSession,
            cwd: this.context.toolContext.cwd,
            model: this.model,
            thinking: coreThinkingLevel(this.thinking),
          });
          this.currentSessionId = session.id;
          this.resetQueues();
          await this.emit({ type: 'session_info_changed', name: session.title });
          return success(id, command, { cancelled: false });
        }
        case 'get_state':
          return success(id, command, this.state());
        case 'read_mcp_content': {
          if (Reflect.ownKeys(request).some(key => !['type', 'id', 'reference'].includes(String(key)))
            || typeof request.reference !== 'string' || !/^[a-f0-9-]{36}$/u.test(request.reference)) throw new Error('Invalid MCP content reference.');
          const source = this.currentSessionId, read = this.context.readMcpContent;
          if (this.navigationRetired || !read) throw new Error('MCP content unavailable.');
          const content = await read(source, request.reference);
          if (!content || this.navigationRetired || this.currentSessionId !== source || this.context.readMcpContent !== read) throw new Error('MCP content unavailable.');
          return success(id, command, { reference: request.reference, mediaType: content.mediaType, size: content.size,
            sha256: content.sha256, data: content.data.toString('base64') });
        }
        case 'reload_context_settings': {
          if (Reflect.ownKeys(request).some(key => key !== 'type' && key !== 'id')) {
            throw new Error('reload_context_settings accepts only type and id.');
          }
          if (this.navigationRetired) return success(id, command, { cancelled: true, reloaded: [] });
          if (this.activeRun || this.activeBash || this.compacting) {
            throw new Error('reload_context_settings is not available while a foreground operation is processing.');
          }
          const descriptor = Object.getOwnPropertyDescriptor(this.context, 'prepareContextSettingsReload');
          if (!descriptor) throw new Error('Context settings reload is unavailable.');
          if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
            throw new Error('Context settings reload is invalid.');
          }
          const prepare = descriptor.value as NonNullable<RpcControllerContext['prepareContextSettingsReload']>;
          const controller = new AbortController();
          let finish!: () => void;
          const reload: ActiveRun = { controller, done: new Promise<void>(resolve => { finish = resolve; }) };
          this.activeContextReload = reload;
          try {
            let publish: () => void;
            try { publish = await prepare.call(this.context, controller.signal); }
            catch (error) {
              if (controller.signal.aborted || this.navigationRetired) {
                return success(id, command, { cancelled: true, reloaded: [] });
              }
              throw error;
            }
            if (controller.signal.aborted || this.navigationRetired
              || Object.getOwnPropertyDescriptor(this.context, 'prepareContextSettingsReload')?.value !== prepare) {
              return success(id, command, { cancelled: true, reloaded: [] });
            }
            if (typeof publish !== 'function') throw new Error('Prepared context settings reload is invalid.');
            publish();
            this.refreshCompactionSettings();
            return success(id, command, { cancelled: false, reloaded: ['compaction', 'branchSummary'] });
          } finally {
            if (this.activeContextReload === reload) this.activeContextReload = undefined;
            finish();
          }
        }
        case 'set_model': {
          const provider = requiredString(request.provider, 'provider');
          const modelId = requiredString(request.modelId, 'modelId');
          const selected = this.configuredProvider(provider);
          const sources = new Map(this.context.providers ?? [[this.context.providerName, this.context.provider]]);
          const available = await this.availableModels();
          if (!this.hasModelSources(sources)) return failure(id, command, 'Model catalogue changed during selection.');
          if (!selected || !available.some(model => model.provider === provider && model.id === modelId)) {
            return failure(id, command, `Model not found: ${provider}/${modelId}`);
          }
          await this.selectModel(provider, modelId, selected);
          return success(id, command, createProtocolModelDescriptor(provider, modelId, selected.getModelApi?.(modelId), getProviderPublishedModels(selected)));
        }
        case 'cycle_model': {
          const sources = new Map(this.context.providers ?? [[this.context.providerName, this.context.provider]]);
          const available = await this.availableModels();
          if (!this.hasModelSources(sources)) return failure(id, command, 'Model catalogue changed during selection.');
          const explicitScope = this.context.scopedModels ?? [];
          const scoped = explicitScope.length > 0
            ? explicitScope.flatMap(candidate => {
                const model = available.find(item => item.provider === candidate.provider && item.id === candidate.id);
                return model ? [{ model, thinkingLevel: candidate.thinkingLevel }] : [];
              })
            : resolveSharedModelScope(this.context.scopedModelPatterns ?? [], available).models;
          const hasScope = explicitScope.length > 0 || (this.context.scopedModelPatterns?.length ?? 0) > 0;
          if (hasScope && scoped.length === 0) {
            return failure(id, command, 'No models match the active model scope.');
          }
          const models = hasScope ? scoped : available.map(model => ({
            model,
            thinkingLevel: undefined as ThinkingLevel | undefined,
          }));
          if (models.length <= 1) return success(id, command, null);
          const current = models.findIndex(item => (
            item.model.provider === this.context.providerName && item.model.id === this.model
          ));
          const next = models[(current + 1 + models.length) % models.length]!;
          const selected = this.configuredProvider(next.model.provider);
          if (!selected) return failure(id, command, `Model not found: ${next.model.provider}/${next.model.id}`);
          await this.selectModel(next.model.provider, next.model.id, selected);
          if (next.thinkingLevel) await this.selectThinking(next.thinkingLevel);
          return success(id, command, {
            model: createProtocolModelDescriptor(next.model.provider, next.model.id, this.context.provider.getModelApi?.(next.model.id), getProviderPublishedModels(this.context.provider)),
            thinkingLevel: this.thinking,
            isScoped: hasScope,
          });
        }
        case 'get_available_models':
          return success(id, command, { models: await this.availableModels() });
        case 'set_thinking_level': {
          const requested = requiredString(request.level, 'level') as RpcThinkingLevel;
          if (!THINKING_LEVELS.includes(requested)) throw new Error(`Invalid thinking level: ${requested}`);
          await this.selectThinking(requested);
          return success(id, command);
        }
        case 'cycle_thinking_level': {
          const levels = this.availableThinkingLevels();
          if (levels.length <= 1) return success(id, command, null);
          const current = levels.indexOf(this.thinking);
          const next = levels[(current + 1 + levels.length) % levels.length]!;
          this.thinking = next;
          await this.context.sessionManager.update(this.currentSessionId, { thinking: coreThinkingLevel(next) });
          await this.emit({ type: 'thinking_level_changed', level: next });
          return success(id, command, { level: next });
        }
        case 'get_available_thinking_levels':
          return success(id, command, { levels: this.availableThinkingLevels() });
        case 'set_steering_mode':
          this.messageQueue.setMode('steer', request.mode);
          return success(id, command);
        case 'set_follow_up_mode':
          this.messageQueue.setMode('follow-up', request.mode);
          return success(id, command);
        case 'set_auto_compaction': {
          if (typeof request.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
          await this.context.sessionManager.update(this.currentSessionId, { autoCompaction: request.enabled });
          return success(id, command);
        }
        case 'set_auto_retry':
          if (typeof request.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
          this.autoRetryEnabled = request.enabled;
          return success(id, command);
        case 'abort_retry':
          if (this.retryActive) this.retryAbortController?.abort();
          return success(id, command);
        case 'compact': {
          const result = await this.compact(
            typeof request.customInstructions === 'string' ? request.customInstructions : undefined,
          );
          return success(id, command, result);
        }
        case 'bash': {
          if (!this.context.tools?.some(tool => tool.name.toLowerCase() === 'bash')) {
            throw new Error('Bash is disabled by the active tool selection.');
          }
          if (this.activeBash) throw new Error('A bash command is already running.');
          const rawShellCommand = requiredString(request.command, 'command');
          const shellCommand = this.context.redactText?.(rawShellCommand) ?? rawShellCommand;
          if (request.excludeFromContext !== undefined && typeof request.excludeFromContext !== 'boolean') {
            throw new Error('excludeFromContext must be a boolean.');
          }
          const controller = new AbortController();
          const outputCapture = await createTemporaryProcessOutput({
            prefix: BASH_OUTPUT_DIRECTORY_PREFIX,
            retentionMs: fullOutputRetentionMs(this.context),
          });
          const fullOutputPath = outputCapture.filePath;
          const capturedChunks: Buffer[] = [];
          let capturedBytes = 0;
          let captureTruncated = false;
          let retainFullOutput = false;
          let bashOutputTail = Promise.resolve();
          const bashRedactor = this.context.createTextRedactor?.();
          const capture = (delta: string): void => {
            capturedChunks.push(Buffer.from(delta));
            capturedBytes += Buffer.byteLength(delta);
            while (capturedBytes > MAX_RPC_BASH_CAPTURE_BYTES && capturedChunks.length) {
              const excess = capturedBytes - MAX_RPC_BASH_CAPTURE_BYTES;
              const first = capturedChunks[0]!;
              if (first.length <= excess) {
                capturedChunks.shift();
                capturedBytes -= first.length;
              } else {
                capturedChunks[0] = first.subarray(excess);
                capturedBytes -= excess;
              }
              captureTruncated = true;
            }
          };
          const capturedOutput = (): string => Buffer.concat(capturedChunks, capturedBytes).toString('utf8');
          const deliverOutput = async (delta: string): Promise<void> => {
            if (!delta) return;
            capture(delta);
            await outputCapture.write(delta);
            await this.emit({
              type: 'bash_execution_update',
              ...(id ? { id } : {}),
              delta,
            });
          };
          const flushOutput = async (): Promise<void> => {
            const finalDelta = bashRedactor?.flush() ?? '';
            if (finalDelta) await deliverOutput(finalDelta);
          };
          let finishBash!: () => void;
          const bashDone = new Promise<void>(resolve => { finishBash = resolve; });
          const activeBash: ActiveBash = { controller, done: bashDone };
          this.activeBash = activeBash;
          try {
            const result = await this.context.extensionRegistry.executeTool('bash', {
              command: shellCommand,
              excludeFromContext: request.excludeFromContext === true,
            }, {
              ...this.context.toolContext,
              currentSessionId: this.currentSessionId,
              provider: this.context.provider,
              providerName: this.context.providerName,
              processOutputPath: fullOutputPath,
              onProcessOutput: delta => {
                bashOutputTail = bashOutputTail.then(() => deliverOutput(
                  bashRedactor?.push(delta) ?? this.context.redactText?.(delta) ?? delta,
                ));
                return bashOutputTail;
              },
            }, controller.signal);
            await bashOutputTail;
            await flushOutput();
            const safeResult = this.context.redactJson?.(result) ?? result;
            const details = safeResult.details && typeof safeResult.details === 'object'
              ? safeResult.details as Record<string, unknown>
              : {};
            const truncated = details.truncated === true;
            retainFullOutput = truncated;
            return success(id, command, {
              output: safeResult.content,
              exitCode: typeof details.exitCode === 'number' ? details.exitCode : safeResult.isError ? 1 : 0,
              cancelled: false,
              truncated,
              ...(truncated ? { fullOutputPath } : {}),
            });
          } catch (error) {
            if (controller.signal.aborted) {
              await bashOutputTail;
              await flushOutput();
              const truncation = truncateToolTail(capturedOutput());
              const truncated = captureTruncated || truncation.truncated;
              retainFullOutput = truncated;
              return success(id, command, {
                output: truncation.content,
                exitCode: 130,
                cancelled: true,
                truncated,
                ...(truncated ? { fullOutputPath } : {}),
              });
            }
            throw error;
          } finally {
            if (this.activeBash === activeBash) this.activeBash = undefined;
            try {
              await bashOutputTail.catch(() => undefined);
              await outputCapture.finalize(retainFullOutput).catch(() => undefined);
            } finally {
              finishBash();
            }
          }
        }
        case 'abort_bash': {
          const activeBash = this.activeBash;
          activeBash?.controller.abort();
          if (activeBash) await activeBash.done;
          return success(id, command);
        }
        case 'get_session_stats':
          if (request.includeAccounting !== undefined && typeof request.includeAccounting !== 'boolean') {
            throw new Error('includeAccounting must be a boolean.');
          }
          return success(id, command, await this.sessionStats(request.includeAccounting === true));
        case 'export_html': {
          const exportedPath = await this.exportHtml(
            typeof request.outputPath === 'string' ? request.outputPath : undefined,
          );
          return success(id, command, { path: exportedPath, warnings: [EXPORT_PRIVACY_WARNING] });
        }
        case 'switch_session': {
          await this.ensureIdle(command);
          const requested = requiredString(request.sessionPath, 'sessionPath');
          const sessionId = path.basename(requested).replace(/\.jsonl$/i, '');
          const session = this.context.sessionManager.get(sessionId) ?? await this.context.sessionManager.loadFromStore(sessionId);
          if (!session) throw new Error(`Session not found: ${requested}`);
          const fallback = await resolveVirtualModelFallback(this.context.sessionManager, session.id,
            this.context.extensionRegistry.virtualModels, name => this.configuredProvider(name));
          if (fallback) await this.context.sessionManager.update(session.id, {
            model: fallback.selection.id, providerConfig: { type: fallback.selection.provider },
          });
          this.currentSessionId = session.id;
          const savedProviderName = fallback?.selection.provider ?? (typeof session.providerConfig?.type === 'string'
            ? session.providerConfig.type
            : this.context.providerName);
          const savedProvider = fallback?.provider ?? this.configuredProvider(savedProviderName);
          if (savedProvider) {
            this.context.provider = savedProvider;
            this.context.providerName = savedProviderName;
            this.context.toolContext.provider = savedProvider;
            this.context.toolContext.providerName = savedProviderName;
          }
          this.model = fallback?.selection.id ?? session.model ?? this.model;
          if (this.model) this.context.provider.setConfiguredModel(this.model);
          this.refreshCompactionSettings(true);
          this.thinking = clampThinkingLevel(
            rpcThinkingLevel(fallback?.selection.thinkingLevel ?? session.thinking ?? this.thinking),
            this.availableThinkingLevels(),
          );
          this.resetQueues();
          await this.emit({ type: 'session_info_changed', name: session.title });
          await this.emit({ type: 'thinking_level_changed', level: this.thinking });
          return success(id, command, { cancelled: false });
        }
        case 'navigate_tree': {
          await this.ensureIdle(command);
          if (this.activeNavigation || this.activeContextReload || this.activeRun || this.activeBash || this.compacting) {
            throw new Error('navigate_tree is not available while a foreground operation is processing.');
          }
          const entryId = requiredString(request.entryId, 'entryId');
          if (request.summarize !== undefined && typeof request.summarize !== 'boolean') {
            throw new Error('summarize must be a boolean.');
          }
          if (request.customInstructions !== undefined && typeof request.customInstructions !== 'string') {
            throw new Error('customInstructions must be a string.');
          }
          if (request.replaceInstructions !== undefined && typeof request.replaceInstructions !== 'boolean') {
            throw new Error('replaceInstructions must be a boolean.');
          }
          if (request.summarize !== true && (request.customInstructions !== undefined || request.replaceInstructions === true)) {
            throw new Error('Summary instructions require summarize: true.');
          }
          if (this.navigationRetired) return success(id, command, { cancelled: true, stale: false,
            leafId: this.context.sessionManager.get(this.currentSessionId)?.activeLeafId ?? null });
          const controller = new AbortController();
          let finish!: () => void;
          const navigation: ActiveRun = { controller, done: new Promise<void>(resolve => { finish = resolve; }) };
          this.activeNavigation = navigation;
          try {
            const summaryProvider = request.summarize === true
              ? createProviderBranchSummarizer(this.context.provider, this.model, this.directChat(this.context.provider)) : undefined;
            const result = await this.context.sessionManager.navigateTree(this.currentSessionId, entryId, {
              summarize: request.summarize === true, ...summaryProvider,
              ...(request.summarize === true
                ? { reserveTokens: this.context.agentSettings?.().branchSummary?.reserveTokens } : {}),
              customInstructions: request.customInstructions as string | undefined,
              replaceInstructions: request.replaceInstructions as boolean | undefined,
              signal: controller.signal,
            });
            if (result.status === 'not-found') throw new Error(`Entry not found: ${entryId}`);
            if (result.status === 'navigated') this.resetQueues();
            return success(id, command, {
              cancelled: result.status === 'cancelled', stale: result.status === 'stale',
              leafId: this.session().activeLeafId ?? null,
              ...(result.summary ? { summaryEntryId: result.summary.id } : {}),
            });
          } finally {
            if (this.activeNavigation === navigation) this.activeNavigation = undefined;
            finish();
          }
        }
        case 'fork': {
          const sourceSessionId = this.currentSessionId, entryId = requiredString(request.entryId, 'entryId');
          const result = await this.withBranchNavigation(command, sourceSessionId, async signal => {
            const selected = await this.context.sessionManager.branchBeforeEntry(sourceSessionId, entryId, { signal });
            if (!selected) throw new Error(`Entry not found: ${entryId}`);
            this.resetQueues();
            return selected;
          });
          return success(id, command, result.cancelled ? { cancelled: true } : { text: result.value.content, cancelled: false });
        }
        case 'clone': {
          const sourceSessionId = this.currentSessionId, title = this.session().title;
          const result = await this.withBranchNavigation(command, sourceSessionId, async signal => {
            const source = this.session();
            if (!source.activeLeafId && source.messages.length === 0 && !source.commands?.length) {
              throw new Error('Cannot clone session: no current entry selected');
            }
            const clone = await this.context.sessionManager.cloneSession(sourceSessionId, title, undefined, { signal });
            if (!clone) throw new Error(`Session not found: ${sourceSessionId}`);
            this.currentSessionId = clone.id;
            this.resetQueues();
            await this.emit({ type: 'session_info_changed', name: clone.title });
          });
          return success(id, command, { cancelled: result.cancelled });
        }
        case 'get_fork_messages': {
          const messages = (await this.activeRawEntries())
            .filter((entry): entry is Extract<SessionEntry, { type: 'message' }> => (
              entry.type === 'message' && entry.role === 'user'
            ))
            .map(message => ({ entryId: message.id, text: message.content }));
          return success(id, command, { messages });
        }
        case 'context_edit': {
          for (const key of Object.keys(request)) {
            if (!['type', 'id', 'targetEntryId', 'replacement'].includes(key)) throw new Error('Unknown context_edit field.');
          }
          if (request.replacement !== undefined && typeof request.replacement !== 'string') throw new Error('replacement must be a string.');
          const sourceId = this.currentSessionId, edit = {
            targetEntryId: requiredString(request.targetEntryId, 'targetEntryId'),
            ...(request.replacement !== undefined ? { replacement: request.replacement as string } : {}),
          };
          const result = await this.withBranchNavigation(command, sourceId, async signal => {
            if (this.promptAdmission) throw new Error('context_edit is not available while prompt admission is processing.');
            try { return await this.context.sessionManager.appendContextEdit(sourceId, edit, { signal }); }
            catch (error) {
              if (signal.aborted && error instanceof Error && error.name === 'AbortError') throw new SessionBranchCancelledError();
              throw error;
            }
          });
          return success(id, command, result.cancelled ? { cancelled: true }
            : { cancelled: false, entryId: result.value?.id, leafId: this.session().activeLeafId });
        }
        case 'get_entries': {
          let entries = await this.entries();
          const leafId = this.leafId(entries);
          if (request.since !== undefined) {
            const since = requiredString(request.since, 'since');
            const index = entries.findIndex(entry => entry.id === since);
            if (index < 0) throw new Error(`Entry not found: ${since}`);
            entries = entries.slice(index + 1);
          }
          return success(id, command, { entries, leafId });
        }
        case 'get_tree': {
          const entries = await this.entries();
          return success(id, command, { tree: this.entryTree(entries), leafId: this.leafId(entries) });
        }
        case 'get_last_assistant_text': {
          const message = [...this.session().messages].reverse().find(candidate => candidate.role === 'assistant');
          return success(id, command, { text: message?.content || null });
        }
        case 'set_session_name': {
          const name = requiredString(request.name, 'name').trim();
          if (!name) return failure(id, command, 'Session name cannot be empty');
          await this.context.sessionManager.update(this.currentSessionId, { title: name });
          await this.emit({ type: 'session_info_changed', name });
          return success(id, command);
        }
        case 'get_messages':
          return success(id, command, { messages: this.rpcMessages() });
        case 'get_commands':
          return success(id, command, {
            commands: [
              ...this.context.extensionRegistry.getCommands().map(registered => ({
                name: registered.name,
                description: registered.description,
                source: 'extension',
                sourceInfo: { path: registered.extensionId, source: 'cli', scope: 'temporary', origin: 'top-level' },
              })),
              ...(this.context.resourceManager?.listPrompts().map(prompt => ({
                name: prompt.name,
                description: prompt.description,
                source: 'prompt',
                sourceInfo: {
                  path: prompt.provenance.path,
                  source: prompt.provenance.source,
                  scope: prompt.provenance.scope,
                  origin: prompt.provenance.origin,
                },
              })) ?? []),
              ...(this.context.enableSkillCommands === false ? []
                : this.context.resourceManager?.listSkills().map(skill => ({
                  name: `skill:${skill.name}`,
                  description: skill.description,
                  source: 'skill',
                  sourceInfo: {
                    path: skill.provenance.path,
                    source: skill.provenance.source,
                    scope: skill.provenance.scope,
                    origin: skill.provenance.origin,
                  },
                })) ?? []),
            ],
          });
        default:
          return failure(id, command, `Unknown command: ${command}`);
      }
    } catch (error) {
      return failure(id, command, error instanceof Error ? error.message : String(error));
    }
  }

  private extensionCommand(message: string): { name: string; args: string } | undefined {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return undefined;
    const [rawName, ...args] = trimmed.slice(1).split(/\s+/);
    const name = rawName?.toLowerCase();
    return name && this.context.extensionRegistry.getCommand(name)
      ? { name, args: args.join(' ') }
      : undefined;
  }

  private isExtensionCommand(message: string): boolean {
    return this.extensionCommand(message) !== undefined;
  }

  private async executeExtensionCommand(message: string): Promise<boolean> {
    const parsed = this.extensionCommand(message);
    if (!parsed) return false;
    const extensionCommand = this.context.extensionRegistry.getCommand(parsed.name)!;
    try {
      const result = await extensionCommand.handler(parsed.args, {
        ...this.context.toolContext,
        currentSessionId: this.currentSessionId,
        provider: this.context.provider,
        providerName: this.context.providerName,
      });
      if (typeof result === 'string' && result) this.context.toolContext.notify(result, 'info');
      return true;
    } catch (error) {
      const descriptor = this.context.extensionRegistry.getCommands().find(item => item.name === parsed.name);
      await this.emit({
        type: 'extension_error',
        extensionPath: descriptor?.extensionId ?? parsed.name,
        event: 'command',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private expandResourceCommand(message: string): string {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/') || !this.context.resourceManager) return message;
    const [name = '', ...args] = parseResourceCommandLine(trimmed.slice(1));
    if (this.context.enableSkillCommands !== false && name.startsWith('skill:')
      && this.context.resourceManager.getSkill(name.slice('skill:'.length))) {
      return this.context.resourceManager.invokeSkill(name.slice('skill:'.length), args.join(' '));
    }
    if (this.context.resourceManager.getPrompt(name)) {
      return this.context.resourceManager.expandPrompt(name, args);
    }
    return message;
  }

  private async preparePrompt(message: unknown, imagesValue: unknown, signal: AbortSignal): Promise<PreparedPrompt> {
    if (signal.aborted) throw new AgentAbortError();
    const sessionId = this.currentSessionId;
    const expanded = this.expandResourceCommand(requiredString(message, 'message'));
    const content = this.context.redactText?.(expanded) ?? expanded;
    const rawImages = optionalImages(imagesValue);
    const images = this.context.redactJson?.(rawImages) ?? rawImages;
    if (!content.trim() && images.length === 0) throw new Error('message must not be empty.');
    if (!this.context.provider.validateConfig()) {
      throw new Error(`Provider is not configured: ${this.context.providerName}`);
    }
    const hook = await this.context.extensionRegistry.runBefore('before:agent', {
      sessionId: this.currentSessionId,
      provider: this.context.redactText?.(this.context.providerName) ?? this.context.providerName,
      input: content,
      signal,
    });
    if (signal.aborted) throw new AgentAbortError();
    if (this.currentSessionId !== sessionId) throw new Error('Session changed while admitting a prompt.');
    if (this.activeRun && !this.runAccepting) throw new Error('Agent is settling; await agent_settled before queueing.');
    if (hook.cancelled) {
      const reason = hook.reason ?? "Requête annulée par un hook d'extension.";
      throw new Error(this.context.redactText?.(reason) ?? reason);
    }
    const safeHookData = this.context.redactJson?.(hook.data) ?? hook.data;
    const transformed = safeHookData.input;
    if (!transformed.trim() && images.length === 0) throw new Error("Requête annulée : le hook d'extension a produit une entrée vide.");
    return {
      content: transformed,
      images,
      blocks: [
        ...(transformed ? [{ type: 'text' as const, text: transformed }] : []),
        ...imageBlocks(images),
      ],
    };
  }

  private start(prompt: PreparedPrompt, controller: AbortController): void {
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    this.activeRun = { controller, done };
    this.runAccepting = true;
    const releaseWork = retainAgentWork();
    setImmediate(() => {
      void this.execute(prompt, controller.signal)
        .catch(error => { this.runFailure ??= error; })
        .finally(() => {
          this.activeRun = undefined;
          settle();
          releaseWork();
        });
    });
  }

  private async execute(initialPrompt: PreparedPrompt, signal: AbortSignal): Promise<void> {
    let nextAgentPrompt: PreparedPrompt | undefined = initialPrompt;
    let activeDynamicTools: RpcDynamicTools | undefined;
    let cleanupFailed = false;
    try {
      while (nextAgentPrompt) {
        if (signal.aborted) throw new AgentAbortError();
        const dynamicTools = await this.context.prepareDynamicTools?.(this.currentSessionId, signal);
        activeDynamicTools = dynamicTools;
        if (signal.aborted) throw new AgentAbortError();
        const staticTools = this.context.tools ?? this.context.extensionRegistry.getTools().map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        }));
        const staticNames = new Set(staticTools.map(tool => tool.name.toLowerCase()));
        const resolveTools = (): ChatToolDefinition[] => {
          const dynamicDefinitions = dynamicTools?.resolveTools?.() ?? dynamicTools?.tools ?? [];
          return [
            ...staticTools,
            ...dynamicDefinitions.filter(tool => !staticNames.has(tool.name.toLowerCase())),
          ];
        };
        await this.events.startAgent(nextAgentPrompt.content, nextAgentPrompt.blocks);
        await this.context.extensionRegistry.emit('agent:start', {
          sessionId: this.currentSessionId,
          provider: this.context.providerName,
        });
        let prompt: PreparedPrompt | undefined = nextAgentPrompt;
        let lastContent = '';

        while (prompt) {
          if (signal.aborted) throw Object.assign(new Error("Exécution de l'agent interrompue."), { name: 'AbortError' });
          const routed = prompt.blocks.some(block => block.type === 'image') && this.context.extensionRegistry.virtualModels.get(this.context.providerName, this.model)
            ? await resolveRoutedImageTarget(this.context.sessionManager, this.currentSessionId, this.context.extensionRegistry.virtualModels, name => this.configuredProvider(name), signal) : undefined;
          const prepared = await prepareMessageImages(routed?.provider ?? this.context.provider, routed?.model ?? this.model, prompt.content, prompt.blocks, 'prompt', this.context.agentSettings?.().images, signal);
          this.events.continueAgent(prepared.content, prepared.blocks);
          await this.context.sessionManager.addMessage(this.currentSessionId, {
            role: 'user',
            content: prepared.content,
            blocks: prepared.blocks,
          }, { signal });

          let activeToolCall: ToolCall | undefined;
          let activeToolOutput = '';
          let activeToolRedactor = this.context.createTextRedactor?.();
          lastContent = await runToolLoop({
            sessionManager: this.context.sessionManager,
            sessionId: this.currentSessionId,
            extensionRegistry: this.context.extensionRegistry,
            imageAutoResize: this.context.agentSettings?.().images?.autoResize,
            resolveImageProvider: name => this.configuredProvider(name),
            tools: resolveTools(),
            resolveTools,
            executeTool: (name, input, context, executionSignal) => {
              const dynamicNames = new Set(resolveTools()
                .filter(tool => !staticNames.has(tool.name.toLowerCase()))
                .map(tool => tool.name.toLowerCase()));
              if (dynamicTools && dynamicNames.has(name.toLowerCase())) {
                return (dynamicTools.isHosted?.(name) ?? true)
                  ? this.context.extensionRegistry.executeHostedTool(
                      name,
                      input,
                      context,
                      (hostInput, hostContext, hostSignal) => dynamicTools.execute(
                        name, hostInput, hostContext, hostSignal,
                      ),
                      executionSignal,
                    )
                  : dynamicTools.execute(name, input, context, executionSignal);
              }
              return this.context.extensionRegistry.executeTool(name, input, context, executionSignal);
            },
            canExecuteInParallel: name => staticNames.has(name.toLowerCase()) && this.context.extensionRegistry.getTools()
              .some(tool => tool.name.toLowerCase() === name.toLowerCase() && tool.readOnly === true),
            getActivatedTools: (name, result) => dynamicTools?.getActivatedTools?.(name, result),
            getToolResultMetadata: (name, result) => dynamicTools?.getToolResultMetadata?.(name, result),
            toolContext: {
              ...this.context.toolContext,
              currentSessionId: this.currentSessionId,
              provider: this.context.provider,
              providerName: this.context.providerName,
              onProcessOutput: delta => {
                if (!activeToolCall) return;
                const safeDelta = activeToolRedactor?.push(delta)
                  ?? this.context.redactText?.(delta)
                  ?? delta;
                if (!safeDelta) return;
                activeToolOutput = truncateToolTail(activeToolOutput + safeDelta).content;
                return this.events.toolExecutionUpdate(activeToolCall, activeToolOutput);
              },
            },
            onTurnStart: () => this.events.startTurn(),
            streamTurn: async (messages, tools) => {
              let partialContent = '', partialReasoning = '';
              let physicalProvider = this.context.providerName, physicalModel = this.model;
              const retryController = new AbortController();
              try {
                return await streamProviderTurn({
                  provider: this.context.provider,
                  providerName: this.context.providerName,
                  blockImages: this.context.agentSettings?.().images?.blockImages,
                  model: this.model,
                  sessionId: this.currentSessionId,
                  sessionManager: this.context.sessionManager,
                  messages,
                  tools,
                  systemPrompt: this.context.systemPrompt,
                  thinking: coreThinkingLevel(this.thinking),
                  thinkingBudgets: this.context.agentSettings?.().thinkingBudgets,
                  cacheWarming: this.context.agentSettings?.().cacheWarming,
                  resolveProvider: name => this.context.providers?.get(name),
                  signal,
                  retrySignal: retryController.signal,
                  extensionRegistry: this.context.extensionRegistry,
                  redactText: this.context.redactText,
                  redactJson: this.context.redactJson,
                  createTextRedactor: this.context.createTextRedactor,
                  onStart: (provider, model) => {
                    physicalProvider = provider; physicalModel = model;
                    return this.events.startAssistant(provider, model);
                  },
                  onTextDelta: delta => { partialContent += delta; return this.events.textDelta(delta); },
                  onReasoningDelta: delta => { partialReasoning += delta; return this.events.reasoningDelta(delta); },
                  onError: async error => {
                    if (!signal.aborted && (partialContent || partialReasoning)) {
                      await this.context.sessionManager.addMessage(this.currentSessionId, {
                        role: 'assistant', content: partialContent,
                        blocks: [
                          ...(partialReasoning ? [{ type: 'reasoning' as const, text: partialReasoning }] : []),
                          ...(partialContent ? [{ type: 'text' as const, text: partialContent }] : []),
                        ], provider: physicalProvider, model: physicalModel,
                        metadata: { outputError: (this.context.redactText?.(error instanceof Error ? error.message : String(error))
                          ?? (error instanceof Error ? error.message : String(error))).slice(0, 4_000) },
                      }, { skipAutoCompaction: true, signal });
                    }
                    await this.events.finishAssistantError(error, signal.aborted);
                  },
                  onRetryStart: ({ attempt, maxAttempts, delayMs, error }) => {
                    this.retryActive = true;
                    this.retryAbortController = retryController;
                    return this.events.retryStart(attempt, maxAttempts, delayMs, error);
                  },
                  onRetryEnd: ({ success, attempt, finalError }) => {
                    this.retryActive = false;
                    if (this.retryAbortController === retryController) this.retryAbortController = undefined;
                    return this.events.retryEnd(success, attempt, finalError);
                  },
                  maxRetries: this.autoRetryEnabled ? this.context.retryMaxRetries ?? 3 : 0,
                  retryDelayMs: this.context.retryDelayMs ?? 2_000,
                  retryMaxDelayMs: this.context.retryMaxDelayMs ?? 60_000,
                });
              } finally {
                this.retryActive = false;
                if (this.retryAbortController === retryController) this.retryAbortController = undefined;
              }
            },
            onToolProgress: progress => this.events.toolProgress(progress),
            onCodemodeProgress: progress => { void this.events.codemodeProgress(progress).catch(() => this.activeRun?.controller.abort()); },
            onAssistantResponse: response => this.events.finishAssistant(response),
            onToolCall: call => {
              activeToolCall = call;
              activeToolOutput = '';
              activeToolRedactor = this.context.createTextRedactor?.();
              return this.events.toolExecutionStart(call);
            },
            onToolResult: async result => {
              const finalDelta = activeToolRedactor?.flush() ?? '';
              if (activeToolCall && finalDelta) {
                activeToolOutput = truncateToolTail(activeToolOutput + finalDelta).content;
                await this.events.toolExecutionUpdate(activeToolCall, activeToolOutput);
              }
              activeToolCall = undefined;
              activeToolOutput = '';
              await this.events.toolExecutionEnd(result);
            },
            onTurnEnd: () => this.events.endTurn(),
            beforeNextTurn: async () => {
              const steering = this.takeNextSteering();
              if (!steering) return;
              const routed = steering.blocks.some(block => block.type === 'image') && this.context.extensionRegistry.virtualModels.get(this.context.providerName, this.model)
                ? await resolveRoutedImageTarget(this.context.sessionManager, this.currentSessionId, this.context.extensionRegistry.virtualModels, name => this.configuredProvider(name), signal) : undefined;
              const prepared = await prepareMessageImages(routed?.provider ?? this.context.provider, routed?.model ?? this.model, steering.content, steering.blocks, 'prompt', this.context.agentSettings?.().images, signal);
              await this.events.continueAgent(prepared.content, prepared.blocks);
              await this.context.sessionManager.addMessage(this.currentSessionId, {
                role: 'user',
                content: prepared.content,
                blocks: prepared.blocks,
              }, { signal });
            },
            signal,
            provider: this.context.providerName,
            redactText: this.context.redactText,
          });

          prompt = this.takeNextSteering();
          if (prompt) await this.events.continueAgent(prompt.content, prompt.blocks);
        }

        await this.context.extensionRegistry.emit('agent:end', {
          sessionId: this.currentSessionId,
          contentLength: lastContent.length,
        });
        const completedTools = activeDynamicTools;
        activeDynamicTools = undefined;
        try { await completedTools?.release?.(); }
        catch (error) { cleanupFailed = true; throw error; }
        await this.events.endAgent(false);
        if (signal.aborted) throw new AgentAbortError();
        nextAgentPrompt = this.takeNextQueued();
      }
    } catch (error) {
      this.runAccepting = false;
      await this.events.failAgent(error, signal.aborted, false).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      await this.context.extensionRegistry.emit('agent:error', {
        sessionId: this.currentSessionId,
        error: this.context.redactText?.(message) ?? message,
      });
      if (cleanupFailed) throw error;
    } finally {
      this.runAccepting = false;
      try { await activeDynamicTools?.release?.(); }
      finally { this.retryActive = false; }
      if (!cleanupFailed) await this.events.settleAgent();
    }
  }

  private async exportHtml(requestedPath?: string): Promise<string> {
    const session = this.session();
    const root = path.resolve(this.context.toolContext.cwd ?? process.cwd());
    const defaultName = `${sanitizeFilename(session.title || session.id)}.html`;
    const outputPath = path.resolve(root, requestedPath?.trim() || defaultName);
    if (outputPath !== root && !outputPath.startsWith(`${root}${path.sep}`)) {
      throw new Error('HTML export path must stay inside the active workspace.');
    }
    let current = root;
    for (const segment of path.relative(root, outputPath).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error('HTML export path must not traverse symbolic links.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    const handle = await open(
      outputPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT
        | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      0o600,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink > 1) throw new Error('HTML export path must be a regular, unlinked file.');
      await handle.chmod(0o600);
      await handle.truncate(0);
      const safeSession = this.context.redactJson?.(session) ?? session;
      await handle.writeFile(renderSessionHtml(safeSession), { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    return outputPath;
  }

  private async summarizeWithRetry<T>(
    reason: 'manual' | 'threshold' | 'overflow',
    operation: (signal?: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const maxAttempts = 3;
    const retryController = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, retryController.signal])
      : retryController.signal;
    this.summarizationAbortController = retryController;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(new DOMException('Compaction cancelled', 'AbortError')); });
    void cancelled.catch(() => undefined);
    const removeListener = signal.removeEventListener.bind(signal);
    let retried = false;
    let completed: { result: T } | undefined;
    try {
      // Node's composite-signal listener hook reads .aborted; subscribe before exposing it.
      signal.addEventListener('abort', cancel, { once: true });
      if (summaryAborted(signal)) cancel();
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (summaryAborted(signal)) throw new DOMException('Compaction cancelled', 'AbortError');
        if (attempt > 1) await this.events.summarizationRetryAttemptStart('compaction', reason);
        try {
          if (summaryAborted(signal)) throw new DOMException('Compaction cancelled', 'AbortError');
          completed = { result: await awaitSummary(Promise.resolve(operation(signal)), signal, cancelled) };
          break;
        } catch (error) {
          if (summaryAborted(signal)) throw new DOMException('Compaction cancelled', 'AbortError');
          if (attempt >= maxAttempts) throw error;
          retried = true;
          this.retryActive = true;
          this.retryAbortController = retryController;
          const delayMs = Math.min(5_000, (this.context.summarizationRetryDelayMs ?? 2_000) * 2 ** (attempt - 1));
          await this.events.summarizationRetryScheduled(attempt, maxAttempts, delayMs, error);
          await waitForRetry(delayMs, signal, cancelled);
        }
      }
      if (!completed) throw new Error('Summarization retry exhausted.');
    } finally {
      try {
        if (retried) await this.events.summarizationRetryFinished();
      } finally {
        removeListener('abort', cancel);
        if (this.retryAbortController === retryController) this.retryAbortController = undefined;
        if (this.summarizationAbortController === retryController) this.summarizationAbortController = undefined;
        this.retryActive = false;
      }
    }
    if (summaryAborted(signal)) throw new DOMException('Compaction cancelled', 'AbortError');
    return completed.result;
  }

  private directChat(provider: AiProvider): AiProvider['chat'] {
    return (messages, options) => this.context.extensionRegistry.chat(provider, messages, options, name => this.context.providers?.get(name));
  }

  private async compact(customInstructions?: string): Promise<Record<string, unknown>> {
    // Admit synchronously before observers/provider callbacks can reenter the controller.
    if (this.navigationRetired) throw new DOMException('Compaction cancelled', 'AbortError');
    this.assertNoContextReload('compact');
    if (this.activeNavigation) throw new Error('compact is not available while navigating the session tree.');
    if (this.activeRun) throw new Error('compact is not available while the agent is processing.');
    if (this.activeBash || this.activeCompaction || this.compacting) throw new Error('compact is not available while a foreground operation is processing.');
    const manager = this.context.sessionManager, session = this.session(), sourceSessionId = this.currentSessionId;
    const source = manager.captureCompactionSource(sourceSessionId);
    if (!source) throw new Error('Compaction context or policy changed.');
    const leaf = session.activeLeafId, provider = this.context.provider, providerName = this.context.providerName, model = this.model, thinking = this.thinking;
    const chat = this.directChat(provider);
    const redactText = this.context.redactText?.bind(this.context), redactJson = this.context.redactJson?.bind(this.context);
    const sourceMessages = session.messages.map(cloneMessage);
    if (sourceMessages.length < 3) throw new Error(`Not enough messages to compact (${sourceMessages.length}/3 minimum).`);
    const preparation = prepareCompactionContext(manager, sourceSessionId);
    if (!preparation) throw new Error('No complete context prefix to compact.');
    const messages = preparation.toCompact, firstKeptEntryId = preparation.firstKeptEntryId;
    const tokensBefore = preparation.messages.reduce((total, message) => total + Math.ceil(message.content.length / 4), 0);
    const retainedTokenEstimate = preparation.keptMessages.reduce((total, message) => total + Math.ceil(message.content.length / 4), 0);
    const controller = new AbortController();
    let finish!: () => void;
    const compaction: ActiveRun = { controller, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.activeCompaction = compaction;
    this.compacting = true;
    const validate = (): void => {
      if (controller.signal.aborted) throw new DOMException('Compaction cancelled', 'AbortError');
      if (this.context.sessionManager !== manager || this.currentSessionId !== sourceSessionId
        || manager.get(sourceSessionId) !== session || session.activeLeafId !== leaf) {
        throw new Error('Compaction context or policy changed.');
      }
    };
    try {
      await this.events.compactionStart('manual');
      validate();
      const rawInstruction = customInstructions?.trim()
        || 'Summarize this conversation concisely, preserving key information, decisions, and context.';
      const instruction = redactText?.(rawInstruction) ?? rawInstruction;
      const summaryInput = getSummaryModelMessages(messages);
      const safeMessages = redactJson?.(summaryInput) ?? summaryInput;
      assertCompactionTranscript(safeMessages);
      const rawSummaryResponse = await this.summarizeWithRetry('manual', signal => {
        const summaryMessages: Message[] = [
          ...safeMessages,
          { id: '__compact__', role: 'user', content: 'Summarize the conversation for future turns. Preserve unresolved work and concrete results.', timestamp: new Date() },
        ];
        assertCompactionTranscript(summaryMessages);
        return chat(summaryMessages, { model, sessionId: sourceSessionId, thinking: coreThinkingLevel(thinking), systemPrompt: instruction, signal, tools: [], maxTokens: 4096 });
      }, controller.signal);
      validate();
      const content = rawSummaryResponse && typeof rawSummaryResponse === 'object' ? Object.getOwnPropertyDescriptor(rawSummaryResponse, 'content') : undefined;
      if (content && 'value' in content && typeof content.value === 'string' && !content.value.trim()) throw new Error('Compaction failed: no summary generated.');
      const ownedResponse = copyCompactionResponse(rawSummaryResponse);
      const summaryResponse = copyCompactionResponse(redactJson?.(ownedResponse) ?? ownedResponse);
      const estimatedTokensAfter = Math.ceil(summaryResponse.content.length / 4) + retainedTokenEstimate;
      const persistedUsage = normalizeProviderUsage(summaryResponse.usage);
      validate();
      await manager.applyCompaction(sourceSessionId, summaryResponse.content, firstKeptEntryId, {
        instruction, tokensBefore, tokensAfter: estimatedTokensAfter, provider: summaryResponse.provider ?? providerName,
        model: summaryResponse.model ?? model, ...(persistedUsage ? { usage: persistedUsage } : {}),
      }, { signal: controller.signal, source });
      // A save already admitted by Core completes even if abort/close arrives during it.
      const rpcUsage = protocolUsage(providerName, summaryResponse.model ?? model, persistedUsage);
      const published = manager.get(sourceSessionId)?.metadata;
      const appliedSummary = typeof published?.compactionSummary === 'string' ? published.compactionSummary : summaryResponse.content;
      const appliedTokensAfter = (published?.compactionStats as { tokensAfter?: number } | undefined)?.tokensAfter ?? estimatedTokensAfter;
      const result = { summary: appliedSummary, firstKeptEntryId, tokensBefore, estimatedTokensAfter: appliedTokensAfter,
        ...(rpcUsage ? { usage: rpcUsage } : {}), details: {} };
      await this.events.compactionEnd('manual', { result });
      return result;
    } catch (error) {
      await this.events.compactionEnd('manual', { error, aborted: error instanceof Error && error.name === 'AbortError' });
      throw error;
    } finally {
      if (this.activeCompaction === compaction) this.activeCompaction = undefined;
      this.compacting = false;
      finish();
    }
  }

  private takeNextSteering(): PreparedPrompt | undefined {
    return this.takeQueued('steer');
  }

  private takeNextQueued(): PreparedPrompt | undefined {
    const batch = this.messageQueue.takeNext();
    if (!batch) return undefined;
    this.emitQueueUpdate();
    return batch.items.length === 1 ? batch.items[0] : this.combine(batch.items);
  }

  private takeQueued(kind: AgentMessageQueueKind): PreparedPrompt | undefined {
    const prompts = this.messageQueue.take(kind);
    if (prompts.length === 0) return undefined;
    this.emitQueueUpdate();
    return prompts.length === 1 ? prompts[0] : this.combine(prompts);
  }

  private emit(record: Record<string, unknown>): Promise<void> {
    const operation = this.eventTail.then(async () => {
      if (this.eventFailure) throw this.eventFailure;
      await this.emitRaw(this.context.redactJson?.(record) ?? record);
    });
    this.eventTail = operation.then(
      () => undefined,
      error => { this.eventFailure ??= error ?? new Error('RPC event delivery failed.'); },
    );
    // Lifecycle listeners are not all Promise-aware; keep ignored rejections observed.
    void operation.catch(() => undefined);
    return operation;
  }

  private emitQueueUpdate(): Promise<void> {
    const queued = this.messageQueue.snapshot();
    return this.emit({
      type: 'queue_update',
      steering: queued.steering.map(prompt => prompt.content),
      followUp: queued.followUp.map(prompt => prompt.content),
    });
  }

  private resetQueues(): void {
    this.messageQueue.clear();
    this.emitQueueUpdate();
  }

  private combine(prompts: PreparedPrompt[]): PreparedPrompt {
    return {
      content: prompts.map(prompt => prompt.content).join('\n\n'),
      images: prompts.flatMap(prompt => prompt.images),
      blocks: prompts.flatMap(prompt => prompt.blocks),
    };
  }

  private assertNoContextReload(command: string): void {
    if (this.activeContextReload) throw new Error(`${command} is not available while reloading context settings.`);
  }

  private async withBranchNavigation<T>(command: string, sourceSessionId: string,
    operation: (signal: AbortSignal) => Promise<T>): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
    if (this.navigationRetired) return { cancelled: true };
    await this.ensureIdle(command);
    if (this.navigationRetired) return { cancelled: true };
    if (this.activeNavigation || this.activeContextReload || this.activeRun || this.activeBash || this.compacting) {
      throw new Error(`${command} is not available while a foreground operation is processing.`);
    }
    if (this.currentSessionId !== sourceSessionId) throw new Error('Session changed while admitting a branch operation.');
    const controller = new AbortController();
    let finish!: () => void;
    const navigation: ActiveRun = { controller, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.activeNavigation = navigation;
    try { return { cancelled: false, value: await operation(controller.signal) }; }
    catch (error) {
      if (error instanceof SessionBranchCancelledError) return { cancelled: true };
      throw error;
    } finally {
      if (this.activeNavigation === navigation) this.activeNavigation = undefined;
      finish();
    }
  }

  private async ensureIdle(command: string): Promise<void> {
    this.assertNoContextReload(command);
    if (this.activeNavigation) throw new Error(`${command} is not available while navigating the session tree.`);
    if (this.activeRun) throw new Error(`${command} is not available while the agent is processing.`);
  }

  private session(): Session {
    const session = this.context.sessionManager.get(this.currentSessionId);
    if (!session) throw new Error(`Session not found: ${this.currentSessionId}`);
    return session;
  }

  private rpcMessages(): Array<Record<string, unknown>> {
    const messages = this.session().messages.map(message => ({
      timestamp: message.timestamp.getTime(),
      value: toJsonProtocolMessage(message),
    }));
    const commands = (this.session().commands ?? []).map(command => ({
      timestamp: command.timestamp.getTime(),
      value: toRpcBashMessage(command),
    }));
    return [...messages, ...commands]
      .sort((left, right) => left.timestamp - right.timestamp)
      .map(item => item.value);
  }

  private async activeRawEntries(): Promise<SessionEntry[]> {
    const source = (await this.context.sessionManager.getRawEntries(this.currentSessionId))
      .filter(entry => entry.type !== 'metadata');
    const session = this.session();
    if (!session.activeLeafId) return session.metadata?.activeLeafReset === true ? [] : source;
    const byId = new Map(source.map(entry => [entry.id, entry]));
    const pathIds = new Set<string>();
    let cursor: string | undefined = session.activeLeafId;
    while (cursor && !pathIds.has(cursor)) {
      const entry = byId.get(cursor);
      if (!entry) break;
      pathIds.add(cursor);
      cursor = entry.type === 'message' ? entry.parentMessageId : entry.parentEntryId;
    }
    if (pathIds.size <= 1 && source.length > 1 && session.metadata?.hasBranchedHistory !== true) return source;
    return source.filter(entry => pathIds.has(entry.id));
  }

  private async entries(): Promise<Array<Record<string, unknown> & { id: string }>> {
    const source = (await this.context.sessionManager.getRawEntries(this.currentSessionId))
      .filter(item => item.type !== 'metadata');
    let parentId: string | null = null;
    return source.map(item => {
      let entry: Record<string, unknown> & { id: string };
      if (item.type === 'message') {
        const message = entryMessage(item)!;
        entry = {
          type: 'message',
          id: item.id,
          parentId: item.parentMessageId ?? parentId,
          timestamp: new Date(item.timestamp).toISOString(),
          message: toJsonProtocolMessage(message),
        };
      } else if (item.type === 'command') {
        entry = {
          type: 'message',
          id: item.id,
          parentId: item.parentEntryId ?? parentId,
          timestamp: new Date(item.timestamp).toISOString(),
          message: toRpcBashMessage({ ...item, timestamp: new Date(item.timestamp) }),
        };
      } else if (item.type === 'compaction') {
        entry = {
          type: 'compaction',
          id: item.id,
          parentId: item.parentEntryId ?? parentId,
          timestamp: new Date(item.timestamp).toISOString(),
          summary: item.summary,
          firstKeptEntryId: item.firstKeptEntryId,
          ...(item.instruction ? { instruction: item.instruction } : {}),
          ...(item.tokensBefore !== undefined ? { tokensBefore: item.tokensBefore } : {}),
          ...(item.tokensAfter !== undefined ? { tokensAfter: item.tokensAfter } : {}),
          ...(item.provider ? { provider: item.provider } : {}),
          ...(item.model ? { model: item.model } : {}),
          ...(item.usage ? {
            usage: protocolUsage(item.provider ?? this.context.providerName, item.model, item.usage),
          } : {}),
        };
      } else if (item.type === 'branch_summary') {
        entry = {
          type: 'branch_summary',
          id: item.id,
          parentId: item.parentEntryId ?? parentId,
          timestamp: new Date(item.timestamp).toISOString(),
          summary: item.summary,
          branchName: item.branchName,
          ...(item.fromEntryId ? { fromId: item.fromEntryId } : {}),
          ...(item.provider ? { provider: item.provider } : {}),
          ...(item.model ? { model: item.model } : {}),
          ...(item.usage ? { usage: protocolUsage(item.provider ?? '', item.model, item.usage) } : {}),
        };
      } else if (item.type === 'context_edit' || item.type === 'loadout') {
        entry = { type: item.type, id: item.id, parentId: item.parentEntryId ?? parentId,
          timestamp: new Date(item.timestamp).toISOString(),
          ...(item.type === 'context_edit' ? { targetEntryId: item.targetEntryId,
            ...(item.replacement !== undefined ? { replacement: item.replacement } : {}) }
            : { changedFields: Object.keys(item.changes) }) };
      } else {
        entry = {
          type: item.type, id: item.id, parentId: item.parentEntryId ?? parentId,
          timestamp: new Date(item.timestamp).toISOString(), customType: item.customType,
          ...(item.type === 'custom_message' ? { content: item.content, display: item.display } : {}),
        };
      }
      if (this.session().metadata?.hasBranchedHistory === true) {
        entry.parentId = item.type === 'message' ? item.parentMessageId ?? null : item.parentEntryId ?? null;
      }
      parentId = item.id;
      return entry;
    });
  }

  private leafId(entries: Array<Record<string, unknown> & { id: string }>): string | null {
    const active = this.session().activeLeafId;
    if (!active && this.session().metadata?.activeLeafReset === true) return null;
    return active && entries.some(entry => entry.id === active) ? active : entries.at(-1)?.id ?? null;
  }

  private entryTree(entries: Array<Record<string, unknown> & { id: string }>): RpcTreeNode[] {
    const nodes = new Map(entries.map(entry => [entry.id, { entry, children: [] as RpcTreeNode[] }]));
    const roots: RpcTreeNode[] = [];
    for (const entry of entries) {
      const node = nodes.get(entry.id)!;
      const parentId = typeof entry.parentId === 'string' ? entry.parentId : undefined;
      const parent = parentId ? nodes.get(parentId) : undefined;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  private availableThinkingLevels(): RpcThinkingLevel[] {
    return supportedThinkingLevels(this.context.providerName, this.model, this.context.extensionRegistry, this.context.provider);
  }

  private configuredProvider(name: string): AiProvider | undefined {
    if (this.context.providers) return this.context.providers.get(name);
    return name === this.context.providerName ? this.context.provider : undefined;
  }

  private hasModelSources(sources: ReadonlyMap<string, AiProvider>): boolean {
    const providers = this.context.providers ?? new Map([[this.context.providerName, this.context.provider]]);
    return providers.size === sources.size && [...sources].every(([name, provider]) => providers.get(name) === provider);
  }

  private async availableModels(): Promise<Array<Record<string, unknown> & { provider: string; id: string }>> {
    const cacheMs = this.context.modelDiscoveryCacheMs ?? 30_000;
    if (!Number.isSafeInteger(cacheMs) || cacheMs < 0) {
      throw new Error('modelDiscoveryCacheMs must be a non-negative safe integer.');
    }
    if (!this.modelSources || !this.hasModelSources(this.modelSources)) {
      this.modelSources = new Map(this.context.providers ?? [[this.context.providerName, this.context.provider]]);
      this.modelCache = undefined;
      this.modelDiscovery = undefined;
    }
    const sources = this.modelSources;
    if (cacheMs > 0 && this.modelCache && this.modelCache.expiresAt >= Date.now()) return this.modelCache.models;
    if (this.modelDiscovery) return this.modelDiscovery;
    const discovery = this.discoverAvailableModels(sources).then(models => {
      if (this.modelSources !== sources || !this.hasModelSources(sources)) {
        throw new Error('Model catalogue changed during discovery.');
      }
      this.modelCache = { expiresAt: Date.now() + cacheMs, models };
      return models;
    });
    this.modelDiscovery = discovery;
    try {
      return await discovery;
    } finally {
      if (this.modelDiscovery === discovery) this.modelDiscovery = undefined;
    }
  }

  private async discoverAvailableModels(providers: ReadonlyMap<string, AiProvider>): Promise<Array<Record<string, unknown> & { provider: string; id: string }>> {
    if (!this.context.offline && this.context.providerModels) {
      const supplied = await this.context.providerModels();
      return supplied.filter((value): value is Record<string, unknown> & { provider: string; id: string } => (
        Boolean(value)
        && typeof value === 'object'
        && typeof (value as Record<string, unknown>).provider === 'string'
        && typeof (value as Record<string, unknown>).id === 'string'
      ));
    }

    const states = await Promise.all([...providers].map(async ([providerName, provider]) => {
      let configured = false;
      try { configured = provider.validateConfig(); } catch { /* Invalid providers remain listed but unavailable. */ }
      let discoveredModels: string[] = [];
      if (!this.context.offline && provider.canDiscoverModels()) {
        try {
          discoveredModels = await discoverProviderModelIds(provider, { retries: 0 });
        } catch { /* Published/configured metadata remains usable when live discovery is unavailable. */ }
      }
      return {
        provider: providerName,
        configured,
        configuredModel: provider === this.context.provider && providerName === this.context.providerName && this.model
          ? this.model
          : provider.getConfiguredModel(),
        discoveredModels,
        publishedModels: getProviderPublishedModels(provider),
        discoveryAuthoritative: provider.isModelDiscoveryAuthoritative?.() === true,
        getModelApi: (model: string) => provider.getModelApi?.(model),
      };
    }));
    return this.context.extensionRegistry.virtualModels.overlayCatalog(buildProviderModelCatalog(states)).flatMap(provider => (
      provider.models.map(model => toProtocolModelDescriptor(model))
    ));
  }

  private async selectThinking(requested: RpcThinkingLevel): Promise<void> {
    const level = clampThinkingLevel(requested, this.availableThinkingLevels());
    const changed = level !== this.thinking;
    this.thinking = level;
    await this.context.sessionManager.update(this.currentSessionId, { thinking: coreThinkingLevel(level) });
    if (changed) await this.emit({ type: 'thinking_level_changed', level });
  }

  private async selectModel(providerName: string, modelId: string, provider: AiProvider): Promise<void> {
    provider.setConfiguredModel(modelId);
    this.context.provider = provider;
    this.context.providerName = providerName;
    this.context.toolContext.provider = provider;
    this.context.toolContext.providerName = providerName;
    this.model = modelId;
    this.refreshCompactionSettings(true);
    const previousThinking = this.thinking;
    this.thinking = clampThinkingLevel(
      this.thinking,
      supportedThinkingLevels(providerName, modelId, this.context.extensionRegistry, provider),
    );
    await this.context.sessionManager.update(this.currentSessionId, {
      model: modelId,
      thinking: coreThinkingLevel(this.thinking),
      providerConfig: { type: providerName, model: modelId },
    });
    if (this.thinking !== previousThinking) {
      await this.emit({ type: 'thinking_level_changed', level: this.thinking });
    }
  }

  private refreshCompactionSettings(resetSessionWindow = false): void {
    if (!this.context.agentSettings) return;
    this.context.sessionManager.setCompactionSettings(resolveAgentCompactionSettings(
      this.context.agentSettings(),
      this.context.providerName,
      this.model,
    ));
    const window = resolveAgentCompactionContextWindow(this.context.providerName, this.model, this.context.provider);
    this.context.sessionManager.setCompactionContextWindow(window);
    if (resetSessionWindow) this.context.sessionManager.setCompactionContextWindow(window, this.currentSessionId);
  }

  private state(): Record<string, unknown> {
    const session = this.session();
    return {
      model: this.model ? createProtocolModelDescriptor(this.context.providerName, this.model, this.context.provider.getModelApi?.(this.model), getProviderPublishedModels(this.context.provider)) : null,
      thinkingLevel: this.thinking,
      isStreaming: this.activeRun !== undefined,
      isCompacting: this.compacting,
      steeringMode: this.messageQueue.getMode('steer'),
      followUpMode: this.messageQueue.getMode('follow-up'),
      sessionFile: this.context.sessionDir ? path.join(this.context.sessionDir, `${session.id}.jsonl`) : undefined,
      sessionId: session.id,
      sessionName: session.title,
      autoCompactionEnabled: session.autoCompaction !== false && this.context.sessionManager.getCompactionSettings().enabled,
      messageCount: session.messages.length,
      pendingMessageCount: this.messageQueue.size(),
    };
  }

  private async sessionStats(includeAccounting = false): Promise<Record<string, unknown>> {
    const session = this.session();
    const rawEntries = await this.context.sessionManager.getRawEntries(session.id);
    const accounting = getSessionAccounting(rawEntries, session.activeLeafId);
    const history = accounting.history;
    const usage = history.usage;
    const metadata = this.model ? getProviderPublishedModel(this.context.providerName, this.model, this.context.provider) : undefined;
    const contextWindow = metadata?.contextWindow;
    const contextTokens = this.context.sessionManager.estimateContextTokens(session.id);
    return {
      sessionFile: this.context.sessionDir ? path.join(this.context.sessionDir, `${session.id}.jsonl`) : undefined,
      sessionId: session.id,
      userMessages: history.userMessages,
      assistantMessages: history.assistantMessages,
      toolCalls: history.toolCalls,
      toolResults: history.toolResults,
      totalMessages: history.totalMessages,
      tokens: {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        total: usage.totalTokens ?? 0,
      },
      cost: history.cost === 'none' ? 0 : history.cost === 'known' ? history.knownCostUsd : null,
      ...(includeAccounting ? { accounting } : {}),
      ...(contextWindow || includeAccounting ? { contextUsage: {
        tokens: contextTokens,
        contextWindow: contextWindow ?? null,
        percent: contextTokens === null || !contextWindow ? null : Math.round((contextTokens / contextWindow) * 10_000) / 100,
      } } : {}),
      autoRetryEnabled: this.autoRetryEnabled,
    };
  }
}

export function isRpcCommandRequest(value: unknown): value is RpcCommandRequest {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string');
}

export function rpcParseError(error: unknown): RpcCommandResponse {
  return failure(undefined, 'parse', `Failed to parse command: ${error instanceof Error ? error.message : String(error)}`);
}
