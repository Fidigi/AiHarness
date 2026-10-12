import { lstat, mkdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  CredentialRedactor} from '@ai-harness/core';
import {
  AnthropicProvider,
  atomicWriteStableFile,
  discoverProviderModelIds,
  GeminiProvider,
  OpenAiProvider,
  OpenAiResponsesProvider,
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

const BUILTIN_IDS = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock']);
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
      if (source !== undefined) {
        const state = parseRegistryState(JSON.parse(source));
        this.source = source;
        this.sourceIdentity = identity;
        this.state = state;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.secretStore?.load();
    await this.migrateLegacySecrets();
    await this.credentialService.load();
    for (const provider of this.state.providers) {
      await this.hydrateSecrets(provider.id);
      this.applyProvider(provider);
    }
  }

  /** Canonical reconciliation after a stale/uncertain outcome. */
  async reload(): Promise<void> {
    return this.withMutation(async () => {
      const before = this.state.providers.map(provider => provider.id);
      // Missing metadata is a canonical empty registry, not a stale memory copy.
      const previous = this.state;
      const source = this.source;
      const identity = this.sourceIdentity;
      this.state = { version: 1, providers: [], models: [] };
      this.source = undefined;
      this.sourceIdentity = undefined;
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
      configured: this.proxy.isConfigured(provider.id),
      modelCount: this.state.models.filter(model => model.provider === provider.id).length,
    }));
  }

  hasCredentials(id: string): boolean { return Boolean(this.readSecrets(id)); }

  getModels(): CustomModelDefinition[] { return structuredClone(this.state.models); }

  async upsertProvider(input: Record<string, unknown>, existingId?: string): Promise<CustomProviderDefinition> {
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
        : currentSecrets.apiKey ? { apiKey: currentSecrets.apiKey } : {}),
      headers: customHeaders ?? currentSecrets.headers,
    };
    await this.assertSource();
    await this.saveSecrets(id, nextSecrets, record.credentialId);
    const previousState = this.state;
    this.state = {
      ...previousState,
      providers: [...previousState.providers.filter(provider => provider.id !== id), record]
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
    try { await this.persist(); }
    catch (error) {
      this.state = previousState;
      try { await this.saveSecrets(id, currentSecrets, record.credentialId); }
      catch { throw Object.assign(new Error('Provider update rollback failed.'), { status: 500, uncertain: true }); }
      throw error;
    }
    await this.proxy.resetNetworkDispatchers();
    this.applyProvider(record);
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
    return this.withMutation(() => this.deleteProviderUnlocked(idValue));
  }

  private async deleteProviderUnlocked(idValue: string): Promise<boolean> {
    const id = providerId(idValue);
    if (!this.state.providers.some(provider => provider.id === id)) return false;
    await this.assertSource();
    const identity = this.storageId(id);
    const previousSecrets = this.readSecrets(id) ?? { headers: {} };
    try {
      await this.saveSecrets(id, { headers: {} });
    } catch (error) {
      await this.saveSecrets(id, previousSecrets).catch(() => undefined);
      throw error;
    }
    const previous = this.state;
    this.state = {
      ...previous,
      providers: previous.providers.filter(provider => provider.id !== id),
      models: previous.models.filter(model => model.provider !== id),
    };
    try { await this.persist(); }
    catch (error) {
      this.state = previous;
      try { await this.saveSecrets(id, previousSecrets, identity); }
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
    return this.withMutation(() => this.disconnectUnlocked(idValue));
  }

  private async disconnectUnlocked(idValue: string): Promise<CustomProviderDefinition> {
    const id = providerId(idValue);
    const provider = this.state.providers.find(item => item.id === id);
    if (!provider) throw Object.assign(new Error('Custom provider not found.'), { status: 404 });
    await this.assertSource();
    const previousSecrets = this.readSecrets(id) ?? { headers: {} };
    try {
      await this.saveSecrets(id, { headers: {} });
    } catch (error) {
      try { await this.saveSecrets(id, previousSecrets); }
      catch { throw Object.assign(new Error('Provider disconnection rollback failed.'), { status: 500 }); }
      throw error;
    }
    const before = this.state;
    this.state = { ...before, providers: before.providers.map(item => item.id === id
      ? { ...item, disconnected: true, updatedAt: new Date().toISOString() } : item) };
    try { await this.persist(); }
    catch (error) {
      this.state = before;
      try { await this.saveSecrets(id, previousSecrets); }
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
      for (const id of models) {
        const key = `${providerId}:${id}`;
        const existing = this.state.models.find(model => model.key === key);
        if (existing) { imported.push(existing); continue; }
        imported.push(await this.upsertModelUnlocked({
          provider: providerId, id, name: id, capabilities: { toolCalls: true },
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

  private async saveSecrets(id: string, value: ProviderSecrets, identity = this.storageId(id)): Promise<void> {
    this.redactor.add(value.apiKey);
    this.redactor.addAll(Object.values(value.headers));
    const hasSecrets = Boolean(value.apiKey) || Object.keys(value.headers).length > 0;
    if (hasSecrets && !this.secretStore) {
      throw Object.assign(new Error('Credential storage is unavailable.'), { status: 503 });
    }
    if (this.secretStore) {
      await this.secretStore.update({
        [`provider:${identity}`]: value.apiKey
          ? JSON.stringify({ version: 1, type: 'api-key', apiKey: value.apiKey })
          : undefined,
        [`provider-headers:${identity}`]: Object.keys(value.headers).length
          ? JSON.stringify(value.headers)
          : undefined,
      });
      this.credentialService.synchronizeFromStore(identity);
    } else {
      await this.credentialService.delete(identity);
    }
    if (hasSecrets) this.volatileSecrets.set(id, structuredClone(value));
    else this.volatileSecrets.delete(id);
  }

  private async hydrateSecrets(id: string): Promise<void> {
    const resolved = await this.credentialService.resolve(this.storageId(id), { env: {} });
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
    if (!apiKey && !Object.keys(customHeaders).length) return;
    this.redactor.add(apiKey);
    this.redactor.addAll(Object.values(customHeaders));
    this.volatileSecrets.set(id, {
      ...(apiKey ? { apiKey } : {}),
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

  private applyProvider(record: StoredProvider): void {
    if (record.disconnected) { this.proxy.removeProvider(record.id); return; }
    const secrets = this.readSecrets(record.id);
    const config: ProviderConfig = {
      type: record.id,
      baseUrl: record.baseUrl,
      apiKey: secrets?.apiKey,
      customHeaders: secrets?.headers,
      model: this.state.models.find(model => model.provider === record.id)?.id,
    };
    const provider = record.dialect === 'openai-completions' ? new OpenAiProvider(config)
      : record.dialect === 'openai-responses' ? new OpenAiResponsesProvider(config)
        : record.dialect === 'anthropic' ? new AnthropicProvider(config)
          : new GeminiProvider(config);
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
