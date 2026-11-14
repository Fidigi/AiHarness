import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CredentialRedactor } from './credentials.js';
import { fetchOAuthResponse, readOAuthJson } from './oauth-device.js';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e', AUTHORIZE = 'https://claude.ai/oauth/authorize', TOKEN = 'https://platform.claude.com/v1/oauth/token';
const BROWSER = 'http://localhost:53692/callback', COPY_CODE = 'https://platform.claude.com/oauth/code/callback', LOGIN_MS = 5 * 60_000;
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export interface AnthropicOAuthIdentity { provider: 'anthropic'; grantId: string }
export interface AnthropicOAuthCredential { accessToken: string; refreshToken: string; expiresAt: number; tokenType: 'Bearer'; subscription: AnthropicOAuthIdentity }
export interface AnthropicOAuthOptions { signal?: AbortSignal; fetcher?: typeof fetch; redactor?: CredentialRedactor }
export interface AnthropicBrowserOAuthOptions extends AnthropicOAuthOptions { callbackUrl?: string }
export interface AnthropicLogin {
  authorizationUrl: string;
  callbackUrl: string;
  expiresAt: number;
  complete(input: string, signal?: AbortSignal): Promise<AnthropicOAuthCredential>;
  cancel(): void;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !!value && Buffer.byteLength(value) <= maximum && !/[\u0000-\u0020\u007f-\u009f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
}
export function validAnthropicOAuthIdentity(value: unknown): value is AnthropicOAuthIdentity {
  const identity = value as Partial<AnthropicOAuthIdentity> | undefined;
  return !!identity && identity.provider === 'anthropic' && typeof identity.grantId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(identity.grantId);
}
function browserCallback(value: string): string {
  try { if (!text(value, 4096)) throw new Error(); const url = new URL(value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.port || url.pathname !== '/callback' || url.username || url.password || url.hash || url.search) throw new Error(); return url.href;
  } catch { throw new Error('Invalid Anthropic callback endpoint.'); }
}
async function exchange(body: Record<string, string>, identity: AnthropicOAuthIdentity, options: AnthropicOAuthOptions): Promise<AnthropicOAuthCredential> {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]), redactor = options.redactor ?? new CredentialRedactor();
  try {
    signal.throwIfAborted(); const response = await fetchOAuthResponse(TOKEN, { method: 'POST', redirect: 'manual', signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }, signal, options.fetcher);
    const data = await readOAuthJson(response, signal); redactor.add(typeof data.access_token === 'string' ? data.access_token : undefined); redactor.add(typeof data.refresh_token === 'string' ? data.refresh_token : undefined);
    if (!response.ok || !text(data.access_token, 64 * 1024) || !text(data.refresh_token, 64 * 1024) || !Number.isSafeInteger(data.expires_in) || (data.expires_in as number) <= 0 || (data.expires_in as number) > 365 * 24 * 60 * 60
      || data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) throw new Error();
    new Headers({ authorization: `Bearer ${data.access_token}` }); signal.throwIfAborted();
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + (data.expires_in as number) * 1000 - 5 * 60_000,
      tokenType: 'Bearer', subscription: { provider: 'anthropic', grantId: identity.grantId } };
  } catch { throw new Error(signal.aborted ? 'Anthropic OAuth cancelled.' : 'Anthropic token exchange failed.'); }
}
/** Fixed issuer; inference proxies/generic OAuth hints never retarget refresh. Identity is local, not an account subject. */
export async function refreshAnthropicToken(refreshToken: string, identity: AnthropicOAuthIdentity, options: AnthropicOAuthOptions = {}): Promise<AnthropicOAuthCredential> {
  if (!validAnthropicOAuthIdentity(identity) || !text(refreshToken, 64 * 1024)) throw new Error('Invalid Anthropic refresh credential.');
  options.redactor?.add(refreshToken);
  return exchange({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken }, { ...identity }, options);
}
function begin(copyCode: boolean, callbackUrl: string, options: AnthropicOAuthOptions): AnthropicLogin {
  const callback = new URL(callbackUrl), controller = new AbortController(), expiresAt = Date.now() + LOGIN_MS;
  const lifetime = AbortSignal.any([controller.signal, AbortSignal.timeout(LOGIN_MS), ...(options.signal ? [options.signal] : [])]); lifetime.throwIfAborted();
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url'), redactor = options.redactor ?? new CredentialRedactor(), identity: AnthropicOAuthIdentity = { provider: 'anthropic', grantId: randomUUID() };
  redactor.add(verifier); const authorization = new URL(AUTHORIZE); authorization.search = new URLSearchParams({ code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: callback.href, scope: SCOPES,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state }).toString();
  let used = false;
  return { authorizationUrl: authorization.href, callbackUrl: callback.href, expiresAt, cancel: () => controller.abort(), complete: async (input, caller) => {
    const signal = AbortSignal.any([lifetime, ...(caller ? [caller] : [])]);
    if (used) throw new Error('Anthropic login already consumed.'); if (signal.aborted) throw new Error('Anthropic login cancelled.'); if (Date.now() >= expiresAt) throw new Error('Anthropic login expired.');
    let code: string;
    try {
      if (!text(input, 8192)) throw new Error();
      if (copyCode && !input.includes('://')) { const parts = input.split('#'); if (parts.length > 2 || !text(parts[0], 4096) || parts.length === 2 && parts[1] !== state) throw new Error(); code = parts[0]; }
      else { const redirect = new URL(input);
        if (redirect.origin !== callback.origin || redirect.pathname !== callback.pathname || redirect.username || redirect.password || redirect.hash || redirect.searchParams.has('error')
          || redirect.searchParams.getAll('state').length !== 1 || redirect.searchParams.get('state') !== state || redirect.searchParams.getAll('code').length !== 1 || !text(redirect.searchParams.get('code'), 4096)) throw new Error(); code = redirect.searchParams.get('code')!;
      }
    } catch { throw new Error('Invalid Anthropic OAuth redirect or code.'); }
    used = true; redactor.add(code);
    try { return await exchange({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, state, redirect_uri: callback.href, code_verifier: verifier }, identity, { ...options, signal, redactor }); }
    finally { controller.abort(); }
  } };
}
/** SDK owns no listener, opener, environment, storage or publication; browser hosts provide only their owned loopback callback. */
export function beginAnthropicBrowserLogin(options: AnthropicBrowserOAuthOptions = {}): AnthropicLogin { return begin(false, browserCallback(options.callbackUrl ?? BROWSER), options); }
/** Explicit copy-code lane accepts the code (optional #state), never an arbitrary callback URL. PKCE binds a bare code to this flow. */
export function beginAnthropicCopyCodeLogin(options: AnthropicOAuthOptions = {}): AnthropicLogin { return begin(true, COPY_CODE, options); }
