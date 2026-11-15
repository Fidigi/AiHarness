import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchOAuthResponse, readOAuthJson } from './oauth-device.js';
import type { BedrockProfileCredentials } from './bedrock-profile.js';
import type { CredentialRedactor } from './credentials.js';

/** Explicit container endpoint only; native hosts own environment/source priority and offline admission. */
export interface BedrockEcsConfig {
  relativeUri?: string;
  fullUri?: string;
  authorizationToken?: string;
  authorizationTokenFile?: string;
  signal?: AbortSignal;
  redactor?: Pick<CredentialRedactor, 'add'>;
}
const failure = () => new Error('Bedrock container authentication failed.');
const safe = (value: unknown, max: number): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function endpoint(config: BedrockEcsConfig): string {
  const value = config.relativeUri ? 'http://169.254.170.2' + config.relativeUri : config.fullUri;
  if (!safe(value, 4096) || config.relativeUri && (!config.relativeUri.startsWith('/') || config.relativeUri.startsWith('//'))) throw failure();
  let url: URL; try { url = new URL(value); } catch { throw failure(); }
  const loopback = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(url.hostname) && url.hostname.split('.').every(part => Number(part) <= 255);
  if (url.username || url.password || url.hash || url.protocol !== 'https:' && (url.protocol !== 'http:'
    || !loopback && !['localhost', '[::1]', '169.254.170.2', '169.254.170.23', '[fd00:ec2::23]'].includes(url.hostname))) throw failure();
  return url.toString();
}
interface Cached { identity: string; credentials: BedrockProfileCredentials; expiresAt: number; sequence: number }
/** Foreground only; no inference headers/proxy, redirects, retries, shared promises, ambient scan, disk cache or refresh timer. */
export class BedrockEcsCredentials {
  private readonly url: string;
  private readonly token?: string;
  private readonly tokenFile?: string;
  private readonly lifetime?: AbortSignal;
  private readonly redactor?: Pick<CredentialRedactor, 'add'>;
  private cached?: Cached;
  private sequence = 0;
  constructor(config: BedrockEcsConfig) {
    this.url = endpoint(config); this.lifetime = config.signal; this.redactor = config.redactor;
    if (config.authorizationTokenFile !== undefined) {
      if (!safe(config.authorizationTokenFile, 4096)) throw failure();
      this.tokenFile = path.resolve(config.authorizationTokenFile);
    } else if (config.authorizationToken !== undefined) {
      this.redactor?.add(config.authorizationToken); if (!safe(config.authorizationToken, 65536)) throw failure(); this.token = config.authorizationToken;
    }
  }
  private async identity(signal: AbortSignal): Promise<{ fingerprint: string; authorization?: string }> {
    signal.throwIfAborted(); let value = this.token, raw: Buffer | undefined;
    if (this.tokenFile) {
      const handle = await open(this.tokenFile, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        signal.throwIfAborted(); const metadata = await handle.stat(); if (!metadata.isFile() || metadata.size > 65536) throw failure();
        const buffer = Buffer.alloc(65537), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); signal.throwIfAborted(); if (bytesRead > 65536) throw failure();
        raw = buffer.subarray(0, bytesRead); value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } finally { await handle.close(); }
      this.redactor?.add(value); if (!safe(value, 65536)) throw failure();
    }
    const authorization = value === undefined ? undefined : new Headers({ authorization: value }).get('authorization')!;
    const hash = createHash('sha256'); for (const part of [Buffer.from(this.url), Buffer.from(authorization ?? ''), raw ?? Buffer.alloc(0)]) hash.update(String(part.length) + ':').update(part);
    signal.throwIfAborted(); return { fingerprint: hash.digest('hex'), ...(authorization !== undefined ? { authorization } : {}) };
  }
  invalidate(credentials: BedrockProfileCredentials, status: number): void {
    if ((status === 401 || status === 403) && this.cached?.credentials === credentials) this.cached = undefined;
  }
  async resolve(caller: AbortSignal): Promise<{ credentials: BedrockProfileCredentials; region?: string; signal: AbortSignal; assertCurrent(): Promise<void> }> {
    const signal = this.lifetime ? AbortSignal.any([caller, this.lifetime]) : caller;
    try {
      signal.throwIfAborted(); const authSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]), identity = await this.identity(authSignal);
      let cached = this.cached;
      if (!cached || cached.identity !== identity.fingerprint || cached.expiresAt <= Date.now() + 300000) {
        const sequence = ++this.sequence, response = await fetchOAuthResponse(this.url, { method: 'GET', redirect: 'manual', signal: authSignal, headers: { accept: 'application/json', ...(identity.authorization !== undefined ? { authorization: identity.authorization } : {}) } }, authSignal, (url, init) => Promise.resolve().then(() => fetch(url, init)));
        if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw failure(); }
        const body = await readOAuthJson(response, authSignal), accessKeyId = body.AccessKeyId, secretAccessKey = body.SecretAccessKey, sessionToken = body.Token;
        for (const value of [accessKeyId, secretAccessKey, sessionToken]) if (typeof value === 'string') this.redactor?.add(value);
        const expiresAt = typeof body.Expiration === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(body.Expiration) ? Date.parse(body.Expiration) : NaN;
        if (!/^[A-Za-z0-9]{1,128}$/u.test(String(accessKeyId ?? '')) || typeof accessKeyId !== 'string'
          || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(String(secretAccessKey ?? '')) || typeof secretAccessKey !== 'string'
          || !/^[A-Za-z0-9/+=]{1,61440}$/u.test(String(sessionToken ?? '')) || typeof sessionToken !== 'string' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw failure();
        if ((await this.identity(authSignal)).fingerprint !== identity.fingerprint) throw failure(); authSignal.throwIfAborted();
        cached = { identity: identity.fingerprint, credentials: Object.freeze({ accessKeyId, secretAccessKey, sessionToken }), expiresAt, sequence };
        if (!this.cached || sequence > this.cached.sequence) this.cached = cached;
      }
      const admitted = cached;
      const assertCurrent = async () => { signal.throwIfAborted(); if (admitted.expiresAt <= Date.now() || (await this.identity(signal)).fingerprint !== admitted.identity) throw failure(); signal.throwIfAborted(); };
      return { credentials: admitted.credentials, signal, assertCurrent };
    } catch { throw failure(); }
  }
}
