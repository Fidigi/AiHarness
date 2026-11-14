import { randomUUID } from 'node:crypto';
import { CredentialRedactor, type ProviderOAuthCredential } from './credentials.js';
import { fetchOAuthResponse, readOAuthJson, waitForOAuth } from './oauth-device.js';
const CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828', DEVICE = 'https://auth.x.ai/oauth2/device/code', TOKEN = 'https://auth.x.ai/oauth2/token';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access', LOGIN_MS = 15 * 60_000;
export interface XaiOAuthIdentity { provider: 'xai'; grantId: string }
export interface XaiOAuthCredential { accessToken: string; refreshToken: string; expiresAt: number; tokenType: 'Bearer'; subscription: XaiOAuthIdentity }
export type XaiOAuthCredentialSource = (signal?: AbortSignal, allowRefresh?: boolean) => Promise<ProviderOAuthCredential | undefined>;
export interface XaiOAuthOptions { signal?: AbortSignal; fetcher?: typeof fetch; redactor?: CredentialRedactor }
export interface XaiDeviceLogin { userCode: string; verificationUri: string; expiresAt: number; complete(signal?: AbortSignal): Promise<XaiOAuthCredential>; cancel(): void }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && !!value && Buffer.byteLength(value) <= maximum && !/[\u0000-\u0020\u007f-\u009f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value; }
export function validXaiOAuthIdentity(value: unknown): value is XaiOAuthIdentity { const identity = value as Partial<XaiOAuthIdentity> | undefined; return !!identity && identity.provider === 'xai' && typeof identity.grantId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(identity.grantId); }
function verification(value: unknown): string { if (!text(value, 4096)) throw new Error(); const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(); return url.href; }
async function post(url: string, fields: Record<string, string>, options: XaiOAuthOptions) {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]); signal.throwIfAborted();
  const response = await fetchOAuthResponse(url, { method: 'POST', redirect: 'manual', signal, headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }, signal, options.fetcher);
  const data = await readOAuthJson(response, signal); signal.throwIfAborted(); return { response, data };
}
function credential(data: Record<string, unknown>, identity: XaiOAuthIdentity, redactor: CredentialRedactor, previous?: string): XaiOAuthCredential {
  redactor.add(typeof data.access_token === 'string' ? data.access_token : undefined); redactor.add(typeof data.refresh_token === 'string' ? data.refresh_token : undefined);
  const refresh = data.refresh_token === undefined ? previous : data.refresh_token, ttl = data.expires_in === undefined ? 3600 : data.expires_in;
  if (!text(data.access_token, 64 * 1024) || !text(refresh, 64 * 1024) || typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0 || ttl > 365 * 24 * 60 * 60
    || data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) throw new Error();
  new Headers({ authorization: `Bearer ${data.access_token}` });
  return { accessToken: data.access_token, refreshToken: refresh, expiresAt: Date.now() + Math.floor(ttl * 1000) - 5 * 60_000, tokenType: 'Bearer', subscription: { ...identity } };
}
/** Fixed issuer, never inferred from a storage label, inference endpoint or generic refresh hint. */
export async function refreshXaiToken(refreshToken: string, identity: XaiOAuthIdentity, options: XaiOAuthOptions = {}): Promise<XaiOAuthCredential> {
  options = { signal: options.signal, fetcher: options.fetcher, redactor: options.redactor };
  if (!validXaiOAuthIdentity(identity) || !text(refreshToken, 64 * 1024)) throw new Error('Invalid xAI refresh credential.');
  const subscription = { provider: 'xai' as const, grantId: identity.grantId }, redactor = options.redactor ?? new CredentialRedactor(); redactor.add(refreshToken);
  try { const { response, data } = await post(TOKEN, { grant_type: 'refresh_token', client_id: CLIENT, refresh_token: refreshToken }, options); if (!response.ok) throw new Error(); options.signal?.throwIfAborted(); return credential(data, subscription, redactor, refreshToken); }
  catch { throw new Error(options.signal?.aborted ? 'xAI authentication cancelled.' : 'xAI token refresh failed.'); }
}
/** Host reserves encrypted publication first; SDK owns no opener, listener or storage. */
export async function beginXaiDeviceLogin(options: XaiOAuthOptions = {}): Promise<XaiDeviceLogin> {
  options = { signal: options.signal, fetcher: options.fetcher, redactor: options.redactor };
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LOGIN_MS), ...(options.signal ? [options.signal] : [])]), redactor = options.redactor ?? new CredentialRedactor();
  try {
    const { response, data } = await post(DEVICE, { client_id: CLIENT, scope: SCOPE, referrer: 'pi' }, { ...options, signal }); redactor.add(typeof data.device_code === 'string' ? data.device_code : undefined);
    if (!response.ok || !text(data.device_code, 4000) || !text(data.user_code, 500) || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error();
    const base = verification(data.verification_uri), verificationUri = typeof data.verification_uri_complete === 'string' && data.verification_uri_complete ? verification(data.verification_uri_complete) : base;
    if (redactor.redact(verificationUri) !== verificationUri || redactor.redact(data.user_code) !== data.user_code) throw new Error();
    const deviceCode = data.device_code, userCode = data.user_code, expiresAt = Date.now() + Math.min(LOGIN_MS, Math.floor(data.expires_in * 1000)), identity: XaiOAuthIdentity = { provider: 'xai', grantId: randomUUID() };
    const initialInterval = typeof data.interval === 'number' && Number.isFinite(data.interval) && data.interval > 0 ? Math.max(1000, Math.floor(data.interval * 1000)) : 5000; let used = false; signal.throwIfAborted();
    return { userCode, verificationUri, expiresAt, cancel: () => controller.abort(), complete: async caller => {
      if (used) throw new Error('xAI login already consumed.'); used = true;
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, expiresAt - Date.now())), ...(caller ? [caller] : [])]); let interval = initialInterval;
      try {
        for (let attempts = 0; attempts < 600 && Date.now() < expiresAt; attempts++) {
          lifetime.throwIfAborted(); await waitForOAuth(Math.min(interval, Math.max(0, expiresAt - Date.now())), lifetime); lifetime.throwIfAborted(); if (Date.now() >= expiresAt) throw new Error();
          const { response, data } = await post(TOKEN, { client_id: CLIENT, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, { ...options, redactor, signal: lifetime }); lifetime.throwIfAborted(); if (Date.now() >= expiresAt) throw new Error();
          if (response.ok) return credential(data, identity, redactor);
          if (data.error === 'slow_down') { interval = typeof data.interval === 'number' && Number.isFinite(data.interval) && data.interval > 0 ? Math.max(1000, Math.floor(data.interval * 1000)) : interval + 5000; continue; }
          if (data.error !== 'authorization_pending') throw new Error();
        }
        throw new Error();
      } catch { throw new Error(lifetime.aborted ? 'xAI authentication cancelled.' : 'xAI device login failed.'); }
      finally { controller.abort(); }
    } };
  } catch { const error = new Error(signal.aborted ? 'xAI authentication cancelled.' : 'xAI device login failed.'); controller.abort(); throw error; }
}
