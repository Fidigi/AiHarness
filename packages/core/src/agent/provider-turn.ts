import {
  normalizeProviderUsage,
  AnthropicProvider,
  type AiProvider,
  type ChatResponse,
  type ChatToolDefinition,
  type StreamEvent,
  type ThinkingLevel,
  type ThinkingBudgets,
} from '../providers/index.js';
import type { ExtensionRegistry } from '../extensions/extension-registry.js';
import type { Message, MessageContentBlock, TokenUsage } from '../types/index.js';
import { calculatePublishedModelCost } from '../providers/model-metadata.js';
import type { CredentialRedactionStream } from '../providers/credentials.js';
import { copyThinkingBudgets } from '../providers/thinking-budgets.js';
import { ProviderToolArgumentsError } from '../providers/tool-arguments.js';
import { ProviderContextOverflowError } from '../providers/context-overflow.js';
import { captureNativeOutputBudget, ProviderOutputBudgetError } from '../providers/provider-output-budget.js';
import { assertProviderRequestBudget, captureProviderRequestBudget, ProviderRequestContextError,
  type ProviderRequestBudget } from './provider-request-estimate.js';
import { ProviderRequestOptionsError } from './provider-request-options.js';
import { captureProviderCallLabels, captureProviderMessages, prepareProviderPayload } from './provider-request-payload.js';
import { AgentAbortError } from './tool-loop.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { resolveVirtualModelFallback, VirtualModelRoutingError, type VirtualModelReason, type VirtualModelRequest } from '../providers/virtual-models.js';
import { getProviderPublishedModel } from '../providers/provider-model-metadata.js';
import { clampPublishedThinkingLevel, getSupportedThinkingLevels } from '../providers/model-metadata.js';
import { getSessionCacheWarmer, type CacheWarmingMode } from '../providers/cache-warmer.js';
import { projectAssistantReplay } from '../providers/message-replay.js';
import { hasBedrockProfile } from '../providers/bedrock-profiles.js';
import { blockMessageImages } from '../media/message-images.js';

export interface StreamProviderTurnOptions {
  provider: AiProvider;
  providerName: string;
  model?: string;
  /** Trusted host conversation projection, never an extension/request-option override. */
  blockImages?: boolean;
  maxTokens?: number;
  temperature?: number;
  resolveProvider?(name: string): AiProvider | undefined | Promise<AiProvider | undefined>;
  routeReason?: VirtualModelReason;
  cacheWarming?: CacheWarmingMode;
  cacheRetention?: 'none' | 'short' | 'long';
  /** Stable conversation identity for provider transports with bounded continuation caches. */
  sessionId?: string;
  /** Owning hosts persist private post-hook loadout deltas before physical dispatch. */
  sessionManager?: SessionManager;
  messages: Message[];
  tools: ChatToolDefinition[];
  systemPrompt?: string;
  thinking?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  signal?: AbortSignal;
  /** Cancels only an in-progress retry delay, without aborting the provider run. */
  retrySignal?: AbortSignal;
  /** Optional owned canonical-policy ceiling; not vendor/media tokenization. */
  contextBudget?: ProviderRequestBudget;
  extensionRegistry: ExtensionRegistry;
  onStart?(provider: string, model?: string): void | Promise<void>;
  onTextDelta?(delta: string): void | Promise<void>;
  onReasoningDelta?(delta: string): void | Promise<void>;
  onProviderEvent?(event: StreamEvent): void | Promise<void>;
  onComplete?(response: ChatResponse): void | Promise<void>;
  onCacheWarmUsage?(usage: TokenUsage, provider: string, model: string): void | Promise<void>;
  onError?(error: unknown): void | Promise<void>;
  onRetryStart?(details: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }): void | Promise<void>;
  onRetryEnd?(details: { success: boolean; attempt: number; finalError?: unknown }): void | Promise<void>;
  maxRetries?: number;
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Hard guard for extension providers that do not await chunk delivery. */
  maxPendingStreamBytes?: number;
  /** Hard guard for the number of concurrently queued provider callbacks. */
  maxPendingStreamEvents?: number;
  /** Scrub a complete untrusted provider/extension string before it crosses a boundary. */
  redactText?(value: string): string;
  /** Scrub nested provider events and final responses. */
  redactJson?<T>(value: T): T;
  /** Build independent stateful scrubbers for text/reasoning chunk boundaries. */
  createTextRedactor?(): CredentialRedactionStream;
}

function captureRedactor<K extends 'redactText' | 'redactJson'>(options: StreamProviderTurnOptions,
  key: K): StreamProviderTurnOptions[K] {
  try {
    let source: object | null = options;
    for (let depth = 0; source && depth < 32; depth++, source = Object.getPrototypeOf(source)) {
      const property = Object.getOwnPropertyDescriptor(source, key);
      if (!property) continue;
      if (!('value' in property) || (property.value !== undefined && typeof property.value !== 'function')) throw new Error();
      return property.value as StreamProviderTurnOptions[K];
    }
    if (source) throw new Error();
    return undefined;
  } catch { throw new ProviderRequestOptionsError(); }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run one provider turn through shared extension and retry semantics while
 * preserving streamed text/reasoning deltas for any frontend adapter.
 */
export async function streamProviderTurn(options: StreamProviderTurnOptions): Promise<ChatResponse> {
  if (options.blockImages) options = { ...options, messages: blockMessageImages(options.messages) };
  const models = options.extensionRegistry.virtualModels;
  const hasVirtual = models.list().some(model => model.provider === options.providerName);
  if (hasVirtual && !options.model) captureNativeOutputBudget(options.provider);
  const definition = hasVirtual ? models.get(options.providerName, options.model ?? options.provider.getConfiguredModel()) : undefined;
  const resumed = !definition && options.sessionManager && options.sessionId && options.resolveProvider
    ? await resolveVirtualModelFallback(options.sessionManager, options.sessionId, models, options.resolveProvider,
      { provider: options.providerName, id: options.model }, options.signal) : undefined;
  if (!definition && !resumed) {
    if (options.sessionManager && options.sessionId && options.sessionManager.get(options.sessionId)) {
      options.sessionManager.setCompactionContextWindow(options.sessionManager.getCompactionContextWindow(), options.sessionId);
    }
    return streamPhysicalProviderTurn(options);
  }
  const virtual = definition ?? resumed!.virtual;
  let failed: VirtualModelRequest['failed'];
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new VirtualModelRoutingError();
  for (let attempt = 0; ; attempt++) {
    let producedOutput = false;
    const resolved = resumed ?? await models.resolve({ definition: definition!, messages: options.messages, thinking: options.thinking,
      reason: attempt ? 'retry' : options.routeReason ?? (options.sessionManager ? (options.messages.at(-1)?.role === 'user' ? 'user' : 'continuation') : 'direct'),
      failed, signal: options.signal, sessionId: options.sessionId, sessionManager: options.sessionManager,
      context: { resolveProvider: name => options.resolveProvider ? options.resolveProvider(name)
        : name === options.providerName ? options.provider : undefined },
    });
    const { provider, selection } = resolved;
    const metadata = getProviderPublishedModel(selection.provider, selection.id, provider);
    const api = provider.getModelApi?.(selection.id);
    const project = (input: Message[]): Message[] => input.flatMap(message => {
      const privateReplay = ['anthropic-messages', 'google-generative-ai', 'google-vertex', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(message.api ?? '')
        || message.api === 'bedrock-converse-stream' && hasBedrockProfile(message.model ?? '');
      if (message.role === 'assistant' && privateReplay && message.metadata?.outputError) return [];
      let projected = message;
      // Private replay belongs to the exact physical source, not the virtual alias.
      if (message.role === 'assistant' && (message.provider !== selection.provider || message.model !== selection.id
        || message.api !== undefined && message.api !== api)) {
        const source = privateReplay ? projectAssistantReplay(message, selection.provider, selection.id, api) : message;
        projected = { id: source.id, timestamp: source.timestamp, role: source.role, content: source.content,
          ...(source.toolCalls ? { toolCalls: source.toolCalls.map(({ thoughtSignature: _signature, ...call }) => call) } : {}),
          ...(source.blocks ? { blocks: source.blocks.flatMap((block): MessageContentBlock[] => {
            if (block.type === 'reasoning') return [];
            if (block.type === 'text') return [{ type: 'text' as const, text: block.text }];
            if (block.type === 'tool_call') { const { thoughtSignature: _signature, ...call } = block; return [call]; }
            return [block];
          }) } : {}) };
      }
      if (metadata?.capabilities.imageInput === false && projected.blocks?.some(block => block.type === 'image')) {
        projected = { ...projected, content: `${projected.content}\n[Image omitted: physical model does not support images.]`,
          blocks: projected.blocks.filter(block => block.type !== 'image') };
      }
      return projected;
    });
    const outputLimit = Math.min(metadata?.maxOutputTokens ?? Infinity, definition?.maxOutputTokens ?? Infinity);
    const manager = options.sessionManager;
    let messages = project(captureProviderMessages(options.messages));
    let contextBudget = options.contextBudget;
    const physicalWindow = metadata?.contextWindow ?? definition?.contextWindow;
    if (physicalWindow) {
      const window = Math.min(physicalWindow, definition?.contextWindow ?? Infinity, options.contextBudget?.contextWindow ?? Infinity);
      if (manager && options.sessionId) manager.setCompactionContextWindow(window, options.sessionId);
      contextBudget = { contextWindow: window,
        reserveTokens: manager?.getCompactionSettings().reserveTokens ?? options.contextBudget?.reserveTokens ?? 0 };
      try { assertProviderRequestBudget(messages, { systemPrompt: options.systemPrompt,
        tools: metadata?.capabilities.toolCalls === false ? [] : options.tools }, contextBudget); }
      catch (error) {
        if (!(error instanceof ProviderRequestContextError) || error.kind !== 'overflow' || !manager || !options.sessionId
          || !await manager.checkAndTriggerCompaction(options.sessionId, options.signal, 'overflow')) throw error;
        messages = manager.getEffectiveContext(options.sessionId).flatMap(entry => entry.type === 'message'
          ? [{ ...entry, timestamp: new Date(entry.timestamp) }] : []);
      }
    } else if (manager && options.sessionId) {
      manager.setCompactionContextWindow(options.contextBudget?.contextWindow, options.sessionId);
    }
    messages = project(messages);
    const dispatchSession = options.sessionId ? manager?.get(options.sessionId) : undefined;
    const dispatchLeaf = dispatchSession?.activeLeafId;
    const dispatchContext = manager && options.sessionId ? JSON.stringify(manager.getEffectiveContext(options.sessionId)) : undefined;
    let accepted: ChatResponse | undefined;
    try {
      const response = await streamPhysicalProviderTurn({ ...options, provider, providerName: selection.provider,
        model: selection.id, thinking: selection.thinkingLevel, messages, contextBudget, maxRetries: 0,
        cacheWarming: 'off',
        onComplete: undefined, onError: undefined,
        onTransportComplete: () => { producedOutput = true; },
        tools: metadata?.capabilities.toolCalls === false ? [] : options.tools,
        prepareDispatch: (input, request) => ({ messages: project(input), options: { ...request,
          ...(metadata?.capabilities.toolCalls === false ? { tools: [] } : {}),
          thinking: clampPublishedThinkingLevel(request.thinking ?? 'off', getSupportedThinkingLevels(selection.provider, selection.id, undefined, provider)),
          ...(Number.isFinite(outputLimit) && (request.maxTokens !== undefined || definition?.maxOutputTokens !== undefined)
            ? { maxTokens: Math.min(request.maxTokens ?? outputLimit, outputLimit) } : {}),
        } }),
        validateDispatch: async model => {
          const currentProvider = options.resolveProvider ? await options.resolveProvider(selection.provider)
            : selection.provider === options.providerName ? options.provider : undefined;
          if (currentProvider !== provider || !provider.validateConfig()) throw new VirtualModelRoutingError();
          if (manager && options.sessionId) {
            const ancestry = await manager.getActiveBranchEntries(options.sessionId);
            if (manager.get(options.sessionId) !== dispatchSession || ancestry.at(-1)?.id !== dispatchSession?.activeLeafId
              || dispatchLeaf && !ancestry.some(entry => entry.id === dispatchLeaf)
              || JSON.stringify(manager.getEffectiveContext(options.sessionId)) !== dispatchContext) throw new VirtualModelRoutingError();
          }
          if (models.get(virtual.provider, virtual.id) !== definition || models.get(selection.provider, model)
            || model !== selection.id) throw new VirtualModelRoutingError();
        },
        onTextDelta: delta => { producedOutput = true; return options.onTextDelta?.(delta); },
        onReasoningDelta: delta => { producedOutput = true; return options.onReasoningDelta?.(delta); },
        onProviderEvent: event => { if (event.type === 'tool_call') producedOutput = true; return options.onProviderEvent?.(event); },
      });
      accepted = { ...response, provider: selection.provider, model: response.model ?? selection.id,
        thinkingLevel: selection.thinkingLevel,
        selection: { provider: virtual.provider, id: virtual.id, thinkingLevel: options.thinking ?? 'off' as ThinkingLevel } };
    } catch (error) {
      if (producedOutput || options.signal?.aborted || options.retrySignal?.aborted || attempt >= maxRetries
        || error instanceof ProviderRequestContextError || error instanceof ProviderContextOverflowError
        || error instanceof ProviderToolArgumentsError || error instanceof ProviderOutputBudgetError || error instanceof VirtualModelRoutingError) {
        if (attempt) await options.onRetryEnd?.({ success: false, attempt: attempt + 1, finalError: error });
        await options.onError?.(error); throw error;
      }
      failed = { ...selection, error: options.redactText?.(error instanceof Error ? error.message : String(error))
        ?? 'Provider request failed.' };
      const delayMs = Math.min(options.retryMaxDelayMs ?? 5_000, (options.retryDelayMs ?? 500) * 2 ** attempt);
      await options.onRetryStart?.({ attempt: attempt + 1, maxAttempts: maxRetries + 1, delayMs, error });
      await abortableDelay(delayMs, options.signal && options.retrySignal
        ? AbortSignal.any([options.signal, options.retrySignal]) : options.signal ?? options.retrySignal);
    }
    if (accepted) {
      if (attempt) await options.onRetryEnd?.({ success: true, attempt: attempt + 1 });
      await options.onComplete?.(accepted);
      return accepted;
    }
  }
}

async function streamPhysicalProviderTurn(options: StreamProviderTurnOptions & {
  validateDispatch?(model?: string): Promise<void>;
  onTransportComplete?(): void;
  prepareDispatch?(messages: Message[], options: import('../providers/index.js').ChatOptions): {
    messages: Message[]; options: import('../providers/index.js').ChatOptions;
  };
}): Promise<ChatResponse> {
  const contextBudget = captureProviderRequestBudget(options), signal = options.signal, blockImages = options.blockImages === true;
  const sessionManager = options.sessionManager, sessionId = options.sessionId;
  const sourceSession = sessionId ? sessionManager?.get(sessionId) : undefined;
  const current = (): void => { if (signal?.aborted) throw new AgentAbortError(); };
  current();
  const redactText = captureRedactor(options, 'redactText'), redactJson = captureRedactor(options, 'redactJson');
  const safeText = (value: string): string => redactText ? Reflect.apply(redactText, options, [value]) as string ?? value : value;
  const safeJson = <T>(value: T): T => redactJson ? Reflect.apply(redactJson, options, [value]) as T ?? value : value;
  const safeError = (value: unknown): unknown => {
    if (value instanceof ProviderContextOverflowError) return new ProviderContextOverflowError();
    if (value instanceof ProviderRequestContextError) return new ProviderRequestContextError(value.kind);
    if (value instanceof VirtualModelRoutingError) return new VirtualModelRoutingError();
    if (value instanceof ProviderToolArgumentsError) return new ProviderToolArgumentsError();
    if (value instanceof ProviderOutputBudgetError) return new ProviderOutputBudgetError(
      value.message === new ProviderOutputBudgetError('thinking').message ? 'thinking' : undefined,
    );
    if (!redactText) return value;
    const message = safeText(value instanceof Error ? value.message : String(value));
    const error = new Error(message);
    if (value instanceof Error && value.name && value.name !== 'Error') error.name = safeText(value.name);
    return error;
  };
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new Error('maxRetries must be an integer between 0 and 10.');
  }
  const retryDelayMs = options.retryDelayMs ?? 500;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 5_000;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || !Number.isFinite(retryMaxDelayMs) || retryMaxDelayMs < 0) {
    throw new Error('Retry delays must be finite non-negative numbers.');
  }
  const maxPendingStreamBytes = options.maxPendingStreamBytes ?? 1024 * 1024;
  const maxPendingStreamEvents = options.maxPendingStreamEvents ?? 1024;
  if (!Number.isSafeInteger(maxPendingStreamBytes) || maxPendingStreamBytes < 1
    || !Number.isSafeInteger(maxPendingStreamEvents) || maxPendingStreamEvents < 1) {
    throw new Error('Streaming queue limits must be positive safe integers.');
  }

  const provider = options.provider, streamChat = provider.streamChat.bind(provider);
  const nativeOutputPolicy = contextBudget ? captureNativeOutputBudget(provider) : undefined;
  const providerHook = await options.extensionRegistry.runBefore('before:provider', {
    provider: safeText(options.providerName),
    model: options.model ? safeText(options.model) : undefined,
    messages: safeJson(captureProviderMessages(options.messages)),
    options: {
      model: options.model ? safeText(options.model) : undefined,
      sessionId: options.sessionId ? safeText(options.sessionId) : undefined,
      systemPrompt: options.systemPrompt ? safeText(options.systemPrompt) : undefined,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      tools: options.tools,
      thinking: options.thinking,
      ...(options.thinkingBudgets !== undefined ? { thinkingBudgets: copyThinkingBudgets(options.thinkingBudgets) } : {}),
      ...(options.cacheRetention !== undefined ? { cacheRetention: options.cacheRetention } : {}),
      signal,
    },
  });
  current();
  if (providerHook.cancelled) {
    throw new Error(providerHook.reason ?? "Appel provider annulé par un hook d'extension.");
  }

  // Validate before any extensible metadata redactor, without detaching the
  // mutable hook payload subsequently exposed to awaited start observers.
  const prepare = (redact: <T>(value: T) => T) => {
    try { return prepareProviderPayload(providerHook.data, redact, signal); }
    catch (error) {
      if (contextBudget && error instanceof ProviderRequestOptionsError) throw new ProviderRequestContextError('unmeasurable');
      throw error;
    }
  };
  const preview = prepare(<T>(value: T): T => value).data;
  const callLabels = captureProviderCallLabels(safeJson(captureProviderCallLabels(preview)));
  const callStartedAt = Date.now();
  await options.extensionRegistry.emit('provider:call:start', {
    provider: safeText(callLabels.provider),
    model: callLabels.model ? safeText(callLabels.model) : undefined,
  });
  await options.onStart?.(
    safeText(callLabels.provider),
    callLabels.model ? safeText(callLabels.model) : undefined,
  );

  current();
  const maxAttempts = maxRetries + 1;
  let streamedContent = '';
  let streamedReasoning = '';
  const contentRedactor = options.createTextRedactor?.();
  const reasoningRedactor = options.createTextRedactor?.();
  let response: ChatResponse | undefined;
  let retrying = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let attemptProducedOutput = false;
    let callbackDeliveryFailed = false;
    try {
      let completedResponse: ChatResponse | undefined;
      let streamError: Error | undefined;
      let deliveryFailure: unknown;
      let deliveryTail: Promise<void> = Promise.resolve();
      let pendingDeliveryBytes = 0;
      let pendingDeliveryEvents = 0;
      let accepting = true;
      const deliver = (chunk: string, event?: StreamEvent): Promise<void> => {
        // A retained extension callback has no authority after abort/transport return.
        if (!accepting || signal?.aborted) return Promise.resolve();
        const reasoningDelta = event?.type === 'reasoning_delta'
          && typeof (event.data as { content?: unknown } | undefined)?.content === 'string'
          ? String((event.data as { content: string }).content)
          : '';
        if (chunk || reasoningDelta || event?.type === 'tool_call') attemptProducedOutput = true;
        const eventBytes = event ? Buffer.byteLength(JSON.stringify(event) ?? '') : 0;
        const deliveryBytes = Buffer.byteLength(chunk) + Buffer.byteLength(reasoningDelta) + eventBytes;
        if (deliveryFailure || pendingDeliveryEvents >= maxPendingStreamEvents
          || pendingDeliveryBytes + deliveryBytes > maxPendingStreamBytes) {
          const error = deliveryFailure ?? new Error(
            `Provider streaming queue exceeded ${maxPendingStreamEvents} events or ${maxPendingStreamBytes} bytes; `
            + 'extension providers must await chunk callbacks.',
          );
          callbackDeliveryFailed = true;
          deliveryFailure ??= error;
          throw error;
        }
        pendingDeliveryEvents++;
        pendingDeliveryBytes += deliveryBytes;
        const operation = deliveryTail.then(async () => {
          if (deliveryFailure) throw deliveryFailure;
          if (signal?.aborted) return;
          if (event) await options.onProviderEvent?.(safeJson(event));
          if (reasoningDelta) {
            const safeReasoning = reasoningRedactor?.push(reasoningDelta) ?? safeText(reasoningDelta);
            streamedReasoning += safeReasoning;
            if (safeReasoning) await options.onReasoningDelta?.(safeReasoning);
          }
          if (chunk) {
            const safeChunk = contentRedactor?.push(chunk) ?? safeText(chunk);
            streamedContent += safeChunk;
            if (safeChunk) await options.onTextDelta?.(safeChunk);
          }
        });
        deliveryTail = operation.then(
          () => {
            pendingDeliveryEvents--;
            pendingDeliveryBytes -= deliveryBytes;
          },
          error => {
            pendingDeliveryEvents--;
            pendingDeliveryBytes -= deliveryBytes;
            callbackDeliveryFailed = true;
            deliveryFailure ??= error;
          },
        );
        // A third-party provider may ignore the returned Promise. Keep its rejection
        // observed while preserving rejection semantics for cooperative providers.
        void operation.catch(() => undefined);
        return operation;
      };

      let providerFailure: unknown;
      try {
        const prepared = prepare(safeJson);
        const projected = options.prepareDispatch?.(prepared.data.messages, prepared.data.options)
          ?? { messages: prepared.data.messages, options: prepared.data.options };
        const requestMessages = blockImages ? blockMessageImages(projected.messages) : projected.messages;
        const nativeOutput = nativeOutputPolicy?.(projected.options, requestMessages);
        const requestOptions = nativeOutput?.options ?? projected.options;
        if (contextBudget) assertProviderRequestBudget(requestMessages, requestOptions, contextBudget,
          Math.max(prepared.requestedMaxTokens ?? 0, nativeOutput?.maxTokens ?? 0));
        if (sessionManager && sessionId) {
          if (!sourceSession || sessionManager.get(sessionId) !== sourceSession) throw new Error('Request session changed.');
          await sessionManager.recordSessionLoadout(sessionId, {
            provider: prepared.data.provider, model: requestOptions.model ?? null,
            systemPrompt: requestOptions.systemPrompt ?? '', tools: requestOptions.tools ?? [],
            thinking: requestOptions.thinking ?? null,
          }, { signal });
          current();
          if (sessionManager.get(sessionId) !== sourceSession) throw new Error('Request session changed.');
        }
        await options.validateDispatch?.(requestOptions.model);
        current();
        if (sessionManager && sessionId && sourceSession) {
          const warmer = getSessionCacheWarmer(sessionManager, sessionId, async (decision, warmSignal) => {
            const result = await options.extensionRegistry.runBefore('before:cache:warm', { ...decision, signal: warmSignal }, warmSignal);
            return result.cancelled ? 'stop' : result.data.action === 'warm' ? 'warm' : 'stop';
          }, options.onCacheWarmUsage);
          options.extensionRegistry.trackProviderCache(warmer);
          warmer.setMode(options.cacheWarming ?? 'streaming');
          const metadata = getProviderPublishedModel(prepared.data.provider, requestOptions.model ?? '', provider);
          const api = metadata?.api ?? (provider instanceof AnthropicProvider ? 'anthropic-messages' : undefined);
          const retention = requestOptions.cacheRetention ?? 'short';
          const ttl = retention === 'none' ? undefined : metadata?.promptCache?.[retention];
          const sameSelection = prepared.data.provider === options.providerName
            && options.model !== undefined && requestOptions.model === options.model;
          const replayable = sameSelection && api !== undefined && (api !== 'anthropic-messages'
            || !requestOptions.thinking || requestOptions.thinking === 'off'
            || provider instanceof AnthropicProvider && requestOptions.model === 'claude-sonnet-4-6');
          const pricing = metadata?.pricing;
          const knownPrices = pricing && [pricing.inputPerMillion, pricing.outputPerMillion,
            pricing.cacheReadPerMillion, pricing.cacheWritePerMillion].every(value => value !== undefined);
          if (ttl && pricing && knownPrices && replayable) {
            const ids = sourceSession.messages.map(message => message.id);
            const selectedModel = sourceSession.model;
            warmer.start({ provider, providerName: prepared.data.provider, model: requestOptions.model!,
              messages: requestMessages, options: requestOptions, ttlSeconds: ttl,
              pricing: retention === 'long' && api === 'anthropic-messages'
                ? { ...pricing, cacheWritePerMillion: pricing.inputPerMillion! * 2 } : pricing,
              isAuthorized: async () => (!options.resolveProvider || await options.resolveProvider(prepared.data.provider) === provider) && provider.validateConfig(),
              isCurrent: () => sessionManager.get(sessionId) === sourceSession && sourceSession.model === selectedModel
                && ids.every((id, index) => sourceSession.messages[index]?.id === id),
            });
          } else warmer.cancel('cache lifetime unavailable or unsafe replay');
        }
        await streamChat(
          requestMessages,
          deliver,
          result => { if (accepting && !signal?.aborted) { completedResponse = result; options.onTransportComplete?.(); } },
          error => { if (accepting && !signal?.aborted) streamError = error; },
          requestOptions,
        );
      } catch (error) {
        providerFailure = error;
      } finally {
        accepting = false;
      }
      await deliveryTail;
      current();
      if (providerFailure) throw providerFailure;
      if (deliveryFailure) throw deliveryFailure;
      if (streamError) throw streamError;
      const finalContent = contentRedactor?.flush() ?? '';
      const finalReasoning = reasoningRedactor?.flush() ?? '';
      streamedContent += finalContent;
      streamedReasoning += finalReasoning;
      if (finalContent) await options.onTextDelta?.(finalContent);
      if (finalReasoning) await options.onReasoningDelta?.(finalReasoning);
      response = safeJson(completedResponse ?? { content: streamedContent });
      if (retrying) await options.onRetryEnd?.({ success: true, attempt });
      break;
    } catch (error) {
      const outwardError = safeError(error);
      await options.extensionRegistry.emit('provider:call:error', {
        provider: safeText(callLabels.provider),
        error: outwardError instanceof Error ? outwardError.message : String(outwardError),
      });
      const canRetry = !attemptProducedOutput
        && !(error instanceof ProviderRequestContextError)
        && !(error instanceof ProviderContextOverflowError)
        && !(error instanceof ProviderOutputBudgetError)
        && !(error instanceof ProviderToolArgumentsError)
        && !callbackDeliveryFailed
        && !signal?.aborted
        && !options.retrySignal?.aborted
        && attempt < maxAttempts;
      if (!canRetry) {
        if (retrying) await options.onRetryEnd?.({ success: false, attempt, finalError: outwardError });
        await options.onError?.(outwardError);
        throw outwardError;
      }
      retrying = true;
      const delayMs = Math.min(
        retryMaxDelayMs,
        retryDelayMs * 2 ** (attempt - 1),
      );
      await options.onRetryStart?.({ attempt, maxAttempts, delayMs, error: outwardError });
      try {
        const retryWaitSignal = signal && options.retrySignal
          ? AbortSignal.any([signal, options.retrySignal])
          : options.retrySignal ?? signal;
        await abortableDelay(delayMs, retryWaitSignal);
      } catch (delayError) {
        const outwardDelayError = safeError(delayError);
        await options.onRetryEnd?.({ success: false, attempt, finalError: outwardDelayError });
        await options.onError?.(outwardDelayError);
        throw outwardDelayError;
      }
    }
  }

  if (!response) throw new Error('Provider did not return a response.');
  response = safeJson({
    ...response,
    content: streamedContent || response.content,
    ...(response.reasoning || !streamedReasoning ? {} : { reasoning: streamedReasoning }),
  });
  const normalizedUsage = normalizeProviderUsage(response.usage);
  if (normalizedUsage) {
    response = {
      ...response,
      usage: {
        promptTokens: normalizedUsage.inputTokens ?? 0,
        completionTokens: normalizedUsage.outputTokens ?? 0,
        cacheReadTokens: normalizedUsage.cacheReadTokens,
        cacheWriteTokens: normalizedUsage.cacheWriteTokens,
        totalTokens: normalizedUsage.totalTokens ?? 0,
        costUsd: normalizedUsage.costUsd,
      },
    };
  }
  // A published tariff cannot attribute extra reported tokens; an observed cost still wins.
  if (response.usage && response.usage.costUsd === undefined
    && response.usage.totalTokens === response.usage.promptTokens + response.usage.completionTokens
      + (response.usage.cacheReadTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0)) {
    const costUsd = calculatePublishedModelCost(
      callLabels.provider,
      response.model ?? callLabels.model ?? '',
      {
        inputTokens: response.usage.promptTokens,
        outputTokens: response.usage.completionTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
      },
    );
    if (costUsd !== undefined) response = { ...response, usage: { ...response.usage, costUsd } };
  }
  await options.extensionRegistry.emit('provider:call:end', {
    provider: callLabels.provider,
    tokensUsed: response.usage?.totalTokens,
    durationMs: Date.now() - callStartedAt,
  });
  await options.onComplete?.(response);
  return response;
}
