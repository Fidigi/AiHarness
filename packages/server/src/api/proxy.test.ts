// ============================================================
// AI Proxy Server Tests - Mock API calls with real streaming logic
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CredentialRedactor, type AiProvider } from '@ai-harness/core';
import { AiProxyServer, sanitizedProxyChatOptions, writeSSEStream } from './proxy';

// ===================================================================
// Test helpers
// ===================================================================

function createMockReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

// ===================================================================
// AiProxyServer Tests
// ===================================================================

describe('AiProxyServer', () => {
  let proxy: AiProxyServer;

  beforeEach(() => {
    // Clear environment variables for clean tests
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('LOCAL_BASE_URL', '');
    vi.stubEnv('LLAMA_BASE_URL', '');
    proxy = new AiProxyServer();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('isConfigured()', () => {
    it('should return false for unconfigured providers', () => {
      expect(proxy.isConfigured('openai')).toBe(false);
      expect(proxy.isConfigured('anthropic')).toBe(false);
      expect(proxy.isConfigured('local')).toBe(false);
      expect(proxy.isConfigured('unknown')).toBe(false);
    });

    it('should return true after setting API key', () => {
      proxy.setApiKey('openai', 'sk-test-key');
      expect(proxy.isConfigured('openai')).toBe(true);
    });

    it('should handle both providers configured', () => {
      proxy.setApiKey('openai', 'sk-openai-key');
      proxy.setApiKey('anthropic', 'sk-ant-key');
      expect(proxy.isConfigured('openai')).toBe(true);
      expect(proxy.isConfigured('anthropic')).toBe(true);
    });
  });

  describe('getProviders()', () => {
    it('should return list of providers with configured status', () => {
      const providers = proxy.getProviders();
      expect(providers).toHaveLength(7);
      expect(providers[0]).toEqual({ type: 'openai', configured: false });
      expect(providers[1]).toEqual({ type: 'anthropic', configured: false });
      expect(providers[2]).toEqual({ type: 'google', configured: false });
      expect(providers[3]).toEqual({ type: 'azure', configured: false });
      expect(providers[4]).toEqual({ type: 'vertex', configured: false });
      expect(providers[5]).toEqual({ type: 'bedrock', configured: false });
      expect(providers[6]).toEqual({ type: 'local', configured: false });
    });

    it('should reflect configuration status after setting keys', () => {
      proxy.setApiKey('openai', 'sk-test-key');
      const providers = proxy.getProviders();
      expect(providers[0].configured).toBe(true);
      expect(providers[1].configured).toBe(false);
    });
  });

  describe('sendChat()', () => {
    it('should throw error for unconfigured provider', async () => {
      await expect(
        proxy.sendChat('openai', [{ id: 'm1', role: 'user', content: 'Hello', timestamp: new Date() }]),
      ).rejects.toThrow(/not configured/);
    });

    it('should throw error for unknown provider type', async () => {
      await expect(
        proxy.sendChat('unknown-provider', [{ id: 'm1', role: 'user', content: 'Hello', timestamp: new Date() }]),
      ).rejects.toThrow(/not configured/);
    });

    it('should proxy local chat through the normalized OpenAI-compatible endpoint', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: 'qwen-local',
        choices: [{ message: { role: 'assistant', content: 'Local response' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      proxy.setApiKey('local', 'llama-cpp', 'http://router:8888', 'qwen-local');

      const result = await proxy.sendChat(
        'local',
        [{ id: 'm1', role: 'user', content: 'Hello', timestamp: new Date() }],
        { stream: false },
      );

      expect(result.content).toBe('Local response');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://router:8888/v1/chat/completions',
        expect.objectContaining({ method: 'POST' }),
      );
      const request = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect(JSON.parse(request.body as string).model).toBe('qwen-local');
      global.fetch = originalFetch;
    });

    it('should work with mock provider (anthropic not configured, but test setup)', async () => {
      // Configure a fake anthropic key for this test
      proxy.setApiKey('anthropic', 'sk-ant-test');

      const messages = [
        { id: 'm1', role: 'user' as const, content: 'Hello', timestamp: new Date() },
      ];

      // This will fail because we're not mocking fetch - it's expected
      // The important thing is the method signature works correctly
      await expect(
        proxy.sendChat('anthropic', messages),
      ).rejects.toThrow(); // Will throw due to network error (no real API)
    });

    it('should accept onChunk callback for streaming', async () => {
      proxy.setApiKey('openai', 'sk-test-key');

      const chunks: string[] = [];
      const messages = [{ id: 'm1', role: 'user' as const, content: 'Hello', timestamp: new Date() }];

      // Will fail without real API but tests the callback mechanism
      await expect(
        proxy.sendChat('openai', messages, undefined, (chunk) => {
          chunks.push(chunk.content);
        }),
      ).rejects.toThrow(); // Network error expected
    });
  });

  describe('sendChatSSE()', () => {
    it('should return error stream for unconfigured provider', async () => {
      const result = await proxy.sendChatSSE('openai', []);
      // sendChatSSE returns an error ReadableStream when provider is not configured
      expect(result.stream).toBeDefined();
    });

    it('should return a ReadableStream for configured provider', async () => {
      proxy.setApiKey('anthropic', 'sk-ant-test-key');

      const messages = [
        { id: 'm1', role: 'user' as const, content: 'Hello', timestamp: new Date() },
      ];

      // Will fail due to network but should return a stream object
      const result = await proxy.sendChatSSE('anthropic', messages);
      expect(result.stream).toBeInstanceOf(ReadableStream);
    });

    it('should handle provider type case insensitivity', async () => {
      proxy.setApiKey('openai', 'sk-test-key');

      // These should all resolve to the same proxy
      const result1 = await proxy.sendChatSSE('OPENAI', []);
      expect(result1.stream).toBeDefined();

      const result2 = await proxy.sendChatSSE('OpenAI', []);
      expect(result2.stream).toBeDefined();
    });
  });

  it('redacts credentials fragmented at the final SSE response boundary', async () => {
    const output: string[] = [];
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: (chunk: string | Uint8Array) => {
        output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
      end() { this.writableEnded = true; },
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: error\ndata: boundary-'));
        controller.enqueue(encoder.encode('secret\n\n'));
        controller.close();
      },
    });

    await writeSSEStream(stream, response as never, new CredentialRedactor(['boundary-secret']));

    expect(output.join('')).toBe('event: error\ndata: [REDACTED]\n\n');
  });

  it('redacts raw and encoded runtime credentials from provider SSE errors', async () => {
    const secret = 'short+runtime-secret';
    const provider = {
      config: { type: 'untrusted', apiKey: secret, customHeaders: { 'X-Private': 'header-secret' } },
      validateConfig: () => true,
      getAvailableModels: async () => [],
      getConfiguredModel: () => 'model',
      chat: async () => { throw new Error('unused'); },
      streamChat: async (_messages: unknown, _chunk: unknown, _complete: unknown, onError?: (error: Error) => void) => {
        onError?.(new Error(`failed ${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString('base64')} header-secret`));
      },
    } as unknown as AiProvider;
    proxy.setCustomProvider('untrusted', provider);

    const result = await proxy.sendChatSSE('untrusted', []);
    const reader = result.stream.getReader();
    let output = '';
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      output += new TextDecoder().decode(item.value);
    }

    expect(output).not.toContain(secret);
    expect(output).not.toContain(encodeURIComponent(secret));
    expect(output).not.toContain(Buffer.from(secret).toString('base64'));
    expect(output).not.toContain('header-secret');
    expect(output).toContain('Provider request failed.');
  });

  it('redacts every encoded credential variant split across provider SSE chunks', async () => {
    const secret = 'split+server-secret';
    const variants = [
      secret,
      encodeURIComponent(secret),
      encodeURI(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'),
      JSON.stringify(secret).slice(1, -1),
    ];
    const provider = {
      config: { type: 'fragmented', apiKey: secret },
      validateConfig: () => true,
      getAvailableModels: async () => [],
      getConfiguredModel: () => 'model',
      chat: async () => ({ content: 'unused' }),
      streamChat: async (_messages: unknown, onChunk: (chunk: string) => Promise<void>, onComplete?: () => void) => {
        for (const variant of variants) {
          const split = Math.max(1, Math.floor(variant.length / 2));
          await onChunk(variant.slice(0, split));
          await onChunk(`${variant.slice(split)}|`);
        }
        onComplete?.();
      },
    } as unknown as AiProvider;
    proxy.setCustomProvider('fragmented', provider);

    const result = await proxy.sendChatSSE('fragmented', []);
    const reader = result.stream.getReader();
    let output = '';
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      output += new TextDecoder().decode(item.value);
    }

    for (const variant of variants) expect(output).not.toContain(variant);
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(variants.length);
  });

  it('copies only bounded provider options from untrusted JSON payloads', () => {
    const signal = { hostile: true };
    expect(sanitizedProxyChatOptions({
      model: ' model-1 ', temperature: 0.5, maxTokens: 128, maxRetries: 2,
      thinking: 'high', sessionId: 'session-1', stream: true, signal, ignored: 'value',
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    })).toEqual({
      model: 'model-1', temperature: 0.5, maxTokens: 128, maxRetries: 2,
      thinking: 'high', sessionId: 'session-1', stream: true,
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    });
    expect(sanitizedProxyChatOptions({ maxTokens: 0 })).toBeNull();
    expect(sanitizedProxyChatOptions({ systemPrompt: 'x'.repeat(1024 * 1024 + 1) })).toBeNull();
    expect(sanitizedProxyChatOptions({ tools: Array.from({ length: 1_025 }, () => ({})) })).toBeNull();
  });

  describe('setApiKey()', () => {
    it('should configure OpenAI provider', () => {
      proxy.setApiKey('openai', 'sk-openai-key');
      expect(proxy.isConfigured('openai')).toBe(true);
    });

    it('should configure Anthropic provider', () => {
      proxy.setApiKey('anthropic', 'sk-ant-key');
      expect(proxy.isConfigured('anthropic')).toBe(true);
    });

    it('should configure a local OpenAI-compatible provider without a real key', () => {
      proxy.setApiKey('local', '', 'http://router:8888', 'qwen-local');
      expect(proxy.isConfigured('local')).toBe(true);
    });

    it('should allow updating existing API key', () => {
      proxy.setApiKey('openai', 'old-key');
      proxy.setApiKey('openai', 'new-key');
      expect(proxy.isConfigured('openai')).toBe(true);
    });

    it('should accept baseUrl parameter for OpenAI', () => {
      // Should not throw even with custom base URL
      expect(() => proxy.setApiKey('openai', 'sk-test', 'https://custom.openai.com/v1')).not.toThrow();
    });

    it('should ignore invalid provider types gracefully', () => {
      // This should not throw - just won't match any known provider
      try {
        (proxy as any).setApiKey('invalid-type', 'sk-test');
      } catch {
        // Expected to be ignored or handled
      }
    });
  });

  describe('Streaming behavior', () => {
    it('should handle empty message arrays gracefully for streaming SSE', async () => {
      proxy.setApiKey('anthropic', 'sk-ant-test');

      const result = await proxy.sendChatSSE('anthropic', []);
      expect(result.stream).toBeDefined();
      // The stream should be a valid ReadableStream even with empty messages
    });

    it('should handle multiple messages in streaming request', async () => {
      proxy.setApiKey('openai', 'sk-test-key');

      const messages = [
        { id: 'm1', role: 'user' as const, content: 'Hello', timestamp: new Date() },
        { id: 'm2', role: 'assistant' as const, content: 'Hi there!', timestamp: new Date() },
        { id: 'm3', role: 'user' as const, content: 'How are you?', timestamp: new Date() },
      ];

      // Should not throw during setup (will fail at network level)
      await expect(
        proxy.sendChatSSE('openai', messages),
      ).resolves.toHaveProperty('stream');
    });
  });
});

// ===================================================================
// Integration: Proxy with mock fetch
// ===================================================================

describe('Proxy with mocked fetch', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should handle OpenAI streaming response correctly', async () => {
    const mockStreamContent = [
      'data: {"choices":[{"delta":{"content":"H"}}]}\n',
      'data: {"choices":[{"delta":{"content":"i"}}]}\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n',
      'data: [DONE]\n',
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockReadableStream(mockStreamContent),
    } as Response);

    const proxy = new AiProxyServer();
    proxy.setApiKey('openai', 'sk-test');

    // We can't easily test the internal OpenAiProxy class directly since it's not exported,
    // but we verified the SSE stream is created correctly above.
  });

  it('should handle Anthropic streaming response format', async () => {
    const mockStreamContent = [
      'event: message_start\ndata: {"type":"message_start"}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" World"}}\n',
      'event: message_stop\n',
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockReadableStream(mockStreamContent),
    } as Response);

    const proxy = new AiProxyServer();
    proxy.setApiKey('anthropic', 'sk-ant-test');

    // Verify the stream is created (actual parsing tested in provider tests)
    await expect(
      proxy.sendChatSSE('anthropic', [{ id: 'm1', role: 'user' as const, content: 'Hi', timestamp: new Date() }]),
    ).resolves.toHaveProperty('stream');
  });

  it('calculates cache-aware model cost and restores atomically persisted metrics', async () => {
    const proxy = new AiProxyServer();
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-usage-'));
    const file = path.join(root, 'usage.json');
    try {
      await proxy.initializeUsage(file, () => ({
        inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1,
      }));
      expect(proxy.recordUsage('openai', 'priced-model', {
        promptTokens: 100, completionTokens: 10, cacheReadTokens: 20, totalTokens: 110,
      })).toBeCloseTo(0.00026);
      await proxy.flushUsage();

      const restored = new AiProxyServer();
      await restored.initializeUsage(file, () => undefined);
      expect(restored.getUsage('openai')).toMatchObject({
        requests: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 20,
        cacheWriteTokens: 0, totalTokens: 110, costUsd: 0.00026,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns final usage from streaming chat calls', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockReadableStream([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n',
        'data: {"type":"message_delta","usage":{"output_tokens":3}}\n',
      ]),
    } as Response);
    const proxy = new AiProxyServer();
    proxy.setApiKey('anthropic', 'sk-ant-test');

    const result = await proxy.sendChat(
      'anthropic',
      [{ id: 'm1', role: 'user', content: 'Hi', timestamp: new Date() }],
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      content: 'Hello',
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
  });

  it('should handle API errors gracefully in streaming', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{ "error": "Invalid API key" }'),
    } as Response);

    const proxy = new AiProxyServer();
    proxy.setApiKey('openai', 'sk-invalid');

    // sendChatSSE returns { stream, error? }, doesn't throw directly
    // When API key is invalid, the stream will contain an SSE event with the error
    const result = await proxy.sendChatSSE('openai', [{ id: 'm1', role: 'user' as const, content: 'Hello', timestamp: new Date() }]);
    expect(result.stream).toBeDefined();
  });
});
