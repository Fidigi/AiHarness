import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { BedrockRefreshingCredentials, bedrockCredentialFile, bedrockVendedCredentials } from './bedrock-credentials.js';
import type { BedrockCredentialIdentity, BedrockVendedCredentials } from './bedrock-credentials.js';
import { fetchOAuthResponse } from './oauth-device.js';
import { disableProviderNetworkRetries } from './provider-network.js';
import type { CredentialRedactor } from './credentials.js';

/** Explicit role/token-file only; STS authority is derived from the trusted region, never the inference URL. */
export interface BedrockWebIdentityConfig {
  roleArn: string;
  tokenFile: string;
  roleSessionName?: string;
  durationSeconds?: number;
  region?: string;
  signal?: AbortSignal;
  redactor?: Pick<CredentialRedactor, 'add'>;
}
const failure = () => new Error('Bedrock web identity authentication failed.');
type Send = (url: string, init: RequestInit) => Promise<Response>;
const namespace = 'https://sts.amazonaws.com/doc/2011-06-15/', root = 'AssumeRoleWithWebIdentityResponse', result = root + '/AssumeRoleWithWebIdentityResult', credentialsPath = result + '/Credentials';
const fields = new Set(['AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Expiration']);
async function readCredentials(response: Response, signal: AbortSignal): Promise<Record<string, string>> {
  const length = response.headers.get('content-length'); if (length !== null && (!/^(?:0|[1-9]\d*)$/u.test(length) || Number(length) > 262144)) { void response.body?.cancel().catch(() => undefined); throw failure(); }
  signal.throwIfAborted(); const reader = response.body?.getReader(); if (!reader) throw failure();
  const parser = new SaxesParser({ xmlns: true }), stack: string[] = [], values: Record<string, string> = Object.create(null); let nodes = 0, results = 0, credentials = 0, rootClosed = false;
  parser.on('doctype', () => { throw failure(); }); parser.on('processinginstruction', () => { throw failure(); }); parser.on('error', () => { throw failure(); });
  parser.on('xmldecl', declaration => { if (declaration.encoding && declaration.encoding.toLowerCase() !== 'utf-8') throw failure(); });
  parser.on('opentag', tag => {
    if (++nodes > 2048 || stack.length >= 8 || tag.uri !== namespace || !stack.length && tag.local !== root
      || stack.length >= 4 && stack.slice(0, 3).join('/') === credentialsPath && fields.has(stack[3])) throw failure();
    stack.push(tag.local); const current = stack.join('/'); if (current === result && ++results > 1 || current === credentialsPath && ++credentials > 1) throw failure();
    if (stack.length === 4 && stack.slice(0, 3).join('/') === credentialsPath && fields.has(tag.local)) { if (Object.hasOwn(values, tag.local)) throw failure(); values[tag.local] = ''; }
  });
  const text = (value: string) => { if (stack.length === 4 && stack.slice(0, 3).join('/') === credentialsPath && fields.has(stack[3])) values[stack[3]] += value; };
  parser.on('text', text); parser.on('cdata', text); parser.on('closetag', () => { stack.pop(); if (!stack.length) rootClosed = true; });
  const decoder = new TextDecoder('utf-8', { fatal: true }), aborted = Symbol('aborted'); let onAbort!: () => void, bytes = 0, complete = false;
  const cancellation = new Promise<typeof aborted>(resolve => { onAbort = () => resolve(aborted); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    while (true) { const item = await Promise.race([reader.read(), cancellation]); if (item === aborted) throw failure(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 262144) throw failure(); parser.write(decoder.decode(item.value, { stream: true })); }
    parser.write(decoder.decode()).close(); signal.throwIfAborted(); if (!rootClosed || stack.length || results !== 1 || credentials !== 1 || Object.keys(values).length !== 4) throw failure();
    complete = true; return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
  } finally { signal.removeEventListener('abort', onAbort); if (!complete) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* Hostile pending read need not settle. */ } }
}
interface Identity extends BedrockCredentialIdentity { token: string }
export class BedrockWebIdentityCredentials extends BedrockRefreshingCredentials<Identity> {
  private readonly tokenFile: string;
  private readonly roleArn: string;
  private readonly roleSessionName: string;
  private readonly durationSeconds?: number;
  private readonly region: string;
  private readonly url: string;
  constructor(config: BedrockWebIdentityConfig, parentRegion?: string, private readonly send: Send = (url, init) => Promise.resolve().then(() => fetch(url, init))) {
    super('Bedrock web identity authentication failed.', config.signal, config.redactor);
    const region = config.region ?? parentRegion ?? 'us-east-1', roleSessionName = config.roleSessionName ?? 'ai-harness-' + randomUUID();
    if (typeof region !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(region)
      || typeof config.roleArn !== 'string' || Buffer.byteLength(config.roleArn) > 2048 || !/^arn:aws(?:-[a-z0-9-]+)?:iam::\d{12}:role\/(?:[\x21-\x7e]+\/)?[A-Za-z0-9+=,.@_-]{1,64}$/u.test(config.roleArn)
      || typeof config.tokenFile !== 'string' || !config.tokenFile || Buffer.byteLength(config.tokenFile) > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(config.tokenFile)
      || typeof roleSessionName !== 'string' || !/^[A-Za-z0-9+=,.@_-]{2,64}$/u.test(roleSessionName)
      || config.durationSeconds !== undefined && (!Number.isInteger(config.durationSeconds) || config.durationSeconds < 900 || config.durationSeconds > 43200)) throw failure();
    const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : region.startsWith('eusc-') ? 'amazonaws.eu' : region.startsWith('us-iso-') ? 'c2s.ic.gov' : region.startsWith('us-isob-') ? 'sc2s.sgov.gov' : region.startsWith('eu-isoe-') ? 'cloud.adc-e.uk' : region.startsWith('us-isof-') ? 'csp.hci.ic.gov' : 'amazonaws.com';
    this.region = region; this.url = 'https://sts.' + region + '.' + suffix + '/'; this.roleArn = config.roleArn; this.roleSessionName = roleSessionName;
    this.tokenFile = path.resolve(config.tokenFile); this.durationSeconds = config.durationSeconds;
  }
  protected async identity(signal: AbortSignal): Promise<Identity> {
    const bytes = await bedrockCredentialFile(this.tokenFile, 20000, signal), token = new TextDecoder('utf-8', { fatal: true }).decode(bytes); this.redactor?.add(token);
    if (token.length < 4 || /[\u0000-\u0020\u007f-\u009f]/u.test(token)) throw failure();
    const hash = createHash('sha256'); for (const value of [this.url, this.roleArn, this.roleSessionName, String(this.durationSeconds ?? ''), token]) hash.update(String(Buffer.byteLength(value)) + ':').update(value);
    signal.throwIfAborted(); return { token, fingerprint: hash.digest('hex') };
  }
  protected async acquire(identity: Identity, signal: AbortSignal): Promise<BedrockVendedCredentials> {
    const body = new URLSearchParams({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: this.roleArn, RoleSessionName: this.roleSessionName, WebIdentityToken: identity.token, ...(this.durationSeconds !== undefined ? { DurationSeconds: String(this.durationSeconds) } : {}) });
    disableProviderNetworkRetries(signal);
    const request: RequestInit = { method: 'POST', redirect: 'manual', signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/xml' }, body };
    const response = await fetchOAuthResponse(this.url, request, signal, () => this.send(this.url, request));
    if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw failure(); }
    const data = await readCredentials(response, signal), value = bedrockVendedCredentials({ ...data, Token: data.SessionToken }, this.redactor);
    if (value.expiresAt > Date.now() + 43200000) throw failure(); return { ...value, region: this.region };
  }
}
