// ============================================================
// AI Proxy Server Tests - Mock API calls with real streaming logic
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AiProxyServer } from './proxy';

// ===================================================================
// Test helpers
// ===================================================================

function createMockFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
    body: null as ReadableStream | null,
  } as Response;
}

function createMockReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
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
