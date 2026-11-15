import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BedrockProvider, CredentialRedactor, type BedrockProviderConfig, type ChatResponse, type Message } from '../../dist/index.js';
import { syntheticStsRole, syntheticAssumeRoleXml } from '../../../../tests/fixtures/sts-web-identity.js';
import { bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';
const roots: string[] = [], model = 'anthropic.claude-opus-4-6-v1', sts = 'https://sts.eu-west-1.amazonaws.com/', rolePath = '/latest/meta-data/iam/security-credentials/';
const messages: Message[] = [{ id: 'u', timestamp: new Date(0), role: 'user', content: 'instance role probe' }];
const recipe = (leaf = false) => `[profile chosen]\nrole_arn=${syntheticStsRole}\n${leaf ? 'source_profile=base' : 'credential_source=Ec2InstanceMetadata'}\nregion=eu-west-1\nrole_session_name=synthetic-imds-role\n` + (leaf ? '[profile base]\ncredential_source=Ec2InstanceMetadata\nregion=ap-northeast-1\n' : '');
const json = () => Response.json({ output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'consider', signature: 'imds-private-signature' } } }, { text: 'profile-imds-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
const credentials = (revision = 'A') => Response.json({ Code: 'Success', AccessKeyId: 'IMDSLEAF' + revision, SecretAccessKey: 'ImdsSecret' + revision, Token: 'ImdsSession' + revision, Expiration: new Date(Date.now() + 3600000).toISOString() });
beforeEach(() => { for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE']) vi.stubEnv(key, undefined); vi.stubEnv('AWS_ACCESS_KEY_ID', 'MUSTNOTFALLBACK'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'MustNotFallbackSecret'); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(leaf = false) { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-imds-role-')); roots.push(root); const configFile = path.join(root, 'config'); await writeFile(configFile, recipe(leaf)); const redactor = new CredentialRedactor(), config: BedrockProviderConfig = { type: 'bedrock', model, region: 'us-west-2', customHeaders: { 'x-aih-inference': 'inference-only' }, bedrockProfile: { profile: 'chosen', configFile, redactor } }; return { configFile, config, redactor }; }
it.each([false, true])('uses explicit captured IMDSv2 source only, then final native JSON/binary/private cache (recursive IPv6 leaf=%s)', async leaf => {
  const f = await fixture(leaf); if (leaf) vi.stubEnv('AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE', 'IPv6'); const origin = leaf ? 'http://[fd00:ec2::254]' : 'http://169.254.169.254', provider = new BedrockProvider(f.config);
  vi.stubEnv('AWS_EC2_METADATA_SERVICE_ENDPOINT', 'https://must-not-retarget.synthetic'); vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
  const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { const value = String(url); calls.push({ url: value, init, headers: new Headers(init.headers) }); return value === origin + '/latest/api/token' ? new Response('SyntheticImdsTokenA') : value === origin + rolePath ? new Response('SyntheticInstanceRole\n') : value === origin + rolePath + 'SyntheticInstanceRole' ? credentials() : value === sts ? new Response(syntheticAssumeRoleXml('IMDSROLEA')) : value.endsWith('/converse-stream') ? new Response(bedrockText('profile-imds-ready', 'end_turn', { inputTokens: 8, outputTokens: 2, totalTokens: 10 })) : json(); }));
  expect(provider.validateConfig()).toBe(true); expect(provider.canDiscoverModels()).toBe(false); expect(await provider.getAvailableModels()).toEqual([]); expect(calls).toHaveLength(0);
  const first = await provider.chat(messages); let streamed: ChatResponse | undefined; await provider.streamChat(messages, () => {}, result => { streamed = result; }); await provider.chat([...messages, { id: 'a', timestamp: new Date(1), role: 'assistant', content: first.content, blocks: first.blocks, provider: first.provider, api: first.api, model }]);
  expect(first).toMatchObject({ model, content: 'profile-imds-ready', usage: { totalTokens: 10 } }); expect(streamed).toMatchObject({ model, content: 'profile-imds-ready', usage: { totalTokens: 10 } }); expect(calls).toHaveLength(7);
  expect(calls[0].init).toMatchObject({ method: 'PUT', redirect: 'manual' }); expect(calls[0].headers.get('x-aws-ec2-metadata-token-ttl-seconds')).toBe('21600'); expect(calls[0].headers.get('x-aws-ec2-metadata-token')).toBeNull();
  for (const call of calls.slice(0, 3)) { expect(call.headers.get('authorization')).toBeNull(); expect(call.headers.get('x-aih-inference')).toBeNull(); expect(call.headers.get('x-amz-security-token')).toBeNull(); expect(call.init.body).toBeUndefined(); expect((call.init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeUndefined(); }
  for (const call of calls.slice(1, 3)) { expect(call.init.method).toBe('GET'); expect(call.headers.get('x-aws-ec2-metadata-token')).toBe('SyntheticImdsTokenA'); }
  expect(calls[3].url).toBe(sts); expect(calls[3].headers.get('authorization')).toContain('Credential=IMDSLEAFA/'); expect(calls[3].headers.get('authorization')).toContain('/eu-west-1/sts/aws4_request');
  for (const call of calls.slice(3)) expect(call.headers.get('x-aws-ec2-metadata-token')).toBeNull(); for (const call of calls.slice(4)) { expect(call.headers.get('authorization')).toContain('Credential=IMDSROLEA/'); expect(call.headers.get('authorization')).toContain('/us-west-2/bedrock/aws4_request'); }
  expect(JSON.stringify(calls.at(-1)!.init.body)).toContain('imds-private-signature'); for (const secret of ['SyntheticImdsTokenA', 'IMDSLEAFA', 'ImdsSecretA', 'ImdsSessionA', 'IMDSROLEA']) expect(f.redactor.redact(secret)).not.toContain(secret);
});
it('captures env/root-file endpoint authority and rejects disabled/offline/unsafe/mixed sources before any metadata or ambient fallback', async () => {
  const f = await fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const env of [{ AWS_EC2_METADATA_DISABLED: 'true' }, { AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: 'invalid' }, { AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://outside.invalid/' }, { AWS_EC2_METADATA_SERVICE_ENDPOINT: 'https://user:secret@metadata.synthetic/' }, { AWS_EC2_METADATA_SERVICE_ENDPOINT: 'https://metadata.synthetic/?secret=query' }]) {
    for (const key of ['AWS_EC2_METADATA_DISABLED', 'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE', 'AWS_EC2_METADATA_SERVICE_ENDPOINT']) vi.stubEnv(key, undefined); for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  }
  vi.stubEnv('AWS_EC2_METADATA_SERVICE_ENDPOINT', undefined); vi.stubEnv('AWS_EC2_METADATA_DISABLED', undefined); vi.stubEnv('AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE', undefined);
  await expect(new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile!, allowNetwork: false } }).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  for (const extra of ['source_profile=must-not-select', 'credential_process=must-not-run', 'web_identity_token_file=/must-not-read']) { await writeFile(f.configFile, recipe() + extra + '\n'); await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); } expect(fetch).not.toHaveBeenCalled();
  await writeFile(f.configFile, recipe() + 'ec2_metadata_service_endpoint=https://file-metadata.synthetic/prefix\n'); const urls: string[] = []; vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { urls.push(String(url)); return new Response('denied', { status: 403 }); }));
  await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(urls).toEqual(['https://file-metadata.synthetic/prefix/latest/api/token']);
  urls.length = 0; vi.stubEnv('AWS_EC2_METADATA_SERVICE_ENDPOINT', 'https://env-metadata.synthetic/captured'); const captured = new BedrockProvider(f.config); vi.stubEnv('AWS_EC2_METADATA_SERVICE_ENDPOINT', 'https://must-not-retarget.synthetic/');
  await expect(captured.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(urls).toEqual(['https://env-metadata.synthetic/captured/latest/api/token']);
});
it('refuses failed token exchange, redirects, malformed/oversized UTF8 tokens, ambiguous role names and invalid credentials without v1 downgrade', async () => {
  const f = await fixture();
  for (const bad of ['token-status', 'token-large', 'token-length', 'token-utf8', 'token-header', 'roles', 'role-status', 'role-large', 'credentials', 'expiry'] as const) {
    const urls: string[] = []; vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { const value = String(url); urls.push(value);
      if (value.endsWith('/api/token')) return bad === 'token-status' ? new Response('v1 forbidden', { status: 404 }) : bad === 'token-large' ? new Response('x'.repeat(4097)) : bad === 'token-length' ? new Response('short', { headers: { 'content-length': '4097' } }) : bad === 'token-utf8' ? new Response(Buffer.from([0xff])) : bad === 'token-header' ? new Response('unsafe\nheader') : new Response('SyntheticImdsTokenA');
      if (value.endsWith(rolePath)) return bad === 'roles' ? new Response('two\nroles') : bad === 'role-status' ? new Response('redirect', { status: 302, headers: { location: 'https://must-not-follow.invalid' } }) : bad === 'role-large' ? new Response('a'.repeat(1025)) : new Response('SyntheticInstanceRole');
      return bad === 'credentials' ? Response.json({ Code: 'Denied' }) : credentials();
    }));
    if (bad === 'expiry') vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { const value = String(url); urls.push(value); return value.endsWith('/api/token') ? new Response('SyntheticImdsTokenA') : value.endsWith(rolePath) ? new Response('SyntheticInstanceRole') : Response.json({ Code: 'Success', AccessKeyId: 'EXPIRED', SecretAccessKey: 'ExpiredSecret', Token: 'ExpiredSession', Expiration: '2000-01-01T00:00:00Z' }); }));
    await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(urls).toHaveLength(bad.startsWith('token-') ? 1 : bad.startsWith('role') ? 2 : 3); expect(urls.some(url => url === sts)).toBe(false);
  }
});
it('rechecks current INI at every metadata boundary and after credentials before signing STS', async () => {
  const f = await fixture();
  for (const stage of [1, 2, 3]) { await writeFile(f.configFile, recipe()); const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { const value = String(url); urls.push(value); if (urls.length === stage) await writeFile(f.configFile, '[profile chosen]\ncredential_source=unsupported\n'); return value.endsWith('/api/token') ? new Response('SyntheticImdsTokenA') : value.endsWith(rolePath) ? new Response('SyntheticInstanceRole') : credentials(); }));
    await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(urls).toHaveLength(stage);
  }
});
it('cancels a held metadata body without releasing STS or late credentials', async () => {
  const f = await fixture(), lifetime = new AbortController(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); let cancelled = false; const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { urls.push(String(url)); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial-token')); started(); }, cancel() { cancelled = true; } })); }));
  const operation = new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile!, signal: lifetime.signal } }).chat(messages); const refused = expect(operation).rejects.toThrow('Bedrock profile authentication failed.'); await ready; lifetime.abort(); await refused; expect(cancelled).toBe(true); expect(urls).toHaveLength(1);
});
it('retains only final roles across calls and re-acquires IMDSv2 only after matching403 eviction', async () => {
  const f = await fixture(), provider = new BedrockProvider(f.config); let metadata = 0, tokens = 0, inference = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { const value = String(url); if (value.includes('/latest/')) { metadata++; return value.endsWith('/api/token') ? new Response('SyntheticImdsTokenA') : value.endsWith(rolePath) ? new Response('SyntheticInstanceRole') : credentials(); } if (value === sts) { tokens++; return new Response(syntheticAssumeRoleXml('IMDSROLEA')); } return ++inference === 3 ? new Response('denied', { status: 403 }) : json(); }));
  await provider.chat(messages); await provider.chat(messages); expect(metadata).toBe(3); expect(tokens).toBe(1); await expect(provider.chat(messages)).rejects.toThrow('Bedrock API error (403).'); expect(metadata).toBe(3); await provider.chat(messages); expect(metadata).toBe(6); expect(tokens).toBe(2);
});
