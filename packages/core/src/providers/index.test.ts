// ============================================================
// AI Provider Tests - Real API + Mock implementations
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AiProvider,
  OpenAiProvider,
  AnthropicProvider,
  GeminiProvider,
  VertexGeminiProvider,
  BedrockProvider,
  LocalProvider,
  MockProvider,
  ProviderFactory,
} from './index';
import type { Message, ProviderConfig } from '../types';

// ===================================================================
// Helper functions
// ===================================================================

function createMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    timestamp: new Date(),
  };
}

// ===================================================================
// MockProvider Tests (no external dependencies needed)
// ===================================================================

describe('MockProvider', () => {
  let provider: MockProvider;
  const config: ProviderConfig = { type: 'mock' as any, apiKey: 'test-key' };

  beforeEach(() => {
    provider = new MockProvider(config);
  });

  describe('validateConfig()', () => {
    it('should always return true', () => {
      expect(provider.validateConfig()).toBe(true);
    });
  });

  describe('chat()', () => {
    it('should return a mock response when no custom responses are set', async () => {
      provider.reset();
      const messages = [createMessage('user', 'Hello')];
      const result = await provider.chat(messages);

      expect(result.content).toBe('[Mock AI Response]');
      expect(result.model).toBe('mock-model');
    });

    it('should return custom responses in order', async () => {
      provider.addResponse('First response');
      provider.addResponse('Second response');
      provider.reset();

      const result1 = await provider.chat([createMessage('user', 'Q1')]);
      expect(result1.content).toBe('First response');

      const result2 = await provider.chat([createMessage('user', 'Q2')]);
      expect(result2.content).toBe('Second response');

      // Should cycle back to first response
      const result3 = await provider.chat([createMessage('user', 'Q3')]);
      expect(result3.content).toBe('First response');
    });

    it('should include usage information', async () => {
      provider.addResponse('Hello world');
      const messages = [createMessage('user', 'Hi'), createMessage('assistant', 'Hello'), createMessage('user', 'World')];
      const result = await provider.chat(messages);

      expect(result.usage).toBeDefined();
      expect(result.usage?.promptTokens).toBeGreaterThan(0);
    });

    it('should handle empty messages array gracefully', async () => {
      const result = await provider.chat([]);
      // Should not throw, just return mock response
      expect(typeof result.content).toBe('string');
    });
  });

  describe('streamChat()', () => {
    let chunks: string[];
    let events: any[];

    beforeEach(() => {
      chunks = [];
      events = [];
      provider.reset();
    });

    const collectChunks = async (p: MockProvider, messages: Message[]) => {
      await p.streamChat(
        messages,
        (chunk) => chunks.push(chunk),
        () => {},
        (error) => { throw error; },
      );
    };

    it('should stream response character by character', async () => {
      const testResponse = 'Hello World';
      provider.addResponse(testResponse);

      await collectChunks(provider, [createMessage('user', 'Hi')]);

      // All chunks should join to form the full response
      expect(chunks.join('')).toBe(testResponse);
    });

    it('should emit message_start event at the beginning', async () => {
      provider.addResponse('Test');
      let hasStartEvent = false;

      await provider.streamChat(
        [createMessage('user', 'Hi')],
        (chunk, event) => {
          if (event?.type === 'message_start') hasStartEvent = true;
          chunks.push(chunk);
        },
      );

      expect(hasStartEvent).toBe(true);
    });

    it('should call onComplete with response data', async () => {
      provider.addResponse('Complete test');
      let completeCalled = false;
      let completeData: any;

      await provider.streamChat(
        [createMessage('user', 'Hi')],
        (chunk) => chunks.push(chunk),
        (response) => {
          completeCalled = true;
          completeData = response;
        },
      );

      expect(completeCalled).toBe(true);
      expect(completeData?.content).toBe('Complete test');
    });

    it('should handle onError for errors', async () => {
      let errorCaught: Error | null = null;

      await provider.streamChat(
        [createMessage('user', 'Hi')],
        () => {},
        undefined,
        (error) => { errorCaught = error; },
      );

      expect(errorCaught).toBeNull(); // Mock should not throw
    });

    it('should track call count correctly', async () => {
      provider.addResponse('Resp1');
      provider.addResponse('Resp2');
      await collectChunks(provider, [createMessage('user', 'Q')]);
      await collectChunks(provider, [createMessage('user', 'Q')]);

      expect(provider.getCallCount()).toBe(2);
    });
  });

  describe('reset()', () => {
    let testChunks: string[];

    beforeEach(() => {
      testChunks = [];
      provider.reset();
    });

    const collectTestChunks = async (p: MockProvider, messages: Message[]) => {
      await p.streamChat(
        messages,
        (chunk) => testChunks.push(chunk),
        () => {},
        (error) => { throw error; },
      );
    };

    it('should reset the response index', async () => {
      provider.addResponse('First');
      provider.addResponse('Second');

      await collectTestChunks(provider, [createMessage('user', 'Q')]); // First
      expect(testChunks.join('')).toBe('First');

      provider.reset();
      testChunks = [];
      await collectTestChunks(provider, [createMessage('user', 'Q')]); // Should be First again
      expect(testChunks.join('')).toBe('First');
    });
  });
});

// ===================================================================
// Reasoning normalization
// ===================================================================

describe('provider reasoning normalization', () => {
  it('preserves explicit OpenAI-compatible reasoning summaries in chat responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'reasoner', choices: [{ index: 0, message: { role: 'assistant', content: 'Answer', reasoning_content: 'Safe summary' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new OpenAiProvider({ type: 'openai', apiKey: 'test' });
      await expect(provider.chat([createMessage('user', 'Question')])).resolves.toMatchObject({
        content: 'Answer', reasoning: 'Safe summary', model: 'reasoner',
      });
    } finally { vi.unstubAllGlobals(); }
  });

  it('streams OpenAI and Anthropic reasoning deltas separately from answer text', async () => {
    const openAiBody = [
      'data: {"choices":[{"delta":{"reasoning_content":"Plan "}}]}',
      'data: {"choices":[{"delta":{"content":"Answer"}}]}',
      'data: [DONE]', '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(openAiBody, { status: 200 })));
    const openAiEvents: string[] = [];
    let openAiComplete: unknown;
    await new OpenAiProvider({ type: 'openai', apiKey: 'test' }).streamChat(
      [createMessage('user', 'Question')],
      (chunk, event) => openAiEvents.push(`${event?.type}:${chunk || (event?.data as { content?: string })?.content || ''}`),
      response => { openAiComplete = response; },
    );
    expect(openAiEvents).toEqual(['reasoning_delta:Plan ', 'text_delta:Answer']);
    expect(openAiComplete).toMatchObject({ content: 'Answer', reasoning: 'Plan ' });

    const anthropicBody = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check "}}',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}', '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(anthropicBody, { status: 200 })));
    const anthropicEvents: string[] = [];
    let anthropicComplete: unknown;
    await new AnthropicProvider({ type: 'anthropic', apiKey: 'test' }).streamChat(
      [createMessage('user', 'Question')],
      (chunk, event) => anthropicEvents.push(`${event?.type}:${chunk || (event?.data as { content?: string })?.content || ''}`),
      response => { anthropicComplete = response; },
    );
    expect(anthropicEvents).toEqual(['reasoning_delta:Check ', 'text_delta:Done']);
    expect(anthropicComplete).toMatchObject({ content: 'Done', reasoning: 'Check ' });
    vi.unstubAllGlobals();
  });
});

// ===================================================================
// ProviderFactory Tests
// ===================================================================

describe('ProviderFactory', () => {
  it('should create OpenAiProvider for openai type', () => {
    const provider = ProviderFactory.create({ type: 'openai', apiKey: 'test' } as any);
    expect(provider).toBeInstanceOf(OpenAiProvider);
  });

  it('should create AnthropicProvider for anthropic type', () => {
    const provider = ProviderFactory.create({ type: 'anthropic', apiKey: 'test' } as any);
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('creates all enterprise cloud providers', () => {
    expect(ProviderFactory.create({ type: 'azure', apiKey: 'key', baseUrl: 'https://azure.example', deployment: 'gpt' } as any)).toBeInstanceOf(OpenAiProvider);
    expect(ProviderFactory.create({ type: 'vertex', apiKey: 'token', project: 'project' } as any)).toBeInstanceOf(VertexGeminiProvider);
    expect(ProviderFactory.create({ type: 'bedrock', accessKeyId: 'access', secretAccessKey: 'secret' } as any)).toBeInstanceOf(BedrockProvider);
  });

  it('should create MockProvider for mock type', () => {
    const provider = ProviderFactory.create({ type: 'mock', apiKey: 'test' } as any);
    expect(provider).toBeInstanceOf(MockProvider);
  });

  it('should create LocalProvider for local type', () => {
    const provider = ProviderFactory.create({ type: 'local', baseUrl: 'http://router:8888' } as any);
    expect(provider).toBeInstanceOf(LocalProvider);
  });

  it('should throw error for unsupported type', () => {
    expect(() => ProviderFactory.create({ type: 'unsupported' as any, apiKey: 'test' })).toThrow(
      'Unsupported provider type: unsupported',
    );
  });

  describe('getDefaultModel()', () => {
    it('should return default model for openai', () => {
      expect(ProviderFactory.getDefaultModel('openai')).toBe('gpt-4o');
    });

    it('should return default model for anthropic', () => {
      expect(ProviderFactory.getDefaultModel('anthropic')).toBe('claude-3-haiku-20240307');
    });

    it('should return mock-model for mock type', () => {
      expect(ProviderFactory.getDefaultModel('mock')).toBe('mock-model-v1');
    });

    it('should return local-model for local type', () => {
      expect(ProviderFactory.getDefaultModel('local')).toBe('local-model');
    });
  });
});

describe('multimodal provider adapters', () => {
  const imageMessage: Message = {
    id: 'image-message',
    role: 'user',
    content: 'Describe this image',
    timestamp: new Date(),
    blocks: [
      { type: 'text', text: 'Describe this image' },
      { type: 'image', mediaType: 'image/png', name: 'pixel.png', size: 3, url: 'data:image/png;base64,AQID' },
    ],
  };

  it('maps image blocks to OpenAI image_url content', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'gpt-4o', choices: [{ message: { role: 'assistant', content: 'image' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await new OpenAiProvider({ type: 'openai', apiKey: 'key' }).chat([imageMessage]);
    const request = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body)).messages[0].content).toEqual([
      { type: 'text', text: 'Describe this image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ]);
  });

  it('maps image blocks to Anthropic base64 sources', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'claude', content: [{ type: 'text', text: 'image' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await new AnthropicProvider({ type: 'anthropic', apiKey: 'key' }).chat([imageMessage]);
    const request = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body)).messages[0].content).toEqual([
      { type: 'text', text: 'Describe this image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ]);
  });

  it('maps image blocks to Gemini inlineData parts', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'image' }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await new GeminiProvider({ type: 'google', apiKey: 'key', model: 'gemini-2.0-flash' }).chat([imageMessage]);
    const request = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body)).contents[0].parts).toEqual([
      { text: 'Describe this image' },
      { inlineData: { mimeType: 'image/png', data: 'AQID' } },
    ]);
  });
});

// ===================================================================
// OpenAiProvider Tests (unit tests with mocked fetch)
// ===================================================================

describe('OpenAiProvider', () => {
  let provider: OpenAiProvider;
  const config: ProviderConfig = { type: 'openai' as any, apiKey: 'sk-test-key-123' };

  beforeEach(() => {
    provider = new OpenAiProvider(config);
    vi.clearAllMocks();
  });

  describe('validateConfig()', () => {
    it('should return true when apiKey is present', () => {
      expect(provider.validateConfig()).toBe(true);
    });

    it('should return false when apiKey is missing', () => {
      const noKeyProvider = new OpenAiProvider({ type: 'openai' as any } as any);
      expect(noKeyProvider.validateConfig()).toBe(false);
    });
  });

  describe('chat()', () => {
    it('should throw error when API key is missing', async () => {
      const noKeyProvider = new OpenAiProvider({ type: 'openai' } as any);
      await expect(noKeyProvider.chat([createMessage('user', 'Hello')])).rejects.toThrow(
        'OpenAI API key is required',
      );
    });

    it('should call the correct API endpoint', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello! How can I help you?' } }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await provider.chat([createMessage('user', 'Hello')]);

      expect(global.fetch).toHaveBeenCalledWith(
        `${OpenAiProvider.DEFAULT_BASE_URL}/chat/completions`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key-123',
          }),
        }),
      );

      expect(result.content).toBe('Hello! How can I help you?');
      expect(result.model).toBe('gpt-4o');
    });

    it('should handle API errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{ "error": { "message": "Invalid API key" } }'),
      });

      await expect(provider.chat([createMessage('user', 'Hello')])).rejects.toThrow(
        /OpenAI API error \(401\)/,
      );
    });

    it('should handle empty response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      await expect(provider.chat([createMessage('user', 'Hello')])).rejects.toThrow(
        /No content in OpenAI response/,
      );
    });

    it('should include system prompt when provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { role: 'assistant', content: 'Test' } }],
        }),
      });

      await provider.chat([createMessage('user', 'Hello')], { systemPrompt: 'You are a helpful assistant.' });

      const callArgs = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.messages[0].role).toBe('system');
    });

    it('should send tool schemas and normalize tool calls', async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: 'gpt-4o',
        choices: [{ message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'sum', arguments: '{"a":2,"b":3}' },
          }],
        } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const result = await provider.chat([createMessage('user', 'Add')], {
        tools: [{
          name: 'sum',
          description: 'Add numbers',
          parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
        }],
      });

      expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'sum', input: { a: 2, b: 3 } }]);
      const request = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(request.body as string);
      expect(body.tools[0].function.name).toBe('sum');
      expect(body.tool_choice).toBe('auto');
    });

    it('should retry on rate limit errors (429)', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return new Response(JSON.stringify({ error: 'Rate limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Success!' } }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      await provider.chat([createMessage('user', 'Hello')]);
      expect(callCount).toBe(3); // Failed twice, succeeded on third attempt
    });

    it('should retry on server errors (503)', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          return new Response(JSON.stringify({ error: 'Service unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Recovered!' } }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      await provider.chat([createMessage('user', 'Hello')]);
      expect(callCount).toBe(2);
    });
  });

  describe('streamChat()', () => {
    it('should throw error when API key is missing', async () => {
      const noKeyProvider = new OpenAiProvider({ type: 'openai' } as any);
      await expect(noKeyProvider.streamChat(
        [createMessage('user', 'Hello')],
        () => {},
      )).rejects.toThrow('OpenAI API key is required');
    });

    it('should stream response chunks correctly', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"id":"1","choices":[{"delta":{"content":"H"}}]}\n' +
            'data: {"id":"2","choices":[{"delta":{"content":"i"}}]}\n' +
            'data: [DONE]\n'
          ));
          controller.close();
        },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const chunks: string[] = [];
      await provider.streamChat(
        [createMessage('user', 'Hello')],
        (chunk) => chunks.push(chunk),
      );

      expect(chunks.join('')).toBe('Hi');
    });

    it('should call onComplete with full content', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"Full"}}]}\n' +
            'data: {"choices":[{"delta":{"content":" response"}}]}\n' +
            'data: [DONE]\n'
          ));
          controller.close();
        },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      let onCompleteCalled = false;
      await provider.streamChat(
        [createMessage('user', 'Hello')],
        () => {},
        (response) => {
          onCompleteCalled = true;
          expect(response?.content).toBe('Full response');
        },
      );

      expect(onCompleteCalled).toBe(true);
    });

    it('should assemble fragmented streaming tool calls', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"sum","arguments":"{\\"a\\":"}}]}}]}\n' +
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"2}"}}]}}]}\n' +
            'data: [DONE]\n',
          ));
          controller.close();
        },
      });
      global.fetch = vi.fn().mockResolvedValue(new Response(mockStream, { status: 200 }));
      let completed: any;

      await provider.streamChat(
        [createMessage('user', 'Use a tool')],
        () => {},
        response => { completed = response; },
        undefined,
        { tools: [{ name: 'sum', description: 'Add', parameters: { type: 'object' } }] },
      );

      expect(completed.toolCalls).toEqual([{ id: 'call-1', name: 'sum', input: { a: 2 } }]);
    });

    it('should handle API errors in streaming', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve('{ "error": "Rate limit exceeded" }'),
      });

      let errorCaught: Error | null = null;
      await provider.streamChat(
        [createMessage('user', 'Hello')],
        () => {},
        undefined,
        (error) => { errorCaught = error; },
      );

      expect(errorCaught).not.toBeNull();
    });
  });
});

// ===================================================================
// LocalProvider Tests (OpenAI-compatible Ollama / llama.cpp)
// ===================================================================

describe('LocalProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a local endpoint without an API key', () => {
    const provider = new LocalProvider({ type: 'local', baseUrl: 'http://router:8888' } as ProviderConfig);
    expect(provider.validateConfig()).toBe(true);
  });

  it('rejects malformed endpoint URLs', () => {
    const provider = new LocalProvider({ type: 'local', baseUrl: 'not a URL' } as ProviderConfig);
    expect(provider.validateConfig()).toBe(false);
  });

  it('normalizes the endpoint and uses the configured model', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'qwen-local',
      choices: [{ message: { role: 'assistant', content: 'Réponse locale' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const provider = new LocalProvider({
      type: 'local',
      baseUrl: 'http://router:8888/',
      apiKey: 'llama-cpp',
      model: 'qwen-local',
    } as ProviderConfig);

    const response = await provider.chat([createMessage('user', 'Bonjour')]);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://router:8888/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer llama-cpp' }),
      }),
    );
    const request = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string).model).toBe('qwen-local');
    expect(response.content).toBe('Réponse locale');
  });

  it('discovers OpenAI-compatible and Ollama model catalogues', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'qwen-35b' }],
      models: [{ name: 'llama3.2' }, { model: 'mistral' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const provider = new LocalProvider({ type: 'local', baseUrl: 'http://router:8888/v1' } as ProviderConfig);

    await expect(provider.getAvailableModels()).resolves.toEqual(['qwen-35b', 'llama3.2', 'mistral']);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://router:8888/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer local' } }),
    );
  });

  it('streams chunks from the local OpenAI-compatible endpoint', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"Local"}}]}\n' +
          'data: {"choices":[{"delta":{"content":" stream"}}]}\n' +
          'data: [DONE]\n',
        ));
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    const provider = new LocalProvider({ type: 'local', baseUrl: 'http://router:8888' } as ProviderConfig);
    const chunks: string[] = [];

    await provider.streamChat([createMessage('user', 'Hello')], chunk => chunks.push(chunk));

    expect(chunks.join('')).toBe('Local stream');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://router:8888/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ===================================================================
// GeminiProvider Tests
// ===================================================================

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new GeminiProvider({ type: 'google' as any, apiKey: 'gemini-key', model: 'gemini-2.0-flash' });
  });

  it('normalizes text, usage, function calls, and tool schemas', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: 'Je vérifie. ' },
        { functionCall: { name: 'weather', args: { city: 'Paris' } } },
      ] } }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await provider.chat([createMessage('user', 'Météo ?')], {
      tools: [{ name: 'weather', description: 'Météo', parameters: { type: 'object' } }],
    });

    expect(result).toMatchObject({
      content: 'Je vérifie. ',
      usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
      toolCalls: [{ name: 'weather', input: { city: 'Paris' } }],
    });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain(':generateContent?key=gemini-key');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.tools[0].functionDeclarations[0].name).toBe('weather');
  });

  it('maps assistant tool calls and tool results to Gemini parts', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Terminé' }] } }],
    }), { status: 200 }));
    const messages: Message[] = [
      createMessage('user', 'Calcule'),
      { ...createMessage('assistant', ''), toolCalls: [{ id: 'c1', name: 'sum', input: { a: 1, b: 2 } }] },
      { ...createMessage('user', '3'), role: 'tool', name: 'sum', toolCallId: 'c1' },
    ];

    await provider.chat(messages);

    const body = JSON.parse(((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body.contents[1].parts[0].functionCall).toEqual({ name: 'sum', args: { a: 1, b: 2 } });
    expect(body.contents[2].parts[0].functionResponse.name).toBe('sum');
  });

  it('streams SSE records and reports tool calls', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"Bon"}]}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"jour"},{"functionCall":{"name":"clock","args":{}}}]}}]}\n\n'));
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    const chunks: string[] = [];
    let completed: any;

    await provider.streamChat(
      [createMessage('user', 'Heure ?')],
      chunk => { if (chunk) chunks.push(chunk); },
      response => { completed = response; },
    );

    expect(chunks.join('')).toBe('Bonjour');
    expect(completed.toolCalls[0]).toMatchObject({ name: 'clock', input: {} });
  });

  it('requires an API key', async () => {
    const noKey = new GeminiProvider({ type: 'google' as any });
    await expect(noKey.chat([])).rejects.toThrow('Gemini API key is required');
  });
});

// ===================================================================
// AnthropicProvider Tests (unit tests with mocked fetch)
// ===================================================================

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;
  const config: ProviderConfig = { type: 'anthropic' as any, apiKey: 'sk-ant-test-key' };

  beforeEach(() => {
    provider = new AnthropicProvider(config);
    vi.clearAllMocks();
  });

  describe('validateConfig()', () => {
    it('should return true when apiKey is present', () => {
      expect(provider.validateConfig()).toBe(true);
    });

    it('should return false when apiKey is missing', () => {
      const noKeyProvider = new AnthropicProvider({ type: 'anthropic' } as any);
      expect(noKeyProvider.validateConfig()).toBe(false);
    });
  });

  describe('chat()', () => {
    it('should throw error when API key is missing', async () => {
      const noKeyProvider = new AnthropicProvider({ type: 'anthropic' } as any);
      await expect(noKeyProvider.chat([createMessage('user', 'Hello')])).rejects.toThrow(
        'Anthropic API key is required',
      );
    });

    it('should call the correct API endpoint with proper headers', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        model: 'claude-3-haiku-20240307',
        content: [{ type: 'text', text: 'Hello from Claude!' }],
        usage: { input_tokens: 5, output_tokens: 6 },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await provider.chat([createMessage('user', 'Hello')]);

      expect(global.fetch).toHaveBeenCalledWith(
        `${AnthropicProvider.DEFAULT_BASE_URL}/v1/messages`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-test-key',
            'anthropic-version': AnthropicProvider.API_VERSION,
          }),
        }),
      );

      expect(result.content).toBe('Hello from Claude!');
    });

    it('should send Anthropic tools and parse tool_use blocks', async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: 'claude-test',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'weather', input: { city: 'Paris' } }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const result = await provider.chat([createMessage('user', 'Weather?')], {
        tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object' } }],
      });

      expect(result.toolCalls).toEqual([{ id: 'tool-1', name: 'weather', input: { city: 'Paris' } }]);
      const request = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect(JSON.parse(request.body as string).tools[0]).toMatchObject({
        name: 'weather',
        input_schema: { type: 'object' },
      });
    });

    it('should handle API errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{ "type": "error", "message": "Invalid request" }'),
      });

      await expect(provider.chat([createMessage('user', 'Hello')])).rejects.toThrow(
        /Anthropic API error \(401\)/,
      );
    });

    it('should handle empty response content', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: [] }),
      });

      await expect(provider.chat([createMessage('user', 'Hello')])).rejects.toThrow(
        /No text or tool content in Anthropic response/,
      );
    });

    it('should include system prompt when provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'Test' }],
        }),
      });

      await provider.chat([createMessage('user', 'Hello')], { systemPrompt: 'You are a helpful assistant.' });

      const callArgs = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.system).toBe('You are a helpful assistant.');
    });
  });

  describe('streamChat()', () => {
    it('should throw error when API key is missing', async () => {
      const noKeyProvider = new AnthropicProvider({ type: 'anthropic' } as any);
      await expect(noKeyProvider.streamChat(
        [createMessage('user', 'Hello')],
        () => {},
      )).rejects.toThrow('Anthropic API key is required');
    });

    it('should stream response chunks correctly', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: message_start\ndata: {"type":"message_start"}\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" World"}}\n' +
            'event: message_stop\n'
          ));
          controller.close();
        },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const chunks: string[] = [];
      await provider.streamChat(
        [createMessage('user', 'Hello')],
        (chunk) => { if (chunk) chunks.push(chunk); },
      );

      expect(chunks.join('')).toBe('Hello World');
    });

    it('should assemble streaming tool_use input', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"weather","input":{}}}\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n',
          ));
          controller.close();
        },
      });
      global.fetch = vi.fn().mockResolvedValue(new Response(mockStream, { status: 200 }));
      let completed: any;

      await provider.streamChat(
        [createMessage('user', 'Weather?')],
        () => {},
        response => { completed = response; },
        undefined,
        { tools: [{ name: 'weather', description: 'Weather', parameters: { type: 'object' } }] },
      );

      expect(completed.toolCalls).toEqual([{ id: 'tool-1', name: 'weather', input: { city: 'Paris' } }]);
    });

    it('should call onComplete with full content and usage', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Test"}}\n' +
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n' +
            'event: message_stop\n'
          ));
          controller.close();
        },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      let onCompleteCalled = false;
      await provider.streamChat(
        [createMessage('user', 'Hello')],
        () => {},
        (response) => {
          onCompleteCalled = true;
          expect(response?.content).toBe('Test');
          expect(response?.usage?.promptTokens).toBe(10);
          expect(response?.usage?.completionTokens).toBe(4);
        },
      );

      expect(onCompleteCalled).toBe(true);
    });
  });
});

describe('BedrockProvider', () => {
  it('signs Converse requests and parses tool calls', async () => {
    const provider = new BedrockProvider({
      type: 'bedrock' as any,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      sessionToken: 'token',
      region: 'eu-west-1',
      model: 'anthropic.claude-3-haiku-20240307-v1:0',
    });
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: { message: { content: [
        { text: 'Je vérifie.' },
        { toolUse: { toolUseId: 'call-1', name: 'weather', input: { city: 'Paris' } } },
      ] } },
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await provider.chat([createMessage('user', 'Météo ?')], {
      tools: [{ name: 'weather', description: 'Météo', parameters: { type: 'object' } }],
    });

    expect(response.content).toBe('Je vérifie.');
    expect(response.toolCalls).toEqual([{ id: 'call-1', name: 'weather', input: { city: 'Paris' } }]);
    expect(response.usage?.totalTokens).toBe(12);
    const [url, request] = vi.mocked(global.fetch).mock.calls[0];
    expect(String(url)).toContain('bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1%3A0/converse');
    expect(new Headers(request?.headers).get('authorization')).toContain('Credential=AKIDEXAMPLE/');
    expect(new Headers(request?.headers).get('x-amz-security-token')).toBe('token');
    const body = JSON.parse(String(request?.body));
    expect(body.toolConfig.tools[0].toolSpec.name).toBe('weather');
  });

  it('requires AWS credentials', async () => {
    const oldAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const provider = new BedrockProvider({ type: 'bedrock' as any });
      expect(provider.validateConfig()).toBe(false);
      await expect(provider.chat([createMessage('user', 'Hello')])).rejects.toThrow('credentials');
    } finally {
      if (oldAccessKey) process.env.AWS_ACCESS_KEY_ID = oldAccessKey;
      if (oldSecret) process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
    }
  });
});

// ===================================================================
// Integration: Provider usage pattern tests
// ===================================================================

describe('Provider Usage Patterns', () => {
  it('MockProvider should work in a typical chat flow (non-streaming)', async () => {
    const provider = new MockProvider({ type: 'mock' as any }, ['Hi there!']);
    const messages = [
      createMessage('user', 'Hello'),
    ];

    const response = await provider.chat(messages);
    expect(response.content).toBe('Hi there!');
  });

  it('MockProvider should work in a typical chat flow (streaming)', async () => {
    const provider = new MockProvider({ type: 'mock' as any }, ['Streaming works!']);
    const messages = [createMessage('user', 'Hello')];

    let streamedContent = '';
    await provider.streamChat(
      messages,
      (chunk) => { streamedContent += chunk; },
    );

    expect(streamedContent).toBe('Streaming works!');
  });

  it('should handle multi-turn conversation with MockProvider', async () => {
    const provider = new MockProvider({ type: 'mock' as any }, [
      'Hello! How can I help you?',
      "I'm glad to hear that!",
      'You are welcome!',
    ]);

    // Turn 1
    let response = await provider.chat([createMessage('user', 'Hi')]);
    expect(response.content).toBe('Hello! How can I help you?');

    // Simulate adding assistant response and user follow-up
    const messages = [
      createMessage('user', 'Hi'),
      { ...response, role: 'assistant' } as Message,
      createMessage('user', "That's great"),
    ];

    response = await provider.chat(messages);
    expect(response.content).toBe("I'm glad to hear that!");
  });
});
