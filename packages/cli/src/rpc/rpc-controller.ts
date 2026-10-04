import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import {
  buildProviderModelCatalog,
  calculatePublishedModelCost,
  clampPublishedThinkingLevel,
  cleanupExpiredProcessOutputs,
  createProtocolModelDescriptor,
  createTemporaryProcessOutput,
  discoverProviderModelIds,
  getPublishedModelMetadata,
  getSupportedThinkingLevels,
  normalizeProviderUsage,
  resolveModelScope as resolveSharedModelScope,
  toProtocolModelDescriptor,
  truncateToolTail,
} from '@ai-harness/core';
import type {
  AiProvider,
  ChatToolDefinition,
  ExtensionRegistry,
  ExtensionRuntimeContext,
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
import type { ResourceManager } from '../resources/resource-manager.js';

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
  tools?: ChatToolDefinition[];
  hooks?: { emit(event: string, data: Record<string, unknown>): Promise<void> };
  thinking?: ThinkingLevel;
  providerModels?: () => unknown[] | Promise<unknown[]>;
  steeringMode?: 'one-at-a-time' | 'all';
  followUpMode?: 'one-at-a-time' | 'all';
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
}

export interface RpcCommandRequest {
  type: string;
  id?: string;
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

type QueueMode = 'one-at-a-time' | 'all';
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

function supportedThinkingLevels(provider: string, model: string | undefined): RpcThinkingLevel[] {
  return getSupportedThinkingLevels(provider, model);
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

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Retry aborted.'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Retry aborted.'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
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
  private steeringMode: QueueMode = 'one-at-a-time';
  private followUpMode: QueueMode = 'one-at-a-time';
  private autoRetryEnabled = true;
  private retryActive = false;
  private retryAbortController?: AbortController;
  private summarizationAbortController?: AbortController;
  private compacting = false;
  private activeRun?: ActiveRun;
  private activeBash?: ActiveBash;
  private steeringQueue: PreparedPrompt[] = [];
  private followUpQueue: PreparedPrompt[] = [];
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
    this.steeringMode = context.steeringMode ?? 'one-at-a-time';
    this.followUpMode = context.followUpMode ?? 'one-at-a-time';
    this.autoRetryEnabled = context.retryEnabled ?? true;
    this.events = new JsonEventStream(record => this.emit(record));
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
        supportedThinkingLevels(this.context.providerName, this.model),
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
        supportedThinkingLevels(this.context.providerName, this.model),
      );
    }

    this.context.sessionManager.setAutoCompactionCallback(async (_sessionId, toCompact, _keptEntries, signal) => {
      const messages = toCompact.flatMap(entry => {
        const message = entryMessage(entry);
        return message ? [message] : [];
      });
      const response = await this.summarizeWithRetry('threshold', retrySignal => this.context.provider.chat([
        ...messages,
        {
          id: '__auto_compact__',
          role: 'user',
          content: 'Summarize the earlier conversation while preserving decisions, unresolved work, and concrete results.',
          timestamp: new Date(),
        },
      ], {
        model: this.model,
        thinking: coreThinkingLevel(this.thinking),
        systemPrompt: 'Produce a concise context summary for future assistant turns.',
        signal: retrySignal,
      }), signal);
      if (!response.content.trim()) throw new Error('Automatic compaction produced an empty summary.');
      return {
        summary: response.content,
        provider: this.context.providerName,
        model: response.model ?? this.model,
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

  async close(): Promise<void> {
    this.retryAbortController?.abort();
    this.summarizationAbortController?.abort();
    const activeBash = this.activeBash;
    activeBash?.controller.abort();
    if (activeBash) await activeBash.done;
    if (this.activeRun) {
      this.activeRun.controller.abort();
      await this.activeRun.done;
    }
    await this.eventTail;
    if (this.eventFailure) throw this.eventFailure;
  }

  async handle(request: RpcCommandRequest): Promise<RpcCommandResponse | undefined> {
    const id = typeof request.id === 'string' ? request.id : undefined;
    const command = request.type;
    try {
      if (this.eventFailure) throw this.eventFailure;
      switch (command) {
        case 'prompt': {
          const message = requiredString(request.message, 'message');
          if (await this.executeExtensionCommand(message)) {
            return success(id, command, { disposition: 'handled' });
          }
          const prompt = await this.preparePrompt(message, request.images);
          if (this.activeRun) {
            if (request.streamingBehavior === 'steer') this.steeringQueue.push(prompt);
            else if (request.streamingBehavior === 'followUp') this.followUpQueue.push(prompt);
            else throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
            await this.emitQueueUpdate();
            return success(id, command, { disposition: 'queued' });
          }
          this.start(prompt);
          return success(id, command, { disposition: 'started' });
        }
        case 'steer': {
          const message = requiredString(request.message, 'message');
          if (this.isExtensionCommand(message)) throw new Error('Extension commands are not allowed in steer; use prompt instead.');
          const prompt = await this.preparePrompt(message, request.images);
          this.steeringQueue.push(prompt);
          await this.emitQueueUpdate();
          return success(id, command, { disposition: 'queued' });
        }
        case 'follow_up': {
          const message = requiredString(request.message, 'message');
          if (this.isExtensionCommand(message)) throw new Error('Extension commands are not allowed in follow_up; use prompt instead.');
          const prompt = await this.preparePrompt(message, request.images);
          this.followUpQueue.push(prompt);
          await this.emitQueueUpdate();
          return success(id, command, { disposition: 'queued' });
        }
        case 'abort': {
          const active = this.activeRun;
          if (active) {
            active.controller.abort();
            await active.done;
          }
          return success(id, command);
        }
        case 'clear_queue': {
          const steering = this.steeringQueue.map(item => item.content);
          const followUp = this.followUpQueue.map(item => item.content);
          this.steeringQueue = [];
          this.followUpQueue = [];
          await this.emitQueueUpdate();
          return success(id, command, { steering, followUp });
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
        case 'set_model': {
          const provider = requiredString(request.provider, 'provider');
          const modelId = requiredString(request.modelId, 'modelId');
          const selected = this.configuredProvider(provider);
          const available = await this.availableModels();
          if (!selected || !available.some(model => model.provider === provider && model.id === modelId)) {
            return failure(id, command, `Model not found: ${provider}/${modelId}`);
          }
          await this.selectModel(provider, modelId, selected);
          return success(id, command, createProtocolModelDescriptor(provider, modelId));
        }
        case 'cycle_model': {
          const available = await this.availableModels();
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
            model: createProtocolModelDescriptor(next.model.provider, next.model.id),
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
          this.steeringMode = this.queueMode(request.mode);
          return success(id, command);
        case 'set_follow_up_mode':
          this.followUpMode = this.queueMode(request.mode);
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
          await this.ensureIdle(command);
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
          const shellCommand = requiredString(request.command, 'command');
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
                bashOutputTail = bashOutputTail.then(async () => {
                  capture(delta);
                  await outputCapture.write(delta);
                  await this.emit({
                    type: 'bash_execution_update',
                    ...(id ? { id } : {}),
                    delta,
                  });
                });
                return bashOutputTail;
              },
            }, controller.signal);
            await bashOutputTail;
            const details = result.details && typeof result.details === 'object'
              ? result.details as Record<string, unknown>
              : {};
            const truncated = details.truncated === true;
            retainFullOutput = truncated;
            return success(id, command, {
              output: result.content,
              exitCode: typeof details.exitCode === 'number' ? details.exitCode : result.isError ? 1 : 0,
              cancelled: false,
              truncated,
              ...(truncated ? { fullOutputPath } : {}),
            });
          } catch (error) {
            if (controller.signal.aborted) {
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
          return success(id, command, await this.sessionStats());
        case 'export_html': {
          const exportedPath = await this.exportHtml(
            typeof request.outputPath === 'string' ? request.outputPath : undefined,
          );
          return success(id, command, { path: exportedPath });
        }
        case 'switch_session': {
          await this.ensureIdle(command);
          const requested = requiredString(request.sessionPath, 'sessionPath');
          const sessionId = path.basename(requested).replace(/\.jsonl$/i, '');
          const session = this.context.sessionManager.get(sessionId) ?? await this.context.sessionManager.loadFromStore(sessionId);
          if (!session) throw new Error(`Session not found: ${requested}`);
          this.currentSessionId = session.id;
          const savedProviderName = typeof session.providerConfig?.type === 'string'
            ? session.providerConfig.type
            : this.context.providerName;
          const savedProvider = this.configuredProvider(savedProviderName);
          if (savedProvider) {
            this.context.provider = savedProvider;
            this.context.providerName = savedProviderName;
            this.context.toolContext.provider = savedProvider;
            this.context.toolContext.providerName = savedProviderName;
          }
          this.model = session.model ?? this.model;
          if (this.model) this.context.provider.setConfiguredModel(this.model);
          this.thinking = clampThinkingLevel(
            rpcThinkingLevel(session.thinking ?? this.thinking),
            this.availableThinkingLevels(),
          );
          this.resetQueues();
          await this.emit({ type: 'session_info_changed', name: session.title });
          await this.emit({ type: 'thinking_level_changed', level: this.thinking });
          return success(id, command, { cancelled: false });
        }
        case 'fork': {
          await this.ensureIdle(command);
          const source = this.session();
          const entryId = requiredString(request.entryId, 'entryId');
          const selected = await this.context.sessionManager.branchBeforeEntry(source.id, entryId);
          if (!selected) throw new Error(`Entry not found: ${entryId}`);
          this.resetQueues();
          return success(id, command, { text: selected.content, cancelled: false });
        }
        case 'clone': {
          await this.ensureIdle(command);
          const source = this.session();
          if (source.messages.length === 0) throw new Error('Cannot clone session: no current entry selected');
          const clone = await this.context.sessionManager.cloneSession(source.id, source.title);
          if (!clone) throw new Error(`Session not found: ${source.id}`);
          this.currentSessionId = clone.id;
          this.resetQueues();
          await this.emit({ type: 'session_info_changed', name: clone.title });
          return success(id, command, { cancelled: false });
        }
        case 'get_fork_messages': {
          const messages = (await this.activeRawEntries())
            .filter((entry): entry is Extract<SessionEntry, { type: 'message' }> => (
              entry.type === 'message' && entry.role === 'user'
            ))
            .map(message => ({ entryId: message.id, text: message.content }));
          return success(id, command, { messages });
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
                sourceInfo: { path: prompt.filePath, source: 'auto', scope: 'project', origin: 'top-level' },
              })) ?? []),
              ...(this.context.enableSkillCommands === false ? []
                : this.context.resourceManager?.listSkills().map(skill => ({
                  name: `skill:${skill.name}`,
                  description: skill.description,
                  source: 'skill',
                  sourceInfo: { path: skill.filePath, source: 'auto', scope: 'project', origin: 'top-level' },
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
    const [name = '', ...args] = trimmed.slice(1).split(/\s+/);
    if (this.context.enableSkillCommands !== false && name.startsWith('skill:')
      && this.context.resourceManager.getSkill(name.slice('skill:'.length))) {
      return this.context.resourceManager.invokeSkill(name.slice('skill:'.length), args.join(' '));
    }
    if (this.context.resourceManager.getPrompt(name)) {
      return this.context.resourceManager.expandPrompt(name, args);
    }
    return message;
  }

  private async preparePrompt(message: unknown, imagesValue: unknown): Promise<PreparedPrompt> {
    const content = this.expandResourceCommand(requiredString(message, 'message'));
    const images = optionalImages(imagesValue);
    if (!content.trim() && images.length === 0) throw new Error('message must not be empty.');
    if (!this.context.provider.validateConfig()) {
      throw new Error(`Provider is not configured: ${this.context.providerName}`);
    }
    const hook = await this.context.extensionRegistry.runBefore('before:agent', {
      sessionId: this.currentSessionId,
      provider: this.context.providerName,
      input: content,
    });
    if (hook.cancelled) throw new Error(hook.reason ?? "Requête annulée par un hook d'extension.");
    const transformed = hook.data.input;
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

  private start(prompt: PreparedPrompt): void {
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    this.activeRun = { controller, done };
    setImmediate(() => {
      void this.execute(prompt, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          this.activeRun = undefined;
          settle();
        });
    });
  }

  private async execute(initialPrompt: PreparedPrompt, signal: AbortSignal): Promise<void> {
    let nextAgentPrompt: PreparedPrompt | undefined = initialPrompt;
    try {
      while (nextAgentPrompt) {
        await this.events.startAgent(nextAgentPrompt.content, nextAgentPrompt.blocks);
        await this.context.extensionRegistry.emit('agent:start', {
          sessionId: this.currentSessionId,
          provider: this.context.providerName,
        });
        let prompt: PreparedPrompt | undefined = nextAgentPrompt;
        let lastContent = '';

        while (prompt) {
          if (signal.aborted) throw Object.assign(new Error("Exécution de l'agent interrompue."), { name: 'AbortError' });
          await this.context.sessionManager.addMessage(this.currentSessionId, {
            role: 'user',
            content: prompt.content,
            blocks: prompt.blocks,
          }, { signal });

          let activeToolCall: ToolCall | undefined;
          let activeToolOutput = '';
          lastContent = await runToolLoop({
            sessionManager: this.context.sessionManager,
            sessionId: this.currentSessionId,
            extensionRegistry: this.context.extensionRegistry,
            tools: this.context.tools,
            toolContext: {
              ...this.context.toolContext,
              currentSessionId: this.currentSessionId,
              provider: this.context.provider,
              providerName: this.context.providerName,
              onProcessOutput: delta => {
                if (!activeToolCall) return;
                activeToolOutput = truncateToolTail(activeToolOutput + delta).content;
                return this.events.toolExecutionUpdate(activeToolCall, activeToolOutput);
              },
            },
            onTurnStart: () => this.events.startTurn(),
            streamTurn: async (messages, tools) => {
              const retryController = new AbortController();
              try {
                return await streamProviderTurn({
                  provider: this.context.provider,
                  providerName: this.context.providerName,
                  model: this.model,
                  messages: this.withBashContext(messages),
                  tools,
                  systemPrompt: this.context.systemPrompt,
                  thinking: coreThinkingLevel(this.thinking),
                  signal,
                  retrySignal: retryController.signal,
                  extensionRegistry: this.context.extensionRegistry,
                  onStart: (provider, model) => this.events.startAssistant(provider, model),
                  onTextDelta: delta => this.events.textDelta(delta),
                  onReasoningDelta: delta => this.events.reasoningDelta(delta),
                  onError: error => this.events.finishAssistantError(error, signal.aborted),
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
            onAssistantResponse: response => this.events.finishAssistant(response),
            onToolCall: call => {
              activeToolCall = call;
              activeToolOutput = '';
              return this.events.toolExecutionStart(call);
            },
            onToolResult: result => {
              activeToolCall = undefined;
              activeToolOutput = '';
              return this.events.toolExecutionEnd(result);
            },
            onTurnEnd: () => this.events.endTurn(),
            beforeNextTurn: async () => {
              const steering = this.takeNextSteering();
              if (!steering) return;
              await this.events.continueAgent(steering.content, steering.blocks);
              await this.context.sessionManager.addMessage(this.currentSessionId, {
                role: 'user',
                content: steering.content,
                blocks: steering.blocks,
              }, { signal });
            },
            signal,
            provider: this.context.providerName,
          });

          prompt = this.takeNextSteering();
          if (prompt) await this.events.continueAgent(prompt.content, prompt.blocks);
        }

        await this.context.extensionRegistry.emit('agent:end', {
          sessionId: this.currentSessionId,
          contentLength: lastContent.length,
        });
        await this.events.endAgent();
        nextAgentPrompt = this.takeNextSteering() ?? this.takeNextFollowUp();
      }
    } catch (error) {
      await this.events.failAgent(error, signal.aborted).catch(() => undefined);
      await this.context.extensionRegistry.emit('agent:error', {
        sessionId: this.currentSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.retryActive = false;
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
      await handle.writeFile(renderSessionHtml(session), { encoding: 'utf8' });
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
    this.summarizationAbortController = retryController;
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, retryController.signal])
      : retryController.signal;
    let retried = false;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) await this.events.summarizationRetryAttemptStart('compaction', reason);
        try {
          return await operation(signal);
        } catch (error) {
          if (signal.aborted || attempt >= maxAttempts) throw error;
          retried = true;
          this.retryActive = true;
          this.retryAbortController = retryController;
          const delayMs = Math.min(5_000, (this.context.summarizationRetryDelayMs ?? 2_000) * 2 ** (attempt - 1));
          await this.events.summarizationRetryScheduled(attempt, maxAttempts, delayMs, error);
          await waitForRetry(delayMs, signal);
        }
      }
      throw new Error('Summarization retry exhausted.');
    } finally {
      if (retried) await this.events.summarizationRetryFinished();
      if (this.retryAbortController === retryController) this.retryAbortController = undefined;
      if (this.summarizationAbortController === retryController) this.summarizationAbortController = undefined;
      this.retryActive = false;
    }
  }

  private async compact(customInstructions?: string): Promise<Record<string, unknown>> {
    const session = this.session();
    if (session.messages.length < 3) {
      throw new Error(`Not enough messages to compact (${session.messages.length}/3 minimum).`);
    }
    this.compacting = true;
    await this.events.compactionStart('manual');
    try {
      const instruction = customInstructions?.trim()
        || 'Summarize this conversation concisely, preserving key information, decisions, and context.';
      const summaryResponse = await this.summarizeWithRetry('manual', signal => this.context.provider.chat([
        ...session.messages.map(cloneMessage),
        {
          id: '__compact__',
          role: 'user',
          content: 'Summarize the conversation for future turns. Preserve unresolved work and concrete results.',
          timestamp: new Date(),
        },
      ], {
        model: this.model,
        thinking: coreThinkingLevel(this.thinking),
        systemPrompt: instruction,
        signal,
      }));
      if (!summaryResponse.content.trim()) throw new Error('Compaction failed: no summary generated.');
      const firstKeptEntryId = session.messages.at(-2)?.id;
      if (!firstKeptEntryId) throw new Error('Compaction requires at least two retained messages.');
      const tokensBefore = session.messages.reduce((total, message) => total + Math.ceil(message.content.length / 4), 0);
      const estimatedTokensAfter = Math.ceil(summaryResponse.content.length / 4)
        + session.messages.slice(-2).reduce((total, message) => total + Math.ceil(message.content.length / 4), 0);
      const persistedUsage = normalizeProviderUsage(summaryResponse.usage);
      await this.context.sessionManager.applyCompaction(
        session.id,
        summaryResponse.content,
        firstKeptEntryId,
        {
          instruction,
          tokensBefore,
          tokensAfter: estimatedTokensAfter,
          provider: this.context.providerName,
          model: summaryResponse.model ?? this.model,
          ...(persistedUsage ? { usage: persistedUsage } : {}),
        },
      );
      const rpcUsage = protocolUsage(
        this.context.providerName,
        summaryResponse.model ?? this.model,
        persistedUsage,
      );
      const result = {
        summary: summaryResponse.content,
        firstKeptEntryId,
        tokensBefore,
        estimatedTokensAfter,
        ...(rpcUsage ? { usage: rpcUsage } : {}),
        details: {},
      };
      await this.events.compactionEnd('manual', { result });
      return result;
    } catch (error) {
      await this.events.compactionEnd('manual', {
        error,
        aborted: error instanceof Error && error.name === 'AbortError',
      });
      throw error;
    } finally {
      this.compacting = false;
    }
  }

  private takeNextSteering(): PreparedPrompt | undefined {
    if (this.steeringQueue.length === 0) return undefined;
    const next = this.steeringMode === 'all' && this.steeringQueue.length > 1
      ? this.combine(this.steeringQueue.splice(0))
      : this.steeringQueue.shift();
    this.emitQueueUpdate();
    return next;
  }

  private takeNextFollowUp(): PreparedPrompt | undefined {
    if (this.followUpQueue.length === 0) return undefined;
    const next = this.followUpMode === 'all' && this.followUpQueue.length > 1
      ? this.combine(this.followUpQueue.splice(0))
      : this.followUpQueue.shift();
    this.emitQueueUpdate();
    return next;
  }

  private emit(record: Record<string, unknown>): Promise<void> {
    const operation = this.eventTail.then(async () => {
      if (this.eventFailure) throw this.eventFailure;
      await this.emitRaw(record);
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
    return this.emit({
      type: 'queue_update',
      steering: this.steeringQueue.map(prompt => prompt.content),
      followUp: this.followUpQueue.map(prompt => prompt.content),
    });
  }

  private resetQueues(): void {
    this.steeringQueue = [];
    this.followUpQueue = [];
    this.emitQueueUpdate();
  }

  private combine(prompts: PreparedPrompt[]): PreparedPrompt {
    return {
      content: prompts.map(prompt => prompt.content).join('\n\n'),
      images: prompts.flatMap(prompt => prompt.images),
      blocks: prompts.flatMap(prompt => prompt.blocks),
    };
  }

  private queueMode(value: unknown): QueueMode {
    if (value !== 'one-at-a-time' && value !== 'all') throw new Error(`Invalid queue mode: ${String(value)}`);
    return value;
  }

  private async ensureIdle(command: string): Promise<void> {
    if (this.activeRun) throw new Error(`${command} is not available while the agent is processing.`);
  }

  private session(): Session {
    const session = this.context.sessionManager.get(this.currentSessionId);
    if (!session) throw new Error(`Session not found: ${this.currentSessionId}`);
    return session;
  }

  private withBashContext(messages: Message[]): Message[] {
    const commands = (this.session().commands ?? [])
      .filter(command => !command.excludedFromContext)
      .map(command => ({
        id: `bash-${command.id}`,
        role: 'user' as const,
        content: `Ran \`${command.command}\`\n\`\`\`\n${command.output ?? ''}\n\`\`\``,
        timestamp: command.timestamp,
        metadata: { bashCommandId: command.id },
      }));
    return [...messages, ...commands].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
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
      cursor = entry.type === 'message' ? entry.parentMessageId
        : entry.type === 'command' || entry.type === 'compaction' || entry.type === 'branch_summary'
          ? entry.parentEntryId
          : undefined;
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
      } else {
        entry = {
          type: 'branch_summary',
          id: item.id,
          parentId: item.parentEntryId ?? parentId,
          timestamp: new Date(item.timestamp).toISOString(),
          summary: item.summary,
          branchName: item.branchName,
        };
      }
      parentId = item.id;
      return entry;
    });
  }

  private leafId(entries: Array<Record<string, unknown> & { id: string }>): string | null {
    const active = this.session().activeLeafId;
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
    return supportedThinkingLevels(this.context.providerName, this.model);
  }

  private configuredProvider(name: string): AiProvider | undefined {
    if (this.context.providers) return this.context.providers.get(name);
    return name === this.context.providerName ? this.context.provider : undefined;
  }

  private async availableModels(): Promise<Array<Record<string, unknown> & { provider: string; id: string }>> {
    const cacheMs = this.context.modelDiscoveryCacheMs ?? 30_000;
    if (!Number.isSafeInteger(cacheMs) || cacheMs < 0) {
      throw new Error('modelDiscoveryCacheMs must be a non-negative safe integer.');
    }
    if (cacheMs > 0 && this.modelCache && this.modelCache.expiresAt >= Date.now()) return this.modelCache.models;
    if (this.modelDiscovery) return this.modelDiscovery;
    this.modelDiscovery = this.discoverAvailableModels();
    try {
      const models = await this.modelDiscovery;
      this.modelCache = { expiresAt: Date.now() + cacheMs, models };
      return models;
    } finally {
      this.modelDiscovery = undefined;
    }
  }

  private async discoverAvailableModels(): Promise<Array<Record<string, unknown> & { provider: string; id: string }>> {
    if (this.context.providerModels) {
      const supplied = await this.context.providerModels();
      return supplied.filter((value): value is Record<string, unknown> & { provider: string; id: string } => (
        Boolean(value)
        && typeof value === 'object'
        && typeof (value as Record<string, unknown>).provider === 'string'
        && typeof (value as Record<string, unknown>).id === 'string'
      ));
    }

    const providers = this.context.providers ?? new Map([[this.context.providerName, this.context.provider]]);
    const states = await Promise.all([...providers].map(async ([providerName, provider]) => {
      let configured = false;
      try { configured = provider.validateConfig(); } catch { /* Invalid providers remain listed but unavailable. */ }
      let discoveredModels: string[] = [];
      if (configured) {
        try {
          discoveredModels = await discoverProviderModelIds(provider, { retries: 0 });
        } catch { /* A configured provider remains selectable when live discovery is unavailable. */ }
      }
      return {
        provider: providerName,
        configured,
        configuredModel: providerName === this.context.providerName && this.model
          ? this.model
          : provider.getConfiguredModel(),
        discoveredModels,
      };
    }));
    return buildProviderModelCatalog(states).flatMap(provider => (
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
    const previousThinking = this.thinking;
    this.thinking = clampThinkingLevel(
      this.thinking,
      supportedThinkingLevels(providerName, modelId),
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

  private state(): Record<string, unknown> {
    const session = this.session();
    return {
      model: this.model ? createProtocolModelDescriptor(this.context.providerName, this.model) : null,
      thinkingLevel: this.thinking,
      isStreaming: this.activeRun !== undefined,
      isCompacting: this.compacting,
      steeringMode: this.steeringMode,
      followUpMode: this.followUpMode,
      sessionFile: this.context.sessionDir ? path.join(this.context.sessionDir, `${session.id}.jsonl`) : undefined,
      sessionId: session.id,
      sessionName: session.title,
      autoCompactionEnabled: session.autoCompaction !== false,
      messageCount: session.messages.length,
      pendingMessageCount: this.steeringQueue.length + this.followUpQueue.length,
    };
  }

  private async sessionStats(): Promise<Record<string, unknown>> {
    const session = this.session();
    const rawEntries = await this.context.sessionManager.getRawEntries(session.id);
    const messages = rawEntries.flatMap(entry => {
      const message = entryMessage(entry);
      return message ? [message] : [];
    });
    const commands = rawEntries.filter(entry => entry.type === 'command');
    const assistant = messages.filter(message => message.role === 'assistant');
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    let hasUnpricedUsage = false;
    for (const entry of rawEntries) {
      const message = entryMessage(entry);
      const entryUsage = message?.usage ?? (entry.type === 'compaction' ? entry.usage : undefined);
      if (!entryUsage) continue;
      const provider = message?.provider ?? (entry.type === 'compaction' ? entry.provider : undefined)
        ?? this.context.providerName;
      const model = message?.model ?? (entry.type === 'compaction' ? entry.model : undefined) ?? this.model;
      usage.input += entryUsage.inputTokens ?? 0;
      usage.output += entryUsage.outputTokens ?? 0;
      usage.cacheRead += entryUsage.cacheReadTokens ?? 0;
      usage.cacheWrite += entryUsage.cacheWriteTokens ?? 0;
      const entryCost = entryUsage.costUsd
        ?? (model ? calculatePublishedModelCost(provider, model, {
          inputTokens: entryUsage.inputTokens,
          outputTokens: entryUsage.outputTokens,
          cacheReadTokens: entryUsage.cacheReadTokens,
          cacheWriteTokens: entryUsage.cacheWriteTokens,
        }) : undefined);
      if (entryCost === undefined) {
        if ((entryUsage.totalTokens
          ?? ((entryUsage.inputTokens ?? 0) + (entryUsage.outputTokens ?? 0)
            + (entryUsage.cacheReadTokens ?? 0) + (entryUsage.cacheWriteTokens ?? 0))) > 0) {
          hasUnpricedUsage = true;
        }
      } else {
        usage.cost += entryCost;
      }
    }
    const metadata = this.model ? getPublishedModelMetadata(this.context.providerName, this.model) : undefined;
    const contextWindow = metadata?.contextWindow;
    const contextTokens = this.context.sessionManager.estimateContextTokens(session.id);
    return {
      sessionFile: this.context.sessionDir ? path.join(this.context.sessionDir, `${session.id}.jsonl`) : undefined,
      sessionId: session.id,
      userMessages: messages.filter(message => message.role === 'user').length,
      assistantMessages: assistant.length,
      toolCalls: assistant.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0),
      toolResults: messages.filter(message => message.role === 'tool').length,
      totalMessages: messages.length + commands.length,
      tokens: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      },
      cost: hasUnpricedUsage ? null : usage.cost,
      ...(contextWindow ? {
        contextUsage: {
          tokens: contextTokens,
          contextWindow,
          percent: contextTokens === null ? null : Math.round((contextTokens / contextWindow) * 10_000) / 100,
        },
      } : {}),
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
