import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CredentialRedactor, ProviderOAuthCredential } from './credentials.js';
import { normalizeRadiusGatewayUrl } from './radius-catalogue.js';

const CLIENT_ID = 'pi-gateway', SCOPE = 'gateway offline_access', REDIRECT_URI = 'http://127.0.0.1:1456/oauth/callback';
const MAX_BYTES = 256 * 1024, LOGIN_TIMEOUT_MS = 15 * 60 * 1000, EXPIRY_SKEW_MS = 60_000;
export interface RadiusOAuthIdentity { provider: 'radius'; gateway: string; grantId: string }
export interface RadiusOAuthCredential { accessToken: string; refreshToken: string; expiresAt: number; subscription: RadiusOAuthIdentity }
/** Hosts retain issuer-aware resolution and clip refresh to their own online policy. */
export type RadiusOAuthCredentialSource = (signal?: AbortSignal, allowRefresh?: boolean) => Promise<ProviderOAuthCredential | undefined>;
export interface RadiusOAuthOptions { gateway?: string; signal?: AbortSignal; fetcher?: typeof fetch; redactor?: CredentialRedactor }
export interface RadiusDeviceLogin { userCode: string; verificationUri: string; expiresAt: number; complete(signal?: AbortSignal): Promise<RadiusOAuthCredential>; cancel(): void }
export interface RadiusBrowserLogin { authorizationUrl: string; expiresAt: number; complete(redirectUrl: string, signal?: AbortSignal): Promise<RadiusOAuthCredential>; cancel(): void }
function endpoint(value: string, allowQuery = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !allowQuery && url.search || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Invalid Radius OAuth endpoint.');
  return url.href;
}
export function getRadiusOAuthConfig(gateway?: string) {
  const root = normalizeRadiusGatewayUrl(gateway); endpoint(root);
  return Object.freeze({ gateway: root, clientId: CLIENT_ID, scope: SCOPE, redirectUri: REDIRECT_URI,
    discoveryUrl: new URL('/v1/oauth', root).href, deviceAuthorizationUrl: new URL('/v1/oauth/device', root).href, tokenUrl: new URL('/v1/oauth/token', root).href });
}
export function validRadiusOAuthIdentity(value: unknown): value is RadiusOAuthIdentity {
  if (!record(value) || value.provider !== 'radius' || typeof value.gateway !== 'string' || !text(value.grantId, 64)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.grantId)) return false;
  try { return getRadiusOAuthConfig(value.gateway).gateway === value.gateway; } catch { return false; }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max = 64 * 1024): value is string {
  return typeof value === 'string' && !!value && Buffer.byteLength(value) <= max && !/[\u0000-\u0020\u007f-\u009f]/u.test(value)
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal, abandon?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Radius authentication cancelled.'));
    operation.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abandon?.(value); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
async function request(url: string, body: URLSearchParams | undefined, parent: AbortSignal, options: RadiusOAuthOptions) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]); signal.throwIfAborted();
  const response = await abortable((options.fetcher ?? fetch)(url, { method: body ? 'POST' : 'GET', redirect: 'manual', signal,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(body ? { body } : {}) }), signal,
  response => { void response.body?.cancel('radius-oauth-abandoned').catch(() => undefined); });
  const length = response.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9]\d*)$/u.test(length) || Number(length) > MAX_BYTES)) { void response.body?.cancel().catch(() => undefined); throw new Error('Invalid Radius OAuth response.'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Invalid Radius OAuth response.');
  const chunks: Uint8Array[] = []; let size = 0, finished = false;
  try {
    while (true) { const value = await abortable(reader.read(), signal); signal.throwIfAborted(); if (value.done) { finished = true; break; }
      size += value.value.byteLength; if (size > MAX_BYTES) throw new Error('Invalid Radius OAuth response.'); chunks.push(value.value); }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!record(value)) throw new Error('Invalid Radius OAuth response.');
    return { ok: response.ok, status: response.status, body: value };
  } finally { if (!finished) void reader.cancel('radius-oauth-abandoned').catch(() => undefined); try { reader.releaseLock(); } catch { /* Pending hostile reads cannot delay retirement. */ } }
}
function credential(body: Record<string, unknown>, identity: RadiusOAuthIdentity, options: RadiusOAuthOptions, previousRefresh?: string): RadiusOAuthCredential {
  options.redactor?.add(typeof body.access_token === 'string' ? body.access_token : undefined); options.redactor?.add(typeof body.refresh_token === 'string' ? body.refresh_token : undefined);
  const refresh = body.refresh_token === undefined ? previousRefresh : body.refresh_token;
  if (!text(body.access_token) || !text(refresh) || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in)
    || body.expires_in < 1 || body.expires_in > 365 * 24 * 60 * 60) throw new Error('Invalid Radius OAuth response.');
  const expiresAt = Date.now() + Math.floor(body.expires_in * 1000) - EXPIRY_SKEW_MS;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid Radius OAuth response.');
  return { accessToken: body.access_token, refreshToken: refresh, expiresAt, subscription: { ...identity } };
}
/** Internal native admission: neither a storage label nor an API key supplies issuer authority. */
export function radiusOAuthSnapshot(value: ProviderOAuthCredential | undefined, gateway: string): RadiusOAuthCredential {
  const copy = value && structuredClone(value);
  if (!copy || copy.version !== 1 || copy.type !== 'oauth' || !validRadiusOAuthIdentity(copy.subscription)
    || copy.subscription.gateway !== gateway || !text(copy.accessToken) || !text(copy.refreshToken)
    || !Number.isSafeInteger(copy.expiresAt) || copy.expiresAt! <= Date.now()) throw new Error('Radius OAuth credential is unavailable.');
  return { accessToken: copy.accessToken, refreshToken: copy.refreshToken, expiresAt: copy.expiresAt!, subscription: { ...copy.subscription } };
}
export async function resolveRadiusOAuthCredential(source: RadiusOAuthCredentialSource, gateway: string, signal: AbortSignal, allowRefresh: boolean) {
  signal.throwIfAborted(); const value = await abortable(source(signal, allowRefresh), signal); signal.throwIfAborted();
  return radiusOAuthSnapshot(value, gateway);
}
function failure(signal: AbortSignal, message: string): Error { return new Error(signal.aborted ? 'Radius authentication cancelled.' : message); }
function identity(gateway: string): RadiusOAuthIdentity { return { provider: 'radius', gateway, grantId: randomUUID() }; }
function flowLifetime(parent?: AbortSignal) {
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS), ...(parent ? [parent] : [])]);
  return { controller, signal };
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Radius authentication cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
export async function beginRadiusDeviceLogin(options: RadiusOAuthOptions = {}): Promise<RadiusDeviceLogin> {
  const settings = getRadiusOAuthConfig(options.gateway), { controller, signal } = flowLifetime(options.signal);
  try {
    const response = await request(settings.deviceAuthorizationUrl, new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }), signal, options), body = response.body;
    if (typeof body.device_code === 'string') options.redactor?.add(body.device_code);
    if (!response.ok || !text(body.device_code) || typeof body.user_code !== 'string' || !body.user_code || Buffer.byteLength(body.user_code) > 1024
      || /[\u0000-\u001f\u007f-\u009f]/u.test(body.user_code) || options.redactor && options.redactor.redact(body.user_code) !== body.user_code || !text(body.verification_uri, 2000)
      || typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > 86_400
      || body.interval !== undefined && (typeof body.interval !== 'number' || !Number.isSafeInteger(body.interval) || body.interval < 1 || body.interval > 60)) throw new Error();
    const verificationUri = endpoint(body.verification_uri, true), expiresAt = Date.now() + Math.min(LOGIN_TIMEOUT_MS, body.expires_in * 1000), grant = identity(settings.gateway);
    const deviceCode = body.device_code; let interval = Number(body.interval ?? 5) * 1000, used = false;
    signal.throwIfAborted();
    return { userCode: body.user_code, verificationUri, expiresAt, cancel: () => controller.abort(), complete: async caller => {
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, expiresAt - Date.now())), ...(caller ? [caller] : [])]);
      if (used) throw new Error('Radius login already consumed.'); used = true;
      try {
        for (let polls = 0; polls < 600; polls++) {
          if (Date.now() >= expiresAt) throw new Error(); await pause(interval, lifetime);
          const result = await request(settings.tokenUrl, new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: deviceCode }), lifetime, options);
          if (result.ok) { const value = credential(result.body, grant, options); lifetime.throwIfAborted(); return value; }
          if (result.body.error === 'authorization_pending') continue;
          if (result.body.error === 'slow_down') { interval += 5000; continue; }
          throw new Error();
        }
        throw new Error();
      } catch { throw failure(lifetime, 'Radius device login failed.'); }
      finally { controller.abort(); }
    } };
  } catch { const error = failure(signal, 'Radius device authorization failed.'); controller.abort(); throw error; }
}
/** Discover navigation only; code/token/refresh endpoints remain pinned to the configured gateway. Hosts own the fixed loopback callback. */
export async function beginRadiusBrowserLogin(options: RadiusOAuthOptions = {}): Promise<RadiusBrowserLogin> {
  const settings = getRadiusOAuthConfig(options.gateway), { controller, signal } = flowLifetime(options.signal);
  try {
    const response = await request(settings.discoveryUrl, undefined, signal, options);
    if (!response.ok || !text(response.body.authorizationEndpoint, 2000)) throw new Error();
    const url = new URL(endpoint(response.body.authorizationEndpoint)), verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url'), grant = identity(settings.gateway);
    options.redactor?.add(verifier); const expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
    url.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', handoff: 'url', state }).toString();
    let used = false; signal.throwIfAborted();
    return { authorizationUrl: url.href, expiresAt, cancel: () => controller.abort(), complete: async (redirectUrl, caller) => {
      const lifetime = caller ? AbortSignal.any([signal, caller]) : signal; if (used) throw new Error('Radius login already consumed.');
      if (lifetime.aborted) throw new Error('Radius authentication cancelled.');
      let code: string;
      try {
        if (!text(redirectUrl, 8192) || Date.now() >= expiresAt) throw new Error();
        const redirect = new URL(redirectUrl), expected = new URL(REDIRECT_URI);
        if (redirect.origin !== expected.origin || redirect.pathname !== expected.pathname || redirect.username || redirect.password || redirect.hash || redirect.searchParams.has('error')
          || redirect.searchParams.getAll('state').length !== 1 || redirect.searchParams.get('state') !== state || redirect.searchParams.getAll('code').length !== 1 || !text(redirect.searchParams.get('code'), 4000)) throw new Error();
        code = redirect.searchParams.get('code')!;
      } catch { throw new Error('Invalid Radius OAuth redirect.'); }
      used = true; options.redactor?.add(code);
      try {
        const result = await request(settings.tokenUrl, new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code, code_verifier: verifier }), lifetime, options);
        if (!result.ok) throw new Error(); const value = credential(result.body, grant, options); lifetime.throwIfAborted(); return value;
      } catch { throw failure(lifetime, 'Radius browser login failed.'); }
      finally { controller.abort(); }
    } };
  } catch { const error = failure(signal, 'Radius authorization discovery failed.'); controller.abort(); throw error; }
}
export async function refreshRadiusToken(refreshToken: string, subscription: RadiusOAuthIdentity, options: RadiusOAuthOptions = {}): Promise<RadiusOAuthCredential> {
  const signal = options.signal ?? new AbortController().signal; options.redactor?.add(refreshToken);
  try {
    if (!text(refreshToken) || !validRadiusOAuthIdentity(subscription) || options.gateway !== undefined && getRadiusOAuthConfig(options.gateway).gateway !== subscription.gateway) throw new Error();
    const settings = getRadiusOAuthConfig(subscription.gateway), result = await request(settings.tokenUrl,
      new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken }), signal, options);
    if (!result.ok) throw new Error(); const value = credential(result.body, subscription, options, refreshToken); signal.throwIfAborted(); return value;
  } catch { throw failure(signal, 'Radius token refresh failed.'); }
}
