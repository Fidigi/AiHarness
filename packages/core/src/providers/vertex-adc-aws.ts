import { awsStsEndpoint } from './aws-sts.js';
import { signAwsRequest } from './aws-sigv4.js';
import { awsImdsV2Session, readAwsMetadataText } from './aws-metadata.js';
import { bedrockImdsEndpoint } from './bedrock-imds.js';
import { bedrockVendedCredentials } from './bedrock-credentials.js';
import { readOAuthJson } from './oauth-device.js';
import type { BedrockProfileCredentials } from './bedrock-profile.js';
import type { CredentialRedactor } from './credentials.js';
export interface VertexAwsEnvironment { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string; expiration?: string; credentialScope?: string; metadataDisabled?: boolean }
export interface VertexAwsSource { verificationUrl: string; region?: string; credentials?: BedrockProfileCredentials; expiresAt?: number; metadata?: { endpoint: string; region: boolean; rolesSuffix?: string } }
interface ResolvedSource { url: string; region: string; credentials: BedrockProfileCredentials; expiresAt?: number }
const failure = () => new Error('Vertex ADC authentication failed.');
/** Constructor snapshot only; metadata must be explicitly admitted by the ADC recipe, never ambient discovery. */
export function vertexAwsEnvironment(env: NodeJS.ProcessEnv): VertexAwsEnvironment {
  return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION, expiration: env.AWS_CREDENTIAL_EXPIRATION, credentialScope: env.AWS_CREDENTIAL_SCOPE, metadataDisabled: env.AWS_EC2_METADATA_DISABLED?.toLowerCase() === 'true' };
}
function verificationUrl(value: string, region: string): string {
  const url = new URL(value.replace('{region}', region));
  if (url.origin !== new URL(awsStsEndpoint(region)).origin || url.username || url.password || url.hash || url.pathname !== '/'
    || [...url.searchParams].length !== 2 || url.searchParams.get('Action') !== 'GetCallerIdentity' || url.searchParams.get('Version') !== '2011-06-15') throw failure();
  return url.href;
}
export function vertexAwsSource(value: unknown, env: VertexAwsEnvironment, redactor?: Pick<CredentialRedactor, 'add'>): VertexAwsSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(); const data = value as Record<string, unknown>;
  if (data.environment_id !== 'aws1' || Object.keys(data).some(key => !['environment_id', 'regional_cred_verification_url', 'url', 'region_url', 'imdsv2_session_token_url'].includes(key))) throw failure();
  const { accessKeyId, secretAccessKey, sessionToken, region } = env;
  for (const secret of [accessKeyId, secretAccessKey, sessionToken]) redactor?.add(secret);
  const expiresAt = env.expiration ? Date.parse(env.expiration) : undefined, hasCredentials = !!(accessKeyId || secretAccessKey || sessionToken);
  if (expiresAt !== undefined && !Number.isFinite(expiresAt)
    || hasCredentials && (!/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId ?? '') || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(secretAccessKey ?? '') || sessionToken !== undefined && !/^[A-Za-z0-9/+=]{1,61440}$/u.test(sessionToken))
    || typeof data.regional_cred_verification_url !== 'string' || Buffer.byteLength(data.regional_cred_verification_url) > 4096) throw failure();
  const template = data.regional_cred_verification_url;
  const probe = region ?? (template.includes('{region}') ? (new URL(template.replace('{region}', 'us-east-1')).hostname.endsWith('.amazonaws.com.cn') ? 'cn-north-1' : 'us-east-1') : /^sts\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/u.exec(new URL(template).hostname)?.[1]);
  if (!probe) throw failure(); verificationUrl(template, probe);
  const source: VertexAwsSource = { verificationUrl: template, region, ...(hasCredentials ? { credentials: Object.freeze({ accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, ...(sessionToken ? { sessionToken } : {}) }) } : {}), expiresAt };
  if (source.credentials && region) return source; // Unused metadata descriptors grant no I/O or authority.
  const token = data.imdsv2_session_token_url, suffix = '/latest/api/token';
  if (env.metadataDisabled || typeof token !== 'string' || Buffer.byteLength(token) > 4096 || !token.endsWith(suffix)) throw failure();
  const endpoint = bedrockImdsEndpoint({ endpoint: token.slice(0, -suffix.length) });
  if (new URL(token).href !== endpoint + suffix) throw failure();
  if (!region && (typeof data.region_url !== 'string' || Buffer.byteLength(data.region_url) > 4096 || new URL(data.region_url).href !== endpoint + '/latest/meta-data/placement/availability-zone')) throw failure();
  const roles = '/latest/meta-data/iam/security-credentials'; let rolesSuffix: string | undefined;
  if (!source.credentials) {
    if (typeof data.url !== 'string' || Buffer.byteLength(data.url) > 4096) throw failure(); const url = new URL(data.url).href;
    if (![endpoint + roles, endpoint + roles + '/'].includes(url)) throw failure(); rolesSuffix = url.slice(endpoint.length);
  }
  return { ...source, metadata: { endpoint, region: !region, rolesSuffix } };
}
/** File-admitted IMDSv2 only: one foreground token, no profile/ECS/default-machine fallback or AWS STS call. */
export async function resolveVertexAwsSource(source: VertexAwsSource, signal: AbortSignal, assertCurrent: (signal: AbortSignal) => Promise<void>, redactor?: Pick<CredentialRedactor, 'add'>): Promise<ResolvedSource> {
  if (source.expiresAt !== undefined && source.expiresAt <= Date.now()) throw failure();
  let { region, credentials, expiresAt } = source;
  if (source.metadata) {
    const request = await awsImdsV2Session(source.metadata.endpoint, 300, signal, assertCurrent, redactor);
    if (source.metadata.region) { const zone = (await readAwsMetadataText(await request('/latest/meta-data/placement/availability-zone'), signal, 128)).trim(); const match = /^([a-z0-9]+(?:-[a-z0-9]+)+-\d+)[a-z]$/u.exec(zone); if (!match) throw failure(); region = match[1]; }
    if (!region) throw failure(); verificationUrl(source.verificationUrl, region);
    if (source.metadata.rolesSuffix) {
      const role = (await readAwsMetadataText(await request(source.metadata.rolesSuffix), signal, 1024)).trim();
      if (!/^[A-Za-z0-9_+=,.@-]{1,64}$/u.test(role)) throw failure(); redactor?.add(role);
      const body = await readOAuthJson(await request(source.metadata.rolesSuffix.replace(/\/$/u, '') + '/' + encodeURIComponent(role)), signal);
      if (body.Code !== 'Success' || body.CredentialScope !== undefined && body.CredentialScope !== '' || body.credentialScope !== undefined && body.credentialScope !== '') throw failure();
      const result = bedrockVendedCredentials(body, redactor); if (result.expiresAt > Date.now() + 43200000) throw failure(); credentials = result.credentials; expiresAt = result.expiresAt;
    }
    await assertCurrent(signal);
  }
  if (!credentials || !region) throw failure(); signal.throwIfAborted(); return { url: verificationUrl(source.verificationUrl, region), credentials, region, expiresAt };
}
/** Serialize, do not send: Google STS alone receives this audience-bound AWS proof. */
export function vertexAwsSubject(source: ResolvedSource, audience: string, redactor?: Pick<CredentialRedactor, 'add'>): string {
  if (source.expiresAt !== undefined && source.expiresAt <= Date.now()) throw failure();
  const signed = signAwsRequest(new URL(source.url), '', 'sts', source.credentials, source.region, { 'x-goog-cloud-target-resource': audience });
  const headers = Object.entries(signed).map(([key, value]) => ({ key: key.toLowerCase(), value })).sort((a, b) => a.key.localeCompare(b.key));
  const raw = JSON.stringify({ url: source.url, method: 'POST', headers }), subject = encodeURIComponent(raw);
  if (Buffer.byteLength(subject) > 65536) throw failure(); redactor?.add(signed.Authorization); redactor?.add(raw); redactor?.add(subject); return subject;
}
