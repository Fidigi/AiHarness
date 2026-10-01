import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AiProvider,
  AnthropicProvider,
  GeminiProvider,
  OpenAiProvider,
  type ChatOptions,
  type ChatResponse,
  type CustomModelDefinition,
  type CustomProviderDefinition,
  type Message,
  type ModelCapabilities,
  type ProviderConfig,
  type ProviderDialect,
} from '@ai-harness/core';
import type { AiProxyServer } from '../api/proxy.js';
import { getPublishedModelMetadata } from './model-catalog.js';
import { EncryptedCredentialStore } from '../security/credential-store.js';

const BUILTIN_IDS = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock']);
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'cookie', 'set-cookie']);

interface StoredProvider {
  id: string;
  name: string;
  baseUrl: string;
  dialect: ProviderDialect;
  headerNames: string[];
  createdAt: string;
  updatedAt: string;
}

interface RegistryState {
  version: 1;
  providers: StoredProvider[];
  models: CustomModelDefinition[];
}

interface ProviderSecrets {
  apiKey?: string;
  headers: Record<string, string>;
}

function badRequest(message: string, code = 'INVALID_PROVIDER'): never {
  throw Object.assign(new Error(message), { status: 400, code });
}

function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(value.trim().toLowerCase())) {
    badRequest('Custom provider id must contain 2–64 lowercase letters, digits, dashes or underscores.');
  }
  const id = value.trim().toLowerCase();
  if (BUILTIN_IDS.has(id)) badRequest('Built-in provider ids are reserved.');
  return id;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    badRequest(`${name} is invalid.`);
  }
  return value.trim();
}

function baseUrl(value: unknown): string {
  const parsed = new URL(boundedString(value, 'baseUrl', 2_000));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    badRequest('baseUrl must be an HTTP(S) URL without embedded credentials.');
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function dialect(value: unknown): ProviderDialect {
  if (!['openai-completions', 'openai-responses', 'anthropic', 'google'].includes(String(value))) {
    badRequest('Unsupported provider dialect.');
  }
  return value as ProviderDialect;
}

function headers(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 40) {
    badRequest('Custom headers are invalid.');
  }
  const result: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      badRequest(`Header name is not allowed: ${name}`);
    }
    if (typeof rawValue !== 'string' || rawValue.length > 8_000 || /[\r\n]/.test(rawValue)) {
      badRequest(`Header value is invalid: ${name}`);
    }
    result[name] = rawValue;
  }
  return result;
}

function capabilities(value: unknown): ModelCapabilities {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    reasoning: input.reasoning === true,
    imageInput: input.imageInput === true,
    toolCalls: input.toolCalls !== false,
  };
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 100_000_000) badRequest(`${name} is invalid.`, 'INVALID_MODEL');
  return Number(value);
}

function optionalPrice(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) badRequest(`${name} is invalid.`, 'INVALID_MODEL');
  return value;
}

class OpenAiResponsesProvider extends AiProvider {
  private readonly baseUrl: string;
  private readonly customHeaders: Record<string, string>;

  constructor(config: ProviderConfig) {
    super(config);
    this.baseUrl = String(config.baseUrl).replace(/\/$/, '');
    this.customHeaders = (config.customHeaders ?? {}) as Record<string, string>;
  }

  validateConfig(): boolean { return Boolean(this.baseUrl); }

  async getAvailableModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, { headers: this.requestHeaders() });
    if (!response.ok) throw new Error(`Model discovery failed (${response.status}).`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).flatMap(item => typeof item.id === 'string' ? [item.id] : []);
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.requestHeaders() },
      signal: options?.signal,
      body: JSON.stringify({
        model: options?.model ?? this.config.model,
        input: messages.map(message => ({ role: message.role === 'tool' ? 'user' : message.role, content: message.content })),
        ...(options?.systemPrompt ? { instructions: options.systemPrompt } : {}),
        ...(options?.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
        ...(options?.thinking && options.thinking !== 'off' ? { reasoning: { effort: options.thinking === 'xhigh' ? 'high' : options.thinking } } : {}),
        ...(options?.tools?.length ? { tools: options.tools.map(tool => ({
          type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters,
        })) } : {}),
      }),
    });
    if (!response.ok) throw new Error(`OpenAI Responses API error (${response.status}): ${(await response.text()).slice(0, 2_000)}`);
    const data = await response.json() as Record<string, any>;
    const output = Array.isArray(data.output) ? data.output : [];
    const content = typeof data.output_text === 'string' ? data.output_text : output
      .flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
      .filter((item: any) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item: any) => item.text).join('');
    const toolCalls = output.filter((item: any) => item.type === 'function_call').map((item: any) => {
      let input: unknown = {};
      try { input = JSON.parse(item.arguments || '{}'); } catch { input = { raw: item.arguments }; }
      return { id: String(item.call_id ?? item.id ?? crypto.randomUUID()), name: String(item.name), input };
    });
    return {
      content,
      model: typeof data.model === 'string' ? data.model : undefined,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(data.usage ? { usage: {
        promptTokens: Number(data.usage.input_tokens) || 0,
        completionTokens: Number(data.usage.output_tokens) || 0,
        cacheReadTokens: Number(data.usage.input_tokens_details?.cached_tokens) || 0,
        totalTokens: Number(data.usage.total_tokens) || 0,
      } } : {}),
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: Parameters<AiProvider['streamChat']>[1],
    onComplete?: Parameters<AiProvider['streamChat']>[2],
    onError?: Parameters<AiProvider['streamChat']>[3],
    options?: ChatOptions,
  ): Promise<void> {
    try {
      const response = await this.chat(messages, options);
      if (response.content) onChunk(response.content, { type: 'text_delta', data: response.content });
      for (const call of response.toolCalls ?? []) onChunk('', { type: 'tool_call', data: call });
      onComplete?.(response);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private requestHeaders(): Record<string, string> {
    return {
      ...(this.config.apiKey ? { Authorization: `Bearer ${String(this.config.apiKey)}` } : {}),
      ...this.customHeaders,
    };
  }
}

/** Atomic non-secret custom provider/model registry with separately encrypted credentials. */
export class ProviderRegistryService {
  private state: RegistryState = { version: 1, providers: [], models: [] };
  private readonly volatileSecrets = new Map<string, ProviderSecrets>();
  private readonly secretStore?: EncryptedCredentialStore;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly proxy: AiProxyServer,
    secretsFile: string,
    masterKey = process.env.AI_HARNESS_MASTER_KEY,
  ) {
    if (masterKey) this.secretStore = new EncryptedCredentialStore(secretsFile, masterKey);
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<RegistryState>;
      if (parsed.version === 1 && Array.isArray(parsed.providers) && Array.isArray(parsed.models)) {
        this.state = { version: 1, providers: parsed.providers, models: parsed.models } as RegistryState;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.secretStore?.load();
    for (const provider of this.state.providers) this.applyProvider(provider);
  }

  listProviders(): CustomProviderDefinition[] {
    return this.state.providers.map(provider => ({
      ...provider,
      configured: Boolean(this.readSecrets(provider.id)),
      modelCount: this.state.models.filter(model => model.provider === provider.id).length,
    }));
  }

  getModels(): CustomModelDefinition[] { return structuredClone(this.state.models); }

  async upsertProvider(input: Record<string, unknown>, existingId?: string): Promise<CustomProviderDefinition> {
    const id = providerId(existingId ?? input.id);
    const previous = this.state.providers.find(provider => provider.id === id);
    if (!previous && existingId) throw Object.assign(new Error('Custom provider not found.'), { status: 404 });
    const now = new Date().toISOString();
    const customHeaders = input.headers === undefined ? undefined : headers(input.headers);
    const record: StoredProvider = {
      id,
      name: input.name === undefined && previous ? previous.name : boundedString(input.name, 'name', 200),
      baseUrl: input.baseUrl === undefined && previous ? previous.baseUrl : baseUrl(input.baseUrl),
      dialect: input.dialect === undefined && previous ? previous.dialect : dialect(input.dialect),
      headerNames: customHeaders === undefined ? previous?.headerNames ?? [] : Object.keys(customHeaders).sort(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const currentSecrets = this.readSecrets(id) ?? { headers: {} };
    const nextSecrets: ProviderSecrets = {
      ...(typeof input.apiKey === 'string' ? (input.apiKey ? { apiKey: input.apiKey.slice(0, 20_000) } : {})
        : currentSecrets.apiKey ? { apiKey: currentSecrets.apiKey } : {}),
      headers: customHeaders ?? currentSecrets.headers,
    };
    await this.saveSecrets(id, nextSecrets);
    this.state.providers = [...this.state.providers.filter(provider => provider.id !== id), record]
      .sort((left, right) => left.name.localeCompare(right.name));
    await this.persist();
    this.applyProvider(record);
    return this.listProviders().find(provider => provider.id === id)!;
  }

  async deleteProvider(idValue: string): Promise<boolean> {
    const id = providerId(idValue);
    if (!this.state.providers.some(provider => provider.id === id)) return false;
    this.state.providers = this.state.providers.filter(provider => provider.id !== id);
    this.state.models = this.state.models.filter(model => model.provider !== id);
    this.proxy.removeProvider(id);
    this.volatileSecrets.delete(id);
    await this.secretStore?.delete(`provider:${id}`);
    await this.persist();
    return true;
  }

  async disconnect(idValue: string): Promise<CustomProviderDefinition> {
    const id = providerId(idValue);
    const provider = this.state.providers.find(item => item.id === id);
    if (!provider) throw Object.assign(new Error('Custom provider not found.'), { status: 404 });
    this.volatileSecrets.delete(id);
    await this.secretStore?.delete(`provider:${id}`);
    this.proxy.removeProvider(id);
    return this.listProviders().find(item => item.id === id)!;
  }

  async testProvider(idValue: string): Promise<{ ok: true; models: string[]; checkedAt: string }> {
    const id = providerId(idValue);
    const provider = this.proxy.getAgentProvider(id);
    if (!provider) throw Object.assign(new Error('Provider is not connected.'), { status: 409 });
    const models = await provider.getAvailableModels();
    return { ok: true, models: models.slice(0, 500), checkedAt: new Date().toISOString() };
  }

  async upsertModel(input: Record<string, unknown>, existingKey?: string): Promise<CustomModelDefinition> {
    const provider = typeof input.provider === 'string' ? input.provider.trim().toLowerCase()
      : existingKey?.split(':')[0] ?? '';
    if (!provider || (!BUILTIN_IDS.has(provider) && !this.state.providers.some(item => item.id === provider))) {
      badRequest('Unknown model provider.', 'INVALID_MODEL');
    }
    const id = boundedString(input.id ?? existingKey?.slice(provider.length + 1), 'model id', 500);
    const key = `${provider}:${id}`;
    const previous = this.state.models.find(model => model.key === (existingKey ?? key));
    const published = getPublishedModelMetadata(provider, id);
    if (existingKey && !previous) throw Object.assign(new Error('Custom model not found.'), { status: 404 });
    if (existingKey && existingKey !== key && this.state.models.some(model => model.key === key)) badRequest('Model already exists.', 'MODEL_EXISTS');
    const now = new Date().toISOString();
    const pricingInput = input.pricing && typeof input.pricing === 'object' ? input.pricing as Record<string, unknown> : {};
    const pricing = {
      inputPerMillion: optionalPrice(pricingInput.inputPerMillion ?? previous?.pricing?.inputPerMillion ?? published?.pricing?.inputPerMillion, 'input price'),
      outputPerMillion: optionalPrice(pricingInput.outputPerMillion ?? previous?.pricing?.outputPerMillion ?? published?.pricing?.outputPerMillion, 'output price'),
      cacheReadPerMillion: optionalPrice(pricingInput.cacheReadPerMillion ?? previous?.pricing?.cacheReadPerMillion ?? published?.pricing?.cacheReadPerMillion, 'cache read price'),
      cacheWritePerMillion: optionalPrice(pricingInput.cacheWritePerMillion ?? previous?.pricing?.cacheWritePerMillion ?? published?.pricing?.cacheWritePerMillion, 'cache write price'),
    };
    const compatibilityInput = input.compatibility && typeof input.compatibility === 'object' && !Array.isArray(input.compatibility)
      ? input.compatibility as Record<string, unknown> : {};
    const compatibility = Object.fromEntries(Object.entries(compatibilityInput).slice(0, 50).flatMap(([name, value]) =>
      /^[a-zA-Z][\w.-]{0,99}$/.test(name) && ['string', 'number', 'boolean'].includes(typeof value)
        ? [[name, value as string | number | boolean]] : []));
    const model: CustomModelDefinition = {
      key,
      provider,
      id,
      name: input.name === undefined
        ? previous?.name ?? published?.name ?? id
        : boundedString(input.name, 'model name', 500),
      capabilities: input.capabilities === undefined
        ? previous?.capabilities ?? published?.capabilities ?? capabilities(undefined)
        : capabilities(input.capabilities),
      ...(optionalPositiveInteger(input.contextWindow ?? previous?.contextWindow ?? published?.contextWindow, 'context window')
        ? { contextWindow: optionalPositiveInteger(input.contextWindow ?? previous?.contextWindow ?? published?.contextWindow, 'context window') } : {}),
      ...(optionalPositiveInteger(input.maxOutputTokens ?? previous?.maxOutputTokens ?? published?.maxOutputTokens, 'maximum output')
        ? { maxOutputTokens: optionalPositiveInteger(input.maxOutputTokens ?? previous?.maxOutputTokens ?? published?.maxOutputTokens, 'maximum output') } : {}),
      ...(Object.values(pricing).some(value => value !== undefined)
        ? { pricing }
        : previous?.pricing ? { pricing: previous.pricing }
          : published?.pricing ? { pricing: published.pricing } : {}),
      ...(Object.keys(compatibility).length ? { compatibility } : previous?.compatibility ? { compatibility: previous.compatibility } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.state.models = [...this.state.models.filter(item => item.key !== (existingKey ?? key)), model]
      .sort((left, right) => left.key.localeCompare(right.key));
    await this.persist();
    return structuredClone(model);
  }

  async deleteModel(key: string): Promise<boolean> {
    const before = this.state.models.length;
    this.state.models = this.state.models.filter(model => model.key !== key);
    if (before === this.state.models.length) return false;
    await this.persist();
    return true;
  }

  async importProviderModels(providerId: string): Promise<CustomModelDefinition[]> {
    const provider = this.proxy.getAgentProvider(providerId);
    if (!provider) throw Object.assign(new Error('Provider is not connected.'), { status: 409 });
    const models = [...new Set(await provider.getAvailableModels())].filter(id => id && id.length <= 500).slice(0, 500);
    const imported: CustomModelDefinition[] = [];
    for (const id of models) {
      const key = `${providerId}:${id}`;
      const existing = this.state.models.find(model => model.key === key);
      if (existing) { imported.push(existing); continue; }
      imported.push(await this.upsertModel({ provider: providerId, id, name: id, capabilities: { toolCalls: true } }));
    }
    return imported;
  }

  async testModel(key: string): Promise<{ ok: true; model: string; checkedAt: string }> {
    const model = this.state.models.find(item => item.key === key);
    if (!model) throw Object.assign(new Error('Custom model not found.'), { status: 404 });
    const provider = this.proxy.getAgentProvider(model.provider);
    if (!provider) throw Object.assign(new Error('Provider is not connected.'), { status: 409 });
    await provider.chat([{ id: 'model-test', role: 'user', content: 'Reply with OK.', timestamp: new Date() }], {
      model: model.id, maxTokens: 4,
    });
    return { ok: true, model: model.id, checkedAt: new Date().toISOString() };
  }

  private readSecrets(id: string): ProviderSecrets | undefined {
    const volatile = this.volatileSecrets.get(id);
    if (volatile) return volatile;
    const encrypted = this.secretStore?.get(`provider:${id}`);
    if (!encrypted) return undefined;
    try { return JSON.parse(encrypted) as ProviderSecrets; } catch { return undefined; }
  }

  private async saveSecrets(id: string, value: ProviderSecrets): Promise<void> {
    this.volatileSecrets.set(id, structuredClone(value));
    if (this.secretStore) await this.secretStore.set(`provider:${id}`, JSON.stringify(value));
  }

  private applyProvider(record: StoredProvider): void {
    const secrets = this.readSecrets(record.id);
    if (!secrets) return;
    const config: ProviderConfig = {
      type: record.id,
      baseUrl: record.baseUrl,
      apiKey: secrets.apiKey ?? 'custom',
      customHeaders: secrets.headers,
      model: this.state.models.find(model => model.provider === record.id)?.id,
    };
    const provider = record.dialect === 'openai-completions' ? new OpenAiProvider(config)
      : record.dialect === 'openai-responses' ? new OpenAiResponsesProvider(config)
        : record.dialect === 'anthropic' ? new AnthropicProvider(config)
          : new GeminiProvider(config);
    this.proxy.setCustomProvider(record.id, provider);
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}
