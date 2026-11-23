import { readOAuthJson } from './oauth-device.js';
import { awsImdsV2Session, readAwsMetadataText } from './aws-metadata.js';
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
/** IMDSv2 only, foreground/parent-bound; no inference headers/proxy, v1 downgrade, retries or persistent token. */
export class BedrockImdsCredentials extends BedrockRefreshingCredentials<BedrockCredentialIdentity> {
  private readonly url: string;
  constructor(config: BedrockImdsConfig, private readonly assertParent: (signal: AbortSignal) => Promise<void>) {
    super('Bedrock instance metadata authentication failed.', config.signal, config.redactor); this.url = bedrockImdsEndpoint(config);
  }
  protected async identity(signal: AbortSignal): Promise<BedrockCredentialIdentity> { signal.throwIfAborted(); return { fingerprint: this.url }; }
  protected async acquire(_identity: BedrockCredentialIdentity, signal: AbortSignal): Promise<BedrockVendedCredentials> {
    const request = await awsImdsV2Session(this.url, 21600, signal, this.assertParent, this.redactor), prefix = '/latest/meta-data/iam/security-credentials/';
    const role = (await readAwsMetadataText(await request(prefix), signal, 1024)).trim();
    if (!/^[A-Za-z0-9_+=,.@-]{1,64}$/u.test(role)) throw failure(); this.redactor?.add(role);
    const body = await readOAuthJson(await request(prefix + encodeURIComponent(role)), signal);
    if (body.Code !== 'Success') throw failure(); return bedrockVendedCredentials(body, this.redactor);
  }
}
