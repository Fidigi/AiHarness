import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchOAuthResponse, readOAuthJson } from './oauth-device.js';
import { disableProviderNetworkRetries } from './provider-network.js';
import { BedrockRefreshingCredentials, bedrockCredentialFile, bedrockVendedCredentials, type BedrockCredentialIdentity, type BedrockVendedCredentials } from './bedrock-credentials.js';
import type { AwsStsSend } from './aws-sts.js';
import type { CredentialRedactor } from './credentials.js';
/** Internal descriptor from an explicitly selected INI profile; not a public/browser source. */
export interface BedrockSsoConfig {
  startUrl: string; region: string; accountId: string; roleName: string; cacheDirectory: string; sessionName?: string;
  signal?: AbortSignal; redactor?: Pick<CredentialRedactor, 'add'>;
}
const failure = () => new Error('Bedrock profile authentication failed.');
const safe = (value: unknown, max: number): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= max && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
export function bedrockSsoCacheFile(config: BedrockSsoConfig): string {
  if (!safe(config.startUrl, 4096) || !safe(config.region, 64) || !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(config.region)
    || /^(?:us-iso|us-isob|eu-isoe|us-isof|eusc-)/u.test(config.region) || !/^\d{12}$/u.test(config.accountId)
    || !/^[A-Za-z0-9_+=,.@-]{1,64}$/u.test(config.roleName) || typeof config.cacheDirectory !== 'string' || !config.cacheDirectory
    || Buffer.byteLength(config.cacheDirectory) > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(config.cacheDirectory)
    || config.sessionName !== undefined && (!safe(config.sessionName, 128) || /[\[\]]/u.test(config.sessionName))) throw failure();
  const start = new URL(config.startUrl); if (start.protocol !== 'https:' || start.username || start.password || start.search || start.hash) throw failure();
  return path.join(path.resolve(config.cacheDirectory), createHash('sha1').update(config.sessionName ?? config.startUrl).digest('hex') + '.json');
}
interface Identity extends BedrockCredentialIdentity { accessToken: string; expiresAt: number; refresh?: { clientId: string; clientSecret: string; refreshToken: string } }
/** Read-only external cache; modern refresh is foreground/instance-local, never login/writeback or ambient scan. */
export class BedrockSsoCredentials extends BedrockRefreshingCredentials<Identity> {
  private readonly file: string;
  private readonly url: string;
  private refreshed?: { fingerprint: string; accessToken: string; expiresAt: number; refreshToken: string; sequence: number };
  private refreshSequence = 0;
  constructor(private readonly config: BedrockSsoConfig, private readonly assertParent: (signal: AbortSignal) => Promise<void>, private readonly send: AwsStsSend) {
    super('Bedrock profile authentication failed.', config.signal, config.redactor); this.file = bedrockSsoCacheFile(config);
    this.url = `https://portal.sso.${config.region}.${config.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}/federation/credentials?` + new URLSearchParams({ account_id: config.accountId, role_name: config.roleName });
  }
  private fingerprint(bytes: Buffer): string { return createHash('sha256').update(this.file).update(this.url).update(this.config.startUrl).update(bytes).digest('hex'); }
  protected async identity(signal: AbortSignal): Promise<Identity> {
    await this.assertParent(signal); const bytes = await bedrockCredentialFile(this.file, 256 * 1024, signal), raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure(); const data = raw as Record<string, unknown>;
    for (const key of ['accessToken', 'refreshToken', 'clientSecret', 'clientId']) if (typeof data[key] === 'string') this.redactor?.add(data[key] as string);
    const expiresAt = typeof data.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(data.expiresAt) ? Date.parse(data.expiresAt) : NaN;
    if (typeof data.accessToken !== 'string' || !/^[!-~]{1,65536}$/u.test(data.accessToken) || !Number.isFinite(expiresAt)
      || data.startUrl !== undefined && data.startUrl !== this.config.startUrl || data.region !== undefined && data.region !== this.config.region) throw failure();
    await this.assertParent(signal); signal.throwIfAborted();
    const refresh = this.config.sessionName !== undefined && safe(data.clientId, 65536) && safe(data.clientSecret, 65536) && safe(data.refreshToken, 65536)
      ? { clientId: data.clientId, clientSecret: data.clientSecret, refreshToken: data.refreshToken } : undefined;
    return { fingerprint: this.fingerprint(bytes), accessToken: data.accessToken, expiresAt, refresh };
  }
  private async current(identity: Identity, signal: AbortSignal): Promise<void> {
    if (this.fingerprint(await bedrockCredentialFile(this.file, 256 * 1024, signal)) !== identity.fingerprint) throw failure(); await this.assertParent(signal); signal.throwIfAborted();
  }
  private async accessToken(identity: Identity, signal: AbortSignal): Promise<string> {
    const previous = this.refreshed?.fingerprint === identity.fingerprint ? this.refreshed : identity;
    if (previous.expiresAt > Date.now() + 300000) return previous.accessToken;
    if (!identity.refresh) { if (previous.expiresAt <= Date.now()) throw failure(); return previous.accessToken; }
    const refreshToken = 'refreshToken' in previous ? previous.refreshToken : identity.refresh.refreshToken, sequence = ++this.refreshSequence;
    try {
      const url = `https://oidc.${this.config.region}.${this.config.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}/token`;
      const init: RequestInit = { method: 'POST', redirect: 'manual', signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ clientId: identity.refresh.clientId, clientSecret: identity.refresh.clientSecret, grantType: 'refresh_token', refreshToken }) };
      const response = await fetchOAuthResponse(url, init, signal, async () => { await this.current(identity, signal); return this.send(url, init); });
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw failure(); }
      const data = await readOAuthJson(response, signal);
      for (const key of ['accessToken', 'refreshToken']) if (typeof data[key] === 'string') this.redactor?.add(data[key] as string);
      if (typeof data.accessToken !== 'string' || !/^[!-~]{1,65536}$/u.test(data.accessToken) || typeof data.expiresIn !== 'number' || !Number.isSafeInteger(data.expiresIn) || data.expiresIn < 1 || data.expiresIn > 86400
        || data.refreshToken !== undefined && !safe(data.refreshToken, 65536)) throw failure();
      const refreshed = { fingerprint: identity.fingerprint, accessToken: data.accessToken, expiresAt: Date.now() + data.expiresIn * 1000, refreshToken: data.refreshToken as string | undefined ?? refreshToken, sequence };
      await this.current(identity, signal); if (!this.refreshed || sequence > this.refreshed.sequence) this.refreshed = refreshed; return refreshed.accessToken;
    } catch { await this.current(identity, signal); if (previous.expiresAt <= Date.now()) throw failure(); return previous.accessToken; }
  }
  protected async acquire(identity: Identity, signal: AbortSignal): Promise<BedrockVendedCredentials> {
    disableProviderNetworkRetries(signal); const accessToken = await this.accessToken(identity, signal);
    const init: RequestInit = { method: 'GET', redirect: 'manual', signal, headers: { accept: 'application/json', 'x-amz-sso_bearer_token': accessToken } };
    const response = await fetchOAuthResponse(this.url, init, signal, async () => { await this.current(identity, signal); return this.send(this.url, init); });
    if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw failure(); }
    const raw = await readOAuthJson(response, signal), data = raw.roleCredentials;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure(); const value = data as Record<string, unknown>;
    if (typeof value.expiration !== 'number' || !Number.isSafeInteger(value.expiration) || value.expiration <= Date.now() || value.expiration > Date.now() + 43200000
      || value.credentialScope !== undefined && value.credentialScope !== '') throw failure();
    return bedrockVendedCredentials({ AccessKeyId: value.accessKeyId, SecretAccessKey: value.secretAccessKey, Token: value.sessionToken, Expiration: new Date(value.expiration).toISOString() }, this.redactor);
  }
}
