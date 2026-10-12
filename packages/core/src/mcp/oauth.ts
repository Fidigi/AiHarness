import { createHash, randomBytes } from 'node:crypto';
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServerRuntimeConfig, McpServerTestTarget } from './config-inventory.js';

const MCP_OAUTH_RECORD_VERSION = 1;
const MCP_OAUTH_RECORD_MAX_BYTES = 60 * 1024;
const MCP_OAUTH_SECRET_MAX_BYTES = 48 * 1024;
const MCP_OAUTH_URL_MAX_BYTES = 16 * 1024;
const MCP_OAUTH_SCOPE_MAX_BYTES = 8 * 1024;
const MCP_OAUTH_VERIFIER_MAX_BYTES = 8 * 1024;
const MCP_OAUTH_NAME_MAX_BYTES = 256;
const MCP_OAUTH_CLIENT_NAME_MAX_BYTES = 256;
const MCP_OAUTH_STORAGE_PREFIX = 'mcp-oauth:';
const MCP_OAUTH_CACHE_MAX_ENTRIES = 512;
const MCP_OAUTH_GENERATION_MAX_ENTRIES = 512;
const DEFAULT_REDIRECT_URL = 'http://127.0.0.1/oauth/callback';

export interface McpOAuthIdentity {
  name: string;
  url: string;
}

export interface McpOAuthCredentialBackend {
  load(): Promise<void>;
  get(name: string): string | undefined;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  compareAndSet(
    name: string,
    expected: string | undefined,
    value: string | undefined,
  ): Promise<boolean>;
}

export interface McpOAuthSecretRedactor {
  add(value: string | undefined): void;
  redact(value: string): string;
}

export interface McpOAuthStatus {
  available: true;
  signedIn: boolean;
  stateStored: boolean;
}

export interface McpOAuthClientSettings {
  clientId?: string;
  scopes?: readonly string[];
  clientName?: string;
  resolveClientSecret?: () => Promise<string | undefined>;
}

export interface CreateMcpOAuthProviderOptions {
  identity: McpOAuthIdentity;
  mode: 'passive' | 'interactive';
  redirectUrl?: string;
  settings?: McpOAuthClientSettings;
  /** Revalidate configuration/trust immediately before every durable write. */
  validateWrite?: () => Promise<void>;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  onTokensSaved?: () => void;
  state?: string;
}

export interface McpOAuthProviderBinding {
  provider: OAuthClientProvider;
  redact(value: string): string;
  generation: number;
}

interface StoredMcpOAuthRecord {
  version: typeof MCP_OAUTH_RECORD_VERSION;
  identity: string;
  clientInformation?: OAuthClientInformationMixed;
  clientMode?: 'dynamic' | 'configured';
  clientFingerprint?: string;
  tokens?: OAuthTokens;
}

interface CachedMcpOAuthRecord {
  raw?: string;
  state?: StoredMcpOAuthRecord;
}

interface IdentityParts {
  name: string;
  url: string;
  digest: string;
  storageName: string;
}

export class McpOAuthAuthorizationRequiredError extends UnauthorizedError {
  constructor() {
    super('MCP OAuth authorization is required.');
    this.name = 'McpOAuthAuthorizationRequiredError';
  }
}

export class McpOAuthSignedOutError extends UnauthorizedError {
  constructor() {
    super('MCP OAuth credentials were signed out while the operation was running.');
    this.name = 'McpOAuthSignedOutError';
  }
}

export class McpOAuthConfigurationError extends Error {
  constructor(message = 'The MCP OAuth configuration is invalid.') {
    super(message);
    this.name = 'McpOAuthConfigurationError';
  }
}

export class McpOAuthCredentialWriteError extends Error {
  constructor(message = 'The MCP OAuth credential write was rejected.') {
    super(message);
    this.name = 'McpOAuthCredentialWriteError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: string, maximum: number): boolean {
  return value.length > 0 && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= maximum;
}

function normalizeServerUrl(value: string): string {
  if (!boundedString(value, MCP_OAUTH_URL_MAX_BYTES)) throw new McpOAuthConfigurationError();
  let url: URL;
  try { url = new URL(value); }
  catch { throw new McpOAuthConfigurationError(); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new McpOAuthConfigurationError();
  }
  return url.href;
}

function identityParts(identity: McpOAuthIdentity): IdentityParts {
  if (!boundedString(identity.name, MCP_OAUTH_NAME_MAX_BYTES)
    || /[\u0000-\u001f\u007f-\u009f]/u.test(identity.name)) {
    throw new McpOAuthConfigurationError();
  }
  const url = normalizeServerUrl(identity.url);
  const digest = createHash('sha256').update(identity.name).update('\0').update(url).digest('hex');
  return {
    name: identity.name,
    url,
    digest,
    storageName: `${MCP_OAUTH_STORAGE_PREFIX}${digest}`,
  };
}

/** Stable encrypted-store name, deliberately revealing neither configured name nor URL. */
export function mcpOAuthStorageName(identity: McpOAuthIdentity): string {
  return identityParts(identity).storageName;
}

/** HTTP entries with their own Authorization header are not OAuth-managed. */
export function mcpOAuthUrl(config: McpServerRuntimeConfig): string | undefined {
  if (!('url' in config)) return undefined;
  if (Object.keys(config.headers ?? {}).some(name => name.toLowerCase() === 'authorization')) return undefined;
  try { return normalizeServerUrl(config.url); }
  catch { return undefined; }
}

/** Exact target identity required before an OAuth credential write or verification. */
export function isSameMcpOAuthTarget(
  initial: McpServerTestTarget,
  current: McpServerTestTarget,
): boolean {
  return current.scope === initial.scope && current.name === initial.name
    && current.sourcePath === initial.sourcePath && current.configKey === initial.configKey
    && current.cwd === initial.cwd && current.config.enabled !== false
    && mcpOAuthUrl(current.config) === mcpOAuthUrl(initial.config);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseClientInformation(value: unknown): OAuthClientInformationMixed | undefined {
  const full = OAuthClientInformationFullSchema.safeParse(value);
  const parsed = full.success ? full.data : OAuthClientInformationSchema.safeParse(value).data;
  if (!parsed || !boundedString(parsed.client_id, MCP_OAUTH_SECRET_MAX_BYTES)
    || (parsed.client_secret !== undefined
      && !boundedString(parsed.client_secret, MCP_OAUTH_SECRET_MAX_BYTES))
    || (parsed.issuer !== undefined && !boundedString(parsed.issuer, MCP_OAUTH_URL_MAX_BYTES))) {
    return undefined;
  }
  const redirects = 'redirect_uris' in parsed ? parsed.redirect_uris : undefined;
  if (redirects !== undefined && (!Array.isArray(redirects)
    || redirects.some(uri => {
      if (typeof uri !== 'string') return true;
      try {
        const url = new URL(uri);
        return !boundedString(uri, MCP_OAUTH_URL_MAX_BYTES)
          || (url.protocol !== 'http:' && url.protocol !== 'https:');
      } catch { return true; }
    }))) return undefined;
  return cloneJson(parsed as OAuthClientInformationMixed);
}

function parseTokens(value: unknown): OAuthTokens | undefined {
  const result = OAuthTokensSchema.safeParse(value);
  if (!result.success) return undefined;
  const tokens = result.data;
  const values = [tokens.access_token, tokens.refresh_token, tokens.id_token, tokens.scope, tokens.issuer]
    .filter((item): item is string => typeof item === 'string');
  if (!boundedString(tokens.access_token, MCP_OAUTH_SECRET_MAX_BYTES)
    || !boundedString(tokens.token_type, 256)
    || values.some(item => Buffer.byteLength(item, 'utf8') > MCP_OAUTH_SECRET_MAX_BYTES)) {
    return undefined;
  }
  return cloneJson(tokens);
}

function parseStoredRecord(raw: string | undefined, identity: IdentityParts): StoredMcpOAuthRecord | undefined {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MCP_OAUTH_RECORD_MAX_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return undefined; }
  if (!isRecord(value) || value.version !== MCP_OAUTH_RECORD_VERSION || value.identity !== identity.digest
    || Object.keys(value).some(key => ![
      'version', 'identity', 'revision', 'clientInformation', 'clientMode', 'clientFingerprint', 'tokens',
    ].includes(key))) return undefined;
  if (value.revision !== undefined
    && (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.revision))) return undefined;
  const clientInformation = value.clientInformation === undefined
    ? undefined : parseClientInformation(value.clientInformation);
  const tokens = value.tokens === undefined ? undefined : parseTokens(value.tokens);
  if ((value.clientInformation !== undefined && !clientInformation)
    || (value.tokens !== undefined && !tokens)
    || (value.clientMode !== undefined && value.clientMode !== 'dynamic' && value.clientMode !== 'configured')
    || (value.clientFingerprint !== undefined
      && (typeof value.clientFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.clientFingerprint)))) {
    return undefined;
  }
  return {
    version: MCP_OAUTH_RECORD_VERSION,
    identity: identity.digest,
    ...(clientInformation ? { clientInformation } : {}),
    ...(value.clientMode === 'dynamic' || value.clientMode === 'configured'
      ? { clientMode: value.clientMode } : {}),
    ...(typeof value.clientFingerprint === 'string'
      ? { clientFingerprint: value.clientFingerprint } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

function serializeStoredRecord(value: StoredMcpOAuthRecord | undefined): string | undefined {
  if (!value || (!value.clientInformation && !value.tokens)) return undefined;
  const serialized = JSON.stringify({ ...value, revision: randomBytes(32).toString('hex') });
  if (Buffer.byteLength(serialized, 'utf8') > MCP_OAUTH_RECORD_MAX_BYTES) {
    throw new McpOAuthConfigurationError('The MCP OAuth credential record is too large.');
  }
  return serialized;
}

function revocationMarker(parts: IdentityParts): string {
  return JSON.stringify({
    version: MCP_OAUTH_RECORD_VERSION,
    identity: parts.digest,
    signedOut: randomBytes(32).toString('base64url'),
  });
}

function safeRedirectUrl(value: string): string {
  if (!boundedString(value, MCP_OAUTH_URL_MAX_BYTES)) throw new McpOAuthConfigurationError();
  let url: URL;
  try { url = new URL(value); }
  catch { throw new McpOAuthConfigurationError(); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new McpOAuthConfigurationError();
  }
  return url.href;
}

function safeAuthorizationUrl(value: URL): URL {
  const serialized = value.href;
  if (!boundedString(serialized, MCP_OAUTH_URL_MAX_BYTES)
    || (value.protocol !== 'http:' && value.protocol !== 'https:')
    || value.username || value.password) {
    throw new McpOAuthConfigurationError('The OAuth authorization URL is invalid.');
  }
  return new URL(serialized);
}

function normalizedScopes(scopes: readonly string[] | undefined): string | undefined {
  if (!scopes) return undefined;
  const unique = [...new Set(scopes.map(scope => scope.trim()).filter(Boolean))];
  if (unique.some(scope => /[\u0000-\u001f\u007f]/u.test(scope))) throw new McpOAuthConfigurationError();
  const joined = unique.join(' ');
  if (!joined) return undefined;
  if (Buffer.byteLength(joined, 'utf8') > MCP_OAUTH_SCOPE_MAX_BYTES) throw new McpOAuthConfigurationError();
  return joined;
}

function clientFingerprint(clientId: string, clientSecret: string | undefined): string {
  return createHash('sha256').update(clientId).update('\0').update(clientSecret ?? '').digest('hex');
}

function registeredRedirects(client: OAuthClientInformationMixed | undefined): string[] {
  return client && 'redirect_uris' in client ? [...client.redirect_uris] : [];
}

/**
 * Shared encrypted MCP OAuth state and SDK provider factory. Reads happen only
 * through explicit status/login/runtime operations; constructing it is passive.
 */
export class McpOAuthCredentialManager {
  private readonly cache = new Map<string, CachedMcpOAuthRecord>();
  private readonly generations = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private generationEpoch = 0;
  private generationSequence = 0;

  constructor(
    private readonly store: McpOAuthCredentialBackend,
    private readonly redactor?: McpOAuthSecretRedactor,
  ) {}

  async status(identity: McpOAuthIdentity): Promise<McpOAuthStatus> {
    return (await this.statuses([identity]))[0]!;
  }

  /** Refresh the encrypted document once for a bounded inventory batch. */
  async statuses(identities: readonly McpOAuthIdentity[]): Promise<McpOAuthStatus[]> {
    const parts = identities.map(identityParts);
    await this.store.load();
    return parts.map(identity => {
      const raw = this.store.get(identity.storageName);
      const state = parseStoredRecord(raw, identity);
      if (state?.tokens) this.rememberSecrets(state.tokens);
      if (state?.clientInformation) this.rememberSecrets(state.clientInformation);
      this.remember(identity.storageName, {
        ...(raw !== undefined ? { raw } : {}),
        ...(state ? { state } : {}),
      });
      return {
        available: true as const,
        signedIn: state?.tokens !== undefined,
        stateStored: state !== undefined,
      };
    });
  }

  async registeredRedirectUrls(identity: McpOAuthIdentity): Promise<string[]> {
    const parts = identityParts(identity);
    const current = await this.refresh(parts);
    return registeredRedirects(current.state?.clientInformation);
  }

  async signOut(identity: McpOAuthIdentity): Promise<boolean> {
    const parts = identityParts(identity);
    this.bumpGeneration(parts.storageName);
    return this.queued(parts.storageName, async () => {
      // Keep a non-secret revocation marker: deleting an empty record would let a
      // provider in another process whose baseline was undefined recreate it (ABA).
      const tombstone = revocationMarker(parts);
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.store.load();
        const raw = this.store.get(parts.storageName);
        const removed = parseStoredRecord(raw, parts) !== undefined;
        if (await this.store.compareAndSet(parts.storageName, raw, tombstone)) {
          this.remember(parts.storageName, { raw: tombstone });
          return removed;
        }
      }
      throw new McpOAuthCredentialWriteError();
    });
  }

  async createProvider(options: CreateMcpOAuthProviderOptions): Promise<McpOAuthProviderBinding> {
    const parts = identityParts(options.identity);
    const generation = this.generation(parts);
    const snapshot = { current: cloneJson(await this.refresh(parts)) };
    if (this.generation(parts) !== generation) throw new McpOAuthSignedOutError();
    const redirectUrl = safeRedirectUrl(options.redirectUrl ?? DEFAULT_REDIRECT_URL);
    const scope = normalizedScopes(options.settings?.scopes);
    const clientName = options.settings?.clientName?.trim() || 'AiHarness';
    if (!boundedString(clientName, MCP_OAUTH_CLIENT_NAME_MAX_BYTES)
      || /[\u0000-\u001f\u007f]/u.test(clientName)) throw new McpOAuthConfigurationError();
    const clientId = options.settings?.clientId?.trim() || undefined;
    if (clientId && !boundedString(clientId, MCP_OAUTH_SECRET_MAX_BYTES)) {
      throw new McpOAuthConfigurationError();
    }
    const state = options.state ?? randomBytes(32).toString('base64url');
    if (!boundedString(state, 512)) throw new McpOAuthConfigurationError();
    let codeVerifier: string | undefined;
    let discoveryState: OAuthDiscoveryState | undefined;
    let resolvedClientSecret: Promise<string | undefined> | undefined;

    const assertGeneration = (): void => {
      if (this.generation(parts) !== generation) throw new McpOAuthSignedOutError();
    };
    const resolveClientSecret = async (): Promise<string | undefined> => {
      if (!resolvedClientSecret) {
        resolvedClientSecret = Promise.resolve(options.settings?.resolveClientSecret?.()).then(secret => {
          if (secret !== undefined && !boundedString(secret, MCP_OAUTH_SECRET_MAX_BYTES)) {
            throw new McpOAuthConfigurationError();
          }
          this.redactor?.add(secret);
          return secret;
        });
      }
      return resolvedClientSecret;
    };
    const configuredClient = async (): Promise<{
      information: OAuthClientInformationMixed;
      fingerprint: string;
    } | undefined> => {
      const clientSecret = await resolveClientSecret();
      if (!clientId) {
        if (clientSecret) throw new McpOAuthConfigurationError('An OAuth client secret requires a client id.');
        return undefined;
      }
      return {
        information: {
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        },
        fingerprint: clientFingerprint(clientId, clientSecret),
      };
    };
    const clientMetadata: OAuthClientMetadata = {
      redirect_uris: [redirectUrl],
      client_name: clientName,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(scope ? { scope } : {}),
    };

    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadata,
      state: () => state,
      clientInformation: async () => {
        assertGeneration();
        const current = snapshot.current.state;
        const configured = await configuredClient();
        if (configured) {
          if (current?.clientMode === 'configured'
            && current.clientFingerprint === configured.fingerprint
            && current.clientInformation?.client_id === configured.information.client_id) {
            return cloneJson(current.clientInformation);
          }
          await this.update(parts, generation, snapshot, options.validateWrite, () => ({
            version: MCP_OAUTH_RECORD_VERSION,
            identity: parts.digest,
            clientInformation: configured.information,
            clientMode: 'configured',
            clientFingerprint: configured.fingerprint,
          }));
          return configured.information;
        }
        if (current?.clientMode === 'configured') {
          await this.update(parts, generation, snapshot, options.validateWrite, () => undefined);
          if (options.mode === 'passive') throw new McpOAuthAuthorizationRequiredError();
          return undefined;
        }
        if (current?.clientMode === 'dynamic' && current.clientInformation) {
          if (options.mode === 'interactive') {
            const redirects = registeredRedirects(current.clientInformation);
            if (redirects.length > 0 && !redirects.includes(redirectUrl)) return undefined;
          }
          return cloneJson(current.clientInformation);
        }
        if (options.mode === 'passive') throw new McpOAuthAuthorizationRequiredError();
        return undefined;
      },
      saveClientInformation: async clientInformation => {
        const parsed = parseClientInformation(clientInformation);
        if (!parsed) throw new McpOAuthConfigurationError('The OAuth client registration is invalid.');
        const configured = await configuredClient();
        const mode = configured ? 'configured' as const : 'dynamic' as const;
        const fingerprint = configured?.fingerprint;
        await this.update(parts, generation, snapshot, options.validateWrite, current => {
          const clientChanged = current?.clientInformation?.client_id !== parsed.client_id
            || current.clientMode !== mode
            || current.clientFingerprint !== fingerprint;
          return {
            version: MCP_OAUTH_RECORD_VERSION,
            identity: parts.digest,
            clientInformation: parsed,
            clientMode: mode,
            ...(fingerprint ? { clientFingerprint: fingerprint } : {}),
            ...(!clientChanged && current?.tokens ? { tokens: current.tokens } : {}),
          };
        });
      },
      tokens: () => {
        assertGeneration();
        const tokens = snapshot.current.state?.tokens;
        return tokens ? cloneJson(tokens) : undefined;
      },
      saveTokens: async tokens => {
        const parsed = parseTokens(tokens);
        if (!parsed) throw new McpOAuthConfigurationError('The OAuth token response is invalid.');
        this.rememberSecrets(parsed);
        const saved = await this.update(parts, generation, snapshot, options.validateWrite, current => ({
          version: MCP_OAUTH_RECORD_VERSION,
          identity: parts.digest,
          ...(current?.clientInformation ? { clientInformation: current.clientInformation } : {}),
          ...(current?.clientMode ? { clientMode: current.clientMode } : {}),
          ...(current?.clientFingerprint ? { clientFingerprint: current.clientFingerprint } : {}),
          tokens: parsed,
        }));
        if (saved) options.onTokensSaved?.();
      },
      redirectToAuthorization: async authorizationUrl => {
        if (options.mode !== 'interactive') throw new McpOAuthAuthorizationRequiredError();
        const safe = safeAuthorizationUrl(authorizationUrl);
        await options.onAuthorizationUrl?.(safe);
      },
      saveCodeVerifier: verifier => {
        if (!boundedString(verifier, MCP_OAUTH_VERIFIER_MAX_BYTES)) throw new McpOAuthConfigurationError();
        codeVerifier = verifier;
      },
      codeVerifier: () => {
        if (!codeVerifier) throw new McpOAuthConfigurationError('The OAuth verifier is unavailable.');
        return codeVerifier;
      },
      invalidateCredentials: async credentialScope => {
        if (credentialScope === 'verifier') {
          codeVerifier = undefined;
          return;
        }
        if (credentialScope === 'discovery') {
          discoveryState = undefined;
          return;
        }
        await this.update(parts, generation, snapshot, options.validateWrite, current => {
          if (!current) return undefined;
          if (credentialScope === 'all') return undefined;
          if (credentialScope === 'tokens') {
            return current.clientInformation ? {
              version: MCP_OAUTH_RECORD_VERSION,
              identity: parts.digest,
              clientInformation: current.clientInformation,
              ...(current.clientMode ? { clientMode: current.clientMode } : {}),
              ...(current.clientFingerprint ? { clientFingerprint: current.clientFingerprint } : {}),
            } : undefined;
          }
          return current.tokens ? {
            version: MCP_OAUTH_RECORD_VERSION,
            identity: parts.digest,
            tokens: current.tokens,
          } : undefined;
        });
      },
      discoveryState: () => discoveryState ? cloneJson(discoveryState) : undefined,
      saveDiscoveryState: value => { discoveryState = cloneJson(value); },
    };

    return {
      provider,
      generation,
      redact: value => this.redactor?.redact(value) ?? value,
    };
  }

  private generation(parts: IdentityParts): number {
    return this.generations.get(parts.storageName) ?? this.generationEpoch;
  }

  private bumpGeneration(key: string): void {
    this.generations.delete(key);
    this.generations.set(key, ++this.generationSequence);
    if (this.generations.size <= MCP_OAUTH_GENERATION_MAX_ENTRIES) return;
    this.generationEpoch = ++this.generationSequence;
    this.generations.clear();
    this.generations.set(key, ++this.generationSequence);
  }

  private remember(key: string, value: CachedMcpOAuthRecord): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > MCP_OAUTH_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private rememberSecrets(value: OAuthTokens | OAuthClientInformationMixed): void {
    if ('access_token' in value) {
      this.redactor?.add(value.access_token);
      this.redactor?.add(value.refresh_token);
      this.redactor?.add(value.id_token);
    } else {
      this.redactor?.add(value.client_secret);
    }
  }

  private async refresh(parts: IdentityParts): Promise<CachedMcpOAuthRecord> {
    return this.queued(parts.storageName, async () => {
      await this.store.load();
      const raw = this.store.get(parts.storageName);
      const state = parseStoredRecord(raw, parts);
      if (state?.tokens) this.rememberSecrets(state.tokens);
      if (state?.clientInformation) this.rememberSecrets(state.clientInformation);
      const cached = { ...(raw !== undefined ? { raw } : {}), ...(state ? { state } : {}) };
      this.remember(parts.storageName, cached);
      return cached;
    });
  }

  private async update(
    parts: IdentityParts,
    generation: number,
    snapshot: { current: CachedMcpOAuthRecord },
    validateWrite: (() => Promise<void>) | undefined,
    transform: (current: StoredMcpOAuthRecord | undefined) => StoredMcpOAuthRecord | undefined,
  ): Promise<boolean> {
    return this.queued(parts.storageName, async () => {
      if (this.generation(parts) !== generation) throw new McpOAuthSignedOutError();
      await validateWrite?.();
      if (this.generation(parts) !== generation) throw new McpOAuthSignedOutError();
      // A status read or another provider must never advance this writer's CAS baseline.
      const cached = snapshot.current;
      const nextState = transform(cached.state ? cloneJson(cached.state) : undefined);
      const nextRaw = serializeStoredRecord(nextState) ?? revocationMarker(parts);
      let changed = true;
      try {
        changed = await this.store.compareAndSet(parts.storageName, cached.raw, nextRaw);
      } catch {
        throw new McpOAuthCredentialWriteError();
      }
      if (!changed) {
        await this.store.load();
        const freshRaw = this.store.get(parts.storageName);
        const freshState = parseStoredRecord(freshRaw, parts);
        if (freshState?.tokens) this.rememberSecrets(freshState.tokens);
        if (freshState?.clientInformation) this.rememberSecrets(freshState.clientInformation);
        this.remember(parts.storageName, {
          ...(freshRaw !== undefined ? { raw: freshRaw } : {}),
          ...(freshState ? { state: freshState } : {}),
        });
        throw new McpOAuthCredentialWriteError(
          'The MCP OAuth credentials changed concurrently; retry the operation.',
        );
      }
      if (nextState?.tokens) this.rememberSecrets(nextState.tokens);
      if (nextState?.clientInformation) this.rememberSecrets(nextState.clientInformation);
      snapshot.current = {
        ...(nextRaw !== undefined ? { raw: nextRaw } : {}),
        ...(nextState ? { state: nextState } : {}),
      };
      this.remember(parts.storageName, snapshot.current);
      return true;
    });
  }

  private queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const settled = next.then(() => undefined, () => undefined);
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}
