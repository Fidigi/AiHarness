import { CredentialRedactor, type ProviderOAuthCredential } from './credentials.js';
import { OAuthDeviceClient, fetchOAuthResponse, readOAuthJson } from './oauth-device.js';
export const META_OAUTH_CLIENT_ID = '1031625952748946';
const DEVICE = 'https://auth.meta.com/oidc/device/authorization/', TOKEN = 'https://auth.meta.com/oidc/device/token/', MINT = 'https://api.meta.ai/muse-code/key';
export interface MetaOAuthIdentity { provider: 'meta'; grantId: string }
/** refreshToken stores the non-renewable identity token; renewal is a key remint, never an OAuth refresh grant. */
export interface MetaOAuthCredential { accessToken: string; refreshToken: string; expiresAt: number; tokenType: 'Bearer'; subscription: MetaOAuthIdentity }
export type MetaOAuthCredentialSource = (signal?: AbortSignal, allowRefresh?: boolean) => Promise<ProviderOAuthCredential | undefined>;
export interface MetaOAuthOptions { signal?: AbortSignal; fetcher?: typeof fetch; redactor?: CredentialRedactor }
export interface MetaDeviceLogin { userCode: string; verificationUri: string; expiresAt: number; complete(signal?: AbortSignal): Promise<MetaOAuthCredential>; cancel(): void }
export class MetaOAuthSetupRequiredError extends Error {
  constructor(readonly actionUrl: string) { super(`Meta did not issue an API key. Complete setup at ${actionUrl}`); this.name = 'MetaOAuthSetupRequiredError'; }
}
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && !!value && Buffer.byteLength(value) <= maximum && !/[\u0000-\u0020\u007f-\u009f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value; }
export function validMetaOAuthIdentity(value: unknown): value is MetaOAuthIdentity { const identity = value as Partial<MetaOAuthIdentity> | undefined; return !!identity && identity.provider === 'meta' && typeof identity.grantId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(identity.grantId); }
export function getMetaOAuthConfig() { return Object.freeze({ clientId: META_OAUTH_CLIENT_ID, deviceAuthorizationUrl: DEVICE, tokenUrl: TOKEN, responseProfile: 'meta' as const }); }
/** Fixed mint authority, independent of inference endpoint, label, generic OAuth hints and identity-token contents. */
export async function refreshMetaApiKey(identityToken: string, identity: MetaOAuthIdentity, options: MetaOAuthOptions = {}): Promise<MetaOAuthCredential> {
  if (!validMetaOAuthIdentity(identity) || !text(identityToken, 64 * 1024)) throw new Error('Invalid Meta identity credential.');
  const subscription = { provider: 'meta' as const, grantId: identity.grantId }, signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]), redactor = options.redactor ?? new CredentialRedactor(); redactor.add(identityToken);
  try {
    signal.throwIfAborted(); const authorization = new Headers({ authorization: `Bearer ${identityToken}`, accept: 'application/json', 'content-type': 'application/json', 'x-api-version': '1.0.0' });
    const response = await fetchOAuthResponse(MINT, { method: 'POST', redirect: 'manual', signal, headers: authorization, body: '{}' }, signal, options.fetcher);
    if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => undefined); throw new Error('Meta session expired. Sign in again.'); }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(); }
    const data = await readOAuthJson(response, signal); redactor.add(typeof data.api_key === 'string' ? data.api_key : undefined);
    if (!text(data.api_key, 64 * 1024)) {
      if (text(data.action_url, 4096)) { try { const url = new URL(data.action_url); if (url.protocol === 'https:' && !url.username && !url.password && !url.hash && redactor.redact(url.href) === url.href) throw new MetaOAuthSetupRequiredError(url.href); } catch (error) { if (error instanceof MetaOAuthSetupRequiredError) throw error; } }
      throw new Error();
    }
    new Headers({ authorization: `Bearer ${data.api_key}` }); signal.throwIfAborted();
    return { accessToken: data.api_key, refreshToken: identityToken, expiresAt: Date.now() + 24 * 60 * 60 * 1000, tokenType: 'Bearer', subscription };
  } catch (error) {
    if (signal.aborted) throw new Error('Meta authentication cancelled.');
    if (error instanceof MetaOAuthSetupRequiredError || error instanceof Error && error.message === 'Meta session expired. Sign in again.') throw error;
    throw new Error('Meta API key mint failed.');
  }
}
/** Device flow owns no storage/opener; host reserves encrypted publication before beginning. */
export async function beginMetaDeviceLogin(options: MetaOAuthOptions = {}): Promise<MetaDeviceLogin> {
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000), ...(options.signal ? [options.signal] : [])]), redactor = options.redactor ?? new CredentialRedactor(), client = new OAuthDeviceClient(getMetaOAuthConfig(), redactor, options.fetcher);
  try {
    const prompt = Object.freeze(await client.requestCode(signal)), verificationUri = prompt.verificationUriComplete ?? prompt.verificationUri; redactor.add(prompt.deviceCode);
    if (redactor.redact(verificationUri) !== verificationUri || redactor.redact(prompt.userCode) !== prompt.userCode || Buffer.from(prompt.userCode, 'utf8').toString('utf8') !== prompt.userCode) throw new Error();
    const expiresAt = Date.now() + Math.min(15 * 60_000, Math.floor(prompt.expiresIn * 1000)); let used = false; signal.throwIfAborted();
    return { userCode: prompt.userCode, verificationUri, expiresAt, cancel: () => controller.abort(), complete: async caller => {
      if (used) throw new Error('Meta login already consumed.'); used = true;
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, expiresAt - Date.now())), ...(caller ? [caller] : [])]);
      try { lifetime.throwIfAborted(); if (Date.now() >= expiresAt) throw new Error(); const result = await client.pollCredential(prompt, lifetime); lifetime.throwIfAborted();
        if (!result.refreshToken || !Number.isSafeInteger(result.expiresAt) || !validMetaOAuthIdentity(result.subscription)) throw new Error();
        return { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt!, tokenType: 'Bearer', subscription: { ...result.subscription } };
      } catch (error) { if (lifetime.aborted) throw new Error('Meta authentication cancelled.'); if (error instanceof MetaOAuthSetupRequiredError || error instanceof Error && error.message === 'Meta session expired. Sign in again.') throw error; throw new Error('Meta device login failed.'); }
      finally { controller.abort(); }
    } };
  } catch { const error = new Error(signal.aborted ? 'Meta authentication cancelled.' : 'Meta device login failed.'); controller.abort(); throw error; }
}
