import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BedrockProvider, CredentialRedactor, type BedrockProviderConfig, type ChatResponse, type Message } from '../../dist/index.js';
import { syntheticStsRole, syntheticAssumeRoleXml } from '../../../../tests/fixtures/sts-web-identity.js';
import { bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';
const roots: string[] = [], model = 'anthropic.claude-opus-4-6-v1', sts = 'https://sts.eu-west-1.amazonaws.com/';
const messages: Message[] = [{ id: 'u', timestamp: new Date(0), role: 'user', content: 'container role probe' }];
const recipe = (leaf = false) => `[profile chosen]\nrole_arn=${syntheticStsRole}\n${leaf ? 'source_profile=base' : 'credential_source=EcsContainer'}\nregion=eu-west-1\nrole_session_name=synthetic-ecs-role\n` + (leaf ? '[profile base]\ncredential_source=EcsContainer\nregion=ap-northeast-1\n' : '');
const json = () => Response.json({ output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'consider', signature: 'ecs-role-private-signature' } } }, { text: 'profile-ecs-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
const container = (revision = 'A') => Response.json({ AccessKeyId: 'ECSLEAF' + revision, SecretAccessKey: 'EcsSecret' + revision, Token: 'EcsSession' + revision, Expiration: new Date(Date.now() + 3600000).toISOString() });
beforeEach(() => { for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE']) vi.stubEnv(key, undefined); vi.stubEnv('AWS_ACCESS_KEY_ID', 'MUSTNOTFALLBACK'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'MustNotFallbackSecret'); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(leaf = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-ecs-role-')); roots.push(root); const configFile = path.join(root, 'config'), tokenFile = path.join(root, 'container-token'); await writeFile(configFile, recipe(leaf)); await writeFile(tokenFile, 'SyntheticContainerAuthA');
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', 'https://credentials.synthetic/container'); if (leaf) vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/role/container');
  vi.stubEnv('AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', tokenFile); vi.stubEnv('AWS_CONTAINER_AUTHORIZATION_TOKEN', 'ignored-inline-container-token');
  const redactor = new CredentialRedactor(), config: BedrockProviderConfig = { type: 'bedrock', model, region: 'us-west-2', customHeaders: { 'x-aih-inference': 'inference-only' }, bedrockProfile: { profile: 'chosen', configFile, redactor } };
  return { configFile, tokenFile, redactor, config, metadata: leaf ? 'http://169.254.170.2/role/container' : 'https://credentials.synthetic/container' };
}
it.each([false, true])('uses captured EcsContainer authority, source-only keys and final native JSON/binary/private replay without metadata cache hits (leaf=%s)', async leaf => {
  const f = await fixture(leaf); await writeFile(f.tokenFile, Buffer.from([0xff])); const provider = new BedrockProvider(f.config); const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', 'https://must-not-retarget.synthetic/'); vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/must-not-retarget');
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body ?? '') }); return String(url) === f.metadata ? container() : String(url) === sts ? new Response(syntheticAssumeRoleXml('ECSROLEA')) : String(url).endsWith('/converse-stream') ? new Response(bedrockText('profile-ecs-ready', 'end_turn', { inputTokens: 8, outputTokens: 2, totalTokens: 10 })) : json(); }));
  expect(provider.validateConfig()).toBe(true); expect(provider.canDiscoverModels()).toBe(false); expect(await provider.getAvailableModels()).toEqual([]); expect(calls).toHaveLength(0); await writeFile(f.tokenFile, 'SyntheticContainerAuthA');
  const first = await provider.chat(messages); let streamed: ChatResponse | undefined; await provider.streamChat(messages, () => {}, result => { streamed = result; });
  expect(first).toMatchObject({ model, content: 'profile-ecs-ready', provider: 'bedrock', usage: { totalTokens: 10 } }); expect(streamed).toMatchObject({ model, content: 'profile-ecs-ready', usage: { totalTokens: 10 } });
  await provider.chat([...messages, { id: 'a', timestamp: new Date(1), role: 'assistant', content: first.content, blocks: first.blocks, provider: first.provider, api: first.api, model }]);
  expect(calls).toHaveLength(5); expect(calls[0].url).toBe(f.metadata); expect(calls[0].headers.get('authorization')).toBe('SyntheticContainerAuthA'); expect(calls[0].headers.get('x-aih-inference')).toBeNull(); expect(calls[0].headers.get('x-amz-security-token')).toBeNull();
  expect(calls[1].url).toBe(sts); expect(calls[1].headers.get('authorization')).toContain('Credential=ECSLEAFA/'); expect(calls[1].headers.get('authorization')).toContain('/eu-west-1/sts/aws4_request'); expect(calls[1].headers.get('x-amz-security-token')).toBe('EcsSessionA'); expect(calls[1].headers.get('x-aih-inference')).toBeNull();
  for (const call of calls.slice(2)) { expect(call.headers.get('authorization')).toContain('Credential=ECSROLEA/'); expect(call.headers.get('authorization')).toContain('/us-west-2/bedrock/aws4_request'); expect(call.headers.get('x-aih-inference')).toBe('inference-only'); }
  expect(calls.at(-1)!.body).toContain('ecs-role-private-signature'); for (const secret of ['SyntheticContainerAuthA', 'ECSLEAFA', 'EcsSecretA', 'EcsSessionA', 'ECSROLEA']) expect(f.redactor.redact(secret)).not.toContain(secret);
});
it('binds final role cache to current container auth bytes and remints only on the next call after a matching403', async () => {
  const f = await fixture(), provider = new BedrockProvider(f.config); let revision = 'A', metadata = 0, tokens = 0, inference = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { if (String(url) === f.metadata) { metadata++; expect(new Headers(init.headers).get('authorization')).toBe('SyntheticContainerAuth' + revision); return container(revision); } if (String(url) === sts) { tokens++; expect(new Headers(init.headers).get('authorization')).toContain('Credential=ECSLEAF' + revision + '/'); return new Response(syntheticAssumeRoleXml('ECSROLE' + revision)); } return ++inference === 4 ? new Response('denied', { status: 403 }) : json(); }));
  await provider.chat(messages); await provider.chat(messages); expect(metadata).toBe(1); expect(tokens).toBe(1);
  revision = 'B'; await writeFile(f.tokenFile, 'SyntheticContainerAuthB'); await provider.chat(messages); expect(metadata).toBe(2); expect(tokens).toBe(2);
  await expect(provider.chat(messages)).rejects.toThrow('Bedrock API error (403).'); expect(tokens).toBe(2); await provider.chat(messages); expect(metadata).toBe(3); expect(tokens).toBe(3);
});
it('refuses unsafe/missing/mixed/offline container recipes without ambient fallback, and rechecks INI after secret read before GET', async () => {
  const f = await fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', 'http://must-not-read.invalid/'); await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', undefined); await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', f.metadata);
  for (const extra of ['source_profile=must-not-select', 'credential_process=must-not-run', 'web_identity_token_file=/must-not-read']) { await writeFile(f.configFile, recipe() + extra + '\n'); await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); }
  await writeFile(f.configFile, recipe()); await rm(f.tokenFile); await expect(new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile!, allowNetwork: false } }).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); await writeFile(f.tokenFile, 'SyntheticContainerAuthA');
  let withdrew = false; const provider = new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile!, redactor: { add(value) { if (value === 'SyntheticContainerAuthA' && !withdrew) { withdrew = true; writeFileSync(f.configFile, '[profile chosen]\ncredential_source=unsupported\n'); } } } } });
  await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(withdrew).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
it.each(['retirement', 'INI withdrawal'] as const)('does not sign STS or dispatch inference after held metadata outlives %s', async reason => {
  const f = await fixture(), lifetime = new AbortController(), provider = new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile!, signal: lifetime.signal } });
  let release!: () => void, started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; }); const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { urls.push(String(url)); started(); await held; return container(); })); const request = provider.chat(messages); const refused = expect(request).rejects.toThrow('Bedrock profile authentication failed.'); await ready;
  if (reason === 'retirement') lifetime.abort(); else await writeFile(f.configFile, '[profile chosen]\ncredential_source=unsupported\n'); release(); await refused; expect(urls).toEqual([f.metadata]);
});
