import { awsStsEndpoint } from './aws-sts.js';
import { signAwsRequest } from './aws-sigv4.js';
import type { BedrockProfileCredentials } from './bedrock-profile.js';
import type { CredentialRedactor } from './credentials.js';
export interface VertexAwsEnvironment { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string; expiration?: string; credentialScope?: string }
export interface VertexAwsSource { url: string; region: string; credentials: BedrockProfileCredentials; expiresAt?: number }
const failure = () => new Error('Vertex ADC authentication failed.');
/** Constructor snapshot only; no profile, command, container or metadata fallback. */
export function vertexAwsEnvironment(env: NodeJS.ProcessEnv): VertexAwsEnvironment {
  return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION, expiration: env.AWS_CREDENTIAL_EXPIRATION, credentialScope: env.AWS_CREDENTIAL_SCOPE };
}
export function vertexAwsSource(value: unknown, env: VertexAwsEnvironment, redactor?: Pick<CredentialRedactor, 'add'>): VertexAwsSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(); const data = value as Record<string, unknown>;
  if (data.environment_id !== 'aws1' || Object.keys(data).some(key => !['environment_id', 'regional_cred_verification_url', 'url', 'region_url', 'imdsv2_session_token_url'].includes(key))) throw failure();
  const { accessKeyId, secretAccessKey, sessionToken, region } = env;
  for (const secret of [accessKeyId, secretAccessKey, sessionToken]) redactor?.add(secret);
  const expiresAt = env.expiration ? Date.parse(env.expiration) : undefined;
  if (!/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId ?? '') || !/^[A-Za-z0-9/+=]{1,4096}$/u.test(secretAccessKey ?? '')
    || sessionToken !== undefined && !/^[A-Za-z0-9/+=]{1,61440}$/u.test(sessionToken) || env.credentialScope
    || !region || expiresAt !== undefined && !Number.isFinite(expiresAt)
    || typeof data.regional_cred_verification_url !== 'string' || Buffer.byteLength(data.regional_cred_verification_url) > 4096) throw failure();
  const url = new URL(data.regional_cred_verification_url.replace('{region}', region));
  if (url.origin !== new URL(awsStsEndpoint(region)).origin || url.username || url.password || url.hash || url.pathname !== '/'
    || [...url.searchParams].length !== 2 || url.searchParams.get('Action') !== 'GetCallerIdentity' || url.searchParams.get('Version') !== '2011-06-15') throw failure();
  return { url: url.href, region, credentials: Object.freeze({ accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, ...(sessionToken ? { sessionToken } : {}) }), expiresAt };
}
/** Serialize, do not send: Google STS alone receives this audience-bound AWS proof. */
export function vertexAwsSubject(source: VertexAwsSource, audience: string, redactor?: Pick<CredentialRedactor, 'add'>): string {
  if (source.expiresAt !== undefined && source.expiresAt <= Date.now()) throw failure();
  const signed = signAwsRequest(new URL(source.url), '', 'sts', source.credentials, source.region, { 'x-goog-cloud-target-resource': audience });
  const headers = Object.entries(signed).map(([key, value]) => ({ key: key.toLowerCase(), value })).sort((a, b) => a.key.localeCompare(b.key));
  const raw = JSON.stringify({ url: source.url, method: 'POST', headers }), subject = encodeURIComponent(raw);
  if (Buffer.byteLength(subject) > 65536) throw failure(); redactor?.add(signed.Authorization); redactor?.add(raw); redactor?.add(subject); return subject;
}
