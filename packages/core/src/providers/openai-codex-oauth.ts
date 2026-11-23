import { createHash, randomBytes } from 'node:crypto';
import type { CredentialRedactor } from './credentials.js';

const CONFIG = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  browserRedirectUri: 'http://localhost:1455/auth/callback',
  deviceAuthorizationUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  verificationUri: 'https://auth.openai.com/codex/device',
  deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
});
const MAX_BYTES = 256 * 1024;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const AUTH_CLAIM = 'https://api.openai.com/auth';

export interface OpenAICodexOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscription: { provider: 'openai-codex'; accountId: string };
}

export interface OpenAICodexOAuthOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  redactor?: CredentialRedactor;
}

export interface OpenAICodexDeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  /** One-shot completion; the device ID and verifier never cross the public metadata boundary. */
  complete(signal?: AbortSignal): Promise<OpenAICodexOAuthCredential>;
  cancel(): void;
}

export interface OpenAICodexBrowserLogin {
  authorizationUrl: string;
  expiresAt: number;
  /** Exact redirected URL with matching state; invalid candidates do not consume the flow. */
  complete(redirectUrl: string, signal?: AbortSignal): Promise<OpenAICodexOAuthCredential>;
  cancel(): void;
}

/** Frozen public client and issuer, independent of labels, environment and API-key OpenAI. */
export function getOpenAICodexOAuthConfig() { return CONFIG; }

function text(value: unknown, limit = 64 * 1024): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit
    && !/[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Decode an account routing claim, not a JWT signature/issuer verification or entitlement check. */
export function openAICodexAccountId(accessToken: string): string {
  try {
    if (!text(accessToken)) throw new Error();
    const parts = accessToken.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/u.test(part))) throw new Error();
    const bytes = Buffer.from(parts[1], 'base64url');
    if (bytes.toString('base64url') !== parts[1]) throw new Error();
    const payload = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const id = record(payload?.[AUTH_CLAIM])?.chatgpt_account_id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/u.test(id)) throw new Error();
    return id;
  } catch { throw new Error('Invalid OpenAI Codex account credential.'); }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, abandon?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('OpenAI Codex authentication cancelled.'));
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abandon?.(value);
      resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function request(url: string, body: string | URLSearchParams, parent: AbortSignal, options: OpenAICodexOAuthOptions, devicePoll = false) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
  signal.throwIfAborted();
  const response = await abortable((options.fetcher ?? fetch)(url, {
    method: 'POST', redirect: 'manual', signal,
    headers: { Accept: 'application/json', 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/x-www-form-urlencoded' }, body,
  }), signal, response => { void response.body?.cancel().catch(() => undefined); });
  if (devicePoll && (response.status === 403 || response.status === 404)) {
    void response.body?.cancel().catch(() => undefined);
    return { status: response.status, ok: false, body: {} as Record<string, unknown> };
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9]\d*)$/u.test(length) || Number(length) > MAX_BYTES)) {
    void response.body?.cancel().catch(() => undefined); throw new Error('Invalid OpenAI Codex response.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid OpenAI Codex response.');
  let complete = false, size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) { complete = true; break; }
      size += item.value.byteLength;
      if (size > MAX_BYTES) throw new Error();
      chunks.push(item.value);
    }
    const json = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    if (!json) throw new Error();
    return { status: response.status, ok: response.ok, body: json };
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A hostile pending reader may retain the lock. */ }
  }
}

function credential(body: Record<string, unknown>, options: OpenAICodexOAuthOptions): OpenAICodexOAuthCredential {
  options.redactor?.add(typeof body.access_token === 'string' ? body.access_token : undefined);
  options.redactor?.add(typeof body.refresh_token === 'string' ? body.refresh_token : undefined);
  const expiry = body.expires_in;
  if (!text(body.access_token) || !text(body.refresh_token) || typeof expiry !== 'number'
    || !Number.isFinite(expiry) || expiry < 1 || expiry > 365 * 24 * 60 * 60) throw new Error();
  const expiresAt = Date.now() + Math.floor(expiry * 1000);
  if (!Number.isSafeInteger(expiresAt)) throw new Error();
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt,
    subscription: { provider: 'openai-codex', accountId: openAICodexAccountId(body.access_token) } };
}

/** Refresh only the selected account; token bodies and server error text are never exposed. */
export async function refreshOpenAICodexToken(refreshToken: string, accountId: string, options: OpenAICodexOAuthOptions = {}): Promise<OpenAICodexOAuthCredential> {
  options.redactor?.add(refreshToken);
  const signal = options.signal ?? new AbortController().signal;
  try {
    if (!text(refreshToken) || !/^[A-Za-z0-9._:-]{1,256}$/u.test(accountId)) throw new Error();
    const response = await request(CONFIG.tokenUrl, new URLSearchParams({ grant_type: 'refresh_token', client_id: CONFIG.clientId, refresh_token: refreshToken }), signal, options);
    if (!response.ok) throw new Error();
    const result = credential(response.body, options);
    if (result.subscription.accountId !== accountId) throw new Error();
    signal.throwIfAborted();
    return result;
  } catch { throw new Error(signal.aborted ? 'OpenAI Codex authentication cancelled.' : 'OpenAI Codex token refresh failed.'); }
}

/** Fixed-client browser PKCE. Hosts own loopback/pasted input and guarded persistence. */
export function beginOpenAICodexBrowserLogin(options: OpenAICodexOAuthOptions = {}): OpenAICodexBrowserLogin {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  if (signal.aborted) throw new Error('OpenAI Codex authentication cancelled.');
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  options.redactor?.add(verifier);
  const expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
  const url = new URL(CONFIG.authorizationUrl);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: CONFIG.clientId,
    redirect_uri: CONFIG.browserRedirectUri, scope: 'openid profile email offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state,
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'ai-harness' })) url.searchParams.set(key, value);
  let used = false;
  return { authorizationUrl: url.href, expiresAt, cancel: () => controller.abort(), complete: async (redirectUrl, caller) => {
    const lifetime = caller ? AbortSignal.any([signal, caller]) : signal;
    if (used) throw new Error('OpenAI Codex login already consumed.');
    if (lifetime.aborted) throw new Error('OpenAI Codex authentication cancelled.');
    if (Date.now() >= expiresAt) throw new Error('OpenAI Codex login is unavailable.');
    let code: string;
    try {
      if (!text(redirectUrl, 8192)) throw new Error();
      const redirect = new URL(redirectUrl), expected = new URL(CONFIG.browserRedirectUri);
      if (redirect.origin !== expected.origin || redirect.pathname !== expected.pathname || redirect.username || redirect.password || redirect.hash
        || redirect.searchParams.has('error') || redirect.searchParams.getAll('state').length !== 1 || redirect.searchParams.get('state') !== state
        || redirect.searchParams.getAll('code').length !== 1 || !text(redirect.searchParams.get('code'), 4000)) throw new Error();
      code = redirect.searchParams.get('code')!;
    } catch { throw new Error('Invalid OpenAI Codex OAuth redirect.'); }
    used = true; options.redactor?.add(code);
    try {
      const response = await request(CONFIG.tokenUrl, new URLSearchParams({ grant_type: 'authorization_code', client_id: CONFIG.clientId,
        code, code_verifier: verifier, redirect_uri: CONFIG.browserRedirectUri }), lifetime, options);
      if (!response.ok) throw new Error();
      const result = credential(response.body, options); lifetime.throwIfAborted(); return result;
    } catch { throw new Error(lifetime.aborted ? 'OpenAI Codex authentication cancelled.' : 'OpenAI Codex login failed.'); }
    finally { controller.abort(); }
  } };
}

/** OpenAI's JSON device flow, not RFC device-token polling or a Copilot issuer. No persistence or activation. */
export async function beginOpenAICodexDeviceLogin(options: OpenAICodexOAuthOptions = {}): Promise<OpenAICodexDeviceLogin> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  const expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
  try {
    const response = await request(CONFIG.deviceAuthorizationUrl, JSON.stringify({ client_id: CONFIG.clientId }), signal, options);
    if (!response.ok) throw new Error();
    const deviceId = response.body.device_auth_id, userCode = response.body.user_code;
    const seconds = typeof response.body.interval === 'string' ? Number(response.body.interval.trim()) : response.body.interval;
    if (!text(deviceId, 4000) || !text(userCode, 500) || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 60
      || (options.redactor && options.redactor.redact(userCode) !== userCode)) throw new Error();
    options.redactor?.add(deviceId);
    signal.throwIfAborted();
    let used = false;
    return {
      userCode, verificationUri: CONFIG.verificationUri, expiresAt,
      cancel: () => controller.abort(),
      complete: async caller => {
        if (used) throw new Error('OpenAI Codex login already consumed.');
        used = true;
        const lifetime = caller ? AbortSignal.any([signal, caller]) : signal;
        let interval = Math.max(1000, Math.floor(seconds * 1000));
        try {
          while (true) {
            lifetime.throwIfAborted();
            const polled = await request(CONFIG.deviceTokenUrl, JSON.stringify({ device_auth_id: deviceId, user_code: userCode }), lifetime, options, true);
            if (polled.ok) {
              const code = polled.body.authorization_code, verifier = polled.body.code_verifier;
              if (!text(code, 4000) || !text(verifier, 4000)) throw new Error();
              options.redactor?.add(code); options.redactor?.add(verifier);
              const tokens = await request(CONFIG.tokenUrl, new URLSearchParams({ grant_type: 'authorization_code', client_id: CONFIG.clientId,
                code, code_verifier: verifier, redirect_uri: CONFIG.deviceRedirectUri }), lifetime, options);
              if (!tokens.ok) throw new Error();
              const result = credential(tokens.body, options);
              lifetime.throwIfAborted();
              return result;
            }
            const error = record(polled.body.error)?.code ?? polled.body.error;
            if (polled.status !== 403 && polled.status !== 404 && error !== 'deviceauth_authorization_pending' && error !== 'slow_down') throw new Error();
            if (error === 'slow_down') interval = Math.min(60_000, interval + 5000);
            await new Promise<void>((resolve, reject) => {
              const abort = () => { clearTimeout(timer); reject(new Error()); };
              const timer = setTimeout(() => { lifetime.removeEventListener('abort', abort); resolve(); }, interval);
              if (lifetime.aborted) abort(); else lifetime.addEventListener('abort', abort, { once: true });
            });
          }
        } catch { throw new Error(lifetime.aborted ? 'OpenAI Codex authentication cancelled.' : 'OpenAI Codex login failed.'); }
        finally { controller.abort(); }
      },
    };
  } catch { controller.abort(); throw new Error('OpenAI Codex device authorization failed.'); }
}
