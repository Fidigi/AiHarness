import { fetchOAuthResponse, readOAuthJson } from './oauth-device.js';
import { BedrockRefreshingCredentials, bedrockVendedCredentials, type BedrockCredentialIdentity, type BedrockVendedCredentials } from './bedrock-credentials.js';
import type { CredentialRedactor } from './credentials.js';

/** Internal descriptor: only an explicitly selected role-profile source admits IMDS. */
export interface BedrockImdsConfig {
  endpoint?: string;
  endpointMode?: string;
  disabled?: boolean;
  signal?: AbortSignal;
  redactor?: Pick<CredentialRedactor, 'add'>;
}
export function bedrockImdsEnvironment(env: NodeJS.ProcessEnv): BedrockImdsConfig {
  return { endpoint: env.AWS_EC2_METADATA_SERVICE_ENDPOINT || undefined, endpointMode: env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE || undefined,
    disabled: env.AWS_EC2_METADATA_DISABLED?.toLowerCase() === 'true' };
}
const failure = () => new Error('Bedrock instance metadata authentication failed.');
export function bedrockImdsEndpoint(config: BedrockImdsConfig): string {
  if (config.disabled || !config.endpoint && config.endpointMode !== undefined && !['IPv4', 'IPv6'].includes(config.endpointMode)) throw failure();
  const value = config.endpoint ?? (config.endpointMode === 'IPv6' ? 'http://[fd00:ec2::254]' : 'http://169.254.169.254');
  if (!value || Buffer.byteLength(value) > 4096 || /[\u0000-\u0020\u007f-\u009f?#]/u.test(value)) throw failure();
  const url = new URL(value), loopback = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(url.hostname) && url.hostname.split('.').every(part => Number(part) <= 255);
  if (url.username || url.password || url.protocol !== 'https:' && (url.protocol !== 'http:'
    || !loopback && !['localhost', '[::1]', '169.254.169.254', '[fd00:ec2::254]'].includes(url.hostname))) throw failure();
  return url.toString().replace(/\/+$/u, '');
}
async function text(response: Response, signal: AbortSignal, maximum: number): Promise<string> {
  const length = response.headers.get('content-length'), reader = response.body?.getReader();
  if (!reader) throw failure();
  const aborted = Symbol('aborted'); let onAbort!: () => void, complete = false, bytes = 0; const chunks: Uint8Array[] = [];
  const cancellation = new Promise<typeof aborted>(resolve => { onAbort = () => resolve(aborted); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    if (length !== null && (!/^(?:0|[1-9]\d*)$/u.test(length) || Number(length) > maximum)) throw failure();
    while (true) { const item = await Promise.race([reader.read(), cancellation]); if (item === aborted) throw failure(); if (item.done) break; bytes += item.value.byteLength; if (bytes > maximum) throw failure(); chunks.push(item.value); }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); signal.throwIfAborted(); complete = true; return value;
  } finally { signal.removeEventListener('abort', onAbort); if (!complete) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* A hostile pending read need not settle. */ } }
}
/** IMDSv2 only, foreground/parent-bound; no inference headers/proxy, v1 downgrade, retries or persistent token. */
export class BedrockImdsCredentials extends BedrockRefreshingCredentials<BedrockCredentialIdentity> {
  private readonly url: string;
  constructor(config: BedrockImdsConfig, private readonly assertParent: (signal: AbortSignal) => Promise<void>) {
    super('Bedrock instance metadata authentication failed.', config.signal, config.redactor); this.url = bedrockImdsEndpoint(config);
  }
  protected async identity(signal: AbortSignal): Promise<BedrockCredentialIdentity> { signal.throwIfAborted(); return { fingerprint: this.url }; }
  protected async acquire(_identity: BedrockCredentialIdentity, signal: AbortSignal): Promise<BedrockVendedCredentials> {
    const request = async (suffix: string, method: string, headers: Record<string, string>): Promise<Response> => {
      const init: RequestInit = { method, headers, redirect: 'manual', signal };
      const response = await fetchOAuthResponse(this.url + suffix, init, signal, async (url, init) => { await this.assertParent(signal); signal.throwIfAborted(); return fetch(url, init); });
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw failure(); } return response;
    };
    const token = await text(await request('/latest/api/token', 'PUT', { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }), signal, 4096);
    if (!/^[!-~]{1,4096}$/u.test(token)) throw failure(); this.redactor?.add(token);
    const headers = { 'x-aws-ec2-metadata-token': token }, prefix = '/latest/meta-data/iam/security-credentials/';
    const role = (await text(await request(prefix, 'GET', headers), signal, 1024)).trim();
    if (!/^[A-Za-z0-9_+=,.@-]{1,64}$/u.test(role)) throw failure(); this.redactor?.add(role);
    const body = await readOAuthJson(await request(prefix + encodeURIComponent(role), 'GET', headers), signal);
    if (body.Code !== 'Success') throw failure(); return bedrockVendedCredentials(body, this.redactor);
  }
}
