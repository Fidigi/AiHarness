import { lstat, mkdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  CredentialRedactor} from '@ai-harness/core';
import {
  AnthropicProvider, AnthropicOAuthProvider,
  atomicWriteStableFile,
  discoverProviderModelIds,
  getProviderPublishedModels,
  GeminiProvider,
  OpenAiProvider,
  OpenAiResponsesProvider,
  OpenAiMixedProvider,
  OPENAI_RESPONSE_MODELS,
  MistralProvider,
  CerebrasProvider,
  CEREBRAS_MODELS,
  DeepSeekProvider,
  DEEPSEEK_MODELS,
  GroqProvider,
  GROQ_MODELS,
  ZaiProvider,
  ZAI_MODELS,
  MoonshotProvider,
  MOONSHOT_MODELS,
  NvidiaProvider,
  NVIDIA_MODELS,
  AntLingProvider, ANT_LING_MODELS,
  BasetenProvider, BASETEN_MODELS,
  FireworksProvider, FIREWORKS_MODELS,
  HuggingFaceProvider, HUGGINGFACE_MODELS,
  KimiCodingProvider, KimiCodingOAuthProvider, KIMI_CODING_MODELS, getKimiCodingOAuthConfig,
  MetaProvider, META_MODELS,
  MiniMaxProvider, MINIMAX_MODELS,
  MiniMaxCnProvider, MINIMAX_CN_MODELS,
  OpenCodeGoProvider, OPENCODE_GO_MODELS,
  OpenCodeProvider, OPENCODE_MODELS,
  TogetherProvider, TOGETHER_MODELS,
  XaiProvider, XAI_MODELS,
  XiaomiProvider, XIAOMI_MODELS,
  MoonshotCnProvider, MOONSHOT_CN_MODELS,
  QwenTokenPlanProvider, QwenTokenPlanCnProvider, QwenTokenPlanIndividualProvider,
  XiaomiTokenPlanAmsProvider, XiaomiTokenPlanCnProvider, XiaomiTokenPlanSgpProvider, ZaiCodingCnProvider,
  TOKEN_PLAN_MODELS,
  OpenRouterProvider,
  CloudflareWorkersAiMixedProvider,
  TypesafeProvider,
  RadiusProvider,
  getRadiusOAuthConfig,
  type ProviderOAuthCredential,
  type RadiusOAuthCredential, type KimiCodingOAuthCredential, type AnthropicOAuthCredential, type AiProvider,
  CloudflareAiGatewayProvider, CLOUDFLARE_AI_GATEWAY_MODELS,
  VercelAiGatewayProvider, VERCEL_AI_GATEWAY_MODELS,
  CLOUDFLARE_CHAT_MODELS,
  OPENROUTER_MESSAGE_MODELS,
  OPENROUTER_COMPLETION_MODELS,
  ProviderCredentialService,
  readBoundedResourceText,
  type CustomModelDefinition,
  type CustomProviderDefinition,
  type ModelCapabilities,
  type ProviderConfig,
  type ProviderDialect,
} from '@ai-harness/core';
import type { AiProxyServer } from '../api/proxy.js';
import { getPublishedModelMetadata } from './model-catalog.js';
import { EncryptedCredentialStore } from '../security/credential-store.js';

const BUILTIN_IDS = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock', 'github-copilot', 'openai-codex']);
const NATIVE_AUTH_DIALECTS = ['radius', 'kimi-coding', 'openrouter', 'anthropic'];
const MAX_CUSTOM_PROVIDERS = 256;
const MAX_CUSTOM_MODELS = 10_000;
const MAX_PROVIDER_SECRET_BYTES = 64 * 1024;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const registryMutations = new Map<string, Promise<void>>();
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'cookie', 'set-cookie',
  'authorization', 'openai-beta', 'session-id', 'x-client-request-id',
]);

interface StoredProvider {
  id: string;
  /** Stable private-store identity, retained on rename. */
  credentialId?: string;
  disconnected?: boolean;
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
  /** Administrative snapshot only; live native requests always resolve the service. */
  oauth?: ProviderOAuthCredential;
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
  let parsed: URL;
  try { parsed = new URL(boundedString(value, 'baseUrl', 2_000)); }
  catch { badRequest('baseUrl must be an HTTP(S) URL without credentials, a query, or a fragment.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    badRequest('baseUrl must be an HTTP(S) URL without credentials, a query, or a fragment.');
  }
  return parsed.toString().replace(/\/$/, '');
}

// One composition table binds each newly admitted dialect to its owning chat whitelist.
const NATIVE_DIALECTS = {
  'ant-ling': { Adapter: AntLingProvider, models: ANT_LING_MODELS },
  baseten: { Adapter: BasetenProvider, models: BASETEN_MODELS },
  fireworks: { Adapter: FireworksProvider, models: FIREWORKS_MODELS },
  huggingface: { Adapter: HuggingFaceProvider, models: HUGGINGFACE_MODELS },
  'kimi-coding': { Adapter: KimiCodingProvider, models: KIMI_CODING_MODELS },
  meta: { Adapter: MetaProvider, models: META_MODELS },
  minimax: { Adapter: MiniMaxProvider, models: MINIMAX_MODELS },
  'minimax-cn': { Adapter: MiniMaxCnProvider, models: MINIMAX_CN_MODELS },
  'opencode-go': { Adapter: OpenCodeGoProvider, models: OPENCODE_GO_MODELS },
  opencode: { Adapter: OpenCodeProvider, models: OPENCODE_MODELS },
  together: { Adapter: TogetherProvider, models: TOGETHER_MODELS },
  xai: { Adapter: XaiProvider, models: XAI_MODELS },
  xiaomi: { Adapter: XiaomiProvider, models: XIAOMI_MODELS },
  'moonshot-cn': { Adapter: MoonshotCnProvider, models: MOONSHOT_CN_MODELS },
  'qwen-token-plan': { Adapter: QwenTokenPlanProvider, models: TOKEN_PLAN_MODELS['qwen-token-plan'] },
  'qwen-token-plan-cn': { Adapter: QwenTokenPlanCnProvider, models: TOKEN_PLAN_MODELS['qwen-token-plan-cn'] },
  'qwen-token-plan-individual': { Adapter: QwenTokenPlanIndividualProvider, models: TOKEN_PLAN_MODELS['qwen-token-plan-individual'] },
  'xiaomi-token-plan-ams': { Adapter: XiaomiTokenPlanAmsProvider, models: TOKEN_PLAN_MODELS['xiaomi-token-plan-ams'] },
  'xiaomi-token-plan-cn': { Adapter: XiaomiTokenPlanCnProvider, models: TOKEN_PLAN_MODELS['xiaomi-token-plan-cn'] },
  'xiaomi-token-plan-sgp': { Adapter: XiaomiTokenPlanSgpProvider, models: TOKEN_PLAN_MODELS['xiaomi-token-plan-sgp'] },
  'zai-coding-cn': { Adapter: ZaiCodingCnProvider, models: TOKEN_PLAN_MODELS['zai-coding-cn'] },
  'cloudflare-ai-gateway': { Adapter: CloudflareAiGatewayProvider, models: CLOUDFLARE_AI_GATEWAY_MODELS },
  'vercel-ai-gateway': { Adapter: VercelAiGatewayProvider, models: VERCEL_AI_GATEWAY_MODELS },
  typesafe: { Adapter: TypesafeProvider, models: [] }, // Classifier-only: never import or admit a chat row.
};

function nativeDialect(value: string | undefined) {
  return value && Object.hasOwn(NATIVE_DIALECTS, value)
    ? NATIVE_DIALECTS[value as keyof typeof NATIVE_DIALECTS] : undefined;
}

function dialect(value: unknown): ProviderDialect {
  if (!['openai', 'openai-completions', 'openai-responses', 'anthropic', 'google', 'mistral-conversations', 'openrouter', 'cloudflare-workers-ai', 'cerebras', 'deepseek', 'groq', 'zai', 'moonshot', 'nvidia', 'radius', ...Object.keys(NATIVE_DIALECTS)].includes(String(value))) {
    badRequest('Unsupported provider dialect.');
  }
  return value as ProviderDialect;
}

function validateDialectModel(dialect: ProviderDialect | undefined, id: string): void {
  const native = nativeDialect(dialect);
  if (native && !native.models.some(model => model.id === id)) {
    badRequest('Native chat model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'openai' && !OPENAI_RESPONSE_MODELS.some(model => model.id === id)) {
    badRequest('OpenAI response model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'cerebras' && !CEREBRAS_MODELS.some(model => model.id === id)) {
    badRequest('Cerebras chat model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'deepseek' && !DEEPSEEK_MODELS.some(model => model.id === id)) {
    badRequest('DeepSeek chat model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'nvidia' && !NVIDIA_MODELS.some(model => model.id === id)) {
    badRequest('Nvidia chat model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'moonshot' && !MOONSHOT_MODELS.some(model => model.id === id)) {
    badRequest('Moonshot chat model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'zai' && !ZAI_MODELS.some(model => model.id === id)) {
    badRequest('Z.ai chat model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'groq' && !GROQ_MODELS.some(model => model.id === id)) {
    badRequest('Groq chat model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'cloudflare-workers-ai' && !CLOUDFLARE_CHAT_MODELS.some(model => model.id === id)) {
    badRequest('Cloudflare chat model is not supported.', 'INVALID_MODEL');
  }
  if (dialect === 'openrouter' && !OPENROUTER_MESSAGE_MODELS.some(model => model.id === id)
    && !OPENROUTER_COMPLETION_MODELS.some(model => model.id === id)) {
    badRequest('OpenRouter chat model is not supported.', 'INVALID_MODEL');
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function storedTimestamp(value: unknown): string {
  const timestamp = boundedString(value, 'timestamp', 64);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) badRequest('Provider registry timestamp is invalid.');
  } catch {
    badRequest('Provider registry timestamp is invalid.');
  }
  return timestamp;
}

function parseRegistryState(value: unknown): RegistryState {
  if (!isRecord(value) || value.version !== 1
    || Object.keys(value).some(key => !['version', 'providers', 'models'].includes(key))
    || !Array.isArray(value.providers) || value.providers.length > MAX_CUSTOM_PROVIDERS
    || !Array.isArray(value.models) || value.models.length > MAX_CUSTOM_MODELS) {
    badRequest('Provider registry is invalid.');
  }
  const providers = value.providers.map(raw => {
    if (!isRecord(raw) || Object.keys(raw).some(key => !['id', 'credentialId', 'disconnected', 'name', 'baseUrl', 'dialect', 'headerNames', 'createdAt', 'updatedAt'].includes(key))
      || raw.disconnected !== undefined && typeof raw.disconnected !== 'boolean'
      || raw.credentialId !== undefined && (typeof raw.credentialId !== 'string'
        || !/^(?:custom-[a-f0-9-]{36}|[a-z][a-z0-9_-]{1,63})$/.test(raw.credentialId)
        || BUILTIN_IDS.has(raw.credentialId))
      || !Array.isArray(raw.headerNames) || raw.headerNames.length > 40) {
      badRequest('Provider registry is invalid.');
    }
    const names = raw.headerNames.map(name => {
      if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name)
        || FORBIDDEN_HEADERS.has(name.toLowerCase())) badRequest('Provider registry is invalid.');
      return name;
    });
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) {
      badRequest('Provider registry is invalid.');
    }
    return {
      id: providerId(raw.id),
      ...(raw.credentialId === undefined ? {} : { credentialId: boundedString(raw.credentialId, 'credential identity', 100) }),
      ...(raw.disconnected === true ? { disconnected: true } : {}),
      name: boundedString(raw.name, 'name', 200),
      baseUrl: baseUrl(raw.baseUrl),
      dialect: dialect(raw.dialect),
      headerNames: [...names].sort(),
      createdAt: storedTimestamp(raw.createdAt),
      updatedAt: storedTimestamp(raw.updatedAt),
    } satisfies StoredProvider;
  });
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) {
    badRequest('Provider registry is invalid.');
  }
  if (new Set(providers.map(provider => provider.credentialId ?? provider.id)).size !== providers.length) {
    badRequest('Provider registry credential identities are invalid.');
  }
  const configuredProviders = new Set(providers.map(provider => provider.id));
  const models = value.models.map(raw => {
    if (!isRecord(raw) || Object.keys(raw).some(key => !['key', 'provider', 'id', 'name', 'capabilities', 'contextWindow', 'maxOutputTokens', 'pricing', 'compatibility', 'createdAt', 'updatedAt'].includes(key))) {
      badRequest('Provider registry is invalid.', 'INVALID_MODEL');
    }
    const provider = boundedString(raw.provider, 'provider', 64).toLowerCase();
    if (!BUILTIN_IDS.has(provider) && !configuredProviders.has(provider)) {
      badRequest('Provider registry is invalid.', 'INVALID_MODEL');
    }
    const id = boundedString(raw.id, 'model id', 500);
    validateDialectModel(providers.find(item => item.id === provider)?.dialect, id);
    if (raw.key !== `${provider}:${id}`) badRequest('Provider registry is invalid.', 'INVALID_MODEL');
    const pricingInput = raw.pricing === undefined ? undefined : raw.pricing;
    if (pricingInput !== undefined && !isRecord(pricingInput)) {
      badRequest('Provider registry is invalid.', 'INVALID_MODEL');
    }
    const pricing = pricingInput ? {
      inputPerMillion: optionalPrice(pricingInput.inputPerMillion, 'input price'),
      outputPerMillion: optionalPrice(pricingInput.outputPerMillion, 'output price'),
      cacheReadPerMillion: optionalPrice(pricingInput.cacheReadPerMillion, 'cache read price'),
      cacheWritePerMillion: optionalPrice(pricingInput.cacheWritePerMillion, 'cache write price'),
    } : undefined;
    if (raw.compatibility !== undefined && (!isRecord(raw.compatibility)
      || Object.keys(raw.compatibility).length > 50)) {
      badRequest('Provider registry is invalid.', 'INVALID_MODEL');
    }
    const compatibility = raw.compatibility === undefined ? undefined : Object.fromEntries(
      Object.entries(raw.compatibility).map(([name, item]) => {
        if (!/^[a-zA-Z][\w.-]{0,99}$/.test(name)
          || !['string', 'number', 'boolean'].includes(typeof item)
          || typeof item === 'number' && !Number.isFinite(item)
          || typeof item === 'string' && item.length > 1_000) {
          badRequest('Provider registry is invalid.', 'INVALID_MODEL');
        }
        return [name, item as string | number | boolean];
      }),
    );
    return {
      key: `${provider}:${id}`,
      provider,
      id,
      name: boundedString(raw.name, 'model name', 500),
      capabilities: capabilities(raw.capabilities),
      ...(optionalPositiveInteger(raw.contextWindow, 'context window') ? {
        contextWindow: optionalPositiveInteger(raw.contextWindow, 'context window'),
      } : {}),
      ...(optionalPositiveInteger(raw.maxOutputTokens, 'maximum output') ? {
        maxOutputTokens: optionalPositiveInteger(raw.maxOutputTokens, 'maximum output'),
      } : {}),
      ...(pricing && Object.values(pricing).some(item => item !== undefined) ? { pricing } : {}),
      ...(compatibility && Object.keys(compatibility).length ? { compatibility } : {}),
      createdAt: storedTimestamp(raw.createdAt),
      updatedAt: storedTimestamp(raw.updatedAt),
    } satisfies CustomModelDefinition;
  });
  if (new Set(models.map(model => model.key)).size !== models.length) {
    badRequest('Provider registry is invalid.', 'INVALID_MODEL');
  }
  return { version: 1, providers, models };
}

/** Atomic non-secret custom provider/model registry with separately encrypted credentials. */
export class ProviderRegistryService {
  private state: RegistryState = { version: 1, providers: [], models: [] };
  private readonly volatileSecrets = new Map<string, ProviderSecrets>();
  private readonly secretStore?: EncryptedCredentialStore;
  private readonly credentialService: ProviderCredentialService;
  private writeQueue: Promise<void> = Promise.resolve();
  private source?: string;
  private sourceIdentity?: Stats;
  private readonly revisionKey = randomBytes(32);
  private readonly nativeLogins = new Map<string, { controller: AbortController; identity?: Stats; fingerprint: string }>();
  private cancelRadiusLogin(id: string): void { this.nativeLogins.get(id)?.controller.abort(); }

  constructor(
    private readonly filePath: string,
    private readonly proxy: AiProxyServer,
    secretsFile: string,
    masterKey = process.env.AI_HARNESS_MASTER_KEY,
    private readonly redactor: CredentialRedactor = proxy.getCredentialRedactor(),
  ) {
    if (masterKey) this.secretStore = new EncryptedCredentialStore(secretsFile, masterKey);
    this.credentialService = new ProviderCredentialService({
      store: this.secretStore,
      namespace: 'provider',
      redactor: this.redactor,
    });
  }

  async load(): Promise<void> {
    try {
      const { source, identity } = await this.readSource();
      const state: RegistryState = source === undefined ? { version: 1, providers: [], models: [] } : parseRegistryState(JSON.parse(source));
      this.source = source;
      this.sourceIdentity = identity;
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, providers: [], models: [] };
      this.source = undefined;
      this.sourceIdentity = undefined;
    }
    await this.secretStore?.load();
    await this.migrateLegacySecrets();
    await this.credentialService.load();
    for (const [id, login] of this.nativeLogins) {
      if (!this.sameIdentity(login.identity, this.sourceIdentity) || JSON.stringify(this.state.providers.find(provider => provider.id === id)) !== login.fingerprint) this.cancelRadiusLogin(id);
    }
    for (const provider of this.state.providers) {
      await this.hydrateSecrets(provider.id);
      this.applyProvider(provider);
    }
  }

  /** Canonical reconciliation after a stale/uncertain outcome. */
  async reload(): Promise<void> {
    return this.withMutation(async () => {
      const before = this.state.providers.map(provider => provider.id);
      // Keep the last known metadata during the read; load publishes an observed missing source as empty.
      const previous = this.state;
      const source = this.source;
      const identity = this.sourceIdentity;
      try { await this.load(); }
      catch (error) { this.state = previous; this.source = source; this.sourceIdentity = identity; throw error; }
      for (const id of before) {
        if (!this.state.providers.some(provider => provider.id === id)) {
          this.proxy.removeProvider(id);
          this.volatileSecrets.delete(id);
        }
      }
    });
  }

  getRevision(): string {
    return createHmac('sha256', this.revisionKey).update(this.source ?? '').digest('hex');
  }

  listProviders(): Array<CustomProviderDefinition & { revision: string }> {
    return this.state.providers.map(({ credentialId: _privateIdentity, ...provider }) => ({
      ...provider,
      revision: this.getRevision(),
      configured: this.proxy.isConfigured(provider.id) && (!NATIVE_AUTH_DIALECTS.includes(provider.dialect) || this.proxy.getAgentProvider(provider.id)?.validateConfig() === true),
      modelCount: this.state.models.filter(model => model.provider === provider.id).length,
    }));
  }

  hasCredentials(id: string): boolean { return Boolean(this.readSecrets(id)); }
  hasPendingNativeOAuth(id: string): boolean { return this.nativeLogins.has(id); }
  hasPendingRadiusOAuth(id: string): boolean { return this.hasPendingNativeOAuth(id) && this.state.providers.some(provider => provider.id === id && provider.dialect === 'radius'); }
  hasNativeOAuth(id: string): boolean { return this.state.providers.some(provider => provider.id === id && ['radius', 'kimi-coding', 'anthropic'].includes(provider.dialect)) && Boolean(this.readSecrets(id)?.oauth); }
  hasRadiusOAuth(id: string): boolean { return this.state.providers.some(provider => provider.id === id && provider.dialect === 'radius') && this.hasNativeOAuth(id); }

  /** One existing custom record owns the issuer, headers, encrypted slot and eventual runtime admission. */
  async prepareRadiusOAuth(idValue: string, parent: AbortSignal) { return this.prepareIssuerOAuth(idValue, parent, 'radius'); }
  async prepareNativeOAuth(idValue: string, parent: AbortSignal) { return this.prepareIssuerOAuth(idValue, parent); }
  private async prepareIssuerOAuth(idValue: string, parent: AbortSignal, expectedIssuer?: 'radius') {
    parent.throwIfAborted();
    return this.withMutation(async () => {
      parent.throwIfAborted();
      const id = providerId(idValue);
      let record = this.state.providers.find(provider => provider.id === id && NATIVE_AUTH_DIALECTS.includes(provider.dialect) && (!expectedIssuer || provider.dialect === expectedIssuer));
      if (!record) throw Object.assign(new Error('OAuth is unavailable for this provider.'), { status: 404 });
      if (!this.secretStore) throw Object.assign(new Error('OAuth credential storage is unavailable.'), { status: 409 });
      const issuer = record.dialect === 'radius' ? 'radius' : record.dialect === 'openrouter' ? 'openrouter' : record.dialect === 'anthropic' ? 'anthropic' : 'kimi-coding';
      const realm = issuer === 'radius' ? getRadiusOAuthConfig(record.baseUrl).gateway : issuer === 'openrouter' ? 'https://openrouter.ai' : issuer === 'anthropic' ? 'https://platform.claude.com' : this.kimiIssuerHost(this.readSecrets(id)), identity = record.credentialId ?? id;
      this.cancelRadiusLogin(id);
      const login = { controller: new AbortController(), identity: this.sourceIdentity, fingerprint: JSON.stringify(record) };
      this.nativeLogins.set(id, login);
      const signal = AbortSignal.any([parent, login.controller.signal]);
      const release = () => { if (this.nativeLogins.get(id) === login) this.nativeLogins.delete(id); };
      if (signal.aborted) release(); else signal.addEventListener('abort', release, { once: true });
      let publish: Awaited<ReturnType<ProviderCredentialService['prepareOAuthLogin']>> | undefined, publishKey: Awaited<ReturnType<ProviderCredentialService['prepareApiKeyLogin']>> | undefined;
      try { await this.assertSource(); signal.throwIfAborted();
        if (issuer === 'openrouter') publishKey = await this.credentialService.prepareApiKeyLogin(identity, signal);
        else publish = await this.credentialService.prepareOAuthLogin(identity, signal);
      }
      catch (error) { login.controller.abort(); throw error; }
      const guard = async () => {
        signal.throwIfAborted(); await this.assertSource();
        if (!this.sameIdentity(login.identity, this.sourceIdentity) || JSON.stringify(this.state.providers.find(provider => provider.id === id)) !== login.fingerprint) throw Object.assign(new Error('Provider changed during login.'), { status: 409 });
      };
      return { issuer, realm, gateway: realm, signal, redactor: this.redactor, publish: async (credential: RadiusOAuthCredential | KimiCodingOAuthCredential | AnthropicOAuthCredential | { apiKey: string }): Promise<() => void> => this.withMutation(async () => {
        await guard();
        if ('apiKey' in credential ? issuer !== 'openrouter' : issuer === 'openrouter' || credential.subscription.provider !== issuer
          || (credential.subscription.provider === 'radius' ? credential.subscription.gateway : credential.subscription.provider === 'kimi-coding' ? credential.subscription.oauthHost : 'https://platform.claude.com') !== realm) throw new Error('Invalid native issuer.');
        const secrets: ProviderSecrets = { ...('apiKey' in credential ? { apiKey: credential.apiKey } : { oauth: { version: 1 as const, type: 'oauth' as const, ...credential } }), headers: this.readSecrets(id)?.headers ?? {} };
        const prepared = issuer === 'openrouter' ? new OpenRouterProvider({ type: id, baseUrl: record!.baseUrl, apiKey: secrets.apiKey, customHeaders: secrets.headers, model: this.state.models.find(model => model.provider === id)?.id }) : this.createNativeOAuthProvider(record!, secrets, secrets.oauth);
        if (!prepared || issuer === 'openrouter' && !prepared.validateConfig()) throw new Error('Native OAuth provider is unavailable.');
        await guard();
        if (record!.disconnected) {
          const previous = this.state, connected = { ...record!, disconnected: false, updatedAt: new Date().toISOString() };
          this.state = { ...previous, providers: previous.providers.map(provider => provider.id === id ? connected : provider) };
          try { await this.persist(); record = connected; login.identity = this.sourceIdentity; login.fingerprint = JSON.stringify(record); } catch (error) { this.state = previous; throw error; }
        }
        if ('apiKey' in credential) await publishKey!(credential.apiKey); else await publish!(credential); signal.throwIfAborted();
        this.volatileSecrets.set(id, secrets); this.proxy.removeProvider(id);
        await this.proxy.resetNetworkDispatchers(); await guard();
        return () => {
          signal.throwIfAborted();
          if (!this.sameIdentity(login.identity, this.sourceIdentity) || JSON.stringify(this.state.providers.find(provider => provider.id === id)) !== login.fingerprint) throw new Error('Provider changed during login.');
          this.proxy.setCustomProvider(id, prepared);
        };
      }) };
    });
  }

  getModels(): CustomModelDefinition[] { return structuredClone(this.state.models); }

  async upsertProvider(input: Record<string, unknown>, existingId?: string): Promise<CustomProviderDefinition> {
    if (existingId) this.cancelRadiusLogin(providerId(existingId));
    return this.withMutation(() => this.upsertProviderUnlocked(input, existingId));
  }

  private async upsertProviderUnlocked(input: Record<string, unknown>, existingId?: string): Promise<CustomProviderDefinition> {
    if (!isRecord(input) || Object.keys(input).some(key => !['id', 'name', 'baseUrl', 'dialect', 'headers', 'apiKey'].includes(key))) {
      badRequest('Provider input contains unknown fields.');
    }
    const id = providerId(existingId ?? input.id);
    if (existingId && input.id !== undefined && providerId(input.id) !== id) {
      badRequest('Use the provider rename operation to change identity.', 'PROVIDER_RENAME_REQUIRED');
    }
    const previous = this.state.providers.find(provider => provider.id === id);
    if (previous && !existingId) badRequest('Provider already exists.', 'PROVIDER_EXISTS');
    if (!previous && existingId) throw Object.assign(new Error('Custom provider not found.'), { status: 404 });
    const now = new Date().toISOString();
    const customHeaders = input.headers === undefined ? undefined : headers(input.headers);
    const record: StoredProvider = {
      id,
      // Keep the existing first-use credential namespace contract. A public ID
      // retained by a renamed record is reserved; reusing it gets a fresh identity.
      credentialId: previous?.credentialId ?? (previous ? previous.id
        : this.state.providers.some(provider => (provider.credentialId ?? provider.id) === id)
          ? `custom-${randomUUID()}` : id),
      name: input.name === undefined && previous ? previous.name : boundedString(input.name, 'name', 200),
      baseUrl: input.baseUrl === undefined && previous ? previous.baseUrl : baseUrl(input.baseUrl),
      dialect: input.dialect === undefined && previous ? previous.dialect : dialect(input.dialect),
      headerNames: customHeaders === undefined ? previous?.headerNames ?? [] : Object.keys(customHeaders).sort(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    for (const model of this.state.models.filter(model => model.provider === id)) {
      validateDialectModel(record.dialect, model.id);
    }
    if (previous && NATIVE_AUTH_DIALECTS.includes(previous.dialect)) { await this.credentialService.load(); await this.hydrateSecrets(id); }
    const currentSecrets = this.readSecrets(id) ?? { headers: {} };
    if (!previous && this.state.providers.length >= MAX_CUSTOM_PROVIDERS) {
      badRequest('Too many custom providers are configured.');
    }
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') badRequest('apiKey is invalid.');
    if (typeof input.apiKey === 'string' && input.apiKey
      && (/[\u0000-\u001f\u007f-\u009f]/u.test(input.apiKey)
        || Buffer.byteLength(input.apiKey) > MAX_PROVIDER_SECRET_BYTES)) {
      badRequest('apiKey is invalid.');
    }
    const nextSecrets: ProviderSecrets = {
      ...(typeof input.apiKey === 'string' ? (input.apiKey ? { apiKey: input.apiKey } : {})
        : currentSecrets.oauth ? { oauth: currentSecrets.oauth } : currentSecrets.apiKey ? { apiKey: currentSecrets.apiKey } : {}),
      headers: customHeaders ?? currentSecrets.headers,
    };
    // Radius may load its explicit private catalogue locally; reject unsafe cache before mutating credentials/metadata.
    const preparedNative = this.createNativeOAuthProvider(record, nextSecrets);
    await this.assertSource();
    const preserveKey = previous?.dialect === 'openrouter' && input.apiKey === undefined;
    await this.saveSecrets(id, nextSecrets, record.credentialId, preserveKey);
    const credentialRevision = this.secretStore?.getRevision();
    const previousState = this.state;
    this.state = {
      ...previousState,
      providers: [...previousState.providers.filter(provider => provider.id !== id), record]
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
    try { await this.persist(); }
    catch (error) {
      this.state = previousState;
      try { await this.restoreSecrets(id, currentSecrets, nextSecrets, credentialRevision, record.credentialId, preserveKey); }
      catch { throw Object.assign(new Error('Provider update rollback failed.'), { status: 500, uncertain: true }); }
      throw error;
    }
    this.cancelRadiusLogin(id);
    await this.proxy.resetNetworkDispatchers();
    this.applyProvider(record, preparedNative);
    return this.listProviders().find(provider => provider.id === id)!;
  }

  /** Rebind only metadata; the credential identity and encrypted bytes never move.
   * Host must hold its fresh whole-configuration transaction around commit.
   */
  async renameProvider(oldValue: string, newValue: string, revision: string,
    rebind: (commit: () => Promise<void>) => Promise<void>): Promise<CustomProviderDefinition> {
    return this.withMutation(async () => {
      const oldId = providerId(oldValue);
      const newId = providerId(newValue);
      await this.assertSource();
      if (revision !== this.getRevision()) {
        throw Object.assign(new Error('Provider registry changed; refresh before retrying.'), {
          status: 409, code: 'PROVIDER_REGISTRY_STALE',
        });
      }
      const previous = this.state.providers.find(provider => provider.id === oldId);
      if (!previous) throw Object.assign(new Error('Custom provider not found.'), { status: 404 });
      if (oldId === newId) return this.listProviders().find(provider => provider.id === oldId)!;
      if (this.nativeLogins.has(oldId)) throw Object.assign(new Error('Provider login is pending.'), { status: 409, code: 'PROVIDER_OAUTH_PENDING' });
      if (this.state.providers.some(provider => provider.id === newId) || this.proxy.getAgentProvider(newId)) {
        throw Object.assign(new Error('Provider already exists.'), { status: 409, code: 'PROVIDER_EXISTS' });
      }
      const before = this.state;
      const renamed: StoredProvider = { ...previous, id: newId,
        credentialId: previous.credentialId ?? oldId, updatedAt: new Date().toISOString() };
      let committed = false;
      try {
        await rebind(async () => {
          if (committed) throw new Error('Provider rename commit already called.');
          this.state = { ...before,
            providers: before.providers.map(provider => provider.id === oldId ? renamed : provider),
            models: before.models.map(model => model.provider === oldId
              ? { ...model, provider: newId, key: `${newId}:${model.id}` } : model),
          };
          try { await this.persist(); } catch (error) { this.state = before; throw error; }
          committed = true;
        });
        if (!committed) throw new Error('Provider reference transaction did not commit.');
      } catch (error) {
        if (committed) {
          const published = this.state;
          this.state = before;
          try { await this.persist(); }
          catch {
            this.state = published;
            const secrets = this.readSecrets(oldId);
            if (secrets) this.volatileSecrets.set(newId, secrets);
            this.volatileSecrets.delete(oldId);
            this.proxy.removeProvider(oldId);
            this.applyProvider(renamed);
            throw Object.assign(new Error('Provider rename outcome is uncertain; refresh.'), {
              status: 500, code: 'PROVIDER_RENAME_UNCERTAIN', uncertain: true,
            });
          }
        }
        throw error;
      }
      const secrets = this.readSecrets(oldId);
      if (secrets) this.volatileSecrets.set(newId, secrets);
      this.volatileSecrets.delete(oldId);
      this.proxy.removeProvider(oldId);
      this.applyProvider(renamed);
      return this.listProviders().find(provider => provider.id === newId)!;
    });
  }

  async deleteProvider(idValue: string): Promise<boolean> {
    this.cancelRadiusLogin(providerId(idValue));
    return this.withMutation(() => this.deleteProviderUnlocked(idValue));
  }

  private async deleteProviderUnlocked(idValue: string): Promise<boolean> {
    const id = providerId(idValue);
    if (!this.state.providers.some(provider => provider.id === id)) return false;
    if (this.state.providers.some(provider => provider.id === id && NATIVE_AUTH_DIALECTS.includes(provider.dialect))) { await this.credentialService.load(); await this.hydrateSecrets(id); }
    await this.assertSource();
    const identity = this.storageId(id);
    const previousSecrets = this.readSecrets(id) ?? { headers: {} };
    this.cancelRadiusLogin(id);
    try {
      await this.saveSecrets(id, { headers: {} });
    } catch (error) {
      await this.restoreSecrets(id, previousSecrets, { headers: {} }, this.secretStore?.getRevision()).catch(() => undefined);
      throw error;
    }
    const credentialRevision = this.secretStore?.getRevision();
    const previous = this.state;
    this.state = {
      ...previous,
      providers: previous.providers.filter(provider => provider.id !== id),
      models: previous.models.filter(model => model.provider !== id),
    };
    try { await this.persist(); }
    catch (error) {
      this.state = previous;
      try { await this.restoreSecrets(id, previousSecrets, { headers: {} }, credentialRevision, identity); }
      catch {
        throw Object.assign(new Error('Provider deletion rollback failed.'), { status: 500, uncertain: true });
      }
      throw error;
    }
    this.proxy.removeProvider(id);
    this.volatileSecrets.delete(id);
    await this.proxy.resetNetworkDispatchers();
    return true;
  }

  async disconnect(idValue: string): Promise<CustomProviderDefinition> {
    this.cancelRadiusLogin(providerId(idValue));
    return this.withMutation(() => this.disconnectUnlocked(idValue));
  }

  private async disconnectUnlocked(idValue: string): Promise<CustomProviderDefinition> {
    const id = providerId(idValue);
    const provider = this.state.providers.find(item => item.id === id);
    if (!provider) throw Object.assign(new Error('Custom provider not found.'), { status: 404 });
    if (NATIVE_AUTH_DIALECTS.includes(provider.dialect)) { await this.credentialService.load(); await this.hydrateSecrets(id); }
    await this.assertSource();
    const previousSecrets = this.readSecrets(id) ?? { headers: {} };
    this.cancelRadiusLogin(id);
    try {
      await this.saveSecrets(id, { headers: {} });
    } catch (error) {
      try { await this.restoreSecrets(id, previousSecrets, { headers: {} }, this.secretStore?.getRevision()); }
      catch { throw Object.assign(new Error('Provider disconnection rollback failed.'), { status: 500, uncertain: true }); }
      throw error;
    }
    const credentialRevision = this.secretStore?.getRevision();
    const before = this.state;
    this.state = { ...before, providers: before.providers.map(item => item.id === id
      ? { ...item, disconnected: true, updatedAt: new Date().toISOString() } : item) };
    try { await this.persist(); }
    catch (error) {
      this.state = before;
      try { await this.restoreSecrets(id, previousSecrets, { headers: {} }, credentialRevision); }
      catch { throw Object.assign(new Error('Provider disconnection rollback failed.'), { status: 500, uncertain: true }); }
      throw error;
    }
    this.volatileSecrets.delete(id);
    this.proxy.removeProvider(id);
    await this.proxy.resetNetworkDispatchers();
    return this.listProviders().find(item => item.id === id)!;
  }

  async testProvider(idValue: string): Promise<{ ok: true; models: string[]; checkedAt: string }> {
    const id = providerId(idValue);
    const provider = this.proxy.getAgentProvider(id);
    if (!provider) throw Object.assign(new Error('Provider is not connected.'), { status: 409 });
    if (!provider.canDiscoverModels()) {
      throw Object.assign(new Error('Provider does not support connection discovery.'), { status: 409 });
    }
    const models = await discoverProviderModelIds(provider);
    return { ok: true, models: models.slice(0, 500), checkedAt: new Date().toISOString() };
  }

  async upsertModel(input: Record<string, unknown>, existingKey?: string): Promise<CustomModelDefinition> {
    return this.withMutation(() => this.upsertModelUnlocked(input, existingKey));
  }

  private async upsertModelUnlocked(input: Record<string, unknown>, existingKey?: string): Promise<CustomModelDefinition> {
    const provider = typeof input.provider === 'string' ? input.provider.trim().toLowerCase()
      : existingKey?.split(':')[0] ?? '';
    if (!provider || (!BUILTIN_IDS.has(provider) && !this.state.providers.some(item => item.id === provider))) {
      badRequest('Unknown model provider.', 'INVALID_MODEL');
    }
    const id = boundedString(input.id ?? existingKey?.slice(provider.length + 1), 'model id', 500);
    const providerRecord = this.state.providers.find(item => item.id === provider);
    validateDialectModel(providerRecord?.dialect, id);
    if (providerRecord?.dialect === 'radius') {
      const current = this.proxy.getAgentProvider(provider);
      if (!(current instanceof RadiusProvider) || !current.validateConfig() || !current.getCachedAvailableModelIds().includes(id)) {
        badRequest('Radius model is not in the current account catalogue.', 'INVALID_MODEL');
      }
    }
    const key = `${provider}:${id}`;
    const previous = this.state.models.find(model => model.key === (existingKey ?? key));
    const published = getPublishedModelMetadata(provider, id);
    if (existingKey && !previous) throw Object.assign(new Error('Custom model not found.'), { status: 404 });
    if (existingKey && existingKey !== key && this.state.models.some(model => model.key === key)) badRequest('Model already exists.', 'MODEL_EXISTS');
    if (!previous && this.state.models.length >= MAX_CUSTOM_MODELS) {
      badRequest('Too many custom models are configured.', 'INVALID_MODEL');
    }
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
      /^[a-zA-Z][\w.-]{0,99}$/.test(name)
        && ['string', 'number', 'boolean'].includes(typeof value)
        && (typeof value !== 'number' || Number.isFinite(value))
        && (typeof value !== 'string' || value.length <= 1_000)
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
    const previousState = this.state;
    this.state = {
      ...previousState,
      models: [...previousState.models.filter(item => item.key !== (existingKey ?? key)), model]
        .sort((left, right) => left.key.localeCompare(right.key)),
    };
    try { await this.persist(); }
    catch (error) { this.state = previousState; throw error; }
    return structuredClone(model);
  }

  async deleteModel(key: string): Promise<boolean> {
    return this.withMutation(() => this.deleteModelUnlocked(key));
  }

  private async deleteModelUnlocked(key: string): Promise<boolean> {
    const models = this.state.models.filter(model => model.key !== key);
    if (models.length === this.state.models.length) return false;
    const previousState = this.state;
    this.state = { ...previousState, models };
    try { await this.persist(); }
    catch (error) { this.state = previousState; throw error; }
    return true;
  }

  async importProviderModels(providerId: string): Promise<CustomModelDefinition[]> {
    const provider = this.proxy.getAgentProvider(providerId);
    if (!provider) throw Object.assign(new Error('Provider is not connected.'), { status: 409 });
    const models = await discoverProviderModelIds(provider);
    return this.withMutation(async () => {
      if (this.proxy.getAgentProvider(providerId) !== provider) {
        throw Object.assign(new Error('Provider changed during discovery; refresh before retrying.'), {
          status: 409, code: 'PROVIDER_REGISTRY_STALE',
        });
      }
      const imported: CustomModelDefinition[] = [];
      const profiles = new Map((getProviderPublishedModels(provider) ?? []).map(model => [model.id, model]));
      for (const id of models) {
        const key = `${providerId}:${id}`;
        const existing = this.state.models.find(model => model.key === key);
        if (existing) { imported.push(existing); continue; }
        const profile = profiles.get(id);
        imported.push(await this.upsertModelUnlocked({
          provider: providerId, id, name: profile?.name ?? id, capabilities: profile?.capabilities ?? { toolCalls: true },
          contextWindow: profile?.contextWindow, maxOutputTokens: profile?.maxOutputTokens, pricing: profile?.pricing,
        }));
      }
      return imported;
    });
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

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.filePath);
    const next = (registryMutations.get(key) ?? Promise.resolve()).then(operation);
    const queued = next.then(() => undefined, () => undefined);
    registryMutations.set(key, queued);
    void queued.then(() => { if (registryMutations.get(key) === queued) registryMutations.delete(key); });
    return next;
  }

  private readSecrets(id: string): ProviderSecrets | undefined {
    const value = this.volatileSecrets.get(id);
    return value ? structuredClone(value) : undefined;
  }

  private storageId(id: string): string {
    const record = this.state.providers.find(provider => provider.id === id);
    return record?.credentialId ?? id;
  }

  private async saveSecrets(id: string, value: ProviderSecrets, identity = this.storageId(id), preserveCredential = false): Promise<void> {
    this.redactor.add(value.apiKey); this.redactor.add(value.oauth?.accessToken); this.redactor.add(value.oauth?.refreshToken);
    this.redactor.addAll(Object.values(value.headers));
    const hasSecrets = Boolean(value.apiKey || value.oauth) || Object.keys(value.headers).length > 0;
    if (hasSecrets && !this.secretStore) {
      throw Object.assign(new Error('Credential storage is unavailable.'), { status: 503 });
    }
    if (this.secretStore) {
      await this.secretStore.update({
        // Metadata/header edits must not overwrite a refreshed native token or retained permanent key.
        ...(value.oauth || preserveCredential ? {} : { [`provider:${identity}`]: value.apiKey
          ? JSON.stringify({ version: 1, type: 'api-key', apiKey: value.apiKey }) : undefined }),
        [`provider-headers:${identity}`]: Object.keys(value.headers).length
          ? JSON.stringify(value.headers)
          : undefined,
      });
      this.credentialService.synchronizeFromStore(identity);
    } else {
      await this.credentialService.delete(identity);
    }
    if (preserveCredential) await this.hydrateSecrets(id);
    else if (hasSecrets) this.volatileSecrets.set(id, structuredClone(value));
    else this.volatileSecrets.delete(id);
  }

  private async restoreSecrets(id: string, before: ProviderSecrets, after: ProviderSecrets, revision?: string, identity = this.storageId(id), preserveCredential = false): Promise<void> {
    const openrouter = this.state.providers.some(provider => provider.id === id && provider.dialect === 'openrouter');
    if (!preserveCredential && (before.oauth && !after.oauth || openrouter && this.secretStore)) {
      const expected = after.apiKey ? JSON.stringify({ version: 1, type: 'api-key', apiKey: after.apiKey }) : undefined;
      const previous = before.oauth ? JSON.stringify(before.oauth) : before.apiKey ? JSON.stringify({ version: 1, type: 'api-key', apiKey: before.apiKey }) : undefined;
      if (!await this.secretStore?.compareAndSet(`provider:${identity}`, expected, previous, revision)) throw new Error('Credential rollback changed.');
      if (openrouter) preserveCredential = true;
    }
    await this.saveSecrets(id, before, identity, preserveCredential);
  }

  private async hydrateSecrets(id: string): Promise<void> {
    const stored = this.credentialService.readStoredCredential(this.storageId(id));
    const issuer = this.state.providers.find(provider => provider.id === id)?.dialect;
    const oauth = stored?.type === 'oauth' && (issuer === 'radius' || issuer === 'kimi-coding' || issuer === 'anthropic') && stored.subscription?.provider === issuer ? stored : undefined;
    const resolved = oauth ? undefined : await this.credentialService.resolve(this.storageId(id), { env: {} });
    const storedHeaders = this.secretStore?.get(this.headerStorageName(id));
    let customHeaders: Record<string, string> = {};
    if (storedHeaders) {
      try { customHeaders = headers(JSON.parse(storedHeaders)); }
      catch { customHeaders = {}; }
    }
    this.volatileSecrets.delete(id);
    const apiKey = resolved?.credential.type === 'api-key'
      ? resolved.credential.apiKey
      : resolved?.credential.accessToken;
    if (!apiKey && !oauth && !Object.keys(customHeaders).length) return;
    this.redactor.add(apiKey);
    this.redactor.addAll(Object.values(customHeaders));
    this.volatileSecrets.set(id, {
      ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}),
      headers: customHeaders,
    });
  }

  private async migrateLegacySecrets(): Promise<void> {
    if (!this.secretStore) return;
    for (const provider of this.state.providers) {
      const storageName = `provider:${this.storageId(provider.id)}`;
      const raw = this.secretStore.get(storageName);
      if (!raw) continue;
      let legacy: ProviderSecrets | undefined;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.version !== 1 && ('apiKey' in parsed || 'headers' in parsed)) {
          legacy = {
            ...(typeof parsed.apiKey === 'string' && parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
            headers: headers(parsed.headers),
          };
        }
      } catch { /* Invalid legacy records remain unavailable and are never reflected. */ }
      if (!legacy) continue;
      await this.secretStore.update({
        [storageName]: legacy.apiKey
          ? JSON.stringify({ version: 1, type: 'api-key', apiKey: legacy.apiKey })
          : undefined,
        [this.headerStorageName(provider.id)]: Object.keys(legacy.headers).length
          ? JSON.stringify(legacy.headers)
          : undefined,
      });
      this.credentialService.synchronizeFromStore(this.storageId(provider.id));
    }
  }

  private headerStorageName(id: string): string {
    return `provider-headers:${this.storageId(id)}`;
  }

  private kimiIssuerHost(secrets?: ProviderSecrets): string {
    const stored = secrets?.oauth?.subscription;
    return getKimiCodingOAuthConfig(process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || (stored?.provider === 'kimi-coding' ? stored.oauthHost : undefined)).tokenUrl.slice(0, -'/api/oauth/token'.length);
  }

  private nativeCredentialSource(record: StoredProvider, secrets: ProviderSecrets | undefined, issuer: 'radius' | 'kimi-coding' | 'anthropic', realm: string) {
    const bound = () => {
      const current = this.state.providers.find(provider => provider.id === record.id);
      return current && !current.disconnected && current.dialect === record.dialect && current.baseUrl === record.baseUrl
        && (current.credentialId ?? current.id) === (record.credentialId ?? record.id)
        && JSON.stringify(Object.entries(this.readSecrets(record.id)?.headers ?? {}).sort()) === JSON.stringify(Object.entries(secrets?.headers ?? {}).sort());
    };
    return async (signal?: AbortSignal, allowRefresh = true) => {
      if (!bound()) return undefined;
      const resolved = await this.credentialService.resolve(record.credentialId ?? record.id, { env: {}, subscriptionProvider: issuer,
        ...(issuer === 'radius' ? { radiusGateway: realm } : issuer === 'kimi-coding' ? { kimiOAuthHost: realm } : {}), signal, allowRefresh });
      return bound() && resolved?.credential.type === 'oauth' ? resolved.credential : undefined;
    };
  }

  private createNativeOAuthProvider(record: StoredProvider, secrets: ProviderSecrets | undefined, initial?: ProviderOAuthCredential): AiProvider | undefined {
    const model = this.state.models.find(model => model.provider === record.id)?.id;
    if (record.dialect === 'radius') {
      const gateway = getRadiusOAuthConfig(record.baseUrl).gateway;
      const native = secrets?.oauth?.subscription?.provider === 'radius' && secrets.oauth.subscription.gateway === gateway;
      const source = native ? this.nativeCredentialSource(record, secrets, 'radius', gateway) : undefined;
      const credential = initial ?? (source && secrets?.oauth?.expiresAt !== undefined && secrets.oauth.expiresAt > Date.now() + 60_000 ? secrets.oauth : undefined);
      return new RadiusProvider({ type: record.id, apiKey: secrets?.apiKey, customHeaders: secrets?.headers, gateway: record.baseUrl,
        catalogueDirectory: path.join(path.dirname(this.filePath), 'radius-models', record.credentialId ?? record.id), model }, source, credential);
    }
    if (record.dialect === 'anthropic' && secrets?.oauth?.subscription?.provider === 'anthropic') {
      return new AnthropicOAuthProvider({ type: record.id, baseUrl: record.baseUrl, customHeaders: secrets.headers, model }, this.nativeCredentialSource(record, secrets, 'anthropic', 'https://platform.claude.com'));
    }
    if (record.dialect === 'kimi-coding' && secrets?.oauth?.subscription?.provider === 'kimi-coding') {
      const oauthHost = this.kimiIssuerHost(secrets); if (oauthHost !== secrets.oauth.subscription.oauthHost) return undefined;
      return new KimiCodingOAuthProvider({ type: record.id, baseUrl: record.baseUrl, customHeaders: secrets.headers, model, oauthHost }, this.nativeCredentialSource(record, secrets, 'kimi-coding', oauthHost));
    }
    return undefined;
  }

  private applyProvider(record: StoredProvider, prepared?: AiProvider): void {
    if (record.disconnected) { this.proxy.removeProvider(record.id); return; }
    const secrets = this.readSecrets(record.id);
    const config: ProviderConfig = {
      type: record.id,
      baseUrl: record.baseUrl,
      apiKey: secrets?.apiKey,
      customHeaders: secrets?.headers,
      model: this.state.models.find(model => model.provider === record.id)?.id,
    };
    const Adapter = nativeDialect(record.dialect)?.Adapter;
    const provider = prepared ?? this.createNativeOAuthProvider(record, secrets) ?? (Adapter ? new Adapter(config)
      : record.dialect === 'openai-completions' ? new OpenAiProvider(config)
      : record.dialect === 'openai-responses' ? new OpenAiResponsesProvider(config)
        : record.dialect === 'mistral-conversations' ? new MistralProvider(config)
          : record.dialect === 'openrouter' ? new OpenRouterProvider(config)
            : record.dialect === 'cloudflare-workers-ai' ? new CloudflareWorkersAiMixedProvider(config)
              : record.dialect === 'openai' ? new OpenAiMixedProvider(config)
                : record.dialect === 'cerebras' ? new CerebrasProvider(config)
                  : record.dialect === 'deepseek' ? new DeepSeekProvider(config)
                    : record.dialect === 'nvidia' ? new NvidiaProvider(config)
                      : record.dialect === 'moonshot' ? new MoonshotProvider(config)
                        : record.dialect === 'zai' ? new ZaiProvider(config)
                          : record.dialect === 'groq' ? new GroqProvider(config)
                            : record.dialect === 'anthropic' ? new AnthropicProvider(config)
                              : new GeminiProvider(config));
    if (NATIVE_AUTH_DIALECTS.includes(record.dialect) && !provider.validateConfig()) { this.proxy.removeProvider(record.id); return; }
    this.proxy.setCustomProvider(record.id, provider);
  }

  private sameIdentity(first: Stats | undefined, second: Stats | undefined): boolean {
    if (!first || !second) return first === second;
    return first.dev === second.dev && first.ino === second.ino && first.size === second.size
      && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs
      && first.nlink === second.nlink && first.mode === second.mode;
  }

  private staleSource(): never {
    throw Object.assign(new Error('Provider registry changed; refresh before retrying.'), {
      status: 409, code: 'PROVIDER_REGISTRY_STALE',
    });
  }

  private async readSource(): Promise<{ source?: string; identity?: Stats }> {
    let before: Stats;
    try { before = await lstat(this.filePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    const source = await readBoundedResourceText(this.filePath, MAX_REGISTRY_BYTES);
    const after = await lstat(this.filePath);
    if (!this.sameIdentity(before, after)) this.staleSource();
    return { source, identity: after };
  }

  /** Bytes AND observed file identity, including rollback over this publication.
   * Rejects same-byte replacement/ABA; not an OS atomic compare-exchange against
   * arbitrary external writers racing between beforeCommit and rename.
   */
  private async assertSource(): Promise<void> {
    const current = await this.readSource();
    if (current.source !== this.source || !this.sameIdentity(current.identity, this.sourceIdentity)) this.staleSource();
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES) {
      return Promise.reject(Object.assign(new Error('Provider registry exceeds its size limit.'), { status: 409 }));
    }
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await atomicWriteStableFile(this.filePath, serialized, {
        overwrite: true,
        maxBytes: MAX_REGISTRY_BYTES,
        mode: 0o600,
        beforeCommit: () => this.assertSource(),
      });
      const published = await this.readSource();
      if (published.source !== serialized) this.staleSource();
      this.source = serialized;
      this.sourceIdentity = published.identity;
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}
