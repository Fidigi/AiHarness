import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readOAuthJson } from './oauth-device.js';
import { disableProviderNetworkRetries } from './provider-network.js';
import type { CredentialRedactor } from './credentials.js';

/** Explicit trusted file only; host admission owns standard-path/environment selection. */
export interface VertexAdcConfig {
  credentialsFile: string;
  quotaProjectId?: string;
  signal?: AbortSignal;
  redactor?: Pick<CredentialRedactor, 'add'>;
}
type Send = (url: string | URL, init: RequestInit) => Promise<Response>;
const TOKEN = 'https://oauth2.googleapis.com/token', SCOPE = 'https://www.googleapis.com/auth/cloud-platform', MAX_FILE = 256 * 1024;
const failure = () => new Error('Vertex ADC authentication failed.');
const text = (value: unknown, max = 64 * 1024): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= max
  && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;

/** Descriptor-only auth intent; filtered configured headers must not promote a fallback. */
export function hasVertexAuthHeaders(config: object): boolean {
  try {
    const slot = Object.getOwnPropertyDescriptor(config, 'customHeaders'); if (!slot) return false; if (!('value' in slot)) return true;
    const headers: unknown = slot.value; if (!headers || typeof headers !== 'object') return false;
    return Object.getOwnPropertyNames(headers).some(name => {
      if (!['authorization', 'x-goog-api-key'].includes(name.toLowerCase())) return false;
      const value = Object.getOwnPropertyDescriptor(headers, name); return !value || !('value' in value) || typeof value.value === 'string' && !!value.value.trim();
    });
  } catch { return true; }
}
async function observed<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(work), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Per-instance cache bound to the exact current file bytes, never a global/persisted token cache. */
export class VertexAdc {
  private readonly file: string;
  private readonly lifetime?: AbortSignal;
  private readonly redactor?: Pick<CredentialRedactor, 'add'>;
  private readonly quota?: string;
  private cached?: { fingerprint: string; token: string; expiresAt: number };
  private sequence = 0;
  private published = 0;
  constructor(config: VertexAdcConfig) {
    if (!config || typeof config.credentialsFile !== 'string' || !config.credentialsFile || Buffer.byteLength(config.credentialsFile) > 4096
      || /[\u0000-\u001f\u007f-\u009f]/u.test(config.credentialsFile) || config.quotaProjectId !== undefined && !text(config.quotaProjectId, 500)) throw failure();
    this.file = config.credentialsFile; this.lifetime = config.signal; this.redactor = config.redactor; this.quota = config.quotaProjectId;
  }
  private async document(signal: AbortSignal) {
    signal.throwIfAborted(); const handle = await open(this.file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      signal.throwIfAborted(); const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_FILE) throw failure();
      const buffer = Buffer.alloc(MAX_FILE + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); signal.throwIfAborted(); if (bytesRead > MAX_FILE) throw failure();
      const bytes = buffer.subarray(0, bytesRead), value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(); const data = value as Record<string, unknown>;
      for (const field of ['client_secret', 'refresh_token', 'private_key']) this.redactor?.add(typeof data[field] === 'string' ? data[field] as string : undefined);
      if (data.universe_domain !== undefined && data.universe_domain !== 'googleapis.com') throw failure();
      if (data.type === 'authorized_user') { if (!text(data.client_id, 4096) || !text(data.client_secret) || !text(data.refresh_token)) throw failure(); }
      else if (data.type === 'service_account') { if (!text(data.client_email, 4096) || typeof data.private_key !== 'string' || !data.private_key || Buffer.byteLength(data.private_key) > 128 * 1024) throw failure(); }
      else throw failure();
      const quota = this.quota ?? data.quota_project_id; if (quota !== undefined && !text(quota, 500)) throw failure(); if (quota) new Headers({ 'x-goog-user-project': quota });
      return { data, fingerprint: createHash('sha256').update(bytes).digest('hex'), quota };
    } finally { await handle.close(); }
  }
  private async credential(send: Send, parent: AbortSignal) {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]); disableProviderNetworkRetries(signal);
    return observed(async () => {
      const document = await this.document(signal), sequence = ++this.sequence;
      if (this.cached?.fingerprint === document.fingerprint && this.cached.expiresAt > Date.now() + 300_000) return { ...document, token: this.cached.token };
      const data = document.data; let fields: Record<string, string>;
      if (data.type === 'authorized_user') fields = { grant_type: 'refresh_token', client_id: data.client_id as string, client_secret: data.client_secret as string, refresh_token: data.refresh_token as string };
      else {
        const key = createPrivateKey(data.private_key as string); if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw failure();
        const now = Math.floor(Date.now() / 1000), header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: data.client_email, scope: SCOPE, aud: TOKEN, iat: now, exp: now + 3600 })).toString('base64url'), unsigned = `${header}.${payload}`;
        const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`; this.redactor?.add(assertion);
        fields = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion };
      }
      signal.throwIfAborted(); const response = await send(TOKEN, { method: 'POST', redirect: 'manual', signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields) });
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw failure(); } const body = await readOAuthJson(response, signal);
      this.redactor?.add(typeof body.access_token === 'string' ? body.access_token : undefined);
      if (!text(body.access_token) || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 31_536_000
        || body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')) throw failure();
      new Headers({ authorization: `Bearer ${body.access_token}` }); if ((await this.document(signal)).fingerprint !== document.fingerprint) throw failure(); signal.throwIfAborted();
      if (sequence > this.published) { this.published = sequence; this.cached = { fingerprint: document.fingerprint, token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }; }
      return { ...document, token: body.access_token };
    }, signal);
  }
  async request(url: string | URL, init: RequestInit, parent: AbortSignal, send: Send): Promise<Response> {
    const signal = this.lifetime ? AbortSignal.any([parent, this.lifetime]) : parent;
    try {
      const credential = await this.credential(send, signal); signal.throwIfAborted(); const headers = new Headers(init.headers); headers.delete('x-goog-api-key'); headers.set('authorization', `Bearer ${credential.token}`);
      if (credential.quota && !headers.has('x-goog-user-project')) headers.set('x-goog-user-project', credential.quota);
      const response = await send(url, { ...init, headers, signal, redirect: 'manual' }); signal.throwIfAborted();
      if (response.status === 401 && this.cached?.token === credential.token) this.cached = undefined;
      return response;
    } catch { throw failure(); }
  }
}
