import crypto from 'node:crypto';
import type { ProviderCredentialService, ProviderType } from '@ai-harness/core';
import type { AiProxyServer } from '../api/proxy.js';

const SUPPORTED = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'local']);
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const MAX_OAUTH_TOKEN_BYTES = 64 * 1024;
const MAX_OAUTH_POLLS = 600;

interface OAuthConfig {
  deviceUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
}

interface OAuthFlow {
  id: string;
  provider: string;
  state: 'pending' | 'connected' | 'failed' | 'cancelled' | 'expired';
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
  intervalSeconds: number;
  deviceCode: string;
  error?: string;
  controller: AbortController;
}

export interface PublicOAuthFlow {
  id: string;
  provider: string;
  state: OAuthFlow['state'];
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt: string;
  error?: string;
}

function prefix(provider: string): string {
  return `AI_HARNESS_OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function safeEndpoint(value: string, label: string, status = 400): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2_000
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error(`${label} is too long.`), { status });
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw Object.assign(new Error(`${label} must use HTTPS without embedded credentials or fragments.`), { status }); }
  if (url.username || url.password || url.hash
    || (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.protocol === 'http:'))) {
    throw Object.assign(new Error(`${label} must use HTTPS without embedded credentials or fragments.`), { status });
  }
  return url.toString();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
    || Number(contentLength) > MAX_OAUTH_RESPONSE_BYTES)) {
    void response.body?.cancel('oauth-response-limit').catch(() => undefined);
    throw new Error('OAuth response is too large.');
  }
  if (!response.body?.getReader) throw new Error('OAuth response is invalid.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  let text: string;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) { completed = true; break; }
      bytes += item.value.byteLength;
      if (bytes > MAX_OAUTH_RESPONSE_BYTES) {
        void reader.cancel('oauth-response-limit').catch(() => undefined);
        throw new Error('OAuth response is too large.');
      }
      chunks.push(item.value);
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && error.message === 'OAuth response is too large.') throw error;
    throw new Error('OAuth response is invalid.');
  } finally {
    if (!completed) void reader.cancel('oauth-response-abandoned').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Pending hostile readers are already aborted. */ }
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('OAuth response is invalid.');
  }
}

function boundedRemoteValue(value: unknown, maxBytes: number): string | undefined {
  return typeof value === 'string' && value.length > 0
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && Buffer.byteLength(value) <= maxBytes ? value : undefined;
}

function config(provider: string): OAuthConfig | undefined {
  const key = prefix(provider);
  const deviceUrl = process.env[`${key}_DEVICE_URL`];
  const tokenUrl = process.env[`${key}_TOKEN_URL`];
  const clientId = process.env[`${key}_CLIENT_ID`];
  if (!deviceUrl || !tokenUrl || !clientId) return undefined;
  if (Buffer.byteLength(clientId) > 1_000 || /[\u0000-\u001f\u007f]/u.test(clientId)) {
    throw Object.assign(new Error('OAuth client id is invalid.'), { status: 400 });
  }
  const scope = process.env[`${key}_SCOPE`];
  if (scope && (Buffer.byteLength(scope) > 4_000 || /[\u0000-\u001f\u007f]/u.test(scope))) {
    throw Object.assign(new Error('OAuth scope is invalid.'), { status: 400 });
  }
  return {
    deviceUrl: safeEndpoint(deviceUrl, 'OAuth device endpoint'),
    tokenUrl: safeEndpoint(tokenUrl, 'OAuth token endpoint'),
    clientId,
    ...(scope ? { scope } : {}),
  };
}

/** Bounded in-memory OAuth device grants; access tokens go directly to the credential store/provider. */
export class ProviderOAuthService {
  private readonly flows = new Map<string, OAuthFlow>();

  private readonly requestTimeoutMs: number;

  constructor(
    private readonly proxy: AiProxyServer,
    private readonly credentials: () => ProviderCredentialService | undefined,
    private readonly fetcher: typeof fetch = fetch,
    requestTimeoutMs = 15_000,
  ) {
    this.requestTimeoutMs = Number.isSafeInteger(requestTimeoutMs)
      ? Math.max(1, Math.min(60_000, requestTimeoutMs))
      : 15_000;
  }

  isSupported(provider: string): boolean {
    try { return SUPPORTED.has(provider) && Boolean(config(provider)); } catch { return false; }
  }

  async start(providerValue: string): Promise<PublicOAuthFlow> {
    if (typeof providerValue !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(providerValue)) {
      throw Object.assign(new Error('OAuth is unavailable for this provider.'), { status: 404 });
    }
    const provider = providerValue.trim().toLowerCase();
    if (!SUPPORTED.has(provider)) throw Object.assign(new Error('OAuth is unavailable for this provider.'), { status: 404 });
    const settings = config(provider);
    if (!settings) throw Object.assign(new Error('OAuth device flow is not configured for this provider.'), { status: 409 });
    this.prune();
    if (this.flows.size >= 100) {
      for (const [id, flow] of this.flows) {
        if (flow.state !== 'pending') this.flows.delete(id);
        if (this.flows.size < 100) break;
      }
    }
    if (this.flows.size >= 100) throw Object.assign(new Error('Too many active OAuth flows.'), { status: 429 });
    let response: Response;
    const requestSignal = AbortSignal.timeout(this.requestTimeoutMs);
    try {
      response = await abortable(this.fetcher(settings.deviceUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: settings.clientId, ...(settings.scope ? { scope: settings.scope } : {}) }),
        signal: requestSignal,
      }), requestSignal);
    } catch {
      throw Object.assign(new Error('OAuth device authorization failed.'), { status: 502 });
    }
    if (!response.ok) {
      void response.body?.cancel('oauth-device-authorization-failed').catch(() => undefined);
      throw Object.assign(new Error('OAuth device authorization failed.'), { status: 502 });
    }
    let data: Record<string, unknown>;
    try { data = await boundedJson(response, requestSignal); }
    catch { throw Object.assign(new Error('OAuth response is invalid.'), { status: 502 }); }
    const deviceCode = boundedRemoteValue(data.device_code, 4_000);
    const userCode = boundedRemoteValue(data.user_code, 500);
    const verificationUri = boundedRemoteValue(data.verification_uri ?? data.verification_url, 2_000);
    const verificationUriComplete = data.verification_uri_complete === undefined
      ? undefined : boundedRemoteValue(data.verification_uri_complete, 2_000);
    if (!deviceCode || !userCode || !verificationUri
      || (data.verification_uri_complete !== undefined && !verificationUriComplete)) {
      throw Object.assign(new Error('OAuth response is invalid.'), { status: 502 });
    }
    let safeVerificationUri: string;
    let safeVerificationUriComplete: string | undefined;
    try {
      safeVerificationUri = safeEndpoint(verificationUri, 'OAuth verification URL', 502);
      safeVerificationUriComplete = verificationUriComplete
        ? safeEndpoint(verificationUriComplete, 'OAuth verification URL', 502)
        : undefined;
    } catch {
      throw Object.assign(new Error('OAuth response is invalid.'), { status: 502 });
    }
    const expiresIn = data.expires_in === undefined ? 900 : data.expires_in;
    const intervalSeconds = data.interval === undefined ? 5 : data.interval;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 1 || expiresIn > 3_600
      || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds)
      || intervalSeconds < 1 || intervalSeconds > 30) {
      throw Object.assign(new Error('OAuth response is invalid.'), { status: 502 });
    }
    const flow: OAuthFlow = {
      id: crypto.randomUUID(), provider, state: 'pending',
      userCode,
      verificationUri: safeVerificationUri,
      ...(safeVerificationUriComplete ? { verificationUriComplete: safeVerificationUriComplete } : {}),
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
      intervalSeconds,
      deviceCode, controller: new AbortController(),
    };
    this.flows.set(flow.id, flow);
    void this.poll(flow, settings);
    return this.public(flow);
  }

  get(id: string): PublicOAuthFlow | undefined {
    this.prune();
    const flow = this.flows.get(id);
    return flow ? this.public(flow) : undefined;
  }

  cancel(id: string): boolean {
    const flow = this.flows.get(id);
    if (!flow || flow.state !== 'pending') return false;
    flow.state = 'cancelled';
    flow.deviceCode = '';
    flow.controller.abort();
    return true;
  }

  close(): void {
    for (const flow of this.flows.values()) {
      flow.deviceCode = '';
      if (flow.state === 'pending') {
        flow.state = 'cancelled';
        flow.controller.abort();
      }
    }
    this.flows.clear();
  }

  private async poll(flow: OAuthFlow, settings: OAuthConfig): Promise<void> {
    let interval = flow.intervalSeconds * 1_000;
    let attempts = 0;
    while (flow.state === 'pending' && Date.now() < Date.parse(flow.expiresAt) && attempts < MAX_OAUTH_POLLS) {
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            clearTimeout(timer);
            reject(new DOMException('Cancelled', 'AbortError'));
          };
          const timer = setTimeout(() => {
            flow.controller.signal.removeEventListener('abort', abort);
            resolve();
          }, interval);
          flow.controller.signal.addEventListener('abort', abort, { once: true });
          if (flow.controller.signal.aborted) abort();
        });
        attempts++;
        const requestSignal = AbortSignal.any([
          flow.controller.signal,
          AbortSignal.timeout(this.requestTimeoutMs),
        ]);
        const response = await abortable(this.fetcher(settings.tokenUrl, {
          method: 'POST', signal: requestSignal, redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            client_id: settings.clientId, device_code: flow.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        }), requestSignal);
        const data = await boundedJson(response, requestSignal);
        const accessToken = boundedRemoteValue(data.access_token, MAX_OAUTH_TOKEN_BYTES);
        if (accessToken) {
          if (!response.ok) throw new Error('OAuth response is invalid.');
          const refreshToken = data.refresh_token === undefined
            ? undefined : boundedRemoteValue(data.refresh_token, MAX_OAUTH_TOKEN_BYTES);
          const tokenType = data.token_type === undefined
            ? undefined : boundedRemoteValue(data.token_type, 32);
          if ((data.refresh_token !== undefined && !refreshToken)
            || (tokenType !== undefined && !/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(tokenType))
            || (data.token_type !== undefined && !tokenType)) {
            throw new Error('OAuth response is invalid.');
          }
          if (data.expires_in !== undefined && (typeof data.expires_in !== 'number'
            || !Number.isFinite(data.expires_in) || data.expires_in < 0
            || data.expires_in > 365 * 24 * 60 * 60)) {
            throw new Error('OAuth response is invalid.');
          }
          const expiresIn = data.expires_in as number | undefined;
          const credentialService = this.credentials();
          if (!(credentialService as (ProviderCredentialService & { hasPersistentStore?: () => boolean }) | undefined)
            ?.hasPersistentStore?.()) {
            throw new Error('OAuth credential storage is unavailable.');
          }
          await credentialService!.setOAuth(flow.provider, {
            accessToken,
            ...(refreshToken ? { refreshToken } : {}),
            ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + Math.floor(expiresIn * 1_000) }),
            ...(tokenType ? { tokenType } : {}),
          });
          this.proxy.setApiKey(flow.provider as Exclude<ProviderType, 'mock' | 'custom'>, accessToken);
          flow.state = 'connected';
          flow.deviceCode = '';
          return;
        }
        if (data.access_token !== undefined) throw new Error('OAuth response is invalid.');
        if (data.error === 'authorization_pending') continue;
        if (data.error === 'slow_down') { interval = Math.min(60_000, interval + 5_000); continue; }
        flow.state = 'failed';
        flow.error = 'OAuth token exchange failed.';
        flow.deviceCode = '';
        return;
      } catch (error) {
        if (flow.controller.signal.aborted) { flow.deviceCode = ''; return; }
        flow.state = 'failed';
        flow.error = error instanceof DOMException && error.name === 'TimeoutError'
          ? 'OAuth token exchange timed out.' : 'OAuth token exchange failed.';
        flow.deviceCode = '';
        return;
      }
    }
    if (flow.state === 'pending') flow.state = 'expired';
    flow.deviceCode = '';
  }

  private public(flow: OAuthFlow): PublicOAuthFlow {
    return {
      id: flow.id, provider: flow.provider, state: flow.state, expiresAt: flow.expiresAt,
      ...(flow.state === 'pending' ? {
        userCode: flow.userCode, verificationUri: flow.verificationUri,
        ...(flow.verificationUriComplete ? { verificationUriComplete: flow.verificationUriComplete } : {}),
      } : {}),
      ...(flow.error ? { error: flow.error } : {}),
    };
  }

  private prune(): void {
    const threshold = Date.now() - 60 * 60_000;
    for (const [id, flow] of this.flows) {
      if (Date.parse(flow.expiresAt) < threshold) this.flows.delete(id);
    }
  }
}
