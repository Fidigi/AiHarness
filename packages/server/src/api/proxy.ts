// ============================================================
// AI Provider API Proxy - Proxies requests to real AI APIs with SSE streaming
// ============================================================

import { Request, Response } from 'express';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AnthropicProvider as CoreAnthropicProvider,
  atomicWriteStableFile,
  BedrockProvider,
  closeProviderNetworkDispatchers,
  createProviderNetworkScope,
  CredentialRedactor,
  GeminiProvider,
  LocalProvider,
  MockProvider,
  normalizeProviderUsage,
  OpenAiProvider as CoreOpenAiProvider,
  PROVIDER_NETWORK_SCOPE,
  ProviderType,
  readBoundedResourceText,
  VertexGeminiProvider,
} from '@ai-harness/core';
import type {
  AgentProviderNetworkSettings,
  AiProvider,
  ChatOptions,
  Message,
  ModelPricing,
  ProviderConfig,
  ProviderNetworkScope,
} from '@ai-harness/core';

/** Configuration for the proxy server */
export interface ProxyServerConfig {
  /** Default timeout in milliseconds */
  timeout?: number;
  /** Explicit opt-in for the deterministic, credential-free test/demo provider. */
  enableMockProvider?: boolean;
  /** Shared provider network policy; URLs and proxy credentials are never exposed. */
  network?: AgentProviderNetworkSettings;
  /** Shared process-local scrubber for HTTP, WebSocket and log boundaries. */
  redactor?: CredentialRedactor;
}

export type ProxyChatOptions = ChatOptions & { stream?: boolean };

const UNSAFE_OPTION_IDENTIFIER = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;

function boundedToolSchema(value: unknown): Record<string, unknown> | undefined {
  let nodes = 0;
  let stringBytes = 0;
  const clone = (input: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 32) throw new Error('invalid-schema');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('invalid-schema');
      return input;
    }
    if (typeof input === 'string') {
      stringBytes += Buffer.byteLength(input);
      if (stringBytes > 4 * 1024 * 1024) throw new Error('invalid-schema');
      return input;
    }
    if (!input || typeof input !== 'object') throw new Error('invalid-schema');
    if (Array.isArray(input)) {
      if (input.length > 10_000) throw new Error('invalid-schema');
      return input.map((_item, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error('invalid-schema');
        return clone(descriptor.value, depth + 1);
      });
    }
    const names = Object.keys(input);
    if (names.length > 10_000) throw new Error('invalid-schema');
    const result: Record<string, unknown> = {};
    for (const name of names) {
      if (Buffer.byteLength(name) > 1_024 || UNSAFE_OPTION_IDENTIFIER.test(name)) throw new Error('invalid-schema');
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !('value' in descriptor)) throw new Error('invalid-schema');
      Object.defineProperty(result, name, {
        value: clone(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  };
  try {
    const cloned = clone(value, 0);
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned)
      ? cloned as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Validate and copy untrusted JSON chat options without forwarding unknown properties. */
export function sanitizedProxyChatOptions(value: unknown): ProxyChatOptions | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const options: ProxyChatOptions = {};
  if (source.model !== undefined) {
    if (typeof source.model !== 'string' || !source.model.trim() || Buffer.byteLength(source.model) > 500
      || UNSAFE_OPTION_IDENTIFIER.test(source.model)) return null;
    options.model = source.model.trim();
  }
  if (source.temperature !== undefined) {
    if (typeof source.temperature !== 'number' || !Number.isFinite(source.temperature)
      || source.temperature < 0 || source.temperature > 2) return null;
    options.temperature = source.temperature;
  }
  if (source.maxTokens !== undefined) {
    if (!Number.isSafeInteger(source.maxTokens) || (source.maxTokens as number) < 1
      || (source.maxTokens as number) > 1_000_000) return null;
    options.maxTokens = source.maxTokens as number;
  }
  if (source.systemPrompt !== undefined) {
    if (typeof source.systemPrompt !== 'string' || Buffer.byteLength(source.systemPrompt) > 1024 * 1024) return null;
    options.systemPrompt = source.systemPrompt;
  }
  if (source.maxRetries !== undefined) {
    if (!Number.isSafeInteger(source.maxRetries) || (source.maxRetries as number) < 0
      || (source.maxRetries as number) > 10) return null;
    options.maxRetries = source.maxRetries as number;
  }
  if (source.thinking !== undefined) {
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(source.thinking as string)) return null;
    options.thinking = source.thinking as NonNullable<ChatOptions['thinking']>;
  }
  if (source.sessionId !== undefined) {
    if (typeof source.sessionId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(source.sessionId)) return null;
    options.sessionId = source.sessionId;
  }
  if (source.stream !== undefined) {
    if (typeof source.stream !== 'boolean') return null;
    options.stream = source.stream;
  }
  if (source.tools !== undefined) {
    if (!Array.isArray(source.tools) || source.tools.length > 1_024) return null;
    const tools: NonNullable<ChatOptions['tools']> = [];
    let toolBytes = 0;
    for (const toolValue of source.tools) {
      if (!toolValue || typeof toolValue !== 'object' || Array.isArray(toolValue)) return null;
      const tool = toolValue as Record<string, unknown>;
      if (typeof tool.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(tool.name)
        || typeof tool.description !== 'string' || Buffer.byteLength(tool.description) > 4_096
        || !tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) return null;
      const parameters = boundedToolSchema(tool.parameters);
      if (!parameters) return null;
      let encoded: string;
      try { encoded = JSON.stringify(parameters); }
      catch { return null; }
      toolBytes += Buffer.byteLength(tool.name) + Buffer.byteLength(tool.description) + Buffer.byteLength(encoded);
      if (toolBytes > 4 * 1024 * 1024) return null;
      tools.push({
        name: tool.name,
        description: tool.description,
        parameters,
      });
    }
    options.tools = tools;
  }
  return options;
}

const DEFAULT_TIMEOUT = 120_000; // 2 minutes default
const MAX_SSE_TRANSPORT_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_SSE_TRANSPORT_BYTES = 64 * 1024 * 1024;
const MAX_PROXY_STREAM_EVENTS = 100_000;
const MAX_FINAL_CONTENT_JSON_BYTES = MAX_SSE_TRANSPORT_CHUNK_BYTES - 8 * 1024;
const SSE_DRAIN_TIMEOUT_MS = 30_000;
const SSE_READ_IDLE_TIMEOUT_MS = 120_000;
const MAX_USAGE_PROVIDERS = 512;
const MAX_USAGE_FILE_BYTES = 1024 * 1024;

function providerNetworkConfig(
  network: AgentProviderNetworkSettings | undefined,
  scope: ProviderNetworkScope,
): Partial<ProviderConfig> & { [PROVIDER_NETWORK_SCOPE]: ProviderNetworkScope } {
  return {
    [PROVIDER_NETWORK_SCOPE]: scope,
    ...(network ? {
      transport: network.transport,
      ...(network.httpProxy ? { httpProxy: network.httpProxy } : {}),
      httpIdleTimeoutMs: network.httpIdleTimeoutMs,
      websocketConnectTimeoutMs: network.websocketConnectTimeoutMs,
      requestTimeoutMs: network.requestTimeoutMs,
      providerMaxRetries: network.maxRetries,
      providerMaxRetryDelayMs: network.maxRetryDelayMs,
    } : {}),
  };
}

// Every built-in and custom adapter below uses the shared Core network path.

interface ProviderProxy {
  stream(messages: Message[], options?: ChatOptions): AsyncGenerator<{ content: string; usage?: Record<string, number> }, void, unknown>;
  chat(messages: Message[], options?: ChatOptions): Promise<{ content: string; model?: string; usage?: Record<string, number> }>;
}

class CoreProviderProxy implements ProviderProxy {
  constructor(
    private readonly provider: AiProvider,
    private readonly legacyUsage = false,
  ) {}

  private usage(value: Awaited<ReturnType<AiProvider['chat']>>['usage']): Record<string, number> | undefined {
    const normalized = normalizeProviderUsage(value);
    if (!normalized) return undefined;
    if (this.legacyUsage) {
      return {
        prompt_tokens: normalized.inputTokens ?? 0,
        completion_tokens: normalized.outputTokens ?? 0,
        total_tokens: normalized.totalTokens ?? 0,
        ...(normalized.cacheReadTokens !== undefined ? { cache_read_tokens: normalized.cacheReadTokens } : {}),
        ...(normalized.cacheWriteTokens !== undefined ? { cache_write_tokens: normalized.cacheWriteTokens } : {}),
      };
    }
    return {
      promptTokens: normalized.inputTokens ?? 0,
      completionTokens: normalized.outputTokens ?? 0,
      totalTokens: normalized.totalTokens ?? 0,
      ...(normalized.cacheReadTokens !== undefined ? { cacheReadTokens: normalized.cacheReadTokens } : {}),
      ...(normalized.cacheWriteTokens !== undefined ? { cacheWriteTokens: normalized.cacheWriteTokens } : {}),
      ...(normalized.costUsd !== undefined ? { costUsd: normalized.costUsd } : {}),
    };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<{ content: string; model?: string; usage?: Record<string, number> }> {
    const result = await this.provider.chat(messages, options);
    if (!result || typeof result !== 'object') throw new Error('Provider response was invalid.');
    const own = (key: 'content' | 'model' | 'usage'): unknown => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(result, key);
        return descriptor && 'value' in descriptor ? descriptor.value : undefined;
      } catch { throw new Error('Provider response was invalid.'); }
    };
    const content = own('content');
    const model = own('model');
    if (typeof content !== 'string' || Buffer.byteLength(content) > 16 * 1024 * 1024
      || (model !== undefined && (typeof model !== 'string' || Buffer.byteLength(model) > 500
        || UNSAFE_OPTION_IDENTIFIER.test(model)))) {
      throw new Error('Provider response was invalid.');
    }
    const usage = this.usage(own('usage') as Awaited<ReturnType<AiProvider['chat']>>['usage']);
    return { content, ...(model === undefined ? {} : { model }), ...(usage ? { usage } : {}) };
  }

  async *stream(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<{ content: string; usage?: Record<string, number> }, void, unknown> {
    const queue: Array<{ content: string; usage?: Record<string, number>; bytes: number }> = [];
    const controller = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let queuedBytes = 0;
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;
    const notify = (): void => { wake?.(); wake = undefined; };
    const enqueue = (item: { content: string; usage?: Record<string, number> }): void => {
      if (finished) return;
      if (typeof item.content !== 'string') {
        failure = new Error('Provider stream was invalid.');
        finished = true;
        controller.abort(failure);
        notify();
        return;
      }
      const bytes = Buffer.byteLength(item.content);
      if (queue.length >= 1_024 || bytes > 1024 * 1024 || queuedBytes + bytes > 4 * 1024 * 1024) {
        failure = new Error('The provider streaming queue exceeded its output limit.');
        finished = true;
        controller.abort(failure);
        notify();
        return;
      }
      queue.push({ ...item, bytes });
      queuedBytes += bytes;
      notify();
    };

    void this.provider.streamChat(
      messages,
      content => {
        if (typeof content !== 'string') enqueue({ content: content as string });
        else if (content) enqueue({ content });
      },
      response => {
        let rawUsage: unknown;
        try {
          if (response && typeof response === 'object') {
            const descriptor = Object.getOwnPropertyDescriptor(response, 'usage');
            rawUsage = descriptor && 'value' in descriptor ? descriptor.value : undefined;
          }
        } catch {
          failure = new Error('Provider stream was invalid.');
        }
        const usage = failure ? undefined
          : this.usage(rawUsage as Awaited<ReturnType<AiProvider['chat']>>['usage']);
        if (usage) enqueue({ content: '', usage });
        finished = true;
        notify();
      },
      error => {
        failure = error;
        finished = true;
        notify();
      },
      { ...options, signal },
    ).catch(error => {
      if (!finished) failure = error instanceof Error ? error : new Error(String(error));
      finished = true;
      notify();
    });

    try {
      while (!finished || queue.length > 0) {
        if (queue.length > 0) {
          const item = queue.shift()!;
          queuedBytes -= item.bytes;
          const { bytes: _bytes, ...published } = item;
          yield published;
        } else {
          await new Promise<void>(resolve => { wake = resolve; });
        }
      }
      if (failure) throw failure;
    } finally {
      controller.abort();
      queue.length = 0;
      queuedBytes = 0;
    }
  }
}

// ===================================================================
// Proxy Server - Main controller
// ===================================================================

type ProviderUsageMetrics = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
};

type RecordedUsage = {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

function safeMetric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, value)
    : 0;
}

function addMetric(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, safeMetric(left) + safeMetric(right));
}

export class AiProxyServer {
  private openaiProxy?: ProviderProxy;
  private anthropicProxy?: ProviderProxy;
  private localProxy?: ProviderProxy;
  private googleProxy?: CoreProviderProxy;
  private azureProxy?: CoreProviderProxy;
  private vertexProxy?: CoreProviderProxy;
  private bedrockProxy?: CoreProviderProxy;
  private mockProxy?: CoreProviderProxy;
  private readonly customProxies = new Map<string, CoreProviderProxy>();
  private readonly agentProviders = new Map<string, AiProvider>();
  private readonly usage = new Map<string, ProviderUsageMetrics>();
  private usageFile?: string;
  private usageWrite: Promise<void> = Promise.resolve();
  private pricingFor?: (provider: string, model: string | undefined) => ModelPricing | undefined;
  private readonly config: { timeout: number; enableMockProvider: boolean };
  private network?: AgentProviderNetworkSettings;
  private networkScope: ProviderNetworkScope = createProviderNetworkScope();
  private redactor: CredentialRedactor;

  constructor(config?: ProxyServerConfig) {
    this.config = {
      timeout: config?.timeout ?? DEFAULT_TIMEOUT,
      enableMockProvider: config?.enableMockProvider
        ?? process.env.AI_HARNESS_ENABLE_MOCK_PROVIDER === '1',
    };
    this.network = config?.network;
    this.redactor = config?.redactor ?? new CredentialRedactor();
    this.redactor.addEnvironment(process.env);
    this.redactor.add(this.network?.httpProxy);
    const network = providerNetworkConfig(this.network, this.networkScope);

    // Initialize proxies from environment variables if available
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const provider = new CoreOpenAiProvider({
          ...network,
          type: ProviderType.OPENAI,
          apiKey: openaiKey,
          model: process.env.OPENAI_MODEL || 'gpt-4o',
        });
        this.openaiProxy = new CoreProviderProxy(provider, true);
        this.agentProviders.set('openai', provider);
      } catch { /* Skip initialization */ }
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      try {
        const provider = new CoreAnthropicProvider({
          ...network,
          type: ProviderType.ANTHROPIC,
          apiKey: anthropicKey,
          model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
        });
        this.anthropicProxy = new CoreProviderProxy(provider, true);
        this.agentProviders.set('anthropic', provider);
      } catch { /* Skip initialization */ }
    }

    const googleKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (googleKey) {
      const provider = new GeminiProvider({
        ...network,
        type: ProviderType.GOOGLE,
        apiKey: googleKey,
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      });
      this.googleProxy = new CoreProviderProxy(provider);
      this.agentProviders.set('google', provider);
    }

    if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
      const provider = new CoreOpenAiProvider({
        ...network,
        type: ProviderType.AZURE,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        baseUrl: process.env.AZURE_OPENAI_ENDPOINT,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
        model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
      });
      this.azureProxy = new CoreProviderProxy(provider);
      this.agentProviders.set('azure', provider);
    }
    if (process.env.GOOGLE_VERTEX_ACCESS_TOKEN && process.env.GOOGLE_CLOUD_PROJECT) {
      const provider = new VertexGeminiProvider({
        ...network,
        type: ProviderType.VERTEX,
        apiKey: process.env.GOOGLE_VERTEX_ACCESS_TOKEN,
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: process.env.GOOGLE_CLOUD_LOCATION,
      });
      this.vertexProxy = new CoreProviderProxy(provider);
      this.agentProviders.set('vertex', provider);
    }
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      const provider = new BedrockProvider({
        ...network,
        type: ProviderType.BEDROCK,
        region: process.env.AWS_REGION,
        model: process.env.BEDROCK_MODEL,
      });
      this.bedrockProxy = new CoreProviderProxy(provider);
      this.agentProviders.set('bedrock', provider);
    }

    const localBaseUrl = process.env.LOCAL_BASE_URL || process.env.LLAMA_BASE_URL;
    if (localBaseUrl) {
      try {
        const apiKey = process.env.LOCAL_API_KEY || process.env.LLAMA_API_KEY;
        const baseUrl = normalizeLocalBaseUrl(localBaseUrl);
        const model = process.env.LOCAL_MODEL || process.env.LLAMA_MODEL || 'local-model';
        const provider = new LocalProvider({
          ...network,
          type: ProviderType.LOCAL,
          ...(apiKey ? { apiKey } : {}),
          baseUrl,
          model,
        });
        this.localProxy = new CoreProviderProxy(provider, true);
        this.agentProviders.set('local', provider);
      } catch { /* Skip initialization */ }
    }

    if (this.config.enableMockProvider) {
      const provider = new MockProvider({ type: ProviderType.MOCK });
      this.mockProxy = new CoreProviderProxy(provider);
      this.agentProviders.set('mock', provider);
    }
  }

  /** Set provider API keys dynamically and refresh both chat and agent adapters. */
  setApiKey(type: 'openai' | 'anthropic' | 'google' | 'azure' | 'vertex' | 'bedrock' | 'local', apiKey: string, baseUrl?: string, model?: string): void {
    if (apiKey) this.redactor.add(apiKey);
    const bedrockCredential = type === 'bedrock' ? parseBedrockCredential(apiKey) : undefined;
    if (type === 'bedrock' && !bedrockCredential) throw new Error('Invalid provider credential.');
    if (bedrockCredential) this.redactor.addAll(bedrockCredential);
    let provider: AiProvider;
    const network = providerNetworkConfig(this.network, this.networkScope);
    if (type === 'openai') {
      provider = new CoreOpenAiProvider({ ...network, type: ProviderType.OPENAI, apiKey, baseUrl, model });
      this.openaiProxy = new CoreProviderProxy(provider, true);
    } else if (type === 'anthropic') {
      provider = new CoreAnthropicProvider({ ...network, type: ProviderType.ANTHROPIC, apiKey, baseUrl, model });
      this.anthropicProxy = new CoreProviderProxy(provider, true);
    } else if (type === 'google') {
      provider = new GeminiProvider({
        ...network,
        type: ProviderType.GOOGLE,
        apiKey,
        baseUrl,
        model: model || 'gemini-2.0-flash',
      });
      this.googleProxy = new CoreProviderProxy(provider);
    } else if (type === 'azure') {
      provider = new CoreOpenAiProvider({
        ...network, type: ProviderType.AZURE, apiKey, baseUrl, model: model || 'gpt-4o', deployment: model,
      });
      this.azureProxy = new CoreProviderProxy(provider);
    } else if (type === 'vertex') {
      provider = new VertexGeminiProvider({
        ...network, type: ProviderType.VERTEX, apiKey, baseUrl, model: model || 'gemini-2.0-flash',
      });
      this.vertexProxy = new CoreProviderProxy(provider);
    } else if (type === 'bedrock') {
      const [accessKeyId, secretAccessKey, sessionToken] = bedrockCredential!;
      const config: ProviderConfig = {
        ...network,
        type: ProviderType.BEDROCK,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        ...(baseUrl ? { baseUrl } : {}),
        model,
      };
      provider = new BedrockProvider(config);
      this.bedrockProxy = new CoreProviderProxy(provider);
    } else {
      const normalizedBaseUrl = normalizeLocalBaseUrl(baseUrl || 'http://localhost:11434/v1');
      const selectedModel = model || 'local-model';
      provider = new LocalProvider({
        ...network,
        type: ProviderType.LOCAL,
        ...(apiKey ? { apiKey } : {}),
        baseUrl: normalizedBaseUrl,
        model: selectedModel,
      });
      this.localProxy = new CoreProviderProxy(provider, true);
    }
    this.agentProviders.set(type, provider);
  }

  /** Drop this runtime's cached transports after credentials or endpoints change. */
  resetNetworkDispatchers(): Promise<void> {
    return closeProviderNetworkDispatchers(this.networkScope);
  }

  /** Permanently close transports owned by this proxy generation. */
  closeNetworkDispatchers(): Promise<void> {
    return closeProviderNetworkDispatchers(this.networkScope, { permanent: true });
  }

  /** Start a fresh transport generation when an explicitly supplied proxy is reused. */
  async rotateNetworkScope(): Promise<void> {
    const previous = this.networkScope;
    this.networkScope = createProviderNetworkScope();
    const config = providerNetworkConfig(this.network, this.networkScope);
    for (const provider of this.agentProviders.values()) {
      Object.assign((provider as unknown as { config: ProviderConfig }).config, config);
    }
    await closeProviderNetworkDispatchers(previous, { permanent: true });
  }

  /** Apply one policy to built-ins and extension/custom adapters without recreating secrets. */
  setNetworkSettings(network: AgentProviderNetworkSettings): void {
    this.network = { ...network };
    this.redactor.add(network.httpProxy);
    const config = providerNetworkConfig(network, this.networkScope);
    for (const provider of this.agentProviders.values()) {
      Object.assign((provider as unknown as { config: ProviderConfig }).config, config);
    }
  }

  setCredentialRedactor(redactor: CredentialRedactor): void {
    this.redactor = redactor;
    this.redactor.addEnvironment(process.env);
    this.redactor.add(this.network?.httpProxy);
  }

  getCredentialRedactor(): CredentialRedactor {
    return this.redactor;
  }

  redactText(value: string): string {
    return this.redactor.redact(value);
  }

  redactJson<T>(value: T): T {
    return this.redactor.redactJson(value);
  }

  getNetworkSettings(): Omit<AgentProviderNetworkSettings, 'httpProxy'> & { proxyConfigured: boolean } | undefined {
    if (!this.network) return undefined;
    const { httpProxy, ...settings } = this.network;
    return { ...settings, proxyConfigured: Boolean(httpProxy) };
  }

  /** Register or atomically replace an operator-defined provider adapter. */
  setCustomProvider(type: string, provider: AiProvider): void {
    const normalized = type.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(normalized)
      || ['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock'].includes(normalized)) {
      throw new Error(`Invalid custom provider id: ${type}`);
    }
    const providerConfig = (provider as unknown as { config: ProviderConfig }).config;
    this.redactor.add(typeof providerConfig.apiKey === 'string' ? providerConfig.apiKey : undefined);
    for (const value of Object.values(providerConfig.customHeaders ?? {})) {
      if (typeof value === 'string') this.redactor.add(value);
    }
    Object.assign(providerConfig, providerNetworkConfig(this.network, this.networkScope));
    this.agentProviders.set(normalized, provider);
    this.customProxies.set(normalized, new CoreProviderProxy(provider));
  }

  removeProvider(type: string): boolean {
    const normalized = type.toLowerCase();
    const custom = this.customProxies.delete(normalized);
    this.agentProviders.delete(normalized);
    if (custom) return true;
    switch (normalized) {
      case 'openai': this.openaiProxy = undefined; break;
      case 'anthropic': this.anthropicProxy = undefined; break;
      case 'google': this.googleProxy = undefined; break;
      case 'azure': this.azureProxy = undefined; break;
      case 'vertex': this.vertexProxy = undefined; break;
      case 'bedrock': this.bedrockProxy = undefined; break;
      case 'local': this.localProxy = undefined; break;
      default: return false;
    }
    return true;
  }

  /** Provider instance used by the detached multi-turn runtime. */
  getAgentProvider(type: string): AiProvider | undefined {
    return this.agentProviders.get(type.toLowerCase());
  }

  /** Restore process-independent provider metrics and configure model-price lookup. */
  async initializeUsage(
    filePath: string,
    pricingFor: (provider: string, model: string | undefined) => ModelPricing | undefined,
  ): Promise<void> {
    this.usageFile = filePath;
    this.pricingFor = pricingFor;
    this.usage.clear();
    try {
      const parsed = JSON.parse(await readBoundedResourceText(filePath, MAX_USAGE_FILE_BYTES)) as {
        providers?: Record<string, Partial<ProviderUsageMetrics>>;
      };
      const providers = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)
        ? Object.entries(parsed.providers).slice(0, MAX_USAGE_PROVIDERS)
        : [];
      for (const [provider, value] of providers) {
        if (!/^[a-z][a-z0-9_-]{1,63}$/.test(provider) || !value || typeof value !== 'object'
          || Array.isArray(value)) continue;
        this.usage.set(provider, {
          requests: safeMetric(value.requests),
          inputTokens: safeMetric(value.inputTokens),
          outputTokens: safeMetric(value.outputTokens),
          cacheReadTokens: safeMetric(value.cacheReadTokens),
          cacheWriteTokens: safeMetric(value.cacheWriteTokens),
          totalTokens: safeMetric(value.totalTokens),
          costUsd: safeMetric(value.costUsd),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[UsageMetrics] Unable to load usage data.');
      }
    }
  }

  /** Record every provider turn, including intermediate tool-call turns, and return its calculated cost. */
  recordUsage(type: string, model: string | undefined, usage: RecordedUsage): number | undefined {
    const key = type.toLowerCase();
    const inputTokens = safeMetric(usage.promptTokens);
    const outputTokens = safeMetric(usage.completionTokens);
    const cacheReadTokens = safeMetric(usage.cacheReadTokens);
    const cacheWriteTokens = safeMetric(usage.cacheWriteTokens);
    const totalTokens = safeMetric(usage.totalTokens) || inputTokens + outputTokens;
    const pricing = this.pricingFor?.(key, model);
    const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    const calculatedCost = pricing ? (
      uncachedInputTokens * safeMetric(pricing.inputPerMillion)
      + outputTokens * safeMetric(pricing.outputPerMillion)
      + cacheReadTokens * safeMetric(pricing.cacheReadPerMillion ?? pricing.inputPerMillion)
      + cacheWriteTokens * safeMetric(pricing.cacheWritePerMillion ?? pricing.inputPerMillion)
    ) / 1_000_000 : undefined;
    const costUsd = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
      ? usage.costUsd : calculatedCost;
    const current = this.usage.get(key) ?? {
      requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, totalTokens: 0, costUsd: 0,
    };
    current.requests = addMetric(current.requests, 1);
    current.inputTokens = addMetric(current.inputTokens, inputTokens);
    current.outputTokens = addMetric(current.outputTokens, outputTokens);
    current.cacheReadTokens = addMetric(current.cacheReadTokens, cacheReadTokens);
    current.cacheWriteTokens = addMetric(current.cacheWriteTokens, cacheWriteTokens);
    current.totalTokens = addMetric(current.totalTokens, totalTokens);
    current.costUsd = addMetric(current.costUsd, costUsd ?? 0);
    if (this.usage.has(key) || (/^[a-z][a-z0-9_-]{1,63}$/.test(key) && this.usage.size < MAX_USAGE_PROVIDERS)) {
      this.usage.set(key, current);
    }
    this.queueUsageWrite();
    return costUsd;
  }

  getUsage(type: string): ProviderUsageMetrics | undefined {
    const usage = this.usage.get(type.toLowerCase());
    return usage ? { ...usage } : undefined;
  }

  async flushUsage(): Promise<void> {
    await this.usageWrite;
  }

  private queueUsageWrite(): void {
    if (!this.usageFile) return;
    this.usageWrite = this.usageWrite.catch(() => undefined).then(async () => {
      const filePath = this.usageFile!;
      await mkdir(path.dirname(filePath), { recursive: true });
      const providers = Object.fromEntries([...this.usage].sort(([left], [right]) => left.localeCompare(right)));
      await atomicWriteStableFile(filePath, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`, {
        overwrite: true,
        maxBytes: MAX_USAGE_FILE_BYTES,
        mode: 0o600,
      });
    }).catch(() => {
      console.error('[UsageMetrics] Unable to persist metrics.');
    });
  }

  /** Check if a provider is configured */
  isConfigured(type: string): boolean {
    switch (type.toLowerCase()) {
      case 'openai': return !!this.openaiProxy;
      case 'anthropic': return !!this.anthropicProxy;
      case 'google': return !!this.googleProxy;
      case 'azure': return !!this.azureProxy;
      case 'vertex': return !!this.vertexProxy;
      case 'bedrock': return !!this.bedrockProxy;
      case 'local': return !!this.localProxy;
      case 'mock': return !!this.mockProxy;
      default: return this.customProxies.has(type.toLowerCase());
    }
  }

  /** Get configured providers list without exposing credentials. */
  getProviders(): Array<{ type: string; configured: boolean }> {
    return [
      { type: 'openai', configured: !!this.openaiProxy },
      { type: 'anthropic', configured: !!this.anthropicProxy },
      { type: 'google', configured: !!this.googleProxy },
      { type: 'azure', configured: !!this.azureProxy },
      { type: 'vertex', configured: !!this.vertexProxy },
      { type: 'bedrock', configured: !!this.bedrockProxy },
      { type: 'local', configured: !!this.localProxy },
      ...(this.config.enableMockProvider ? [{ type: 'mock', configured: true }] : []),
      ...[...this.customProxies.keys()].sort().map(type => ({ type, configured: true })),
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

    let finalUsage: Record<string, number> | undefined;

    // Streaming mode (preferred for web UI)
    const safeMessages = this.redactJson(messages);
    const safeOptions = options ? this.redactJson(options) : undefined;
    if (safeOptions?.stream !== false && onChunk) {
      const stream = provider.stream(safeMessages, safeOptions);
      const contentRedactor = this.redactor.createStream();
      const contentParts: string[] = [];
      let fullContentBytes = 0;
      let streamEvents = 0;
      for await (const chunk of stream) {
        if (++streamEvents > MAX_PROXY_STREAM_EVENTS || typeof chunk.content !== 'string') {
          throw new Error('Provider response is invalid.');
        }
        const content = contentRedactor.push(chunk.content);
        fullContentBytes += Buffer.byteLength(content);
        if (fullContentBytes > 16 * 1024 * 1024) throw new Error('Provider response exceeded its output limit.');
        if (content) contentParts.push(content);
        finalUsage = chunk.usage ?? finalUsage;
        if (content || chunk.usage) onChunk({ ...chunk, content });
      }
      const finalContent = contentRedactor.flush();
      if (finalContent) {
        fullContentBytes += Buffer.byteLength(finalContent);
        if (fullContentBytes > 16 * 1024 * 1024) throw new Error('Provider response exceeded its output limit.');
        contentParts.push(finalContent);
        onChunk({ content: finalContent });
      }

      if (finalUsage) this.recordProxyUsage(providerType, safeOptions?.model, finalUsage);
      return this.redactJson({ content: contentParts.join(''), model: safeOptions?.model, usage: finalUsage });
    }

    // Non-streaming mode
    const result = this.redactJson(await provider.chat(safeMessages, safeOptions));
    if (result.usage) this.recordProxyUsage(providerType, result.model ?? safeOptions?.model, result.usage);
    return result;
  }

  private recordProxyUsage(provider: string, model: string | undefined, usage: Record<string, number>): void {
    this.recordUsage(provider, model, {
      promptTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
      completionTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
      cacheReadTokens: usage.cacheReadTokens ?? usage.cache_read_tokens,
      cacheWriteTokens: usage.cacheWriteTokens ?? usage.cache_write_tokens,
      totalTokens: usage.totalTokens ?? usage.total_tokens,
      costUsd: usage.costUsd ?? usage.cost_usd,
    });
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
        stream: createSSEError('Provider request failed.'),
      };
    }

    try {
      const server = this;
      const operation = new AbortController();
      let chatStream: AsyncGenerator<{ content: string; usage?: Record<string, number> }, void, unknown> | undefined;
      let cancelled = false;
      let resumeDemand: (() => void) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
          const contentParts: string[] = [];
          let fullContentBytes = 0;
          let fullContentJsonBytes = 0;
          let streamEvents = 0;
          let finalUsage: Record<string, number> | undefined;
          const contentRedactor = server.redactor.createStream();
          const waitForDemand = async (): Promise<void> => {
            while (!cancelled && (controller.desiredSize ?? 0) <= 0) {
              await new Promise<void>(resolve => { resumeDemand = resolve; });
              resumeDemand = undefined;
            }
          };
          const enqueue = async (event: string, data: Record<string, unknown>): Promise<void> => {
            await waitForDemand();
            if (!cancelled) controller.enqueue(textToSSE(event, data));
          };
          await enqueue('message_start', { provider: server.redactText(providerType) });

          try {
            const safeMessages = server.redactJson(messages);
            const safeOptions = options ? server.redactJson(options) : undefined;
            const signal = safeOptions?.signal
              ? AbortSignal.any([safeOptions.signal, operation.signal])
              : operation.signal;
            chatStream = proxy.stream(safeMessages, { ...safeOptions, signal });
            for await (const chunk of chatStream) {
              if (cancelled) break;
              if (++streamEvents > MAX_PROXY_STREAM_EVENTS) {
                throw new Error('The provider response exceeded its event limit.');
              }
              const content = contentRedactor.push(chunk.content);
              fullContentBytes += Buffer.byteLength(content);
              const encodedContent = JSON.stringify(content);
              fullContentJsonBytes += Buffer.byteLength(encodedContent) - 2;
              if (fullContentBytes > 16 * 1024 * 1024
                || fullContentJsonBytes > MAX_FINAL_CONTENT_JSON_BYTES) {
                throw new Error('The provider response exceeded the output limit.');
              }
              if (content) contentParts.push(content);
              finalUsage = chunk.usage ?? finalUsage;
              if (content) await enqueue('text_delta', { content });
            }
            const finalContent = contentRedactor.flush();
            if (finalContent && !cancelled) {
              fullContentBytes += Buffer.byteLength(finalContent);
              fullContentJsonBytes += Buffer.byteLength(JSON.stringify(finalContent)) - 2;
              if (fullContentBytes > 16 * 1024 * 1024
                || fullContentJsonBytes > MAX_FINAL_CONTENT_JSON_BYTES) {
                throw new Error('The provider response exceeded the output limit.');
              }
              contentParts.push(finalContent);
              await enqueue('text_delta', { content: finalContent });
            }
            if (!cancelled) {
              if (finalUsage) server.recordProxyUsage(providerType, safeOptions?.model, finalUsage);
              await enqueue('message_end', {
                content: contentParts.join(''),
                ...(finalUsage ? { usage: finalUsage } : {}),
              });
            }
          } catch {
            const suffix = contentRedactor.flush();
            if (suffix && !cancelled) await enqueue('text_delta', { content: suffix });
            if (!cancelled) await enqueue('error', { message: 'Provider request failed.' });
          } finally {
            if (!cancelled) controller.close();
          }
          })().catch(() => {
            if (!cancelled) {
              try { controller.error(new Error('Provider request failed.')); }
              catch { /* The stream may already be closed. */ }
            }
          });
        },
        pull() {
          resumeDemand?.();
        },
        cancel(reason) {
          cancelled = true;
          operation.abort(reason);
          resumeDemand?.();
          void chatStream?.return?.().catch(() => undefined);
        },
      });

      return { stream };
    } catch {
      return { stream: createSSEError('Provider request failed.') };
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
      case 'mock': return this.mockProxy ?? null;
      default: return this.customProxies.get(type.toLowerCase()) ?? null;
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

function parseBedrockCredential(value: string): [string, string, string?] | undefined {
  const parts = value.split(':');
  if ((parts.length !== 2 && parts.length !== 3)
    || !/^[A-Za-z0-9]{1,128}$/u.test(parts[0] ?? '')
    || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(parts[1] ?? '')
    || (parts[2] !== undefined && !/^[A-Za-z0-9/+=]{1,61440}$/u.test(parts[2]))) return undefined;
  return [parts[0], parts[1], parts[2]];
}

function textToSSE(eventType: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
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
  redactor?: CredentialRedactor,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = redactor ? new TextDecoder('utf-8', { fatal: true }) : undefined;
  const outputRedactor = redactor?.createStream();
  let closed = res.destroyed;
  let completed = false;
  let flushed = false;
  let transportedBytes = 0;
  let writtenBytes = 0;
  const closedResult = Symbol('closed');
  let notifyClosed!: () => void;
  const closeNotification = new Promise<typeof closedResult>(resolve => {
    notifyClosed = () => resolve(closedResult);
  });
  const cancel = (): void => {
    closed = true;
    notifyClosed();
    void reader.cancel('client-disconnected').catch(() => undefined);
  };
  res.once('close', cancel);
  const readNext = async (): Promise<Awaited<ReturnType<typeof reader.read>> | typeof closedResult> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Provider stream was idle for too long.')), SSE_READ_IDLE_TIMEOUT_MS);
      timer.unref?.();
    });
    try { return await Promise.race([reader.read(), closeNotification, deadline]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const write = async (value: string | Uint8Array): Promise<void> => {
    if (closed || res.writableEnded || res.destroyed || (typeof value === 'string' && !value)) return;
    const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
    if (bytes > MAX_SSE_TRANSPORT_CHUNK_BYTES || writtenBytes + bytes > MAX_SSE_TRANSPORT_BYTES) {
      throw new Error('Provider stream exceeded its output limit.');
    }
    writtenBytes += bytes;
    if (res.write(typeof value === 'string' ? value : Buffer.from(value))) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        closed = true;
        try { res.destroy(); } catch { /* The response may already be gone. */ }
        done();
      }, SSE_DRAIN_TIMEOUT_MS);
      timeout.unref?.();
      const done = (): void => {
        clearTimeout(timeout);
        res.off('drain', drained);
        res.off('close', disconnected);
        resolve();
      };
      const drained = (): void => done();
      const disconnected = (): void => { closed = true; done(); };
      res.once('drain', drained);
      res.once('close', disconnected);
    });
  };
  const flushRedactor = async (): Promise<void> => {
    if (!decoder || !outputRedactor || flushed || closed || res.writableEnded) return;
    flushed = true;
    const trailing = outputRedactor.push(decoder.decode()) + outputRedactor.flush();
    await write(trailing);
  };
  try {
    while (!closed) {
      const item = await readNext();
      if (item === closedResult) break;
      const { done, value } = item;
      if (done) {
        completed = true;
        break;
      }
      if (value.byteLength > MAX_SSE_TRANSPORT_CHUNK_BYTES) {
        throw new Error('Provider stream event exceeded its output limit.');
      }
      transportedBytes += value.byteLength;
      if (transportedBytes > MAX_SSE_TRANSPORT_BYTES) {
        throw new Error('Provider stream exceeded its output limit.');
      }
      if (!decoder || !outputRedactor) await write(value);
      else await write(outputRedactor.push(decoder.decode(value, { stream: true })));
    }
    await flushRedactor();
  } catch {
    await flushRedactor().catch(() => undefined);
    if (!closed) await write('event: error\ndata: Provider stream was invalid.\n\n');
  } finally {
    await flushRedactor().catch(() => undefined);
    res.off('close', cancel);
    if (!completed) void reader.cancel('stream-abandoned').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Cancellation may still be settling for a hostile source. */ }
    if (!closed && !res.writableEnded) res.end();
  }
}

// ===================================================================
// Express Route Handlers
// ===================================================================

function validChatRequest(provider: unknown, messages: unknown): messages is Message[] {
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/u.test(provider)
    || !Array.isArray(messages) || messages.length < 1 || messages.length > 10_000) return false;
  let bytes = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const candidate = message as { role?: unknown; content?: unknown };
    if (typeof candidate.role !== 'string'
      || !['system', 'user', 'assistant', 'tool'].includes(candidate.role)
      || typeof candidate.content !== 'string') return false;
    const contentBytes = Buffer.byteLength(candidate.content);
    if (contentBytes > 4 * 1024 * 1024) return false;
    bytes += contentBytes;
    if (bytes > 12 * 1024 * 1024) return false;
  }
  return true;
}

function sanitizedProxyMessages(messages: Message[], prefix: string): Message[] {
  const timestamp = new Date();
  return messages.map((message, index) => ({
    id: `${prefix}-${index}`,
    role: message.role,
    content: message.content,
    timestamp,
  }));
}

export function createProxyRoutes(
  proxy: AiProxyServer,
  options: {
    persistApiKey?: (provider: string, apiKey: string) => Promise<void>;
  } = {},
) {
  /** POST /api/chat - Chat with streaming (SSE) */
  const chatHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider, messages, options } = (req.body ?? {}) as {
        provider: string;
        messages: Message[];
        options?: ChatOptions & { stream?: boolean };
      };
      const safeOptions = sanitizedProxyChatOptions(options);

      if (!validChatRequest(provider, messages) || (options !== undefined && safeOptions === null)) {
        res.status(400).json({ error: 'Invalid provider, messages, or options.' });
        return;
      }

      // Check CORS headers are already set by middleware

      const result = await proxy.sendChatSSE(
        provider,
        sanitizedProxyMessages(messages, 'http'),
        safeOptions ?? undefined,
      );

      if (result.error) {
        res.status(400).json({ error: 'Provider request failed.' });
        return;
      }

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      await writeSSEStream(result.stream, res, proxy.getCredentialRedactor());
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(proxy.redactText(`[Proxy] Chat handler error: ${err.message}`));
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  /** POST /api/chat/compact - Compact conversation with LLM summary */
  const compactHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { messages, provider, options } = (req.body ?? {}) as {
        messages: Message[];
        provider?: string;
        options?: ChatOptions & { instructions?: string };
      };
      const safeOptions = sanitizedProxyChatOptions(options);
      const instructions = options?.instructions ?? 'Summarize this conversation concisely, preserving key information and context. Include any important decisions or conclusions.';

      if (!validChatRequest(provider ?? 'openai', messages) || messages.length < 4
        || (options !== undefined && safeOptions === null)
        || typeof instructions !== 'string' || Buffer.byteLength(instructions) > 64 * 1024
        || UNSAFE_OPTION_IDENTIFIER.test(instructions)) {
        res.status(400).json({ error: 'Need between 4 and 10,000 valid messages and bounded options to compact.' });
        return;
      }

      const proxyType = provider ?? (process.env.OPENAI_API_KEY ? 'openai' : 'anthropic');
      if (!proxy || !proxy.isConfigured(proxyType)) {
        res.status(400).json({ error: `Provider "${proxyType}" not configured` });
        return;
      }

      const result = await proxy.sendChat(
        proxyType,
        sanitizedProxyMessages(messages, 'compact'),
        { ...(safeOptions ?? {}), stream: false, systemPrompt: `You are a conversation summarizer. ${instructions}` },
      );

      res.json({ summary: result.content });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(proxy.redactText(`[Proxy] Compact handler error: ${err.message}`));
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
      const { type, apiKey, baseUrl, model } = (req.body ?? {}) as {
        type: string;
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      };

      if (typeof type !== 'string' || (type !== 'local' && (typeof apiKey !== 'string' || !apiKey))
        || (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey
          || Buffer.byteLength(apiKey) > 64 * 1024
          || /[\u0000-\u001f\u007f-\u009f]/u.test(apiKey)))
        || (model !== undefined && (typeof model !== 'string' || !model.trim()
          || Buffer.byteLength(model) > 500 || UNSAFE_OPTION_IDENTIFIER.test(model)))) {
        res.status(400).json({ error: 'Missing or invalid provider configuration' });
        return;
      }

      const providerType = (['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local'] as const).find(candidate => candidate === type) ?? null;
      if (!providerType) {
        res.status(400).json({ error: 'Invalid provider type' });
        return;
      }
      if (providerType === 'bedrock' && (!apiKey || !parseBedrockCredential(apiKey))) {
        res.status(400).json({ error: 'Invalid provider credential' });
        return;
      }

      let normalizedBaseUrl: string | undefined;
      if (baseUrl !== undefined) {
        if (typeof baseUrl !== 'string' || Buffer.byteLength(baseUrl) > 2_048) {
          res.status(400).json({ error: 'Invalid provider endpoint' });
          return;
        }
        try {
          const parsed = new URL(baseUrl);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
            || parsed.search || parsed.hash
            || (providerType !== 'local' && parsed.protocol !== 'https:')) throw new Error('invalid');
          normalizedBaseUrl = parsed.toString().replace(/\/$/u, '');
        } catch {
          res.status(400).json({ error: 'Invalid provider endpoint' });
          return;
        }
      }

      if (apiKey) {
        if (!options.persistApiKey) throw new Error('Credential storage is unavailable.');
        await options.persistApiKey(providerType, apiKey);
      }
      proxy.setApiKey(providerType, apiKey || '', normalizedBaseUrl, model?.trim());

      res.json({ success: true, message: `Provider "${type}" configured` });
    } catch {
      if (!res.headersSent) {
        res.status(400).json({ error: 'Provider configuration is invalid.' });
      }
    }
  };

  return { chatHandler, compactHandler, providersHandler, configHandler };
}
