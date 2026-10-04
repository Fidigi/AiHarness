import {
  normalizeProviderUsage,
  type AiProvider,
  type ChatResponse,
  type ChatToolDefinition,
  type StreamEvent,
  type ThinkingLevel,
} from '../providers/index.js';
import type { ExtensionRegistry } from '../extensions/extension-registry.js';
import type { Message } from '../types/index.js';
import { calculatePublishedModelCost } from '../providers/model-metadata.js';

export interface StreamProviderTurnOptions {
  provider: AiProvider;
  providerName: string;
  model?: string;
  messages: Message[];
  tools: ChatToolDefinition[];
  systemPrompt?: string;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  /** Cancels only an in-progress retry delay, without aborting the provider run. */
  retrySignal?: AbortSignal;
  extensionRegistry: ExtensionRegistry;
  onStart?(provider: string, model?: string): void | Promise<void>;
  onTextDelta?(delta: string): void | Promise<void>;
  onReasoningDelta?(delta: string): void | Promise<void>;
  onProviderEvent?(event: StreamEvent): void | Promise<void>;
  onComplete?(response: ChatResponse): void | Promise<void>;
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

  const providerHook = await options.extensionRegistry.runBefore('before:provider', {
    provider: options.providerName,
    model: options.model,
    messages: options.messages,
    options: {
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      thinking: options.thinking,
      signal: options.signal,
    },
  });
  if (providerHook.cancelled) {
    throw new Error(providerHook.reason ?? "Appel provider annulé par un hook d'extension.");
  }

  const callStartedAt = Date.now();
  await options.extensionRegistry.emit('provider:call:start', {
    provider: providerHook.data.provider,
    model: providerHook.data.model,
  });
  await options.onStart?.(providerHook.data.provider, providerHook.data.model);

  const maxAttempts = maxRetries + 1;
  let streamedContent = '';
  let streamedReasoning = '';
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
      const deliver = (chunk: string, event?: StreamEvent): Promise<void> => {
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
          if (event) await options.onProviderEvent?.(event);
          if (chunk) {
            streamedContent += chunk;
            await options.onTextDelta?.(chunk);
          }
          if (reasoningDelta) {
            streamedReasoning += reasoningDelta;
            await options.onReasoningDelta?.(reasoningDelta);
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
        await options.provider.streamChat(
          providerHook.data.messages,
          deliver,
          result => { completedResponse = result; },
          error => { streamError = error; },
          { ...providerHook.data.options, signal: options.signal },
        );
      } catch (error) {
        providerFailure = error;
      }
      await deliveryTail;
      if (providerFailure) throw providerFailure;
      if (deliveryFailure) throw deliveryFailure;
      if (streamError) throw streamError;
      response = completedResponse ?? { content: streamedContent };
      if (retrying) await options.onRetryEnd?.({ success: true, attempt });
      break;
    } catch (error) {
      await options.extensionRegistry.emit('provider:call:error', {
        provider: providerHook.data.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      const canRetry = !attemptProducedOutput
        && !callbackDeliveryFailed
        && !options.signal?.aborted
        && !options.retrySignal?.aborted
        && attempt < maxAttempts;
      if (!canRetry) {
        if (retrying) await options.onRetryEnd?.({ success: false, attempt, finalError: error });
        await options.onError?.(error);
        throw error;
      }
      retrying = true;
      const delayMs = Math.min(
        retryMaxDelayMs,
        retryDelayMs * 2 ** (attempt - 1),
      );
      await options.onRetryStart?.({ attempt, maxAttempts, delayMs, error });
      try {
        const retryWaitSignal = options.signal && options.retrySignal
          ? AbortSignal.any([options.signal, options.retrySignal])
          : options.retrySignal ?? options.signal;
        await abortableDelay(delayMs, retryWaitSignal);
      } catch (delayError) {
        await options.onRetryEnd?.({ success: false, attempt, finalError: delayError });
        await options.onError?.(delayError);
        throw delayError;
      }
    }
  }

  if (!response) throw new Error('Provider did not return a response.');
  response = {
    ...response,
    content: streamedContent || response.content,
    ...(response.reasoning || !streamedReasoning ? {} : { reasoning: streamedReasoning }),
  };
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
  if (response.usage && response.usage.costUsd === undefined) {
    const costUsd = calculatePublishedModelCost(
      providerHook.data.provider,
      response.model ?? providerHook.data.model ?? '',
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
    provider: providerHook.data.provider,
    tokensUsed: response.usage?.totalTokens,
    durationMs: Date.now() - callStartedAt,
  });
  await options.onComplete?.(response);
  return response;
}
