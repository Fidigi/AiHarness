// ============================================================
// AI Provider Interface & Real Implementations
// Features: real API integration, SSE streaming, retry with backoff,
// token usage tracking, model registry
// ============================================================

import type { Message, ProviderConfig, ToolCall, TokenUsage } from '../types/index.js';
import { ProviderType } from '../types/index.js';
import type { AgentProviderNetworkSettings } from '../config/agent-settings.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  acquireProviderWebSocket,
  fetchProviderResponse,
  PROVIDER_NETWORK_SCOPE,
  ProviderNetworkError,
  type ProviderNetworkScope,
  type ProviderWebSocket,
  type ProviderWebSocketCacheEntry,
  type ProviderWebSocketFactory,
  type ProviderWebSocketLease,
} from './provider-network.js';

// ===================================================================
// Streaming event types
// ===================================================================

export interface StreamEvent {
  type: 'text_delta' | 'reasoning_delta' | 'tool_call' | 'message_start' | 'message_end' | 'error' | 'done';
  data?: unknown;
}

/** A provider must await this callback before reading or producing the next stream item. */
export type StreamChunkCallback = (chunk: string, event?: StreamEvent) => void | Promise<void>;

function messageImages(message: Message): Array<Extract<NonNullable<Message['blocks']>[number], { type: 'image' }>> {
  return (message.blocks ?? []).filter((block): block is Extract<NonNullable<Message['blocks']>[number], { type: 'image' }> => block.type === 'image');
}

function parseDataImage(url: string): { mediaType: string; data: string } | undefined {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

const PROTECTED_PROVIDER_HEADERS = new Set([
  'authorization', 'openai-beta', 'session-id', 'x-client-request-id',
]);

function configuredHeaders(config: ProviderConfig): Record<string, string> {
  let source: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(config, 'customHeaders');
    source = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return {}; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  let names: string[];
  try { names = Object.getOwnPropertyNames(source); }
  catch { return {}; }
  if (names.length > 256) return {};
  const result = Object.create(null) as Record<string, string>;
  let totalBytes = 0;
  for (const name of names) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(source, name); }
    catch { return {}; }
    const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u.test(name)
      || PROTECTED_PROVIDER_HEADERS.has(name.toLowerCase())
      || typeof value !== 'string' || value.length > 8_000 || /[\r\n]/u.test(value)) continue;
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes > 64 * 1024) return {};
    Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

const MAX_PROVIDER_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_STREAM_EVENT_BYTES = 1024 * 1024;
const MAX_PROVIDER_STREAM_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_STREAM_TRANSPORT_BYTES = 64 * 1024 * 1024;
const MAX_PROVIDER_STREAM_TOOL_CALLS = 1_024;
const MAX_PROVIDER_STREAM_EVENTS = 100_000;
const MAX_PROVIDER_SHIM_WAIT_MS = 60_000;
const MAX_PROVIDER_MODELS = 10_000;

function boundedModelIds(values: unknown, select: (value: unknown) => unknown): string[] {
  if (!Array.isArray(values)) return [];
  if (values.length > MAX_PROVIDER_MODELS) throw new Error('The provider model catalogue exceeded its limit.');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let selected: unknown;
    try { selected = select(value); }
    catch { continue; }
    if (typeof selected !== 'string' || !selected || Buffer.byteLength(selected) > 500
      || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(selected)
      || seen.has(selected)) continue;
    seen.add(selected);
    result.push(selected);
  }
  return result;
}

function serializeProviderBody(value: unknown): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error('The provider request is invalid.'); }
  if (serialized === undefined) throw new Error('The provider request is invalid.');
  if (Buffer.byteLength(serialized) > MAX_PROVIDER_JSON_BYTES) {
    throw new Error('The provider request exceeded the input limit.');
  }
  return serialized;
}

function rejectProviderResponse(response: Response, message: string): never {
  void response.body?.cancel('provider-response-rejected').catch(() => undefined);
  throw new Error(message);
}

async function readProviderJson<T>(response: Response): Promise<T> {
  // Keep lightweight test/custom fetch shims compatible; native fetch responses
  // always expose Headers and a Web ReadableStream and take the bounded path.
  if (!response.headers?.get || !response.body?.getReader) {
    let value: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), MAX_PROVIDER_SHIM_WAIT_MS);
        timer.unref?.();
      });
      value = await Promise.race([
        Promise.resolve().then(() => response.json()),
        deadline,
      ]);
    } catch { throw new Error('The provider response was invalid.'); }
    finally { if (timer) clearTimeout(timer); }
    let serialized: string | undefined;
    try { serialized = JSON.stringify(value); }
    catch { throw new Error('The provider response was invalid.'); }
    if (serialized === undefined) throw new Error('The provider response was invalid.');
    if (Buffer.byteLength(serialized) > MAX_PROVIDER_JSON_BYTES) {
      throw new Error('The provider response exceeded the output limit.');
    }
    try { return JSON.parse(serialized) as T; }
    catch { throw new Error('The provider response was invalid.'); }
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
    || Number(contentLength) > MAX_PROVIDER_JSON_BYTES)) {
    void response.body?.cancel('provider-response-limit').catch(() => undefined);
    throw new Error('The provider response exceeded the output limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The provider response was invalid.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) { completed = true; break; }
      bytes += item.value.byteLength;
      if (bytes > MAX_PROVIDER_JSON_BYTES) {
        void reader.cancel('provider-response-limit').catch(() => undefined);
        throw new Error('The provider response exceeded the output limit.');
      }
      chunks.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
    )) as T;
  } catch (error) {
    if (error instanceof Error && error.message === 'The provider response exceeded the output limit.') throw error;
    throw new Error('The provider response was invalid.');
  } finally {
    if (!completed) void reader.cancel('provider-response-abandoned').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A hostile pending read may retain the lock. */ }
  }
}

export interface ChatResponse {
  content: string;
  /** Provider-supplied visible reasoning summary/process text, when available. */
  reasoning?: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens: number;
    costUsd?: number;
  };
  toolCalls?: ToolCall[];
}

/** Normalize provider response accounting for persistence and cross-frontend reporting. */
export function normalizeProviderUsage(usage: ChatResponse['usage']): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const ownValue = (key: keyof NonNullable<ChatResponse['usage']>): unknown => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(usage, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch { return undefined; }
  };
  const token = (value: unknown): number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0
  );
  const inputTokens = token(ownValue('promptTokens'));
  const outputTokens = token(ownValue('completionTokens'));
  const cacheReadTokens = token(ownValue('cacheReadTokens'));
  const cacheWriteTokens = token(ownValue('cacheWriteTokens'));
  const componentTotal = Math.min(Number.MAX_SAFE_INTEGER,
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
  const reportedTotal = token(ownValue('totalTokens'));
  const rawCost = ownValue('costUsd');
  const costUsd = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, rawCost)
    : undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: Math.max(componentTotal, reportedTotal),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

// ===================================================================
// Abstract base class
// ===================================================================

type ScopedProviderConfig = ProviderConfig & { [PROVIDER_NETWORK_SCOPE]?: ProviderNetworkScope };

function providerNetworkScope(config: ProviderConfig): ProviderNetworkScope | undefined {
  return (config as ScopedProviderConfig)[PROVIDER_NETWORK_SCOPE];
}

function providerNetworkSettings(config: ProviderConfig): AgentProviderNetworkSettings {
  const integer = (value: unknown, fallback: number, maximum: number): number => (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fallback
  );
  const httpIdleTimeoutMs = integer(config.httpIdleTimeoutMs, 300_000, 3_600_000);
  const transport = ['auto', 'sse', 'websocket', 'websocket-cached'].includes(String(config.transport))
    ? config.transport as AgentProviderNetworkSettings['transport']
    : 'auto';
  return {
    transport,
    ...(typeof config.httpProxy === 'string' && config.httpProxy.length <= 4_096 && config.httpProxy
      ? { httpProxy: config.httpProxy }
      : {}),
    httpIdleTimeoutMs,
    websocketConnectTimeoutMs: integer(config.websocketConnectTimeoutMs, 15_000, 3_600_000),
    requestTimeoutMs: integer(config.requestTimeoutMs, httpIdleTimeoutMs, 3_600_000),
    maxRetries: integer(config.providerMaxRetries, 0, 10),
    maxRetryDelayMs: integer(config.providerMaxRetryDelayMs, 60_000, 3_600_000),
  };
}

/** Abstract interface for all AI providers */
export abstract class AiProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /** Shared request path for proxy, timeout, idle and provider-level retry policy. */
  protected request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    return fetchProviderResponse(url, init, providerNetworkSettings(this.config), {
      scope: providerNetworkScope(this.config),
    });
  }

  /** Non-secret effective settings for diagnostics and extension adapters. */
  getNetworkSettings(): Omit<AgentProviderNetworkSettings, 'httpProxy'> & { proxyConfigured: boolean } {
    const settings = providerNetworkSettings(this.config);
    const { httpProxy, ...publicSettings } = settings;
    return { ...publicSettings, proxyConfigured: Boolean(httpProxy) };
  }

  /** Send messages and get a response (non-streaming) */
  abstract chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;

  /** Stream a response (for real-time output) */
  abstract streamChat(
    messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void>;

  /** Validate provider configuration */
  abstract validateConfig(): boolean;

  /** Get the list of available models when the provider exposes discovery. */
  async getAvailableModels(): Promise<string[]> {
    return [];
  }

  /** Expose the non-secret provider type without leaking its configuration. */
  getProviderType(): string {
    return String(this.config.type);
  }

  /** Expose only the configured model identifier; provider credentials stay private. */
  getConfiguredModel(): string | undefined {
    return typeof this.config.model === 'string' && this.config.model.trim()
      ? this.config.model.trim()
      : undefined;
  }

  /** Change the model selected for subsequent requests without exposing provider credentials. */
  setConfiguredModel(model: string): void {
    this.config.model = model;
  }
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: ChatToolDefinition[];
  maxRetries?: number;
  thinking?: ThinkingLevel;
  /** Cancels the active provider request. */
  signal?: AbortSignal;
  /** Stable process-local conversation identity used only by compatible cached transports. */
  sessionId?: string;
}

// ===================================================================
// Provider factory
// ===================================================================

/** Provider factory to create built-in and extension-provided instances. */
export class ProviderFactory {
  private static readonly dynamicProviders = new Map<string, (config: ProviderConfig) => AiProvider>();

  static create(config: ProviderConfig): AiProvider {
    switch (config.type) {
      case 'openai':
        return new OpenAiProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'google':
        return new GeminiProvider(config);
      case 'azure':
        return new OpenAiProvider(config);
      case 'vertex':
        return new VertexGeminiProvider(config);
      case 'bedrock':
        return new BedrockProvider(config);
      case 'local':
        return new LocalProvider(config);
      case 'mock':
        return new MockProvider(config);
      default: {
        const factory = this.dynamicProviders.get(String(config.type).toLowerCase());
        if (factory) return factory(config);
        throw new Error(`Unsupported provider type: ${config.type}`);
      }
    }
  }

  /** Register a provider factory at runtime. Built-in names cannot be replaced. */
  static register(type: string, factory: (config: ProviderConfig) => AiProvider): () => void {
    const normalized = type.trim().toLowerCase();
    if (!normalized || ['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock'].includes(normalized)) {
      throw new Error(`Cannot register reserved provider type: ${type}`);
    }
    if (this.dynamicProviders.has(normalized)) {
      throw new Error(`Provider type already registered: ${normalized}`);
    }
    this.dynamicProviders.set(normalized, factory);
    return () => this.dynamicProviders.delete(normalized);
  }

  static has(type: string): boolean {
    return ['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock'].includes(type.toLowerCase())
      || this.dynamicProviders.has(type.toLowerCase());
  }

  static getRegisteredTypes(): string[] {
    return [...this.dynamicProviders.keys()];
  }

  /** Default models per provider */
  static getDefaultModel(type: ProviderType): string {
    switch (type) {
      case 'openai': return 'gpt-4o';
      case 'anthropic': return 'claude-3-haiku-20240307';
      case 'google': return 'gemini-2.0-flash';
      case 'azure': return 'gpt-4o';
      case 'vertex': return 'gemini-2.0-flash';
      case 'bedrock': return 'anthropic.claude-3-haiku-20240307-v1:0';
      case 'local': return 'local-model';
      case 'mock': return 'mock-model-v1';
      default: return 'unknown-model';
    }
  }
}

// ===================================================================
// OpenAI Provider (real implementation)
// ===================================================================

function normalizeOpenAiUsage(
  usage: NonNullable<OpenAiResponse['usage']> | NonNullable<OpenAiStreamChunk['usage']>,
): NonNullable<ChatResponse['usage']> {
  const tokenCount = (value: unknown): number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
      : 0
  );
  const promptTokens = tokenCount(usage.prompt_tokens);
  const cacheReadTokens = Math.min(promptTokens, tokenCount(usage.prompt_tokens_details?.cached_tokens));
  const cacheWriteTokens = Math.min(
    promptTokens - cacheReadTokens,
    tokenCount(usage.prompt_tokens_details?.cache_write_tokens),
  );
  const inputTokens = promptTokens - cacheReadTokens - cacheWriteTokens;
  const completionTokens = tokenCount(usage.completion_tokens);
  return {
    promptTokens: inputTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: Math.min(
      Number.MAX_SAFE_INTEGER,
      inputTokens + completionTokens + cacheReadTokens + cacheWriteTokens,
    ),
  };
}

export class OpenAiProvider extends AiProvider {
  private readonly baseUrl: string;
  private readonly azure: boolean;
  static readonly DEFAULT_BASE_URL = 'https://api.openai.com/v1';

  constructor(config: ProviderConfig) {
    super(config);
    this.baseUrl = (config.baseUrl || OpenAiProvider.DEFAULT_BASE_URL).replace(/\/$/, '');
    this.azure = String(config.type) === 'azure';
  }

  private getChatUrl(): string {
    if (!this.azure) return `${this.baseUrl}/chat/completions`;
    const deployment = String(this.config.deployment || this.config.model || 'gpt-4o');
    const apiVersion = String(this.config.apiVersion || '2024-10-21');
    if (this.baseUrl.includes('/openai/deployments/')) return `${this.baseUrl}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    return `${this.baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  }

  private getHeaders(): Record<string, string> {
    return {
      ...configuredHeaders(this.config),
      'Content-Type': 'application/json',
      ...(this.azure
        ? { 'api-key': String(this.config.apiKey) }
        : this.config.apiKey ? { Authorization: `Bearer ${String(this.config.apiKey)}` } : {}),
    };
  }

  validateConfig(): boolean {
    return !!this.config.apiKey;
  }

  async getAvailableModels(): Promise<string[]> {
    if (this.azure) return [];
    const response = await this.request(`${this.baseUrl}/models`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) rejectProviderResponse(response, `Model discovery failed (${response.status}).`);
    const data = await readProviderJson<{ data?: Array<{ id?: unknown }> }>(response);
    return boundedModelIds(data.data, model => (model as { id?: unknown })?.id);
  }

  private buildMessages(messages: Message[]): Array<Record<string, unknown>> {
    return messages.map(message => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          content: message.content,
          tool_call_id: message.toolCallId,
          ...(message.name ? { name: message.name } : {}),
        };
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        };
      }
      const images = messageImages(message);
      return {
        role: message.role,
        content: images.length ? [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } })),
        ] : message.content,
      };
    });
  }

  private parseToolCalls(toolCalls?: OpenAiToolCall[]): ToolCall[] | undefined {
    if (!toolCalls?.length) return undefined;
    if (!Array.isArray(toolCalls) || toolCalls.length > MAX_PROVIDER_STREAM_TOOL_CALLS) {
      throw new Error('The provider response exceeded the tool-call limit.');
    }
    return toolCalls.map(call => {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function.arguments || '{}');
      } catch {
        input = { raw: call.function.arguments };
      }
      return { id: call.id, name: call.function.name, input };
    });
  }

  async chat(
    messages: Message[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    if (!this.validateConfig()) {
      throw new Error('OpenAI API key is required');
    }

    const model = options?.model || (this.config.model as string) || 'gpt-4o';

    // Build messages, prepending system prompt if provided
    const finalMessages = this.buildMessages(messages);
    if (options?.systemPrompt) {
      finalMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const response = await this.request(this.getChatUrl(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: serializeProviderBody({
        model,
        messages: finalMessages,
        stream: false,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        ...(options?.thinking && options.thinking !== 'off' ? {
          reasoning_effort: options.thinking === 'xhigh' || options.thinking === 'max'
            ? 'high' : options.thinking,
        } : {}),
        ...(options?.tools?.length ? {
          tools: options.tools.map(tool => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: 'auto',
        } : {}),
      }),
      signal: options?.signal,
    });

    if (!response.ok) rejectProviderResponse(response, `OpenAI API error (${response.status}).`);

    const data = await readProviderJson<OpenAiResponse>(response);
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new Error('No content in OpenAI response');
    }

    return {
      content: choice.message.content || '',
      ...(choice.message.reasoning_content || choice.message.reasoning_summary
        ? { reasoning: choice.message.reasoning_content || choice.message.reasoning_summary } : {}),
      model: data.model,
      usage: data.usage ? normalizeOpenAiUsage(data.usage) : undefined,
      toolCalls: this.parseToolCalls(choice.message.tool_calls),
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    if (!this.validateConfig()) {
      throw new Error('OpenAI API key is required');
    }

    const model = options?.model || (this.config.model as string) || 'gpt-4o';

    const body: Record<string, unknown> = {
      model,
      messages: this.buildMessages(messages),
      stream: true,
      ...(String(this.config.type) !== 'local' && !this.azure ? { stream_options: { include_usage: true } } : {}),
    };

    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options?.thinking && options.thinking !== 'off') {
      body.reasoning_effort = options.thinking === 'xhigh' || options.thinking === 'max'
        ? 'high' : options.thinking;
    }
    if (options?.systemPrompt) {
      const msgs = [...messages];
      msgs.unshift({ role: 'system', content: options.systemPrompt, id: '', timestamp: new Date() });
      body.messages = this.buildMessages(msgs);
    }
    if (options?.tools?.length) {
      body.tools = options.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = 'auto';
    }

    try {
      const serializedBody = serializeProviderBody(body);
      const response = await this.request(this.getChatUrl(), {
        method: 'POST',
        headers: this.getHeaders(),
        body: serializedBody,
        signal: options?.signal,
      });

      if (!response.ok) rejectProviderResponse(response, `OpenAI API error (${response.status}).`);
      if (!response.body) throw new Error('OpenAI streaming response has no body');

      let fullContent = '';
      let fullReasoning = '';
      let streamModel = model;
      let usage: ChatResponse['usage'];
      let outputBytes = 0;
      let transportBytes = 0;
      const addOutput = (value: string): void => {
        outputBytes += Buffer.byteLength(value);
        if (outputBytes > MAX_PROVIDER_STREAM_OUTPUT_BYTES) {
          throw new Error('The provider response exceeded the output limit.');
        }
      };
      const toolCallFragments = new Map<number, OpenAiToolCall>();
      const collectToolCalls = (): ToolCall[] | undefined =>
        this.parseToolCalls([...toolCallFragments.entries()].sort(([a], [b]) => a - b).map(([, call]) => call));
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      let streamEvents = 0;

      try {
        while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        transportBytes += value.byteLength;
        if (value.byteLength > MAX_PROVIDER_STREAM_EVENT_BYTES
          || transportBytes > MAX_PROVIDER_STREAM_TRANSPORT_BYTES) {
          throw new Error('The provider streaming event exceeded the output limit.');
        }

        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer) > MAX_PROVIDER_STREAM_EVENT_BYTES) {
          throw new Error('The provider streaming event exceeded the output limit.');
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6); // Remove "data: " prefix
          if (++streamEvents > MAX_PROVIDER_STREAM_EVENTS) throw new Error('The provider response exceeded its event limit.');
          if (dataStr === '[DONE]') {
            const toolCalls = collectToolCalls();
            for (const call of toolCalls ?? []) await onChunk('', { type: 'tool_call', data: call });
            onComplete?.({
              content: fullContent,
              ...(fullReasoning ? { reasoning: fullReasoning } : {}),
              model: streamModel,
              usage,
              toolCalls,
            });
            return;
          }

          let data: OpenAiStreamChunk;
          try { data = JSON.parse(dataStr) as OpenAiStreamChunk; }
          catch { throw new Error('The provider streaming response was invalid.'); }
          const delta = data.choices?.[0]?.delta;
          if (typeof delta?.content === 'string' && delta.content) {
            addOutput(delta.content);
            fullContent += delta.content;
            await onChunk(delta.content, { type: 'text_delta', data });
          }
          if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
            addOutput(delta.reasoning_content);
            fullReasoning += delta.reasoning_content;
            await onChunk('', { type: 'reasoning_delta', data: { content: delta.reasoning_content } });
          }
          for (const fragment of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
            if (!Number.isSafeInteger(fragment.index) || fragment.index < 0
              || fragment.index >= MAX_PROVIDER_STREAM_TOOL_CALLS) {
              throw new Error('The provider response exceeded the tool-call limit.');
            }
            const existing = toolCallFragments.get(fragment.index) ?? {
              id: typeof fragment.id === 'string' && fragment.id ? fragment.id : `tool-${fragment.index}`,
              type: 'function' as const,
              function: { name: '', arguments: '' },
            };
            if (!toolCallFragments.has(fragment.index)
              && toolCallFragments.size >= MAX_PROVIDER_STREAM_TOOL_CALLS) {
              throw new Error('The provider response exceeded the tool-call limit.');
            }
            if (typeof fragment.id === 'string' && fragment.id) {
              addOutput(fragment.id);
              existing.id = fragment.id;
            }
            if (typeof fragment.function?.name === 'string' && fragment.function.name) {
              addOutput(fragment.function.name);
              existing.function.name += fragment.function.name;
            }
            if (typeof fragment.function?.arguments === 'string' && fragment.function.arguments) {
              addOutput(fragment.function.arguments);
              existing.function.arguments += fragment.function.arguments;
            }
            toolCallFragments.set(fragment.index, existing);
          }

          if (typeof data.model === 'string' && Buffer.byteLength(data.model) <= 500
            && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(data.model)) {
            streamModel = data.model;
          }
          // OpenAI emits usage in a final empty-choices chunk when include_usage is enabled.
          if (data.usage) usage = normalizeOpenAiUsage(data.usage);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) throw new Error('The provider streaming response was invalid.');

      const toolCalls = collectToolCalls();
      for (const call of toolCalls ?? []) await onChunk('', { type: 'tool_call', data: call });
        onComplete?.({
          content: fullContent,
          ...(fullReasoning ? { reasoning: fullReasoning } : {}),
          model: streamModel,
          usage,
          toolCalls,
        });
      } finally {
        void reader.cancel('provider-stream-finished').catch(() => undefined);
        try { reader.releaseLock(); } catch { /* A hostile pending read may retain the lock. */ }
      }
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// ===================================================================
// Local OpenAI-compatible Provider (Ollama / llama.cpp / AirNES)
// ===================================================================

export class LocalProvider extends OpenAiProvider {
  static readonly LOCAL_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
  private readonly localBaseUrl: string;

  constructor(config: ProviderConfig) {
    const baseUrl = LocalProvider.normalizeBaseUrl(config.baseUrl || LocalProvider.LOCAL_DEFAULT_BASE_URL);
    super({
      ...config,
      type: ProviderType.LOCAL,
      baseUrl,
      apiKey: config.apiKey,
      model: config.model || 'local-model',
    });
    this.localBaseUrl = baseUrl;
  }

  /** Local OpenAI-compatible servers generally do not require credentials. */
  validateConfig(): boolean {
    try {
      const url = new URL(this.localBaseUrl);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** Query the OpenAI-compatible model catalogue when exposed by the server. */
  async getAvailableModels(): Promise<string[]> {
    const response = await this.request(`${this.localBaseUrl}/models`, {
      headers: this.config.apiKey ? { Authorization: `Bearer ${String(this.config.apiKey)}` } : {},
    });
    if (!response.ok) rejectProviderResponse(response, `Model discovery failed with HTTP ${response.status}`);

    const payload = await readProviderJson<{
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string; model?: string }>;
    }>(response);
    const openAiModels = boundedModelIds(payload.data, item => (item as { id?: unknown })?.id);
    const ollamaModels = boundedModelIds(payload.models,
      item => (item as { name?: unknown; model?: unknown })?.name || (item as { model?: unknown })?.model);
    if (openAiModels.length + ollamaModels.length > MAX_PROVIDER_MODELS) {
      throw new Error('The provider model catalogue exceeded its limit.');
    }
    return [...new Set([...openAiModels, ...ollamaModels])];
  }

  private static normalizeBaseUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, '');
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
  }
}

// OpenAI internal types
interface OpenAiResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string;
      reasoning_summary?: string;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiStreamToolCallFragment {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface OpenAiStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: OpenAiStreamToolCallFragment[] };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

// ===================================================================
// OpenAI Responses Provider (SSE + bounded WebSocket continuation)
// ===================================================================

const RESPONSES_MAX_EVENT_BYTES = 1024 * 1024;
const RESPONSES_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const RESPONSES_MAX_TOOL_CALLS = 1_024;
const RESPONSES_MAX_PENDING_EVENTS = 1_024;
const RESPONSES_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const RESPONSES_MAX_CACHED_CONTEXT_BYTES = 512 * 1024;
const RESPONSES_FALLBACK_TTL_MS = 5 * 60_000;
const RESPONSES_MAX_FALLBACK_SESSIONS = 256;
const RESPONSES_MAX_STATS_SESSIONS = 512;
const RESPONSES_WEBSOCKET_BETA = 'responses_websockets=2026-02-06';

type ResponsesInput = Array<Record<string, unknown>>;
type ResponsesRequest = Record<string, unknown> & {
  model: string;
  input: ResponsesInput;
  stream: true;
  previous_response_id?: string;
};

type ResponsesContinuation = {
  request: ResponsesRequest;
  responseId: string;
  assistantInput: Record<string, unknown>;
};

type ResponsesToolFragment = { id: string; name: string; arguments: string };
type ProviderResponseRecord = Record<string, unknown>;

function providerResponseRecord(value: unknown): ProviderResponseRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ProviderResponseRecord
    : undefined;
}

type ResponsesAccumulator = {
  content: string;
  reasoning: string;
  model?: string;
  responseId?: string;
  usage?: ChatResponse['usage'];
  tools: Map<string, ResponsesToolFragment>;
  outputBytes: number;
  events: number;
  completed: boolean;
  started: boolean;
};

export interface OpenAiResponsesTransportStats {
  websocketAttempts: number;
  websocketConnectionsCreated: number;
  websocketConnectionsReused: number;
  websocketFailures: number;
  sseFallbacks: number;
  fullContextRequests: number;
  deltaRequests: number;
  fallbackActive: boolean;
}

const responsesFallback = new Map<string, number>();
const responsesStats = new Map<string, OpenAiResponsesTransportStats>();
const responsesIdentitiesBySession = new Map<string, Set<string>>();

function rememberResponsesIdentity(sessionId: string, identity: string): void {
  let identities = responsesIdentitiesBySession.get(sessionId);
  if (!identities) {
    if (responsesIdentitiesBySession.size >= RESPONSES_MAX_STATS_SESSIONS) {
      responsesIdentitiesBySession.delete(responsesIdentitiesBySession.keys().next().value!);
    }
    identities = new Set();
    responsesIdentitiesBySession.set(sessionId, identities);
  }
  if (identities.size >= 16 && !identities.has(identity)) identities.delete(identities.values().next().value!);
  identities.add(identity);
}

function responsesTransportStats(sessionId: string): OpenAiResponsesTransportStats {
  let stats = responsesStats.get(sessionId);
  if (!stats) {
    if (responsesStats.size >= RESPONSES_MAX_STATS_SESSIONS) responsesStats.delete(responsesStats.keys().next().value!);
    stats = {
      websocketAttempts: 0,
      websocketConnectionsCreated: 0,
      websocketConnectionsReused: 0,
      websocketFailures: 0,
      sseFallbacks: 0,
      fullContextRequests: 0,
      deltaRequests: 0,
      fallbackActive: false,
    };
    responsesStats.set(sessionId, stats);
  }
  return stats;
}

export function getOpenAiResponsesTransportStats(sessionId: string): OpenAiResponsesTransportStats | undefined {
  const stats = responsesStats.get(sessionId);
  return stats ? { ...stats } : undefined;
}

export function resetOpenAiResponsesTransportStats(sessionId?: string): void {
  if (sessionId) {
    responsesStats.delete(sessionId);
    for (const identity of responsesIdentitiesBySession.get(sessionId) ?? []) responsesFallback.delete(identity);
    responsesIdentitiesBySession.delete(sessionId);
    return;
  }
  responsesStats.clear();
  responsesFallback.clear();
  responsesIdentitiesBySession.clear();
}

class ResponsesWebSocketFailure extends Error {
  constructor(public readonly reason: unknown, public readonly started: boolean) {
    super(reason instanceof Error ? reason.message : 'The provider WebSocket request failed.');
    this.name = 'ResponsesWebSocketFailure';
  }
}

class ResponsesProtocolError extends Error {
  constructor(
    public readonly code: string,
    message = 'The provider response was invalid.',
    public readonly providerFailure = false,
  ) {
    super(message);
    this.name = 'ResponsesProtocolError';
  }
}

function boundedResponseText(target: ResponsesAccumulator, delta: string): void {
  const bytes = Buffer.byteLength(delta);
  if (target.outputBytes + bytes > RESPONSES_MAX_OUTPUT_BYTES) {
    throw new ResponsesProtocolError('response_too_large', 'The provider response exceeded the output limit.');
  }
  target.outputBytes += bytes;
}

function setResponsesTool(
  target: ResponsesAccumulator,
  key: string,
  tool: ResponsesToolFragment,
): void {
  if ((!target.tools.has(key) && target.tools.size >= RESPONSES_MAX_TOOL_CALLS)
    || Buffer.byteLength(key) > 16_384 || Buffer.byteLength(tool.id) > 16_384
    || Buffer.byteLength(tool.name) > 16_384) {
    throw new ResponsesProtocolError('response_too_large', 'The provider response exceeded the output limit.');
  }
  const previous = target.tools.get(key);
  const previousBytes = previous
    ? Buffer.byteLength(key) + Buffer.byteLength(previous.id) + Buffer.byteLength(previous.name)
      + Buffer.byteLength(previous.arguments)
    : 0;
  const nextBytes = Buffer.byteLength(key) + Buffer.byteLength(tool.id) + Buffer.byteLength(tool.name)
    + Buffer.byteLength(tool.arguments);
  if (target.outputBytes - previousBytes + nextBytes > RESPONSES_MAX_OUTPUT_BYTES) {
    throw new ResponsesProtocolError('response_too_large', 'The provider response exceeded the output limit.');
  }
  target.outputBytes = target.outputBytes - previousBytes + nextBytes;
  target.tools.set(key, tool);
}

function responsesUsage(value: unknown): ChatResponse['usage'] | undefined {
  const usage = providerResponseRecord(value);
  if (!usage) return undefined;
  const tokenCount = (input: unknown): number => {
    const number = Number(input);
    return Number.isFinite(number) && number > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) : 0;
  };
  const promptTokens = tokenCount(usage.input_tokens);
  const completionTokens = tokenCount(usage.output_tokens);
  const details = providerResponseRecord(usage.input_tokens_details);
  const cacheReadTokens = Math.min(promptTokens, tokenCount(details?.cached_tokens));
  return {
    promptTokens: promptTokens - cacheReadTokens,
    completionTokens,
    cacheReadTokens,
    totalTokens: Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(tokenCount(usage.total_tokens), promptTokens + completionTokens),
    ),
  };
}

function parseResponsesTool(item: unknown): ResponsesToolFragment | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  if (record.type !== 'function_call' || typeof record.name !== 'string') return undefined;
  return {
    id: String(record.call_id ?? record.id ?? randomUUID()),
    name: record.name,
    arguments: typeof record.arguments === 'string' ? record.arguments : '',
  };
}

function responseOutputText(response: ProviderResponseRecord): string {
  if (typeof response.output_text === 'string') return response.output_text;
  const content = (Array.isArray(response.output) ? response.output : []).flatMap(item => {
    const record = providerResponseRecord(item);
    return record && Array.isArray(record.content) ? record.content : [];
  });
  return content.flatMap(item => {
    const record = providerResponseRecord(item);
    return record?.type === 'output_text' && typeof record.text === 'string' ? [record.text] : [];
  }).join('');
}

async function applyResponsesEvent(
  event: ProviderResponseRecord,
  state: ResponsesAccumulator,
  onChunk: StreamChunkCallback,
): Promise<void> {
  if (++state.events > 1_024) throw new ResponsesProtocolError('too_many_events');
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'error' || type === 'response.failed') {
    const response = providerResponseRecord(event.response);
    const error = providerResponseRecord(event.error) ?? providerResponseRecord(response?.error);
    const remoteCode = typeof error?.code === 'string' ? error.code : '';
    const code = ['previous_response_not_found', 'websocket_connection_limit_reached'].includes(remoteCode)
      ? remoteCode
      : 'provider_error';
    throw new ResponsesProtocolError(code, 'The provider response failed.', true);
  }
  state.started = true;
  if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
    boundedResponseText(state, event.delta);
    state.content += event.delta;
    await onChunk(event.delta, { type: 'text_delta', data: event });
  }
  if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta')
    && typeof event.delta === 'string') {
    boundedResponseText(state, event.delta);
    state.reasoning += event.delta;
    await onChunk('', { type: 'reasoning_delta', data: { content: event.delta } });
  }
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const tool = parseResponsesTool(event.item);
    if (tool) setResponsesTool(state, String(event.output_index ?? tool.id), tool);
  }
  if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
    const key = String(event.output_index ?? event.item_id ?? event.call_id ?? '0');
    const current = state.tools.get(key);
    const tool: ResponsesToolFragment = current ? {
      ...current,
      arguments: current.arguments + event.delta,
    } : {
      id: String(event.call_id ?? event.item_id ?? key),
      name: typeof event.name === 'string' ? event.name : '',
      arguments: event.delta,
    };
    setResponsesTool(state, key, tool);
  }
  if (type === 'response.function_call_arguments.done') {
    const key = String(event.output_index ?? event.item_id ?? event.call_id ?? '0');
    const current = state.tools.get(key);
    const tool: ResponsesToolFragment = {
      id: current?.id ?? String(event.call_id ?? event.item_id ?? key),
      name: typeof event.name === 'string' ? event.name : current?.name ?? '',
      arguments: typeof event.arguments === 'string' ? event.arguments : current?.arguments ?? '',
    };
    setResponsesTool(state, key, tool);
  }
  if (['response.completed', 'response.done', 'response.incomplete'].includes(type)) {
    const response = providerResponseRecord(event.response) ?? {};
    state.responseId = typeof response.id === 'string' ? response.id : state.responseId;
    state.model = typeof response.model === 'string' ? response.model : state.model;
    state.usage = responsesUsage(response.usage) ?? state.usage;
    for (const [index, item] of (Array.isArray(response.output) ? response.output : []).entries()) {
      const tool = parseResponsesTool(item);
      if (tool) setResponsesTool(state, String(index), tool);
    }
    if (!state.content) {
      const content = responseOutputText(response);
      if (content) {
        boundedResponseText(state, content);
        state.content = content;
        await onChunk(content, { type: 'text_delta', data: event });
      }
    }
    state.completed = true;
  }
}

function finalizeResponses(state: ResponsesAccumulator): ChatResponse {
  const toolCalls: ToolCall[] = [...state.tools.values()].map(tool => {
    let input: unknown = {};
    try { input = JSON.parse(tool.arguments || '{}'); }
    catch { input = { raw: tool.arguments }; }
    return { id: tool.id, name: tool.name, input };
  });
  return {
    content: state.content,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

function decodeProviderWebSocketEvent(event: unknown): string {
  if (!event || typeof event !== 'object') throw new ResponsesProtocolError('invalid_websocket_event');
  let data: unknown;
  try { data = (event as { data?: unknown }).data; }
  catch { throw new ResponsesProtocolError('invalid_websocket_event'); }
  if (typeof data === 'string') {
    if (data.length > RESPONSES_MAX_EVENT_BYTES || Buffer.byteLength(data) > RESPONSES_MAX_EVENT_BYTES) {
      throw new ResponsesProtocolError('websocket_event_too_large');
    }
    return data;
  }
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else throw new ResponsesProtocolError('invalid_websocket_event');
  if (bytes.byteLength > RESPONSES_MAX_EVENT_BYTES) {
    throw new ResponsesProtocolError('websocket_event_too_large');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ResponsesProtocolError('invalid_websocket_event'); }
}

async function* responsesWebSocketEvents(
  socket: ProviderWebSocket,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): AsyncGenerator<ProviderResponseRecord> {
  const effectiveIdleTimeoutMs = idleTimeoutMs > 0 ? Math.min(idleTimeoutMs, 10 * 60_000) : 120_000;
  const queue: Array<{ event: ProviderResponseRecord; bytes: number }> = [];
  let queuedBytes = 0;
  let transportedBytes = 0;
  let wake: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;
  const notify = (): void => { wake?.(); wake = undefined; };
  const message = (event: unknown): void => {
    if (done) return;
    try {
      const text = decodeProviderWebSocketEvent(event);
      const bytes = Buffer.byteLength(text);
      if (queue.length >= RESPONSES_MAX_PENDING_EVENTS || queuedBytes + bytes > RESPONSES_MAX_PENDING_BYTES) {
        throw new ResponsesProtocolError('websocket_queue_limit', 'The provider WebSocket response exceeded the queue limit.');
      }
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ResponsesProtocolError('invalid_websocket_json');
      }
      const parsedRecord = parsed as ProviderResponseRecord;
      queue.push({ event: parsedRecord, bytes });
      queuedBytes += bytes;
      if (['response.completed', 'response.done', 'response.incomplete'].includes(String(parsedRecord.type))) {
        done = true;
      }
    } catch (error) {
      failure = error instanceof ResponsesProtocolError
        ? error : new ResponsesProtocolError('invalid_websocket_event');
      done = true;
      try { socket.close(1009, 'invalid_event'); } catch { /* Ignore cleanup failure. */ }
    }
    notify();
  };
  const failed = (): void => {
    failure ??= new ProviderNetworkError('websocket-failed', 'The provider WebSocket connection failed.');
    done = true;
    notify();
  };
  const closed = (): void => {
    if (!done) failure ??= new ProviderNetworkError('websocket-failed', 'The provider WebSocket connection closed early.');
    done = true;
    notify();
  };
  const aborted = (): void => {
    failure = signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError');
    done = true;
    notify();
  };
  socket.addEventListener('message', message);
  socket.addEventListener('error', failed);
  socket.addEventListener('close', closed);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    while (true) {
      if (queue.length) {
        const item = queue.shift()!;
        queuedBytes = Math.max(0, queuedBytes - item.bytes);
        transportedBytes += item.bytes;
        if (transportedBytes > MAX_PROVIDER_STREAM_TRANSPORT_BYTES) {
          throw new ResponsesProtocolError('websocket_transport_limit');
        }
        yield item.event;
        continue;
      }
      if (done) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        if (effectiveIdleTimeoutMs > 0) {
          timer = setTimeout(() => {
            failure = new ProviderNetworkError('websocket-idle-timeout', 'The provider WebSocket response was idle for too long.');
            done = true;
            wake = undefined;
            try { socket.close(1000, 'idle_timeout'); } catch { /* Ignore cleanup failure. */ }
            reject(failure);
          }, effectiveIdleTimeoutMs);
          timer.unref?.();
        }
      }).finally(() => { if (timer) clearTimeout(timer); });
    }
    if (failure) throw failure;
  } finally {
    socket.removeEventListener('message', message);
    socket.removeEventListener('error', failed);
    socket.removeEventListener('close', closed);
    signal?.removeEventListener('abort', aborted);
  }
}

function responseRequestComparable(body: ResponsesRequest): string {
  const { input: _input, previous_response_id: _previous, ...rest } = body;
  return JSON.stringify(rest);
}

function cachedResponsesBody(
  body: ResponsesRequest,
  continuation: ResponsesContinuation | undefined,
): ResponsesRequest {
  if (!continuation || responseRequestComparable(body) !== responseRequestComparable(continuation.request)) return body;
  const baseline = [...continuation.request.input, continuation.assistantInput];
  if (body.input.length < baseline.length
    || JSON.stringify(body.input.slice(0, baseline.length)) !== JSON.stringify(baseline)) return body;
  return {
    ...body,
    previous_response_id: continuation.responseId,
    input: body.input.slice(baseline.length),
  };
}

function activeResponsesFallback(key: string): boolean {
  const expiresAt = responsesFallback.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    responsesFallback.delete(key);
    return false;
  }
  return true;
}

function markResponsesFallback(key: string): void {
  if (responsesFallback.size >= RESPONSES_MAX_FALLBACK_SESSIONS && !responsesFallback.has(key)) {
    responsesFallback.delete(responsesFallback.keys().next().value!);
  }
  responsesFallback.set(key, Date.now() + RESPONSES_FALLBACK_TTL_MS);
}

export class OpenAiResponsesProvider extends AiProvider {
  private readonly baseUrl: string;
  private readonly customHeaders: Record<string, string>;

  constructor(config: ProviderConfig) {
    super(config);
    this.baseUrl = String(config.baseUrl || OpenAiProvider.DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.customHeaders = configuredHeaders(config);
  }

  validateConfig(): boolean {
    try {
      const parsed = new URL(this.baseUrl);
      return ['http:', 'https:'].includes(parsed.protocol)
        && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch { return false; }
  }

  async getAvailableModels(): Promise<string[]> {
    const response = await this.request(`${this.baseUrl}/models`, { headers: this.headers(false) });
    if (!response.ok) rejectProviderResponse(response, `Model discovery failed (${response.status}).`);
    const body = await this.boundedJson(response);
    return boundedModelIds(body.data, item => (item as { id?: unknown })?.id);
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      void this.streamChat(
        messages,
        () => undefined,
        response => {
          if (settled) return;
          settled = true;
          resolve(response ?? { content: '' });
        },
        error => {
          if (settled) return;
          settled = true;
          reject(error);
        },
        options,
      ).catch(reject);
    });
  }

  async streamChat(
    messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    try {
      if (!this.validateConfig()) throw new Error('OpenAI Responses provider configuration is invalid.');
      if (options?.sessionId !== undefined
        && (typeof options.sessionId !== 'string' || !options.sessionId
          || Buffer.byteLength(options.sessionId) > 4_096
          || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(options.sessionId))) {
        throw new Error('The provider session identifier is invalid.');
      }
      const body = this.requestBody(messages, options);
      serializeProviderBody(body);
      const transport = this.config.transport ?? 'auto';
      const identity = this.transportIdentity(options?.sessionId);
      if (options?.sessionId) rememberResponsesIdentity(options.sessionId, identity);
      const stats = options?.sessionId ? responsesTransportStats(options.sessionId) : undefined;
      let response: ChatResponse | undefined;
      if (transport !== 'sse' && !activeResponsesFallback(identity)) {
        try {
          response = await this.streamWebSocket(body, onChunk, options, identity, stats);
          responsesFallback.delete(identity);
          if (stats) stats.fallbackActive = false;
        } catch (error) {
          const reason = error instanceof ResponsesWebSocketFailure ? error.reason : error;
          const connectionLimit = reason instanceof ResponsesProtocolError
            && reason.code === 'websocket_connection_limit_reached';
          if (options?.signal?.aborted
            || (reason instanceof ResponsesProtocolError && reason.providerFailure && !connectionLimit)) throw reason;
          const started = error instanceof ResponsesWebSocketFailure && error.started;
          if (started) throw reason;
          markResponsesFallback(identity);
          if (stats) {
            stats.websocketFailures++;
            stats.sseFallbacks++;
            stats.fallbackActive = true;
          }
        }
      } else if (transport !== 'sse' && stats) {
        stats.sseFallbacks++;
        stats.fallbackActive = true;
      }
      response ??= await this.streamSse(body, onChunk, options);
      for (const call of response.toolCalls ?? []) await onChunk('', { type: 'tool_call', data: call });
      onComplete?.(response);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private requestBody(messages: Message[], options?: ChatOptions): ResponsesRequest {
    const input: ResponsesInput = [];
    for (const message of messages) {
      if (message.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId ?? message.id,
          output: message.content,
        });
        continue;
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        if (message.content) input.push({ role: 'assistant', content: message.content });
        for (const call of message.toolCalls) input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: serializeProviderBody(call.input),
        });
        continue;
      }
      input.push({ role: message.role, content: message.content });
    }
    return {
      model: options?.model ?? this.getConfiguredModel() ?? 'gpt-4o',
      input,
      stream: true,
      store: false,
      ...(options?.systemPrompt ? { instructions: options.systemPrompt } : {}),
      ...(options?.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.thinking && options.thinking !== 'off' ? {
        reasoning: { effort: options.thinking === 'xhigh' || options.thinking === 'max' ? 'high' : options.thinking },
      } : {}),
      ...(options?.tools?.length ? {
        tools: (() => {
          if (!Array.isArray(options.tools) || options.tools.length > MAX_PROVIDER_STREAM_TOOL_CALLS) {
            throw new Error('The provider request exceeded the tool-call limit.');
          }
          return options.tools.map(tool => ({
            type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters,
          }));
        })(),
        tool_choice: 'auto',
      } : {}),
    };
  }

  private async streamWebSocket(
    fullBody: ResponsesRequest,
    onChunk: StreamChunkCallback,
    options: ChatOptions | undefined,
    identity: string,
    stats?: OpenAiResponsesTransportStats,
  ): Promise<ChatResponse> {
    const network = providerNetworkSettings(this.config);
    const cache = (this.config.transport === 'websocket-cached' || this.config.transport === 'auto')
      && Boolean(options?.sessionId);
    const timeout = network.requestTimeoutMs > 0 ? AbortSignal.timeout(network.requestTimeoutMs) : undefined;
    const signal = options?.signal && timeout ? AbortSignal.any([options.signal, timeout]) : options?.signal ?? timeout;
    const stableTransportError = (error: unknown): unknown => (
      timeout?.aborted && !options?.signal?.aborted
        ? new ProviderNetworkError('request-timeout', 'The provider request timed out.')
        : error
    );
    let retriedContinuation = false;
    let retriedConnectionLimit = false;
    while (true) {
      if (stats) stats.websocketAttempts++;
      let lease: ProviderWebSocketLease;
      try {
        lease = await acquireProviderWebSocket(
          this.websocketUrl(),
          this.headers(true, options?.sessionId),
          network,
          {
            cacheKey: cache ? identity : undefined,
            scope: providerNetworkScope(this.config),
            signal,
            ...(typeof this.config.webSocketFactory === 'function'
              ? { factory: this.config.webSocketFactory as ProviderWebSocketFactory }
              : {}),
          },
        );
      } catch (error) {
        throw stableTransportError(error);
      }
      if (stats) {
        if (lease.reused) stats.websocketConnectionsReused++;
        else stats.websocketConnectionsCreated++;
      }
      const entry = lease.entry as (ProviderWebSocketCacheEntry & { continuation?: ResponsesContinuation }) | undefined;
      const body = cache && entry ? cachedResponsesBody(fullBody, entry.continuation) : fullBody;
      if (stats) {
        if (body.previous_response_id) stats.deltaRequests++;
        else stats.fullContextRequests++;
      }
      const state: ResponsesAccumulator = {
        content: '', reasoning: '', tools: new Map(), outputBytes: 0, events: 0, completed: false, started: false,
      };
      let keep = false;
      try {
        lease.socket.send(serializeProviderBody({ type: 'response.create', ...body }));
        for await (const event of responsesWebSocketEvents(lease.socket, signal, network.httpIdleTimeoutMs)) {
          await applyResponsesEvent(event, state, onChunk);
        }
        if (!state.completed) throw new ResponsesProtocolError('incomplete_websocket_response');
        const response = finalizeResponses(state);
        if (entry) {
          const cachedBytes = Buffer.byteLength(JSON.stringify(fullBody)) + Buffer.byteLength(response.content);
          entry.continuation = state.responseId && !response.toolCalls?.length
            && cachedBytes <= RESPONSES_MAX_CACHED_CONTEXT_BYTES
            ? {
                request: fullBody,
                responseId: state.responseId,
                assistantInput: { role: 'assistant', content: response.content },
              }
            : undefined;
          keep = true;
        }
        return response;
      } catch (error) {
        if (entry) entry.continuation = undefined;
        const stableError = stableTransportError(error);
        const code = stableError instanceof ResponsesProtocolError ? stableError.code : '';
        if (!state.started && code === 'previous_response_not_found' && !retriedContinuation) {
          retriedContinuation = true;
          continue;
        }
        if (!state.started && code === 'websocket_connection_limit_reached' && !retriedConnectionLimit) {
          retriedConnectionLimit = true;
          continue;
        }
        throw new ResponsesWebSocketFailure(stableError, state.started);
      } finally {
        lease.release({ keep });
      }
    }
  }

  private async streamSse(
    body: ResponsesRequest,
    onChunk: StreamChunkCallback,
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const response = await this.request(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...this.headers(false, options?.sessionId) },
      body: serializeProviderBody(body),
      signal: options?.signal,
    });
    if (!response.ok) rejectProviderResponse(response, `OpenAI Responses API error (${response.status}).`);
    if (!response.body) throw new Error('OpenAI Responses streaming response has no body.');
    const state: ResponsesAccumulator = {
      content: '', reasoning: '', tools: new Map(), outputBytes: 0, events: 0, completed: false, started: false,
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let transportBytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        transportBytes += item.value.byteLength;
        if (item.value.byteLength > RESPONSES_MAX_EVENT_BYTES
          || transportBytes > MAX_PROVIDER_STREAM_TRANSPORT_BYTES) {
          throw new ResponsesProtocolError('sse_event_too_large');
        }
        buffer += decoder.decode(item.value, { stream: true });
        if (Buffer.byteLength(buffer) > RESPONSES_MAX_EVENT_BYTES) throw new ResponsesProtocolError('sse_event_too_large');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let event: ProviderResponseRecord;
          try { event = JSON.parse(payload) as ProviderResponseRecord; }
          catch { throw new ResponsesProtocolError('invalid_sse_json'); }
          await applyResponsesEvent(event, state, onChunk);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim().startsWith('data:')) {
        const payload = buffer.trim().slice(5).trim();
        if (payload && payload !== '[DONE]') {
          let event: ProviderResponseRecord;
          try { event = JSON.parse(payload) as ProviderResponseRecord; }
          catch { throw new ResponsesProtocolError('invalid_sse_json'); }
          await applyResponsesEvent(event, state, onChunk);
        }
      }
    } finally {
      void reader.cancel('provider-stream-finished').catch(() => undefined);
      try { reader.releaseLock(); } catch { /* A hostile pending read may retain the lock. */ }
    }
    if (!state.completed && !state.content && !state.tools.size) {
      throw new ResponsesProtocolError('incomplete_sse_response');
    }
    return finalizeResponses(state);
  }

  private async boundedJson(response: Response): Promise<ProviderResponseRecord> {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
      || Number(contentLength) > RESPONSES_MAX_EVENT_BYTES)) {
      void response.body?.cancel('provider-response-limit').catch(() => undefined);
      throw new Error('The provider response exceeded the output limit.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The provider response was invalid.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let completed = false;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) { completed = true; break; }
        bytes += item.value.byteLength;
        if (bytes > RESPONSES_MAX_EVENT_BYTES) {
          throw new Error('The provider response exceeded the output limit.');
        }
        chunks.push(item.value);
      }
      const combined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
        const record = providerResponseRecord(parsed);
        if (!record) throw new Error('invalid');
        return record;
      } catch { throw new Error('The provider response was invalid.'); }
    } finally {
      if (!completed) void reader.cancel('provider-response-abandoned').catch(() => undefined);
      try { reader.releaseLock(); } catch { /* A hostile pending read may retain the lock. */ }
    }
  }

  private headers(websocket: boolean, sessionId?: string): Record<string, string> {
    const providerSessionId = sessionId
      ? (/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)
          ? sessionId
          : createHash('sha256').update(sessionId).digest('hex'))
      : undefined;
    return {
      ...this.customHeaders,
      ...(this.config.apiKey ? { Authorization: `Bearer ${String(this.config.apiKey)}` } : {}),
      ...(websocket ? { 'OpenAI-Beta': RESPONSES_WEBSOCKET_BETA } : {}),
      ...(providerSessionId ? { 'session-id': providerSessionId, 'x-client-request-id': providerSessionId } : {}),
    };
  }

  private websocketUrl(): string {
    const url = new URL(`${this.baseUrl}/responses`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  private transportIdentity(sessionId?: string): string {
    const session = typeof sessionId === 'string' ? sessionId : 'ephemeral';
    return createHash('sha256')
      .update(`${session}\0${this.baseUrl}\0${String(this.config.apiKey ?? '')}\0${JSON.stringify(
        Object.entries(this.customHeaders).sort(([left], [right]) => left.localeCompare(right)),
      )}`)
      .digest('hex');
  }
}

// ===================================================================
// Google Gemini Provider
// ===================================================================

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: unknown };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string };
}

export class GeminiProvider extends AiProvider {
  static readonly DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    super({ ...config, type: ProviderType.GOOGLE, model: config.model || 'gemini-2.0-flash' });
    this.baseUrl = (config.baseUrl || GeminiProvider.DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  validateConfig(): boolean {
    return Boolean(this.config.apiKey);
  }

  async getAvailableModels(): Promise<string[]> {
    const response = await this.request(`${this.baseUrl}/models?key=${encodeURIComponent(String(this.config.apiKey || ''))}`, {
      headers: this.requestHeaders(),
    });
    if (!response.ok) rejectProviderResponse(response, `Model discovery failed (${response.status}).`);
    const data = await readProviderJson<{ models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }> }>(response);
    return boundedModelIds(data.models, value => {
      const model = value as { name?: unknown; supportedGenerationMethods?: unknown };
      return typeof model.name === 'string'
        && (!Array.isArray(model.supportedGenerationMethods)
          || model.supportedGenerationMethods.slice(0, 100).includes('generateContent'))
        ? model.name.replace(/^models\//u, '') : undefined;
    });
  }

  protected endpoint(method: 'generateContent' | 'streamGenerateContent'): string {
    const model = String(this.config.model || 'gemini-2.0-flash').replace(/^models\//, '');
    const suffix = method === 'streamGenerateContent' ? '?alt=sse&' : '?';
    return `${this.baseUrl}/models/${encodeURIComponent(model)}:${method}${suffix}key=${encodeURIComponent(String(this.config.apiKey || ''))}`;
  }

  protected requestHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...configuredHeaders(this.config) };
  }

  private buildBody(messages: Message[], options?: ChatOptions): Record<string, unknown> {
    const systemText = [
      options?.systemPrompt,
      ...messages.filter(message => message.role === 'system').map(message => message.content),
    ].filter(Boolean).join('\n\n');
    const contents = messages.filter(message => message.role !== 'system').map(message => {
      if (message.role === 'tool') {
        return {
          role: 'user',
          parts: [{ functionResponse: {
            name: message.name || 'tool',
            response: { content: message.content, isError: Boolean(message.isError) },
          } }],
        };
      }
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      for (const image of messageImages(message)) {
        const data = parseDataImage(image.url);
        if (data) parts.push({ inlineData: { mimeType: data.mediaType, data: data.data } });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      return { role: message.role === 'assistant' ? 'model' : 'user', parts };
    });
    const thinkingModel = String(options?.model ?? this.config.model ?? '');
    const highBudget = thinkingModel.includes('2.5-pro') ? 32768
      : thinkingModel.includes('2.5-flash') ? 24576 : 8192;
    const thinkingBudgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: highBudget,
      xhigh: highBudget,
      max: highBudget,
    } as const;
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options?.thinking
          ? { thinkingConfig: { thinkingBudget: options.thinking === 'off' ? 0 : thinkingBudgets[options.thinking] } }
          : {}),
      },
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    if (options?.tools?.length) {
      body.tools = [{ functionDeclarations: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })) }];
    }
    return body;
  }

  private normalize(response: GeminiResponse): ChatResponse {
    if (response.error?.message) throw new Error('Gemini API returned an error.');
    const token = (value: unknown): number => (
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
        : 0
    );
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    if (!Array.isArray(parts) || parts.length > MAX_PROVIDER_STREAM_TOOL_CALLS) {
      throw new Error('The provider response exceeded the content-block limit.');
    }
    const content = parts.map(part => part.text ?? '').join('');
    const toolCalls = parts.flatMap((part, index) => part.functionCall ? [{
      id: `gemini-${index}-${part.functionCall.name}`,
      name: part.functionCall.name,
      input: part.functionCall.args ?? {},
    }] : []);
    const usage = response.usageMetadata;
    return {
      content,
      model: String(this.config.model),
      usage: usage ? (() => {
        const prompt = token(usage.promptTokenCount);
        const cacheRead = Math.min(prompt, token(usage.cachedContentTokenCount));
        const completion = Math.min(
          Number.MAX_SAFE_INTEGER,
          token(usage.candidatesTokenCount) + token(usage.thoughtsTokenCount),
        );
        return {
          promptTokens: prompt - cacheRead,
          completionTokens: completion,
          cacheReadTokens: cacheRead,
          totalTokens: Math.min(
            Number.MAX_SAFE_INTEGER,
            Math.max(token(usage.totalTokenCount), prompt + completion),
          ),
        };
      })() : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    if (!this.validateConfig()) throw new Error('Gemini API key is required');
    const response = await this.request(this.endpoint('generateContent'), {
      method: 'POST',
      headers: this.requestHeaders(),
      body: serializeProviderBody(this.buildBody(messages, options)),
      signal: options?.signal,
    });
    if (!response.ok) rejectProviderResponse(response, `Gemini API error (${response.status}).`);
    return this.normalize(await readProviderJson<GeminiResponse>(response));
  }

  async streamChat(
    messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    try {
      if (!this.validateConfig()) throw new Error('Gemini API key is required');
      const response = await this.request(this.endpoint('streamGenerateContent'), {
        method: 'POST',
        headers: this.requestHeaders(),
        body: serializeProviderBody(this.buildBody(messages, options)),
        signal: options?.signal,
      });
      if (!response.ok) rejectProviderResponse(response, `Gemini API error (${response.status}).`);
      if (!response.body) throw new Error('Gemini streaming response has no body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      let content = '';
      let outputBytes = 0;
      let transportBytes = 0;
      let streamEvents = 0;
      const toolCalls: ToolCall[] = [];
      let usage: ChatResponse['usage'];

      const consume = async (record: string): Promise<void> => {
        const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') return;
        if (++streamEvents > MAX_PROVIDER_STREAM_EVENTS) {
          throw new Error('The provider response exceeded its event limit.');
        }
        const eventBytes = Buffer.byteLength(data);
        if (eventBytes > MAX_PROVIDER_STREAM_EVENT_BYTES
          || outputBytes + eventBytes > MAX_PROVIDER_STREAM_OUTPUT_BYTES) {
          throw new Error('The provider response exceeded the output limit.');
        }
        outputBytes += eventBytes;
        let parsed: GeminiResponse;
        try { parsed = JSON.parse(data) as GeminiResponse; }
        catch { throw new Error('The provider streaming response was invalid.'); }
        const normalized = this.normalize(parsed);
        if (normalized.content) {
          content += normalized.content;
          await onChunk(normalized.content, { type: 'text_delta', data: normalized.content });
        }
        for (const call of normalized.toolCalls ?? []) {
          if (toolCalls.length >= MAX_PROVIDER_STREAM_TOOL_CALLS) {
            throw new Error('The provider response exceeded the tool-call limit.');
          }
          toolCalls.push(call);
        }
        if (normalized.usage) usage = normalized.usage;
      };

      try {
        while (true) {
        const { done, value } = await reader.read();
        if (!done) transportBytes += value.byteLength;
        if (!done && (value.byteLength > MAX_PROVIDER_STREAM_EVENT_BYTES
          || transportBytes > MAX_PROVIDER_STREAM_TRANSPORT_BYTES)) {
          throw new Error('The provider streaming event exceeded the output limit.');
        }
        buffer += decoder.decode(value, { stream: !done });
        if (Buffer.byteLength(buffer) > MAX_PROVIDER_STREAM_EVENT_BYTES) {
          throw new Error('The provider streaming event exceeded the output limit.');
        }
        const records = buffer.split(/\r?\n\r?\n/);
        buffer = records.pop() ?? '';
        for (const record of records) await consume(record);
        if (done) break;
      }
      if (buffer.trim()) await consume(buffer);
      for (const call of toolCalls) await onChunk('', { type: 'tool_call', data: call });
        onComplete?.({ content, model: String(this.config.model), usage, toolCalls: toolCalls.length ? toolCalls : undefined });
      } finally {
        void reader.cancel('provider-stream-finished').catch(() => undefined);
        try { reader.releaseLock(); } catch { /* A hostile pending read may retain the lock. */ }
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      onError?.(normalized);
      if (!onError) throw normalized;
    }
  }
}

/** Google Vertex AI variant using an OAuth access token. */
export class VertexGeminiProvider extends GeminiProvider {
  constructor(config: ProviderConfig) {
    const project = String(config.project || process.env.GOOGLE_CLOUD_PROJECT || '');
    const location = String(config.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1');
    const baseUrl = config.baseUrl
      || `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google`;
    super({ ...config, type: ProviderType.VERTEX, baseUrl });
  }

  protected endpoint(method: 'generateContent' | 'streamGenerateContent'): string {
    const model = String(this.config.model || 'gemini-2.0-flash').replace(/^models\//, '');
    const suffix = method === 'streamGenerateContent' ? '?alt=sse' : '';
    return `${String(this.config.baseUrl).replace(/\/$/, '')}/models/${encodeURIComponent(model)}:${method}${suffix}`;
  }

  protected requestHeaders(): Record<string, string> {
    return {
      ...configuredHeaders(this.config),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }
}

interface BedrockResponse {
  output?: { message?: { content?: Array<{
    text?: string;
    toolUse?: { toolUseId: string; name: string; input: unknown };
  }> } };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/** AWS Bedrock Converse provider with native SigV4 authentication. */
export class BedrockProvider extends AiProvider {
  private readonly region: string;

  constructor(config: ProviderConfig) {
    super({
      ...config,
      type: ProviderType.BEDROCK,
      model: config.model || 'anthropic.claude-3-haiku-20240307-v1:0',
      accessKeyId: config.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: config.sessionToken || process.env.AWS_SESSION_TOKEN,
    });
    this.region = String(config.region || process.env.AWS_REGION || 'us-east-1');
  }

  validateConfig(): boolean {
    return Boolean(this.config.accessKeyId && this.config.secretAccessKey);
  }

  private requestBody(messages: Message[], options?: ChatOptions): Record<string, unknown> {
    const system = [options?.systemPrompt, ...messages.filter(message => message.role === 'system').map(message => message.content)]
      .filter(Boolean).map(text => ({ text }));
    const mapped = messages.filter(message => message.role !== 'system').map(message => {
      if (message.role === 'tool') {
        return { role: 'user', content: [{ toolResult: {
          toolUseId: message.toolCallId,
          content: [{ text: message.content }],
          status: message.isError ? 'error' : 'success',
        } }] };
      }
      return {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: [
          ...(message.content ? [{ text: message.content }] : []),
          ...(message.toolCalls ?? []).map(call => ({ toolUse: {
            toolUseId: call.id, name: call.name, input: call.input,
          } })),
        ],
      };
    });
    return {
      messages: mapped,
      ...(system.length ? { system } : {}),
      inferenceConfig: {
        ...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      },
      ...(options?.tools?.length ? { toolConfig: { tools: options.tools.map(tool => ({ toolSpec: {
        name: tool.name, description: tool.description, inputSchema: { json: tool.parameters },
      } })) } } : {}),
    };
  }

  private async signedHeaders(url: URL, body: string, now = new Date()): Promise<Record<string, string>> {
    const { createHash, createHmac } = await import('node:crypto');
    const accessKey = String(this.config.accessKeyId);
    const secret = String(this.config.secretAccessKey);
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (this.config.sessionToken) headers['x-amz-security-token'] = String(this.config.sessionToken);
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map(name => `${name}:${headers[name].trim()}\n`).join('');
    const canonicalRequest = ['POST', url.pathname, url.searchParams.toString(), canonicalHeaders, names.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.region}/bedrock/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const hmac = (key: Buffer | string, value: string): Buffer => createHmac('sha256', key).update(value).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), this.region), 'bedrock'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    return headers;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    if (!this.validateConfig()) throw new Error('AWS Bedrock credentials are required');
    const model = encodeURIComponent(String(this.config.model));
    const url = new URL(String(this.config.baseUrl || `https://bedrock-runtime.${this.region}.amazonaws.com/model/${model}/converse`));
    const body = serializeProviderBody(this.requestBody(messages, options));
    const response = await this.request(url, {
      method: 'POST', headers: await this.signedHeaders(url, body), body, signal: options?.signal,
    });
    if (!response.ok) rejectProviderResponse(response, `Bedrock API error (${response.status}).`);
    const data = await readProviderJson<BedrockResponse>(response);
    const token = (value: unknown): number => (
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
        : 0
    );
    const blocks = data.output?.message?.content ?? [];
    if (!Array.isArray(blocks) || blocks.length > MAX_PROVIDER_STREAM_TOOL_CALLS) {
      throw new Error('The provider response exceeded the content-block limit.');
    }
    const content = blocks.map(block => block.text ?? '').join('');
    const toolCalls = blocks.flatMap(block => block.toolUse ? [{
      id: block.toolUse.toolUseId, name: block.toolUse.name, input: block.toolUse.input,
    }] : []);
    return {
      content,
      model: String(this.config.model),
      usage: data.usage ? (() => {
        const prompt = token(data.usage?.inputTokens);
        const completion = token(data.usage?.outputTokens);
        return {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: Math.min(
            Number.MAX_SAFE_INTEGER,
            Math.max(token(data.usage?.totalTokens), prompt + completion),
          ),
        };
      })() : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    try {
      const response = await this.chat(messages, options);
      if (response.content) await onChunk(response.content, { type: 'text_delta', data: response.content });
      for (const call of response.toolCalls ?? []) await onChunk('', { type: 'tool_call', data: call });
      onComplete?.(response);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      onError?.(normalized);
      if (!onError) throw normalized;
    }
  }
}

// ===================================================================
// Anthropic Provider (real implementation)
// ===================================================================

export class AnthropicProvider extends AiProvider {
  private readonly baseUrl: string;
  static readonly DEFAULT_BASE_URL = 'https://api.anthropic.com';
  static readonly API_VERSION = '2023-06-01';

  constructor(config: ProviderConfig) {
    super(config);
    this.baseUrl = config.baseUrl || AnthropicProvider.DEFAULT_BASE_URL;
  }

  validateConfig(): boolean {
    return !!this.config.apiKey;
  }

  async getAvailableModels(): Promise<string[]> {
    const response = await this.request(`${this.baseUrl}/v1/models`, {
      headers: {
        ...configuredHeaders(this.config),
        'x-api-key': String(this.config.apiKey),
        'anthropic-version': AnthropicProvider.API_VERSION,
      },
    });
    if (!response.ok) rejectProviderResponse(response, `Model discovery failed (${response.status}).`);
    const data = await readProviderJson<{ data?: Array<{ id?: unknown }> }>(response);
    return boundedModelIds(data.data, model => (model as { id?: unknown })?.id);
  }

  private buildAnthropicMessages(messages: Message[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
    return messages.filter(message => message.role !== 'system').map(message => {
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
            ...(message.isError ? { is_error: true } : {}),
          }],
        };
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...message.toolCalls.map(call => ({
              type: 'tool_use', id: call.id, name: call.name, input: call.input,
            })),
          ],
        };
      }
      const images = messageImages(message).flatMap(image => {
        const data = parseDataImage(image.url);
        return data ? [{ type: 'image', source: { type: 'base64', media_type: data.mediaType, data: data.data } }] : [];
      });
      return {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: images.length ? [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...images,
        ] : message.content,
      };
    });
  }

  async chat(
    messages: Message[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    if (!this.validateConfig()) {
      throw new Error('Anthropic API key is required');
    }

    const model = options?.model || (this.config.model as string) || 'claude-3-haiku-20240307';

    const systemPrompt = options?.systemPrompt || '';
    const anthropicMessages = this.buildAnthropicMessages(messages);

    // Handle the case where first user message should be preceded by system prompt in messages
    const bodyMessages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [...anthropicMessages];
    if (systemPrompt && bodyMessages.length > 0 && bodyMessages[0].role === 'user') {
      // Insert a system-like context at the beginning for Anthropic's message format
      // Anthropic uses top-level `system` field, not in messages array
    }

    const body: Record<string, unknown> = {
      model,
      messages: bodyMessages.length > 0 ? bodyMessages : [{ role: 'user', content: 'Hello' }],
      max_tokens: options?.maxTokens ?? 1024,
      stream: false,
    };

    if (systemPrompt) body.system = systemPrompt;
    if (options?.temperature !== undefined && (!options.thinking || options.thinking === 'off')) body.temperature = options.temperature;
    if (options?.thinking && options.thinking !== 'off') {
      const budgets = {
        minimal: 512, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768,
      } as const;
      body.thinking = { type: 'enabled', budget_tokens: budgets[options.thinking] };
      body.max_tokens = Math.max(Number(body.max_tokens), budgets[options.thinking] + 1024);
    }
    if (options?.tools?.length) {
      body.tools = options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const response = await this.request(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        ...configuredHeaders(this.config),
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey as string,
        'anthropic-version': AnthropicProvider.API_VERSION,
      },
      body: serializeProviderBody(body),
      signal: options?.signal,
    });

    if (!response.ok) rejectProviderResponse(response, `Anthropic API error (${response.status}).`);

    const data = await readProviderJson<AnthropicResponse>(response);
    const token = (value: unknown): number => (
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
        : 0
    );
    if (data.content && (!Array.isArray(data.content) || data.content.length > MAX_PROVIDER_STREAM_TOOL_CALLS)) {
      throw new Error('The provider response exceeded the content-block limit.');
    }
    const contentBlock = data.content?.find(c => c.type === 'text') as AnthropicTextContent | undefined;
    const reasoning = data.content
      ?.filter((block): block is AnthropicThinkingContent => block.type === 'thinking')
      .map(block => block.thinking ?? '')
      .join('');
    const toolCalls = data.content
      ?.filter((block): block is AnthropicToolUseContent => block.type === 'tool_use')
      .map(block => ({ id: block.id, name: block.name, input: block.input }));
    if (!contentBlock && !toolCalls?.length) {
      throw new Error('No text or tool content in Anthropic response');
    }

    return {
      content: contentBlock?.text || '',
      ...(reasoning ? { reasoning } : {}),
      model: data.model,
      usage: data.usage ? (() => {
        const prompt = token(data.usage?.input_tokens);
        const completion = token(data.usage?.output_tokens);
        const cacheRead = token(data.usage?.cache_read_input_tokens);
        const cacheWrite = token(data.usage?.cache_creation_input_tokens);
        return {
          promptTokens: prompt,
          completionTokens: completion,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          totalTokens: Math.min(Number.MAX_SAFE_INTEGER, prompt + completion + cacheRead + cacheWrite),
        };
      })() : undefined,
      toolCalls,
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    if (!this.validateConfig()) {
      throw new Error('Anthropic API key is required');
    }

    const model = options?.model || (this.config.model as string) || 'claude-3-haiku-20240307';
    const url = `${this.baseUrl}/v1/messages`;

    const systemPrompt = options?.systemPrompt || '';
    const anthropicMessages = this.buildAnthropicMessages(messages);

    let bodyMessages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [...anthropicMessages];
    if (bodyMessages.length === 0) {
      bodyMessages = [{ role: 'user', content: 'Hello' }];
    }

    const body: Record<string, unknown> = {
      model,
      messages: bodyMessages,
      max_tokens: options?.maxTokens ?? 1024,
      stream: true,
    };

    if (systemPrompt) body.system = systemPrompt;
    if (options?.temperature !== undefined && (!options.thinking || options.thinking === 'off')) body.temperature = options.temperature;
    if (options?.thinking && options.thinking !== 'off') {
      const budgets = {
        minimal: 512, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768,
      } as const;
      body.thinking = { type: 'enabled', budget_tokens: budgets[options.thinking] };
      body.max_tokens = Math.max(Number(body.max_tokens), budgets[options.thinking] + 1024);
    }
    if (options?.tools?.length) {
      body.tools = options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    try {
      const response = await this.request(url, {
        method: 'POST',
        headers: {
          ...configuredHeaders(this.config),
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey as string,
          'anthropic-version': AnthropicProvider.API_VERSION,
        },
        body: serializeProviderBody(body),
        signal: options?.signal,
      });

      if (!response.ok) rejectProviderResponse(response, `Anthropic API error (${response.status}).`);

      let fullContent = '';
      let fullReasoning = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let outputBytes = 0;
      let transportBytes = 0;
      let streamEvents = 0;
      const token = (value: unknown): number => (
        typeof value === 'number' && Number.isFinite(value) && value > 0
          ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
          : 0
      );
      const toolCallFragments = new Map<number, { id: string; name: string; json: string }>();

      if (!response.body) throw new Error('Anthropic streaming response has no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';

      try {
        while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        transportBytes += value.byteLength;
        if (value.byteLength > MAX_PROVIDER_STREAM_EVENT_BYTES
          || transportBytes > MAX_PROVIDER_STREAM_TRANSPORT_BYTES) {
          throw new Error('The provider streaming event exceeded the output limit.');
        }

        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer) > MAX_PROVIDER_STREAM_EVENT_BYTES) {
          throw new Error('The provider streaming event exceeded the output limit.');
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (++streamEvents > MAX_PROVIDER_STREAM_EVENTS) {
            throw new Error('The provider response exceeded its event limit.');
          }
          const eventBytes = Buffer.byteLength(dataStr);
          if (eventBytes > MAX_PROVIDER_STREAM_EVENT_BYTES
            || outputBytes + eventBytes > MAX_PROVIDER_STREAM_OUTPUT_BYTES) {
            throw new Error('The provider response exceeded the output limit.');
          }
          outputBytes += eventBytes;
          let eventData: AnthropicStreamEvent;
          try { eventData = JSON.parse(dataStr) as AnthropicStreamEvent; }
          catch { throw new Error('The provider streaming response was invalid.'); }

          switch (eventData.type) {
            case 'content_block_start': {
              if (eventData.content_block?.type === 'tool_use') {
                if (!Number.isSafeInteger(eventData.index) || eventData.index < 0
                  || eventData.index >= MAX_PROVIDER_STREAM_TOOL_CALLS
                  || typeof eventData.content_block.id !== 'string'
                  || typeof eventData.content_block.name !== 'string') {
                  throw new Error('The provider response exceeded the tool-call limit.');
                }
                if (!toolCallFragments.has(eventData.index)
                  && toolCallFragments.size >= MAX_PROVIDER_STREAM_TOOL_CALLS) {
                  throw new Error('The provider response exceeded the tool-call limit.');
                }
                toolCallFragments.set(eventData.index, {
                  id: eventData.content_block.id,
                  name: eventData.content_block.name,
                  json: '',
                });
              }
              break;
            }
            case 'content_block_delta': {
              const delta = eventData.delta;
              if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
                fullContent += delta.text;
                await onChunk(delta.text, { type: 'text_delta', data: eventData });
              } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
                fullReasoning += delta.thinking;
                await onChunk('', { type: 'reasoning_delta', data: { content: delta.thinking } });
              } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                const fragment = toolCallFragments.get(eventData.index);
                if (fragment) fragment.json += delta.partial_json;
              }
              break;
            }
            case 'message_start': {
              const msgStart = eventData.message as AnthropicStreamMessage | undefined;
              if (msgStart?.usage) {
                cacheReadTokens = token(msgStart.usage.cache_read_input_tokens);
                cacheWriteTokens = token(msgStart.usage.cache_creation_input_tokens);
                inputTokens = token(msgStart.usage.input_tokens);
              }
              await onChunk('', { type: 'message_start', data: eventData });
              break;
            }
            case 'message_delta': {
              if (eventData.usage) outputTokens = token(eventData.usage.output_tokens);
              break;
            }
            case 'error':
              throw new Error('Anthropic streaming error.');
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) throw new Error('The provider streaming response was invalid.');

      const toolCalls = [...toolCallFragments.values()].map(fragment => {
        let input: unknown = {};
        try {
          input = JSON.parse(fragment.json || '{}');
        } catch {
          input = { raw: fragment.json };
        }
        return { id: fragment.id, name: fragment.name, input };
      });
      for (const call of toolCalls) await onChunk('', { type: 'tool_call', data: call });
        onComplete?.({
          content: fullContent,
          ...(fullReasoning ? { reasoning: fullReasoning } : {}),
          model,
          usage: inputTokens > 0 || outputTokens > 0 ? {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens: Math.min(
              Number.MAX_SAFE_INTEGER,
              inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
            ),
          } : undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined,
        });
      } finally {
        void reader.cancel('provider-stream-finished').catch(() => undefined);
        try { reader.releaseLock(); } catch { /* A hostile pending read may retain the lock. */ }
      }
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// Anthropic internal types
interface AnthropicResponse {
  id?: string;
  type?: string;
  model?: string;
  content?: Array<AnthropicTextContent | AnthropicThinkingContent | AnthropicToolUseContent>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface AnthropicTextContent {
  type: 'text';
  text?: string;
}

interface AnthropicThinkingContent {
  type: 'thinking';
  thinking?: string;
}

interface AnthropicToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

type AnthropicStreamEvent = AnthropicMessageStart | AnthropicContentBlockStart | AnthropicContentDelta | AnthropicMessageDelta | AnthropicErrorEvent;

interface AnthropicMessageStart {
  type: 'message_start';
  message: AnthropicStreamMessage;
}

interface AnthropicStreamMessage {
  id?: string;
  type?: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface AnthropicContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicToolUseContent | AnthropicTextContent | AnthropicThinkingContent;
}

interface AnthropicContentDelta {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'signature_delta'; signature: string }
    | { type: 'input_json_delta'; partial_json: string };
}

interface AnthropicMessageDelta {
  type: 'message_delta';
  usage?: { output_tokens?: number };
  stop_reason?: string | null;
}

interface AnthropicErrorEvent {
  type: 'error';
  error?: { type: string; message: string };
}

// ===================================================================
// Mock Provider (for testing without real API keys)
// ===================================================================

export class MockProvider extends AiProvider {
  private readonly _responses: string[] = [];
  private _responseIndex = 0;

  constructor(config: ProviderConfig, responses?: string[]) {
    super({ ...config, type: ProviderType.MOCK });
    if (responses) {
      this._responses.push(...responses);
    }
  }

  /** Add a response for the mock to return */
  addResponse(response: string): void {
    this._responses.push(response);
  }

  /** Reset responses and index */
  reset(): void {
    this._responseIndex = 0;
  }

  validateConfig(): boolean {
    return true; // Mock always validates
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    if (options?.signal?.aborted) throw new Error('Request aborted');
    const content = this.getNextMockResponse();
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
    if (options?.signal?.aborted) throw new Error('Request aborted');
    return {
      content,
      model: 'mock-model',
      usage: { promptTokens: messages.length * 10, completionTokens: content.length / 4, totalTokens: messages.length * 10 + content.length / 4 },
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: StreamChunkCallback,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    try {
      if (options?.signal?.aborted) throw new Error('Request aborted');
      const content = this.getNextMockResponse();

      // Emit message_start event
      await onChunk('', { type: 'message_start', data: { mock: true } });

      // Stream the response character by character
      for (let i = 0; i < content.length; i++) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 15 + 5));
        if (options?.signal?.aborted) throw new Error('Request aborted');
        await onChunk(content[i], { type: 'text_delta', data: { index: i } });
      }

      onComplete?.({
        content,
        model: 'mock-model',
        usage: { promptTokens: messages.length * 10, completionTokens: content.length / 4, totalTokens: messages.length * 10 + content.length / 4 },
      });
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private getNextMockResponse(): string {
    if (this._responses.length === 0) {
      // Default mock response based on last user message
      return '[Mock AI Response]';
    }
    const response = this._responses[this._responseIndex % this._responses.length];
    this._responseIndex++;
    return response;
  }

  /** Get the number of times chat was called */
  getCallCount(): number {
    return this._responseIndex;
  }
}
