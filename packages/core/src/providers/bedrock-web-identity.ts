import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { awsStsEndpoint, readAwsStsCredentials, validIamRoleArn, type AwsStsSend } from './aws-sts.js';
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
interface Identity extends BedrockCredentialIdentity { token: string }
export class BedrockWebIdentityCredentials extends BedrockRefreshingCredentials<Identity> {
  private readonly tokenFile: string;
  private readonly roleArn: string;
  private readonly roleSessionName: string;
  private readonly durationSeconds?: number;
  private readonly region: string;
  private readonly url: string;
  constructor(config: BedrockWebIdentityConfig, parentRegion?: string, private readonly send: AwsStsSend = (url, init) => Promise.resolve().then(() => fetch(url, init))) {
    super('Bedrock web identity authentication failed.', config.signal, config.redactor);
    const region = config.region ?? parentRegion ?? 'us-east-1', roleSessionName = config.roleSessionName ?? 'ai-harness-' + randomUUID();
    if (typeof region !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(region)
      || !validIamRoleArn(config.roleArn)
      || typeof config.tokenFile !== 'string' || !config.tokenFile || Buffer.byteLength(config.tokenFile) > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(config.tokenFile)
      || typeof roleSessionName !== 'string' || !/^[A-Za-z0-9+=,.@_-]{2,64}$/u.test(roleSessionName)
      || config.durationSeconds !== undefined && (!Number.isInteger(config.durationSeconds) || config.durationSeconds < 900 || config.durationSeconds > 43200)) throw failure();
    this.region = region; this.url = awsStsEndpoint(region); this.roleArn = config.roleArn; this.roleSessionName = roleSessionName;
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
    const data = await readAwsStsCredentials(response, signal, 'AssumeRoleWithWebIdentity'), value = bedrockVendedCredentials({ ...data, Token: data.SessionToken }, this.redactor);
    if (value.expiresAt > Date.now() + 43200000) throw failure(); return { ...value, region: this.region };
  }
}
