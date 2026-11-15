import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchOAuthResponse, readOAuthJson } from './oauth-device.js';
import { BedrockRefreshingCredentials, bedrockCredentialFile, bedrockVendedCredentials } from './bedrock-credentials.js';
import type { BedrockCredentialIdentity, BedrockVendedCredentials } from './bedrock-credentials.js';
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
/** Pure captured descriptor shared by direct hosts and explicit role-profile leaves. */
export function bedrockEcsEnvironment(env: NodeJS.ProcessEnv, signal?: AbortSignal): BedrockEcsConfig | undefined {
  return env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI ? {
    relativeUri: env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || undefined, fullUri: env.AWS_CONTAINER_CREDENTIALS_FULL_URI || undefined,
    authorizationToken: env.AWS_CONTAINER_AUTHORIZATION_TOKEN || undefined,
    authorizationTokenFile: env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ? path.resolve(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) : undefined, signal,
  } : undefined;
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
interface Identity extends BedrockCredentialIdentity { authorization?: string }
/** Foreground only; no inference headers/proxy, redirects, retries, ambient scan, disk cache or refresh timer. */
export class BedrockEcsCredentials extends BedrockRefreshingCredentials<Identity> {
  private readonly url: string;
  private readonly token?: string;
  private readonly tokenFile?: string;
  constructor(config: BedrockEcsConfig, private readonly assertParent?: (signal: AbortSignal) => Promise<void>) {
    super('Bedrock container authentication failed.', config.signal, config.redactor);
    this.url = endpoint(config);
    if (config.authorizationTokenFile !== undefined) {
      if (!safe(config.authorizationTokenFile, 4096)) throw failure();
      this.tokenFile = path.resolve(config.authorizationTokenFile);
    } else if (config.authorizationToken !== undefined) {
      this.redactor?.add(config.authorizationToken); if (!safe(config.authorizationToken, 65536)) throw failure(); this.token = config.authorizationToken;
    }
  }
  protected async identity(signal: AbortSignal): Promise<Identity> {
    signal.throwIfAborted(); let value = this.token, raw: Buffer | undefined;
    if (this.tokenFile) {
      raw = await bedrockCredentialFile(this.tokenFile, 65536, signal); value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      this.redactor?.add(value); if (!safe(value, 65536)) throw failure();
    }
    const authorization = value === undefined ? undefined : new Headers({ authorization: value }).get('authorization')!;
    const hash = createHash('sha256'); for (const part of [Buffer.from(this.url), Buffer.from(authorization ?? ''), raw ?? Buffer.alloc(0)]) hash.update(String(part.length) + ':').update(part);
    signal.throwIfAborted(); return { fingerprint: hash.digest('hex'), ...(authorization !== undefined ? { authorization } : {}) };
  }
  protected async acquire(identity: Identity, signal: AbortSignal): Promise<BedrockVendedCredentials> {
    const response = await fetchOAuthResponse(this.url, { method: 'GET', redirect: 'manual', signal, headers: { accept: 'application/json', ...(identity.authorization !== undefined ? { authorization: identity.authorization } : {}) } }, signal, (url, init) => Promise.resolve().then(async () => { await this.assertParent?.(signal); signal.throwIfAborted(); return fetch(url, init); }));
    if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw failure(); }
    return bedrockVendedCredentials(await readOAuthJson(response, signal), this.redactor);
  }
}
