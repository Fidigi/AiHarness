import { describe, expect, it, vi } from 'vitest';
import {
  AiProvider,
  ExtensionRegistry,
  type ChatOptions,
  type ChatResponse,
  type Message,
  type StreamChunkCallback,
} from '@ai-harness/core';
import { streamProviderTurn } from './provider-turn';

class RetryProvider extends AiProvider {
  attempts = 0;

  validateConfig(): boolean { return true; }

  async chat(): Promise<ChatResponse> {
    return { content: 'unused' };
  }

  async streamChat(
    _messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    _options?: ChatOptions,
  ): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      onError?.(new Error('temporary outage'));
      return;
    }
    await onChunk('ok', { type: 'text_delta' });
    onComplete?.({ content: 'ok', model: 'retry-model' });
  }
}

class UsageProvider extends AiProvider {
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    _messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
  ): Promise<void> {
    await onChunk('priced', { type: 'text_delta' });
    onComplete?.({
      content: 'priced',
      model: 'o3',
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        cacheReadTokens: 200_000,
        totalTokens: 1_700_000,
      },
    });
  }
}

class NonCooperativeProvider extends AiProvider {
  validateConfig(): boolean { return true; }

  async chat(): Promise<ChatResponse> {
    return { content: 'unused' };
  }

  async streamChat(
    _messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
  ): Promise<void> {
    void onChunk('a', { type: 'text_delta' });
    void onChunk('b', { type: 'text_delta' });
    onComplete?.({ content: 'ab' });
  }
}

class OversizedEventProvider extends AiProvider {
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    _messages: Message[],
    onChunk: StreamChunkCallback,
  ): Promise<void> {
    void onChunk('', {
      type: 'tool_call',
      data: { id: 'large', name: 'large', input: { value: 'x'.repeat(1_024) } },
    });
  }
}

class BackpressureProvider extends AiProvider {
  produced: string[] = [];

  validateConfig(): boolean { return true; }

  async chat(): Promise<ChatResponse> {
    return { content: 'unused' };
  }

  async streamChat(
    _messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
  ): Promise<void> {
    await onChunk('a', { type: 'text_delta' });
    this.produced.push('after-a');
    await onChunk('b', { type: 'text_delta' });
    this.produced.push('after-b');
    onComplete?.({ content: 'ab', model: 'backpressure-model' });
  }
}

describe('streamProviderTurn', () => {
  it('retries failures before the first delta and emits retry lifecycle callbacks', async () => {
    const provider = new RetryProvider({ type: 'mock' as any });
    const extensionRegistry = new ExtensionRegistry();
    const onRetryStart = vi.fn();
    const onRetryEnd = vi.fn();
    const deltas: string[] = [];

    await expect(streamProviderTurn({
      provider,
      providerName: 'mock',
      messages: [],
      tools: [],
      extensionRegistry,
      retryDelayMs: 1,
      onTextDelta: delta => deltas.push(delta),
      onRetryStart,
      onRetryEnd,
    })).resolves.toMatchObject({ content: 'ok', model: 'retry-model' });

    expect(provider.attempts).toBe(2);
    expect(deltas).toEqual(['ok']);
    expect(onRetryStart).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1, maxAttempts: 3, delayMs: 1, error: expect.any(Error),
    }));
    expect(onRetryEnd).toHaveBeenCalledWith({ success: true, attempt: 2 });
  });

  it('attaches shared published pricing to normalized provider usage', async () => {
    await expect(streamProviderTurn({
      provider: new UsageProvider({ type: 'openai' as any, model: 'o3' }),
      providerName: 'openai',
      model: 'o3',
      messages: [],
      tools: [],
      extensionRegistry: new ExtensionRegistry(),
    })).resolves.toMatchObject({ usage: { costUsd: 6.1 } });
  });

  it('bounds extension providers that ignore callback backpressure', async () => {
    const onError = vi.fn();
    await expect(streamProviderTurn({
      provider: new NonCooperativeProvider({ type: 'mock' as any }),
      providerName: 'mock',
      messages: [],
      tools: [],
      extensionRegistry: new ExtensionRegistry(),
      maxPendingStreamEvents: 1,
      onTextDelta: vi.fn(),
      onError,
    })).rejects.toThrow('extension providers must await chunk callbacks');

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('counts provider event payloads against the pending byte guard', async () => {
    await expect(streamProviderTurn({
      provider: new OversizedEventProvider({ type: 'mock' as any }),
      providerName: 'mock',
      messages: [],
      tools: [],
      extensionRegistry: new ExtensionRegistry(),
      maxPendingStreamBytes: 128,
    })).rejects.toThrow('extension providers must await chunk callbacks');
  });

  it('backpressures provider production on asynchronous delta consumers', async () => {
    const provider = new BackpressureProvider({ type: 'mock' as any });
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => { signalFirst = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const consumed: string[] = [];

    const run = streamProviderTurn({
      provider,
      providerName: 'mock',
      messages: [],
      tools: [],
      extensionRegistry: new ExtensionRegistry(),
      onTextDelta: async delta => {
        consumed.push(`start:${delta}`);
        if (delta === 'a') {
          signalFirst();
          await firstGate;
        }
        consumed.push(`end:${delta}`);
      },
    });

    await firstStarted;
    expect(provider.produced).toEqual([]);
    expect(consumed).toEqual(['start:a']);

    releaseFirst();
    await expect(run).resolves.toMatchObject({ content: 'ab', model: 'backpressure-model' });
    expect(provider.produced).toEqual(['after-a', 'after-b']);
    expect(consumed).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });
});
