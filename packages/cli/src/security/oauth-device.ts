export interface OAuthDeviceConfig {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
}

export interface OAuthDevicePrompt {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface OAuthDeviceCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}

const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const MAX_POLL_ATTEMPTS = 600;
const UNSAFE_OAUTH_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;

function validOAuthText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Boolean(value) && Buffer.byteLength(value) <= maxBytes
    && !UNSAFE_OAUTH_TEXT.test(value);
}

function safeEndpoint(value: string): string {
  let endpoint: URL;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4_096
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('La configuration OAuth doit utiliser une URL HTTPS sûre.');
  }
  try { endpoint = new URL(value); }
  catch { throw new Error('La configuration OAuth doit utiliser une URL HTTPS sûre.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('La configuration OAuth doit utiliser HTTPS sans identifiants intégrés.');
  }
  return endpoint.toString();
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
    || Number(contentLength) > MAX_OAUTH_RESPONSE_BYTES)) {
    void response.body?.cancel('oauth-response-limit').catch(() => undefined);
    throw new Error('La réponse OAuth est invalide.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('La réponse OAuth est invalide.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  const abortedResult = Symbol('aborted');
  let onAbort!: () => void;
  const aborted = new Promise<typeof abortedResult>(resolve => {
    onAbort = () => resolve(abortedResult);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item === abortedResult) throw new Error('invalid');
      if (item.done) { completed = true; break; }
      bytes += item.value.byteLength;
      if (bytes > MAX_OAUTH_RESPONSE_BYTES) throw new Error('invalid');
      chunks.push(item.value);
    }
    const combined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch { throw new Error('La réponse OAuth est invalide.'); }
  finally {
    signal.removeEventListener('abort', onAbort);
    if (!completed) void reader.cancel('oauth-response-abandoned').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A hostile pending read may retain the lock. */ }
  }
}

function oauthDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Authentification OAuth annulée.'));
  return new Promise((resolve, reject) => {
    const done = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error('Authentification OAuth annulée.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class OAuthDeviceClient {
  constructor(private readonly config: OAuthDeviceConfig) {
    safeEndpoint(config.deviceAuthorizationUrl);
    safeEndpoint(config.tokenUrl);
    if (!config.clientId || Buffer.byteLength(config.clientId) > 4_096 || config.clientId.includes('\0')) {
      throw new Error('La configuration OAuth contient un identifiant client invalide.');
    }
    if (config.scope !== undefined && (Buffer.byteLength(config.scope) > 4_096 || config.scope.includes('\0'))) {
      throw new Error('La configuration OAuth contient un scope invalide.');
    }
  }

  async requestCode(signal?: AbortSignal): Promise<OAuthDevicePrompt> {
    if (signal?.aborted) throw new Error('Authentification OAuth annulée.');
    let response: Response;
    const deadline = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      response = await fetch(safeEndpoint(this.config.deviceAuthorizationUrl), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: this.config.clientId, ...(this.config.scope ? { scope: this.config.scope } : {}) }),
        signal: requestSignal,
      });
    } catch {
      throw new Error('OAuth device authorization failed.');
    }
    if (!response.ok) {
      void response.body?.cancel('oauth-device-authorization-failed').catch(() => undefined);
      throw new Error(`OAuth device authorization failed (${response.status})`);
    }
    const data = await boundedJson(response, requestSignal);
    const verificationUri = data.verification_uri ?? data.verification_url;
    const expiresIn = data.expires_in === undefined ? 900 : data.expires_in;
    const interval = data.interval === undefined ? 5 : data.interval;
    if (!validOAuthText(data.device_code, 4_000) || !validOAuthText(data.user_code, 500)
      || !validOAuthText(verificationUri, 4_096)
      || (data.verification_uri_complete !== undefined
        && !validOAuthText(data.verification_uri_complete, 4_096))
      || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 1 || expiresIn > 3_600
      || typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0.001 || interval > 30) {
      throw new Error('La réponse OAuth est invalide.');
    }
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: safeEndpoint(verificationUri),
      verificationUriComplete: data.verification_uri_complete === undefined
        ? undefined : safeEndpoint(data.verification_uri_complete),
      expiresIn,
      interval,
    };
  }

  async pollCredential(prompt: OAuthDevicePrompt, signal?: AbortSignal): Promise<OAuthDeviceCredential> {
    if (!prompt || typeof prompt !== 'object' || !validOAuthText(prompt.deviceCode, 4_000)
      || typeof prompt.expiresIn !== 'number' || !Number.isFinite(prompt.expiresIn)
      || prompt.expiresIn < 1 || prompt.expiresIn > 3_600
      || typeof prompt.interval !== 'number' || !Number.isFinite(prompt.interval)
      || prompt.interval < 0.001 || prompt.interval > 30) {
      throw new Error('La réponse OAuth est invalide.');
    }
    const deadline = Date.now() + prompt.expiresIn * 1000;
    let interval = prompt.interval * 1000;
    let attempts = 0;
    while (Date.now() < deadline && attempts++ < MAX_POLL_ATTEMPTS) {
      if (signal?.aborted) throw new Error('Authentification OAuth annulée.');
      await oauthDelay(interval, signal);
      let response: Response;
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(safeEndpoint(this.config.tokenUrl), {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            client_id: this.config.clientId,
            device_code: prompt.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          signal: requestSignal,
        });
      } catch {
        if (signal?.aborted) throw new Error('Authentification OAuth annulée.');
        throw new Error('OAuth token exchange failed.');
      }
      const data = await boundedJson(response, requestSignal);
      if (response.ok && typeof data.access_token === 'string' && data.access_token) {
        if (!validOAuthText(data.access_token, 64 * 1024)
          || (data.refresh_token !== undefined && !validOAuthText(data.refresh_token, 64 * 1024))
          || (data.token_type !== undefined && !validOAuthText(data.token_type, 128))
          || (data.expires_in !== undefined && (typeof data.expires_in !== 'number'
            || !Number.isFinite(data.expires_in) || data.expires_in < 0
            || data.expires_in > 365 * 24 * 60 * 60))) {
          throw new Error('La réponse OAuth est invalide.');
        }
        const expiresIn = data.expires_in as number | undefined;
        return {
          accessToken: data.access_token,
          ...(data.refresh_token === undefined ? {} : { refreshToken: data.refresh_token }),
          ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + Math.floor(expiresIn * 1_000) }),
          ...(data.token_type === undefined ? {} : { tokenType: data.token_type }),
        };
      }
      if (data.error === 'slow_down') {
        interval = Math.min(60_000, interval + 5000);
        continue;
      }
      if (data.error === 'authorization_pending') continue;
      throw new Error(`OAuth token exchange failed (${response.status}).`);
    }
    throw new Error('Le code OAuth a expiré.');
  }

  async pollToken(prompt: OAuthDevicePrompt, signal?: AbortSignal): Promise<string> {
    return (await this.pollCredential(prompt, signal)).accessToken;
  }
}

export function oauthConfigFromEnv(provider: string): OAuthDeviceConfig | undefined {
  const prefix = `AI_HARNESS_OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const deviceAuthorizationUrl = process.env[`${prefix}_DEVICE_URL`];
  const tokenUrl = process.env[`${prefix}_TOKEN_URL`];
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  if (!deviceAuthorizationUrl || !tokenUrl || !clientId) return undefined;
  return { deviceAuthorizationUrl, tokenUrl, clientId, scope: process.env[`${prefix}_SCOPE`] };
}
