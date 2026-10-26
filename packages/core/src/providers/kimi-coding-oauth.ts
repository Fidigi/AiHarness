import type { ProviderOAuthRefreshConfig } from './credentials.js';

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
