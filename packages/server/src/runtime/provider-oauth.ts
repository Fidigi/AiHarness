import crypto from 'node:crypto';
import type { ProviderType } from '@ai-harness/core';
import type { AiProxyServer } from '../api/proxy.js';
import type { EncryptedCredentialStore } from '../security/credential-store.js';

const SUPPORTED = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local']);

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

function safeEndpoint(value: string, label: string): string {
  if (value.length > 2_000) throw Object.assign(new Error(`${label} is too long.`), { status: 400 });
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.protocol === 'http:'))) {
    throw Object.assign(new Error(`${label} must use HTTPS without embedded credentials.`), { status: 400 });
  }
  return url.toString();
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 1024 * 1024) throw new Error('OAuth response is too large.');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('OAuth response is too large.');
  return JSON.parse(text) as Record<string, unknown>;
}

function config(provider: string): OAuthConfig | undefined {
  const key = prefix(provider);
  const deviceUrl = process.env[`${key}_DEVICE_URL`];
  const tokenUrl = process.env[`${key}_TOKEN_URL`];
  const clientId = process.env[`${key}_CLIENT_ID`];
  if (!deviceUrl || !tokenUrl || !clientId) return undefined;
  if (clientId.length > 1_000) throw Object.assign(new Error('OAuth client id is too long.'), { status: 400 });
  const scope = process.env[`${key}_SCOPE`];
  if (scope && scope.length > 4_000) throw Object.assign(new Error('OAuth scope is too long.'), { status: 400 });
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

  constructor(
    private readonly proxy: AiProxyServer,
    private readonly credentials: () => EncryptedCredentialStore | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  isSupported(provider: string): boolean {
    try { return SUPPORTED.has(provider) && Boolean(config(provider)); } catch { return false; }
  }

  async start(providerValue: string): Promise<PublicOAuthFlow> {
    const provider = providerValue.trim().toLowerCase();
    if (!SUPPORTED.has(provider)) throw Object.assign(new Error('OAuth is unavailable for this provider.'), { status: 404 });
    const settings = config(provider);
    if (!settings) throw Object.assign(new Error('OAuth device flow is not configured for this provider.'), { status: 409 });
    this.prune();
    if (this.flows.size >= 100) throw Object.assign(new Error('Too many active OAuth flows.'), { status: 429 });
    const response = await this.fetcher(settings.deviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: settings.clientId, ...(settings.scope ? { scope: settings.scope } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw Object.assign(new Error(`OAuth device authorization failed (${response.status}).`), { status: 502 });
    const data = await boundedJson(response);
    if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string'
      || typeof (data.verification_uri ?? data.verification_url) !== 'string') {
      throw Object.assign(new Error('OAuth device authorization response is invalid.'), { status: 502 });
    }
    const expiresIn = Math.max(60, Math.min(3_600, Number(data.expires_in) || 900));
    const flow: OAuthFlow = {
      id: crypto.randomUUID(), provider, state: 'pending',
      userCode: data.user_code.slice(0, 500),
      verificationUri: safeEndpoint(String(data.verification_uri ?? data.verification_url), 'OAuth verification URL'),
      ...(typeof data.verification_uri_complete === 'string'
        ? { verificationUriComplete: safeEndpoint(data.verification_uri_complete, 'OAuth verification URL') } : {}),
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
      intervalSeconds: Math.max(1, Math.min(30, Number(data.interval) || 5)),
      deviceCode: data.device_code.slice(0, 4_000), controller: new AbortController(),
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

  private async poll(flow: OAuthFlow, settings: OAuthConfig): Promise<void> {
    let interval = flow.intervalSeconds * 1_000;
    while (flow.state === 'pending' && Date.now() < Date.parse(flow.expiresAt)) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, interval);
          flow.controller.signal.addEventListener('abort', () => {
            clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError'));
          }, { once: true });
        });
        const response = await this.fetcher(settings.tokenUrl, {
          method: 'POST', signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(15_000)]),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            client_id: settings.clientId, device_code: flow.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });
        const data = await boundedJson(response);
        if (typeof data.access_token === 'string' && data.access_token) {
          const token = data.access_token.slice(0, 20_000);
          this.proxy.setApiKey(flow.provider as Exclude<ProviderType, 'mock' | 'custom'>, token);
          await this.credentials()?.set(flow.provider, token);
          flow.state = 'connected';
          flow.deviceCode = '';
          return;
        }
        if (data.error === 'authorization_pending') continue;
        if (data.error === 'slow_down') { interval = Math.min(60_000, interval + 5_000); continue; }
        flow.state = 'failed';
        flow.error = String(data.error_description || data.error || `Token endpoint returned ${response.status}`).slice(0, 1_000);
        flow.deviceCode = '';
        return;
      } catch (error) {
        if (flow.controller.signal.aborted) { flow.deviceCode = ''; return; }
        flow.state = 'failed';
        flow.error = error instanceof Error ? error.message.slice(0, 1_000) : 'OAuth token exchange failed.';
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
