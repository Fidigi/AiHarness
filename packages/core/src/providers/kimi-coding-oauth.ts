import { randomUUID } from 'node:crypto';
import { CredentialRedactor, type ProviderOAuthRefreshConfig, type ProviderOAuthCredential } from './credentials.js';
import { OAuthDeviceClient } from './oauth-device.js';

export const KIMI_CODING_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

export interface KimiCodingOAuthConfig extends Readonly<Pick<ProviderOAuthRefreshConfig, 'tokenUrl' | 'clientId'>> {
  readonly deviceAuthorizationUrl: string;
  readonly responseProfile: 'kimi-coding';
}

/** Explicit issuer configuration; never selected from a provider label or token. */
export function getKimiCodingOAuthConfig(oauthHost = 'https://auth.kimi.com'): KimiCodingOAuthConfig {
  const invalid = (): never => { throw new Error('Kimi Coding OAuth host is invalid.'); };
  if (typeof oauthHost !== 'string' || !oauthHost || Buffer.byteLength(oauthHost) > 4096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(oauthHost)) invalid();
  let endpoint: URL;
  try { endpoint = new URL(oauthHost); }
  catch { return invalid(); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || oauthHost.includes('?') || oauthHost.includes('#')) invalid();
  const base = endpoint.toString().replace(/\/+$/u, '');
  const deviceAuthorizationUrl = `${base}/api/oauth/device_authorization`;
  const tokenUrl = `${base}/api/oauth/token`;
  if (Buffer.byteLength(deviceAuthorizationUrl) > 4096 || Buffer.byteLength(tokenUrl) > 4096) invalid();
  return Object.freeze({ deviceAuthorizationUrl, tokenUrl,
    clientId: KIMI_CODING_OAUTH_CLIENT_ID, responseProfile: 'kimi-coding' });
}

export interface KimiCodingOAuthIdentity { provider: 'kimi-coding'; oauthHost: string; grantId: string }
export interface KimiCodingOAuthCredential { accessToken: string; refreshToken: string; expiresAt: number; subscription: KimiCodingOAuthIdentity }
export type KimiCodingOAuthCredentialSource = (signal?: AbortSignal, allowRefresh?: boolean) => Promise<ProviderOAuthCredential | undefined>;
export interface KimiCodingOAuthOptions { oauthHost?: string; signal?: AbortSignal; fetcher?: typeof fetch; redactor?: CredentialRedactor }
export interface KimiCodingDeviceLogin { userCode: string; verificationUri: string; expiresAt: number; complete(signal?: AbortSignal): Promise<KimiCodingOAuthCredential>; cancel(): void }
function issuerHost(value?: string): string { return getKimiCodingOAuthConfig(value).tokenUrl.slice(0, -'/api/oauth/token'.length); }
export function validKimiCodingOAuthIdentity(value: unknown): value is KimiCodingOAuthIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<KimiCodingOAuthIdentity>;
  if (identity.provider !== 'kimi-coding' || typeof identity.oauthHost !== 'string' || typeof identity.grantId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(identity.grantId)) return false;
  try { return issuerHost(identity.oauthHost) === identity.oauthHost; } catch { return false; }
}
/** Fixed native issuer; hosts reserve encrypted publication before beginning this flow. */
export async function beginKimiCodingDeviceLogin(options: KimiCodingOAuthOptions = {}): Promise<KimiCodingDeviceLogin> {
  const config = getKimiCodingOAuthConfig(options.oauthHost), oauthHost = config.tokenUrl.slice(0, -'/api/oauth/token'.length), controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000), ...(options.signal ? [options.signal] : [])]);
  const redactor = options.redactor ?? new CredentialRedactor(), client = new OAuthDeviceClient(config, redactor, options.fetcher);
  const failure = () => new Error(signal.aborted ? 'Kimi Coding authentication cancelled.' : 'Kimi Coding device login failed.');
  try {
    const prompt = Object.freeze(await client.requestCode(signal)), verificationUri = prompt.verificationUriComplete!;
    redactor.add(prompt.deviceCode);
    if (redactor.redact(verificationUri) !== verificationUri || redactor.redact(prompt.userCode) !== prompt.userCode
      || Buffer.from(prompt.userCode, 'utf8').toString('utf8') !== prompt.userCode) throw new Error();
    const expiresAt = Date.now() + Math.min(15 * 60_000, Math.floor(prompt.expiresIn * 1000));
    const subscription: KimiCodingOAuthIdentity = { provider: 'kimi-coding', oauthHost, grantId: randomUUID() };
    let used = false; signal.throwIfAborted();
    return { userCode: prompt.userCode, verificationUri, expiresAt, cancel: () => controller.abort(), complete: async caller => {
      if (used) throw new Error('Kimi Coding login already consumed.'); used = true;
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, expiresAt - Date.now())), ...(caller ? [caller] : [])]);
      try {
        lifetime.throwIfAborted(); if (Date.now() >= expiresAt) throw new Error(); const value = await client.pollCredential(prompt, lifetime); lifetime.throwIfAborted();
        if (!value.refreshToken || !Number.isSafeInteger(value.expiresAt) || value.expiresAt! <= Date.now()) throw new Error();
        for (const token of [value.accessToken, value.refreshToken]) if (/\s/u.test(token) || Buffer.from(token, 'utf8').toString('utf8') !== token) throw new Error();
        return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt!, subscription: { ...subscription } };
      } catch { throw new Error(lifetime.aborted ? 'Kimi Coding authentication cancelled.' : 'Kimi Coding device login failed.'); }
      finally { controller.abort(); }
    } };
  } catch { const error = failure(); controller.abort(); throw error; }
}
