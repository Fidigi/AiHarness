import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { fetchOAuthResponse, readOAuthJson } from './oauth-device.js';
import { disableProviderNetworkRetries } from './provider-network.js';
import { BedrockRefreshingCredentials, bedrockCredentialFile, bedrockVendedCredentials, type BedrockCredentialIdentity, type BedrockVendedCredentials } from './bedrock-credentials.js';
import type { BedrockProfileCredentials } from './bedrock-profile.js';
import type { AwsStsSend } from './aws-sts.js';
import type { CredentialRedactor } from './credentials.js';
/** Explicit selected-profile descriptor, never an ambient login or executable source. */
export interface BedrockLoginConfig { session: string; region: string; cacheDirectory: string; signal?: AbortSignal; redactor?: Pick<CredentialRedactor, 'add'> }
const failure = () => new Error('Bedrock profile authentication failed.');
const safe = (value: unknown, max: number): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= max && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
export function bedrockLoginCacheFile(config: BedrockLoginConfig): string {
  if (!safe(config.session, 2048) || !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(config.region) || /^(?:us-iso|us-isob|eu-isoe|us-isof|eusc-)/u.test(config.region)
    || typeof config.cacheDirectory !== 'string' || !config.cacheDirectory || Buffer.byteLength(config.cacheDirectory) > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(config.cacheDirectory)) throw failure();
  return path.join(path.resolve(config.cacheDirectory), createHash('sha256').update(config.session).digest('hex') + '.json');
}
interface Identity extends BedrockCredentialIdentity { credentials: BedrockProfileCredentials; expiresAt: number; clientId: string; refreshToken: string; dpopKey: string }
interface Memo extends BedrockVendedCredentials { fingerprint: string; refreshToken: string; sequence: number }
/** Foreground source-bound memory only; external aws-login caches are never scanned, created or rewritten. */
export class BedrockLoginCredentials extends BedrockRefreshingCredentials<Identity> {
  private readonly file: string;
  private readonly url: string;
  private memo?: Memo;
  private rejected?: string;
  private loginSequence = 0;
  constructor(config: BedrockLoginConfig, private readonly assertParent: (signal: AbortSignal) => Promise<void>, private readonly send: AwsStsSend) {
    super('Bedrock profile authentication failed.', config.signal, config.redactor); this.file = bedrockLoginCacheFile(config);
    this.url = `https://${config.region}.signin.${config.region.startsWith('cn-') ? 'amazonaws.cn' : config.region.startsWith('us-gov-') ? 'amazonaws-us-gov.com' : 'aws.amazon.com'}/v1/token`;
  }
  override invalidate(credentials: BedrockProfileCredentials, status: number): void {
    super.invalidate(credentials, status); if ((status === 401 || status === 403) && this.memo?.credentials === credentials) this.rejected = this.memo.fingerprint;
  }
  private fingerprint(bytes: Buffer): string { return createHash('sha256').update(this.file).update(this.url).update(bytes).digest('hex'); }
  protected async identity(signal: AbortSignal): Promise<Identity> {
    await this.assertParent(signal); const bytes = await bedrockCredentialFile(this.file, 256 * 1024, signal), raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure(); const data = raw as Record<string, unknown>, token = data.accessToken;
    if (!token || typeof token !== 'object' || Array.isArray(token)) throw failure(); const access = token as Record<string, unknown>;
    for (const value of [data.clientId, data.refreshToken, data.dpopKey, access.accessKeyId, access.secretAccessKey, access.sessionToken]) if (typeof value === 'string') this.redactor?.add(value);
    const expiresAt = typeof access.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(access.expiresAt) ? Date.parse(access.expiresAt) : NaN;
    if (!safe(data.clientId, 65536) || !safe(data.refreshToken, 65536) || typeof data.dpopKey !== 'string' || !data.dpopKey || Buffer.byteLength(data.dpopKey) > 65536
      || typeof access.accessKeyId !== 'string' || !/^[A-Za-z0-9]{1,128}$/u.test(access.accessKeyId) || typeof access.secretAccessKey !== 'string' || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(access.secretAccessKey)
      || typeof access.sessionToken !== 'string' || !/^[A-Za-z0-9/+=]{1,61440}$/u.test(access.sessionToken) || typeof access.accountId !== 'string' || !/^\d{12}$/u.test(access.accountId)
      || !Number.isFinite(expiresAt) || expiresAt > Date.now() + 43200000 || access.credentialScope !== undefined && access.credentialScope !== '') throw failure();
    await this.assertParent(signal); signal.throwIfAborted();
    return { fingerprint: this.fingerprint(bytes), credentials: Object.freeze({ accessKeyId: access.accessKeyId, secretAccessKey: access.secretAccessKey, sessionToken: access.sessionToken }), expiresAt, clientId: data.clientId, refreshToken: data.refreshToken, dpopKey: data.dpopKey };
  }
  private async current(identity: Identity, signal: AbortSignal): Promise<void> {
    if (this.fingerprint(await bedrockCredentialFile(this.file, 256 * 1024, signal)) !== identity.fingerprint) throw failure(); await this.assertParent(signal); signal.throwIfAborted();
  }
  protected async acquire(identity: Identity, signal: AbortSignal): Promise<BedrockVendedCredentials> {
    const previous = this.memo?.fingerprint === identity.fingerprint ? this.memo : identity, sequence = ++this.loginSequence;
    let result: BedrockVendedCredentials = previous, refreshToken = previous.refreshToken;
    if (previous.expiresAt <= Date.now() + 300000 || this.rejected === identity.fingerprint) {
      let denied = false; disableProviderNetworkRetries(signal);
      try {
        const key = createPrivateKey({ key: identity.dpopKey, format: 'pem' });
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw failure();
        const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk: createPublicKey(key).export({ format: 'jwk' }) })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ jti: randomUUID(), htm: 'POST', htu: this.url, iat: Math.floor(Date.now() / 1000) })).toString('base64url'), input = header + '.' + payload;
        const dpop = input + '.' + sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url'); this.redactor?.add(dpop);
        const init: RequestInit = { method: 'POST', redirect: 'manual', signal, headers: { 'content-type': 'application/json', accept: 'application/json', dpop }, body: JSON.stringify({ clientId: identity.clientId, grantType: 'refresh_token', refreshToken }) };
        const response = await fetchOAuthResponse(this.url, init, signal, async () => { await this.current(identity, signal); return this.send(this.url, init); });
        if (response.status !== 200) { denied = response.status >= 400 && response.status < 500 && response.status !== 429; void response.body?.cancel().catch(() => undefined); throw failure(); }
        const data = await readOAuthJson(response, signal), token = data.accessToken;
        if (typeof data.refreshToken === 'string') this.redactor?.add(data.refreshToken);
        const seconds = data.expiresIn === undefined ? 900 : data.expiresIn;
        if (!token || typeof token !== 'object' || Array.isArray(token) || !safe(data.refreshToken, 65536) || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 43200) throw failure();
        const access = token as Record<string, unknown>;
        if (access.credentialScope !== undefined && access.credentialScope !== '') throw failure();
        result = bedrockVendedCredentials({ AccessKeyId: access.accessKeyId, SecretAccessKey: access.secretAccessKey, Token: access.sessionToken, Expiration: new Date(Date.now() + seconds * 1000).toISOString() }, this.redactor); refreshToken = data.refreshToken;
      } catch { await this.current(identity, signal); if (denied || this.rejected === identity.fingerprint || previous.expiresAt <= Date.now()) throw failure(); result = previous; }
    }
    await this.current(identity, signal);
    if (!this.memo || sequence > this.memo.sequence) { this.memo = { ...result, fingerprint: identity.fingerprint, refreshToken, sequence }; this.rejected = undefined; }
    return result;
  }
}
