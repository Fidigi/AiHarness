// ============================================================
// AI Provider API Proxy - Proxies requests to real AI APIs with SSE streaming
// ============================================================

import { Request, Response } from 'express';
import { BedrockProvider, GeminiProvider, OpenAiProvider as CoreOpenAiProvider, VertexGeminiProvider, Message, ChatOptions } from '@ai-harness/core';
import type { AiProvider } from '@ai-harness/core';

/** Configuration for the proxy server */
export interface ProxyServerConfig {
  /** Default timeout in milliseconds */
  timeout?: number;
}

type ProxyChatOptions = ChatOptions & { stream?: boolean };

const DEFAULT_TIMEOUT = 120_000; // 2 minutes default

// ===================================================================
// OpenAI API Proxy
// ===================================================================

class OpenAiProxy {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(apiKey: string, baseUrl?: string, defaultModel = 'gpt-4o') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'https://api.openai.com/v1';
    this.defaultModel = defaultModel;
  }

  /** Stream response via SSE */
  async *stream(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<{ content: string; usage?: Record<string, number> }, void, unknown> {
    const model = options?.model || this.defaultModel;

    // Build message array with optional system prompt
    let apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
    if (options?.systemPrompt) {
      apiMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        stream: true,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    let fullContent = '';
    const reader = (response.body as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') return;

        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            yield { content: delta.content };
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Yield final usage info if available
  }

  /** Non-streaming response */
  async chat(messages: Message[], options?: ChatOptions): Promise<{ content: string; model?: string; usage?: Record<string, number> }> {
    const model = options?.model || this.defaultModel;

    let apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
    if (options?.systemPrompt) {
      apiMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        stream: false,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as OpenAiResponse;
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new Error('No content in OpenAI response');
    }

    return {
      content: choice.message.content || '',
      model: data.model,
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens ?? 0,
        completion_tokens: data.usage.completion_tokens ?? 0,
        total_tokens: data.usage.total_tokens ?? 0,
      } : undefined,
    };
  }
}

// ===================================================================
// Anthropic API Proxy
// ===================================================================

class AnthropicProxy {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  static readonly API_VERSION = '2023-06-01';

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'https://api.anthropic.com';
  }

  /** Stream response via SSE */
  async *stream(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<{ content: string; usage?: Record<string, number> }, void, unknown> {
    const model = options?.model || 'claude-3-haiku-20240307';

    // Build messages (Anthropic doesn't use system in messages array)
    let apiMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    if (apiMessages.length === 0) {
      apiMessages = [{ role: 'user', content: 'Hello' }];
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': AnthropicProxy.API_VERSION,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        max_tokens: options?.maxTokens ?? 1024,
        stream: true,
        ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = (response.body as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const dataStr = trimmed.slice(6);
          const eventData = JSON.parse(dataStr) as AnthropicStreamEvent;

          switch (eventData.type) {
            case 'content_block_delta': {
              const delta = (eventData as any).delta;
              if (delta?.type === 'text_delta' && delta.text) {
                fullContent += delta.text;
                yield { content: delta.text };
              }
              break;
            }
            case 'message_start': {
              const msgStart = eventData.message as any;
              if (msgStart?.usage) {
                inputTokens = msgStart.usage.input_tokens ?? 0;
              }
              break;
            }
            case 'message_delta': {
              const usage = (eventData as any).usage;
              if (usage) outputTokens = usage.output_tokens ?? 0;
              break;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    yield { content: '', usage: inputTokens > 0 || outputTokens > 0 ? { prompt_tokens: inputTokens, completion_tokens: outputTokens } : undefined };
  }

  /** Non-streaming response */
  async chat(messages: Message[], options?: ChatOptions): Promise<{ content: string; model?: string; usage?: Record<string, number> }> {
    const model = options?.model || 'claude-3-haiku-20240307';

    let apiMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    if (apiMessages.length === 0) {
      apiMessages = [{ role: 'user', content: 'Hello' }];
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': AnthropicProxy.API_VERSION,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        max_tokens: options?.maxTokens ?? 1024,
        stream: false,
        ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as AnthropicResponse;
    const contentBlock = data.content?.find((c: any) => c.type === 'text');
    if (!contentBlock) {
      throw new Error('No text content in Anthropic response');
    }

    return {
      content: (contentBlock as any).text || '',
      model: data.model,
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens ?? 0,
        completion_tokens: data.usage.output_tokens ?? 0,
        total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      } : undefined,
    };
  }
}

interface ProviderProxy {
  stream(messages: Message[], options?: ChatOptions): AsyncGenerator<{ content: string; usage?: Record<string, number> }, void, unknown>;
  chat(messages: Message[], options?: ChatOptions): Promise<{ content: string; model?: string; usage?: Record<string, number> }>;
}

class CoreProviderProxy implements ProviderProxy {
  constructor(private readonly provider: AiProvider) {}

  async chat(messages: Message[], options?: ChatOptions): Promise<{ content: string; model?: string; usage?: Record<string, number> }> {
    const result = await this.provider.chat(messages, options);
    return { ...result, usage: result.usage };
  }

  async *stream(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<{ content: string; usage?: Record<string, number> }, void, unknown> {
    const queue: Array<{ content: string; usage?: Record<string, number> }> = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;
    const notify = (): void => { wake?.(); wake = undefined; };

    void this.provider.streamChat(
      messages,
      content => {
        if (content) queue.push({ content });
        notify();
      },
      response => {
        if (response?.usage) queue.push({ content: '', usage: response.usage });
        finished = true;
        notify();
      },
      error => {
        failure = error;
        finished = true;
        notify();
      },
      options,
    ).catch(error => {
      failure = error instanceof Error ? error : new Error(String(error));
      finished = true;
      notify();
    });

    while (!finished || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>(resolve => { wake = resolve; });
      }
    }
    if (failure) throw failure;
  }
}

// ===================================================================
// Proxy Server - Main controller
// ===================================================================

export class AiProxyServer {
  private openaiProxy?: OpenAiProxy;
  private anthropicProxy?: AnthropicProxy;
  private localProxy?: OpenAiProxy;
  private googleProxy?: CoreProviderProxy;
  private azureProxy?: CoreProviderProxy;
  private vertexProxy?: CoreProviderProxy;
  private bedrockProxy?: CoreProviderProxy;
  private readonly config: Required<ProxyServerConfig>;

  constructor(config?: ProxyServerConfig) {
    this.config = { timeout: config?.timeout ?? DEFAULT_TIMEOUT };

    // Initialize proxies from environment variables if available
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        this.openaiProxy = new OpenAiProxy(openaiKey);
      } catch { /* Skip initialization */ }
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      try {
        this.anthropicProxy = new AnthropicProxy(anthropicKey);
      } catch { /* Skip initialization */ }
    }

    const googleKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (googleKey) {
      this.googleProxy = new CoreProviderProxy(new GeminiProvider({
        type: 'google' as any,
        apiKey: googleKey,
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      }));
    }

    if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
      this.azureProxy = new CoreProviderProxy(new CoreOpenAiProvider({
        type: 'azure' as any,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        baseUrl: process.env.AZURE_OPENAI_ENDPOINT,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
        model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
      }));
    }
    if (process.env.GOOGLE_VERTEX_ACCESS_TOKEN && process.env.GOOGLE_CLOUD_PROJECT) {
      this.vertexProxy = new CoreProviderProxy(new VertexGeminiProvider({
        type: 'vertex' as any,
        apiKey: process.env.GOOGLE_VERTEX_ACCESS_TOKEN,
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: process.env.GOOGLE_CLOUD_LOCATION,
      }));
    }
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      this.bedrockProxy = new CoreProviderProxy(new BedrockProvider({
        type: 'bedrock' as any,
        region: process.env.AWS_REGION,
        model: process.env.BEDROCK_MODEL,
      }));
    }

    const localBaseUrl = process.env.LOCAL_BASE_URL || process.env.LLAMA_BASE_URL;
    if (localBaseUrl) {
      try {
        this.localProxy = new OpenAiProxy(
          process.env.LOCAL_API_KEY || process.env.LLAMA_API_KEY || 'local',
          normalizeLocalBaseUrl(localBaseUrl),
          process.env.LOCAL_MODEL || process.env.LLAMA_MODEL || 'local-model',
        );
      } catch { /* Skip initialization */ }
    }
  }

  /** Set provider API keys dynamically */
  setApiKey(type: 'openai' | 'anthropic' | 'google' | 'azure' | 'vertex' | 'bedrock' | 'local', apiKey: string, baseUrl?: string, model?: string): void {
    if (type === 'openai') {
      this.openaiProxy = new OpenAiProxy(apiKey, baseUrl);
    } else if (type === 'anthropic') {
      this.anthropicProxy = new AnthropicProxy(apiKey, baseUrl);
    } else if (type === 'google') {
      this.googleProxy = new CoreProviderProxy(new GeminiProvider({
        type: 'google' as any,
        apiKey,
        baseUrl,
        model: model || 'gemini-2.0-flash',
      }));
    } else if (type === 'azure') {
      this.azureProxy = new CoreProviderProxy(new CoreOpenAiProvider({
        type: 'azure' as any, apiKey, baseUrl, model: model || 'gpt-4o', deployment: model,
      }));
    } else if (type === 'vertex') {
      this.vertexProxy = new CoreProviderProxy(new VertexGeminiProvider({
        type: 'vertex' as any, apiKey, baseUrl, model: model || 'gemini-2.0-flash',
      }));
    } else if (type === 'bedrock') {
      const [accessKeyId, secretAccessKey, sessionToken] = apiKey.split(':');
      this.bedrockProxy = new CoreProviderProxy(new BedrockProvider({
        type: 'bedrock' as any,
        accessKeyId,
        secretAccessKey: baseUrl || secretAccessKey,
        sessionToken,
        model,
      }));
    } else if (type === 'local') {
      this.localProxy = new OpenAiProxy(
        apiKey || 'local',
        normalizeLocalBaseUrl(baseUrl || 'http://localhost:11434/v1'),
        model || 'local-model',
      );
    }
  }

  /** Check if a provider is configured */
  isConfigured(type: string): boolean {
    switch (type) {
      case 'openai': return !!this.openaiProxy;
      case 'anthropic': return !!this.anthropicProxy;
      case 'google': return !!this.googleProxy;
      case 'azure': return !!this.azureProxy;
      case 'vertex': return !!this.vertexProxy;
      case 'bedrock': return !!this.bedrockProxy;
      case 'local': return !!this.localProxy;
      default: return false;
    }
  }

  /** Get configured providers list */
  getProviders(): Array<{ type: string; configured: boolean }> {
    return [
      { type: 'openai', configured: !!this.openaiProxy },
      { type: 'anthropic', configured: !!this.anthropicProxy },
      { type: 'google', configured: !!this.googleProxy },
      { type: 'azure', configured: !!this.azureProxy },
      { type: 'vertex', configured: !!this.vertexProxy },
      { type: 'bedrock', configured: !!this.bedrockProxy },
      { type: 'local', configured: !!this.localProxy },
    ];
  }

  /** Expose the configured timeout for route/integration layers. */
  getTimeoutMs(): number {
    return this.config.timeout;
  }

  /** Send a chat request (streaming or non-streaming) */
  async sendChat(
    providerType: string,
    messages: Message[],
    options?: ProxyChatOptions,
    onChunk?: (chunk: { content: string; usage?: Record<string, number> }) => void,
  ): Promise<{ content: string; model?: string; usage?: Record<string, number> }> {
    const provider = this.getProxy(providerType);

    if (!provider) {
      throw new Error(`Provider "${providerType}" is not configured. Set API key via environment variable or /api/config endpoint.`);
    }

    let fullContent = '';
    let finalUsage: Record<string, number> | undefined;

    // Streaming mode (preferred for web UI)
    if (options?.stream !== false && onChunk) {
      const stream = provider.stream(messages, options);
      for await (const chunk of stream) {
        fullContent += chunk.content;
        finalUsage = chunk.usage ?? finalUsage;
        onChunk(chunk);
      }

      return { content: fullContent, model: options?.model, usage: finalUsage };
    }

    // Non-streaming mode
    const result = await provider.chat(messages, options);
    return result;
  }

  /** Send a chat request with SSE streaming (returns ReadableStream for SSE) */
  async sendChatSSE(
    providerType: string,
    messages: Message[],
    options?: ProxyChatOptions,
  ): Promise<{ stream: ReadableStream<Uint8Array>; error?: Error }> {
    const proxy = this.getProxy(providerType);

    if (!proxy) {
      return {
        stream: createSSEError('Provider not configured'),
      };
    }

    try {
      const stream = new ReadableStream({
        async start(controller) {
          let fullContent = '';
          let finalUsage: Record<string, number> | undefined;

          // Send message_start event
          controller.enqueue(textToSSE('message_start', { provider: providerType }));

          try {
            const chatStream = proxy.stream(messages, options);
            for await (const chunk of chatStream) {
              fullContent += chunk.content;
              finalUsage = chunk.usage ?? finalUsage;

              if (chunk.content) {
                controller.enqueue(textToSSE('text_delta', { content: chunk.content }));
              }
            }

            // Send message_end event with usage
            controller.enqueue(textToSSE('message_end', {
              content: fullContent,
              ...(finalUsage ? { usage: finalUsage } : {}),
            }));
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            controller.enqueue(textToSSE('error', { message: err.message }));
          } finally {
            controller.close();
          }
        },
      });

      return { stream };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { stream: createSSEError(err.message) };
    }
  }

  private getProxy(type: string): ProviderProxy | null {
    switch (type.toLowerCase()) {
      case 'openai': return this.openaiProxy ?? null;
      case 'anthropic': return this.anthropicProxy ?? null;
      case 'google': return this.googleProxy ?? null;
      case 'azure': return this.azureProxy ?? null;
      case 'vertex': return this.vertexProxy ?? null;
      case 'bedrock': return this.bedrockProxy ?? null;
      case 'local': return this.localProxy ?? null;
      default: return null;
    }
  }
}

// ===================================================================
// SSE Helpers
// ===================================================================

function normalizeLocalBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function textToSSE(eventType: string, data: Record<string, unknown>): Uint8Array {
  const lines = [`event: ${eventType}`, `data: ${JSON.stringify(data)}`, ''];
  return new TextEncoder().encode(lines.join('\n'));
}

function createSSEError(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(textToSSE('error', { message }));
      controller.close();
    },
  });
}

/** Pipe a Web ReadableStream to an Express response. */
export async function writeSSEStream(
  stream: ReadableStream<Uint8Array>,
  res: Response,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    if (!res.writableEnded) res.end();
  }
}

// ===================================================================
// Express Route Handlers
// ===================================================================

export function createProxyRoutes(proxy: AiProxyServer) {
  /** POST /api/chat - Chat with streaming (SSE) */
  const chatHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider, messages, options } = req.body as {
        provider: string;
        messages: Message[];
        options?: ChatOptions & { stream?: boolean };
      };

      if (!provider || !messages) {
        res.status(400).json({ error: 'Missing required fields: provider, messages' });
        return;
      }

      // Check CORS headers are already set by middleware

      const result = await proxy.sendChatSSE(provider, messages as Message[], options);

      if (result.error) {
        res.status(400).json({ error: result.error.message });
        return;
      }

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      await writeSSEStream(result.stream, res);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Proxy] Chat handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  /** POST /api/chat/compact - Compact conversation with LLM summary */
  const compactHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { messages, provider, options } = req.body as {
        messages: Message[];
        provider?: string;
        options?: ChatOptions & { instructions?: string };
      };

      if (!messages || messages.length < 4) {
        res.status(400).json({ error: 'Need at least 4 messages to compact' });
        return;
      }

      const proxyType = provider ?? (process.env.OPENAI_API_KEY ? 'openai' : 'anthropic');
      if (!proxy || !proxy.isConfigured(proxyType)) {
        res.status(400).json({ error: `Provider "${proxyType}" not configured` });
        return;
      }

      const instructions = options?.instructions ?? 'Summarize this conversation concisely, preserving key information and context. Include any important decisions or conclusions.';

      // Build system prompt for summarization
      const summaryMessages: Message[] = [
        { id: '__system__', role: 'user', content: `Please summarize the following conversation:\n\n${messages.map(m => `${m.role}: ${m.content}`).join('\n---\n')}`, timestamp: new Date() },
      ];

      let fullSummary = '';
      const result = await proxy.sendChat(
        proxyType,
        summaryMessages,
        { ...options, systemPrompt: `You are a conversation summarizer. ${instructions}` },
        (chunk) => {
          fullSummary += chunk.content;
        },
      );

      res.json({ summary: result.content || fullSummary });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Proxy] Compact handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  /** GET /api/providers - List configured providers */
  const providersHandler = (_req: Request, res: Response): void => {
    res.json(proxy.getProviders());
  };

  /** POST /api/config - Set API keys dynamically */
  const configHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { type, apiKey, baseUrl, model } = req.body as {
        type: string;
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      };

      if (!type || (type !== 'local' && !apiKey)) {
        res.status(400).json({ error: 'Missing required provider configuration' });
        return;
      }

      const providerType = (['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local'] as const).find(candidate => candidate === type) ?? null;
      if (!providerType) {
        res.status(400).json({ error: 'Invalid provider type' });
        return;
      }

      proxy.setApiKey(providerType, apiKey || 'local', baseUrl, model);

      res.json({ success: true, message: `Provider "${type}" configured` });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };

  return { chatHandler, compactHandler, providersHandler, configHandler };
}

// ===================================================================
// Internal Types (not exported)
// ===================================================================

interface OpenAiResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message: { role: string; content: string | null } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface AnthropicResponse {
  id?: string;
  type?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

type AnthropicStreamEvent = {
  type: 'content_block_delta' | 'message_start' | 'message_delta';
  [key: string]: unknown;
};
