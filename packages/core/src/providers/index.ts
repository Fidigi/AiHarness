// ============================================================
// AI Provider Interface & Real Implementations
// Features: real API integration, SSE streaming, retry with backoff,
// token usage tracking, model registry
// ============================================================

import { Message, ProviderConfig, ProviderType, ToolCall } from '../types/index.js';
import { fetchWithRetry, RetryOptions } from '../utils/index.js';

// ===================================================================
// Streaming event types
// ===================================================================

export interface StreamEvent {
  type: 'text_delta' | 'tool_call' | 'message_start' | 'message_end' | 'error' | 'done';
  data?: unknown;
}

export interface ChatResponse {
  content: string;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  toolCalls?: ToolCall[];
}

// ===================================================================
// Abstract base class
// ===================================================================

/** Abstract interface for all AI providers */
export abstract class AiProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /** Send messages and get a response (non-streaming) */
  abstract chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;

  /** Stream a response (for real-time output) */
  abstract streamChat(
    messages: Message[],
    onChunk: (chunk: string, event?: StreamEvent) => void,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void>;

  /** Validate provider configuration */
  abstract validateConfig(): boolean;

  /** Get the list of available models (if supported) */
  async getAvailableModels?(): Promise<string[]> {
    return undefined as unknown as string[];
  }
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

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
    return this.azure
      ? { 'Content-Type': 'application/json', 'api-key': String(this.config.apiKey) }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` };
  }

  validateConfig(): boolean {
    return !!this.config.apiKey;
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
      return { role: message.role, content: message.content };
    });
  }

  private parseToolCalls(toolCalls?: OpenAiToolCall[]): ToolCall[] | undefined {
    if (!toolCalls?.length) return undefined;
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

    // Retry configuration for OpenAI API calls
    const retryOptions: RetryOptions = {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
      backoffMultiplier: 2,
      retryableStatuses: [429, 500, 502, 503, 504],
    };

    // Build messages, prepending system prompt if provided
    let finalMessages = this.buildMessages(messages);
    if (options?.systemPrompt) {
      finalMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const response = await fetchWithRetry(
      this.getChatUrl(),
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model,
          messages: finalMessages,
          stream: false,
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(options?.thinking && options.thinking !== 'off' ? {
            reasoning_effort: options.thinking === 'xhigh' ? 'high' : options.thinking,
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
      },
      { retryOptions }
    );

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
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      } : undefined,
      toolCalls: this.parseToolCalls(choice.message.tool_calls),
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: (chunk: string, event?: StreamEvent) => void,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    if (!this.validateConfig()) {
      throw new Error('OpenAI API key is required');
    }

    const model = options?.model || (this.config.model as string) || 'gpt-4o';

    // Retry configuration for initial connection
    const retryOptions: RetryOptions = {
      maxRetries: 2,
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
      retryableStatuses: [429, 500, 502, 503, 504],
    };

    const body: Record<string, unknown> = {
      model,
      messages: this.buildMessages(messages),
      stream: true,
    };

    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options?.thinking && options.thinking !== 'off') {
      body.reasoning_effort = options.thinking === 'xhigh' ? 'high' : options.thinking;
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
      // Wrap the initial fetch with retry (for connection errors only)
      const response = await fetchWithRetry(
        this.getChatUrl(),
        {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(body),
          signal: options?.signal,
        },
        { retryOptions }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
      }
      if (!response.body) throw new Error('OpenAI streaming response has no body');

      let fullContent = '';
      let totalTokens = 0;
      const toolCallFragments = new Map<number, OpenAiToolCall>();
      const collectToolCalls = (): ToolCall[] | undefined =>
        this.parseToolCalls([...toolCallFragments.entries()].sort(([a], [b]) => a - b).map(([, call]) => call));
      const reader = response.body.getReader();
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

          const dataStr = trimmed.slice(6); // Remove "data: " prefix
          if (dataStr === '[DONE]') {
            const toolCalls = collectToolCalls();
            for (const call of toolCalls ?? []) onChunk('', { type: 'tool_call', data: call });
            onComplete?.({
              content: fullContent,
              usage: totalTokens > 0 ? { promptTokens: 0, completionTokens: totalTokens, totalTokens } : undefined,
              toolCalls,
            });
            return;
          }

          try {
            const data = JSON.parse(dataStr) as OpenAiStreamChunk;
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) {
              fullContent += delta.content;
              onChunk(delta.content, { type: 'text_delta', data });
            }
            for (const fragment of delta?.tool_calls ?? []) {
              const existing = toolCallFragments.get(fragment.index) ?? {
                id: fragment.id || `tool-${fragment.index}`,
                type: 'function' as const,
                function: { name: '', arguments: '' },
              };
              if (fragment.id) existing.id = fragment.id;
              if (fragment.function?.name) existing.function.name += fragment.function.name;
              if (fragment.function?.arguments) existing.function.arguments += fragment.function.arguments;
              toolCallFragments.set(fragment.index, existing);
            }

            // Track token usage from the last chunk
            if (data.usage) {
              totalTokens = data.usage.completion_tokens ?? 0;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      const toolCalls = collectToolCalls();
      for (const call of toolCalls ?? []) onChunk('', { type: 'tool_call', data: call });
      onComplete?.({
        content: fullContent,
        usage: totalTokens > 0 ? { promptTokens: 0, completionTokens: totalTokens, totalTokens } : undefined,
        toolCalls,
      });
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
      apiKey: config.apiKey || 'local',
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
    try {
      const response = await fetch(`${this.localBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey || 'local'}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return [];

      const payload = await response.json() as {
        data?: Array<{ id?: string }>;
        models?: Array<{ name?: string; model?: string }>;
      };
      const openAiModels = payload.data?.map(item => item.id).filter((id): id is string => Boolean(id)) ?? [];
      const ollamaModels = payload.models
        ?.map(item => item.name || item.model)
        .filter((id): id is string => Boolean(id)) ?? [];
      return [...new Set([...openAiModels, ...ollamaModels])];
    } catch {
      return [];
    }
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
    message: { role: string; content: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
    delta: { role?: string; content?: string; tool_calls?: OpenAiStreamToolCallFragment[] };
    finish_reason?: string | null;
  }>;
  usage?: { completion_tokens?: number };
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
    totalTokenCount?: number;
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

  protected endpoint(method: 'generateContent' | 'streamGenerateContent'): string {
    const model = String(this.config.model || 'gemini-2.0-flash').replace(/^models\//, '');
    const suffix = method === 'streamGenerateContent' ? '?alt=sse&' : '?';
    return `${this.baseUrl}/models/${encodeURIComponent(model)}:${method}${suffix}key=${encodeURIComponent(String(this.config.apiKey || ''))}`;
  }

  protected requestHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
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
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      return { role: message.role === 'assistant' ? 'model' : 'user', parts };
    });
    const thinkingBudgets = { low: 1024, medium: 4096, high: 8192, xhigh: 16384 } as const;
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options?.thinking && options.thinking !== 'off'
          ? { thinkingConfig: { thinkingBudget: thinkingBudgets[options.thinking] } }
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
    if (response.error?.message) throw new Error(`Gemini API error: ${response.error.message}`);
    const parts = response.candidates?.[0]?.content?.parts ?? [];
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
      usage: usage ? {
        promptTokens: usage.promptTokenCount ?? 0,
        completionTokens: usage.candidatesTokenCount ?? 0,
        totalTokens: usage.totalTokenCount ?? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
      } : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    if (!this.validateConfig()) throw new Error('Gemini API key is required');
    const response = await fetchWithRetry(this.endpoint('generateContent'), {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(this.buildBody(messages, options)),
      signal: options?.signal,
    }, { retryOptions: { maxRetries: options?.maxRetries ?? 3 } });
    if (!response.ok) throw new Error(`Gemini API error (${response.status}): ${await response.text()}`);
    return this.normalize(await response.json() as GeminiResponse);
  }

  async streamChat(
    messages: Message[],
    onChunk: (chunk: string, event?: StreamEvent) => void,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    try {
      if (!this.validateConfig()) throw new Error('Gemini API key is required');
      const response = await fetchWithRetry(this.endpoint('streamGenerateContent'), {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify(this.buildBody(messages, options)),
        signal: options?.signal,
      }, { retryOptions: { maxRetries: options?.maxRetries ?? 3 } });
      if (!response.ok) throw new Error(`Gemini API error (${response.status}): ${await response.text()}`);
      if (!response.body) throw new Error('Gemini streaming response has no body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      const toolCalls: ToolCall[] = [];
      let usage: ChatResponse['usage'];

      const consume = (record: string): void => {
        const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') return;
        const normalized = this.normalize(JSON.parse(data) as GeminiResponse);
        if (normalized.content) {
          content += normalized.content;
          onChunk(normalized.content, { type: 'text_delta', data: normalized.content });
        }
        for (const call of normalized.toolCalls ?? []) toolCalls.push(call);
        if (normalized.usage) usage = normalized.usage;
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const records = buffer.split(/\r?\n\r?\n/);
        buffer = records.pop() ?? '';
        for (const record of records) consume(record);
        if (done) break;
      }
      if (buffer.trim()) consume(buffer);
      for (const call of toolCalls) onChunk('', { type: 'tool_call', data: call });
      onComplete?.({ content, model: String(this.config.model), usage, toolCalls: toolCalls.length ? toolCalls : undefined });
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
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` };
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
    const body = JSON.stringify(this.requestBody(messages, options));
    const response = await fetchWithRetry(url.toString(), {
      method: 'POST', headers: await this.signedHeaders(url, body), body, signal: options?.signal,
    }, { retryOptions: { maxRetries: options?.maxRetries ?? 3 } });
    if (!response.ok) throw new Error(`Bedrock API error (${response.status}): ${await response.text()}`);
    const data = await response.json() as BedrockResponse;
    const blocks = data.output?.message?.content ?? [];
    const content = blocks.map(block => block.text ?? '').join('');
    const toolCalls = blocks.flatMap(block => block.toolUse ? [{
      id: block.toolUse.toolUseId, name: block.toolUse.name, input: block.toolUse.input,
    }] : []);
    return {
      content,
      model: String(this.config.model),
      usage: data.usage ? {
        promptTokens: data.usage.inputTokens ?? 0,
        completionTokens: data.usage.outputTokens ?? 0,
        totalTokens: data.usage.totalTokens ?? (data.usage.inputTokens ?? 0) + (data.usage.outputTokens ?? 0),
      } : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: (chunk: string, event?: StreamEvent) => void,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    try {
      const response = await this.chat(messages, options);
      if (response.content) onChunk(response.content, { type: 'text_delta', data: response.content });
      for (const call of response.toolCalls ?? []) onChunk('', { type: 'tool_call', data: call });
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
      return {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
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

    // Retry configuration for Anthropic API calls
    const retryOptions: RetryOptions = {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
      backoffMultiplier: 2,
      retryableStatuses: [429, 500, 502, 503, 504],
    };

    const systemPrompt = options?.systemPrompt || '';
    const anthropicMessages = this.buildAnthropicMessages(messages);

    // Handle the case where first user message should be preceded by system prompt in messages
    let bodyMessages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [...anthropicMessages];
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
      const budgets = { low: 1024, medium: 4096, high: 8192, xhigh: 16384 } as const;
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

    const response = await fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey as string,
          'anthropic-version': AnthropicProvider.API_VERSION,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      { retryOptions }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as AnthropicResponse;
    const contentBlock = data.content?.find(c => c.type === 'text') as AnthropicTextContent | undefined;
    const toolCalls = data.content
      ?.filter((block): block is AnthropicToolUseContent => block.type === 'tool_use')
      .map(block => ({ id: block.id, name: block.name, input: block.input }));
    if (!contentBlock && !toolCalls?.length) {
      throw new Error('No text or tool content in Anthropic response');
    }

    return {
      content: contentBlock?.text || '',
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens ?? 0,
        completionTokens: data.usage.output_tokens ?? 0,
        totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      } : undefined,
      toolCalls,
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: (chunk: string, event?: StreamEvent) => void,
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
      const budgets = { low: 1024, medium: 4096, high: 8192, xhigh: 16384 } as const;
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
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey as string,
          'anthropic-version': AnthropicProvider.API_VERSION,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
      }

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      const toolCallFragments = new Map<number, { id: string; name: string; json: string }>();

      if (!response.body) throw new Error('Anthropic streaming response has no body');
      const reader = response.body.getReader();
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
          if (!trimmed.startsWith('event: ') && !trimmed.startsWith('data: ')) continue;

          // Skip event type lines, we handle data directly
          if (trimmed.startsWith('event: ')) continue;

          const dataStr = trimmed.slice(6); // Remove "data: " prefix
          try {
            const eventData = JSON.parse(dataStr) as AnthropicStreamEvent;

            switch (eventData.type) {
              case 'content_block_start': {
                if (eventData.content_block.type === 'tool_use') {
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
                if (delta.type === 'text_delta' && delta.text) {
                  fullContent += delta.text;
                  onChunk(delta.text, { type: 'text_delta', data: eventData });
                } else if (delta.type === 'input_json_delta') {
                  const fragment = toolCallFragments.get(eventData.index);
                  if (fragment) fragment.json += delta.partial_json;
                }
                break;
              }
              case 'message_start': {
                const msgStart = eventData.message as AnthropicStreamMessage | undefined;
                if (msgStart?.usage) {
                  inputTokens = msgStart.usage.input_tokens ?? 0;
                }
                onChunk('', { type: 'message_start', data: eventData });
                break;
              }
              case 'message_delta': {
                if (eventData.usage) {
                  outputTokens = eventData.usage.output_tokens ?? 0;
                }
                break;
              }
              case 'error': {
                const errData = eventData as AnthropicErrorEvent;
                onError?.(new Error(errData.error?.message || 'Unknown Anthropic streaming error'));
                return;
              }
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      const toolCalls = [...toolCallFragments.values()].map(fragment => {
        let input: unknown = {};
        try {
          input = JSON.parse(fragment.json || '{}');
        } catch {
          input = { raw: fragment.json };
        }
        return { id: fragment.id, name: fragment.name, input };
      });
      for (const call of toolCalls) onChunk('', { type: 'tool_call', data: call });
      onComplete?.({
        content: fullContent,
        usage: inputTokens > 0 || outputTokens > 0 ? {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        } : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      });
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
  content?: Array<AnthropicTextContent | AnthropicToolUseContent>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicTextContent {
  type: 'text';
  text?: string;
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
  usage?: { input_tokens?: number };
}

interface AnthropicContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicToolUseContent | AnthropicTextContent;
}

interface AnthropicContentDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
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
    onChunk: (chunk: string, event?: StreamEvent) => void,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    try {
      if (options?.signal?.aborted) throw new Error('Request aborted');
      const content = this.getNextMockResponse();

      // Emit message_start event
      onChunk('', { type: 'message_start', data: { mock: true } });

      // Stream the response character by character
      for (let i = 0; i < content.length; i++) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 15 + 5));
        if (options?.signal?.aborted) throw new Error('Request aborted');
        onChunk(content[i], { type: 'text_delta', data: { index: i } });
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
