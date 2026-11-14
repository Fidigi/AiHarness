import { createHash, randomBytes } from 'node:crypto';
import { CredentialRedactor } from './credentials.js';
import { fetchOAuthResponse, readOAuthJson } from './oauth-device.js';
const AUTHORIZE = 'https://openrouter.ai/auth', TOKEN = 'https://openrouter.ai/api/v1/auth/keys', LOGIN_MS = 5 * 60_000;
export interface OpenRouterOAuthOptions { signal?: AbortSignal; fetcher?: typeof fetch; redactor?: CredentialRedactor }
export interface OpenRouterLogin {
  authorizationUrl: string;
  callbackUrl: string;
  expiresAt: number;
  complete(redirectUrl: string, signal?: AbortSignal): Promise<{ apiKey: string }>;
  cancel(): void;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !!value && Buffer.byteLength(value) <= maximum && !/[\u0000-\u0020\u007f-\u009f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function callbackEndpoint(value: string): URL {
  try {
    if (!text(value, 4096)) throw new Error(); const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash
      || !/^\/oauth\/callback\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(url.pathname)) throw new Error();
    return url;
  } catch { throw new Error('Invalid OpenRouter callback endpoint.'); }
}
/** Hosts own their loopback listener/paste transport and reserve encrypted publication before remote work. */
export function beginOpenRouterLogin(callbackUrl: string, options: OpenRouterOAuthOptions = {}): OpenRouterLogin {
  const callback = callbackEndpoint(callbackUrl), controller = new AbortController(), expiresAt = Date.now() + LOGIN_MS;
  const lifetime = AbortSignal.any([controller.signal, AbortSignal.timeout(LOGIN_MS), ...(options.signal ? [options.signal] : [])]); lifetime.throwIfAborted();
  const verifier = randomBytes(32).toString('base64url'), redactor = options.redactor ?? new CredentialRedactor(), fetcher = options.fetcher;
  redactor.add(verifier); const authorization = new URL(AUTHORIZE);
  authorization.search = new URLSearchParams({ callback_url: callback.href, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  let used = false;
  return { authorizationUrl: authorization.href, callbackUrl: callback.href, expiresAt, cancel: () => controller.abort(), complete: async (redirectUrl, caller) => {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000), ...(caller ? [caller] : [])]);
    if (used) throw new Error('OpenRouter login already consumed.');
    if (signal.aborted) throw new Error('OpenRouter login cancelled.'); if (Date.now() >= expiresAt) throw new Error('OpenRouter login expired.');
    let code: string;
    try {
      if (!text(redirectUrl, 8192)) throw new Error(); const redirect = new URL(redirectUrl);
      if (redirect.origin !== callback.origin || redirect.pathname !== callback.pathname || redirect.username || redirect.password || redirect.hash || redirect.searchParams.has('error')
        || redirect.searchParams.getAll('code').length !== 1 || !text(redirect.searchParams.get('code'), 4096)) throw new Error();
      code = redirect.searchParams.get('code')!;
    } catch { throw new Error('Invalid OpenRouter OAuth redirect.'); }
    used = true; redactor.add(code);
    try {
      const response = await fetchOAuthResponse(TOKEN, { method: 'POST', redirect: 'manual', signal, headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }) }, signal, fetcher);
      const body = await readOAuthJson(response, signal); redactor.add(typeof body.key === 'string' ? body.key : undefined);
      if (!response.ok || !text(body.key, 64 * 1024)) throw new Error();
      new Headers({ authorization: `Bearer ${body.key}` }); signal.throwIfAborted(); return { apiKey: body.key };
    } catch { throw new Error(signal.aborted ? 'OpenRouter login cancelled.' : 'OpenRouter key exchange failed.'); }
    finally { controller.abort(); }
  } };
}
