import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { readOAuthJson } from './oauth-device.js';
import { disableProviderNetworkRetries } from './provider-network.js';

/** Explicit workload configuration only; never discovers profiles or reads environment variables. */
export interface AnthropicFederationConfig {
  federationRuleId: string;
  organizationId: string;
  identityTokenFile: string;
  serviceAccountId?: string;
  workspaceId?: string;
}

export function hasAnthropicAuthHeaders(config: object): boolean {
  try {
    const slot = Object.getOwnPropertyDescriptor(config, 'customHeaders');
    if (!slot) return false;
    if (!('value' in slot)) return true;
    const headers: unknown = slot.value;
    if (!headers || typeof headers !== 'object') return false;
    return Object.getOwnPropertyNames(headers).some(name => {
      if (!['authorization', 'x-api-key', 'cf-aig-authorization'].includes(name.toLowerCase())) return false;
      const value = Object.getOwnPropertyDescriptor(headers, name);
      return !value || !('value' in value) || typeof value.value === 'string' && !!value.value.trim();
    });
  } catch { return true; }
}

type Send = (url: string | URL, init: RequestInit) => Promise<Response>;
const failure = (): Error => new Error('Anthropic workload authentication failed.');
const text = (value: unknown, maximum = 500): value is string => typeof value === 'string' && !!value
  && Buffer.byteLength(value) <= maximum && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);
const OAUTH_BETA = 'oauth-2025-04-20';

async function identityToken(file: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  // Projected Kubernetes tokens may be symlinks. The explicitly supplied path is trusted,
  // but directories/devices/FIFOs and unbounded or invalid UTF-8 content are not tokens.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted(); const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 + 2) throw failure();
    const buffer = Buffer.alloc(16 * 1024 + 3), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    const token = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)).trim();
    if (bytesRead === buffer.length || !text(token, 16 * 1024)) throw failure();
    return token;
  } finally { await handle.close(); }
}

async function observed<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const canceled = new Promise<never>((_, reject) => { abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(work), canceled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Instance-local token cache. Each caller owns its exchange; cancellation cannot retire another caller. */
export class AnthropicFederation {
  private readonly config: Readonly<AnthropicFederationConfig>;
  private readonly endpoint: string;
  private cached?: { token: string; expiresAt: number };
  private sequence = 0;
  private published = 0;

  constructor(config: AnthropicFederationConfig, baseUrl: string) {
    if (!config || !text(config.federationRuleId) || !text(config.organizationId)
      || typeof config.identityTokenFile !== 'string' || !config.identityTokenFile || Buffer.byteLength(config.identityTokenFile) > 4096
      || /[\u0000-\u001f\u007f-\u009f]/u.test(config.identityTokenFile)
      || config.serviceAccountId !== undefined && !text(config.serviceAccountId)
      || config.workspaceId !== undefined && !text(config.workspaceId)) throw failure();
    let base: URL; try { base = new URL(baseUrl); } catch { throw failure(); }
    if (base.username || base.password || base.search || base.hash || !(base.protocol === 'https:'
      || base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw failure();
    this.endpoint = base.toString().replace(/\/+$/u, '') + '/v1/oauth/token';
    this.config = Object.freeze({ federationRuleId: config.federationRuleId, organizationId: config.organizationId,
      identityTokenFile: config.identityTokenFile, ...(config.serviceAccountId ? { serviceAccountId: config.serviceAccountId } : {}),
      ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}) });
  }

  private async token(send: Send, parent: AbortSignal): Promise<string> {
    parent.throwIfAborted();
    const previous = this.cached;
    if (previous && previous.expiresAt - Date.now() > 120_000) return previous.token;
    const sequence = ++this.sequence, signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
    disableProviderNetworkRetries(signal);
    try {
      return await observed(async () => {
        const assertion = await identityToken(this.config.identityTokenFile, signal); signal.throwIfAborted();
        const response = await send(this.endpoint, { method: 'POST', redirect: 'manual', signal,
          headers: { 'content-type': 'application/json', 'anthropic-beta': `${OAUTH_BETA},oidc-federation-2026-04-01` },
          body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
            federation_rule_id: this.config.federationRuleId, organization_id: this.config.organizationId,
            ...(this.config.serviceAccountId ? { service_account_id: this.config.serviceAccountId } : {}),
            ...(this.config.workspaceId ? { workspace_id: this.config.workspaceId } : {}) }) });
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw failure(); }
        const body = await readOAuthJson(response, signal);
        if (!text(body.access_token, 16 * 1024) || body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')
          || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 31_536_000) throw failure();
        new Headers({ authorization: `Bearer ${body.access_token}` }); signal.throwIfAborted();
        const token = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
        if (sequence > this.published) { this.published = sequence; this.cached = token; }
        return token.token;
      }, signal);
    } catch {
      // Foreground advisory refresh avoids background network work. Failure may use a
      // still-valid token only outside the SDK's 30-second mandatory refresh window.
      if (!signal.aborted && previous && previous.expiresAt - Date.now() > 30_000) return previous.token;
      throw failure();
    }
  }

  async request(url: string | URL, init: RequestInit, signal: AbortSignal, send: Send): Promise<Response> {
    try {
      let token = await this.token(send, signal); signal.throwIfAborted();
      const authenticated = (): RequestInit => {
        const headers = new Headers(init.headers); headers.delete('x-api-key'); headers.set('authorization', `Bearer ${token}`);
        headers.set('anthropic-beta', [...new Set([...(headers.get('anthropic-beta')?.split(',').map(value => value.trim()).filter(Boolean) ?? []), OAUTH_BETA])].join(','));
        return { ...init, signal, headers, redirect: 'manual' };
      };
      let response = await send(url, authenticated());
      if (response.status === 401) {
        void response.body?.cancel().catch(() => undefined);
        if (this.cached?.token === token) this.cached = undefined;
        token = await this.token(send, signal); signal.throwIfAborted(); response = await send(url, authenticated());
      }
      return response;
    } catch { throw failure(); }
  }
}
