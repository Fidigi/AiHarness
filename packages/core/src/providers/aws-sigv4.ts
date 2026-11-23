import { createHash, createHmac } from 'node:crypto';
import type { BedrockProfileCredentials } from './bedrock-profile.js';

/** Shared by Bedrock inference and STS AssumeRole; callers own destination, fields and credential-source admission. */
export function signAwsRequest(url: URL, body: string, service: 'bedrock' | 'sts', credentials: BedrockProfileCredentials, region: string, custom: Record<string, string>, now = new Date()): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), date = amzDate.slice(0, 8), payloadHash = createHash('sha256').update(body).digest('hex');
  const headers: Record<string, string> = { ...custom, host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(headers).filter(name => !['user-agent', 'connection', 'expect', 'transfer-encoding', 'x-amzn-trace-id'].includes(name)).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().replace(/[ \t]+/gu, ' ')}\n`).join('');
  // Non-S3 SigV4 escapes the already encoded HTTP path, including model ARN/colon escapes.
  const escape = (value: string) => encodeURIComponent(value).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalPath = `/${url.pathname.split('/').filter(Boolean).map(escape).join('/')}${url.pathname.endsWith('/') && url.pathname !== '/' ? '/' : ''}`;
  const canonicalQuery = [...url.searchParams].map(([key, value]) => [escape(key), escape(value)])
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
  const canonicalRequest = ['POST', canonicalPath, canonicalQuery, canonicalHeaders, names.join(';'), payloadHash].join('\n'), scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (key: Buffer | string, value: string): Buffer => createHmac('sha256', key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), service), 'aws4_request');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`;
  return headers;
}
