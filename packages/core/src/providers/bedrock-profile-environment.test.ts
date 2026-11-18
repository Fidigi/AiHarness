import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BedrockProvider, CredentialRedactor, type BedrockProviderConfig, type ChatResponse, type Message } from '../../dist/index.js';
import { syntheticStsRole, syntheticAssumeRoleXml } from '../../../../tests/fixtures/sts-web-identity.js';
import { bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';
const roots: string[] = [], model = 'anthropic.claude-opus-4-6-v1', sts = 'https://sts.eu-west-1.amazonaws.com/';
const messages: Message[] = [{ id: 'u', timestamp: new Date(0), role: 'user', content: 'environment role probe' }];
const role = (leaf = false) => `[profile chosen]\nrole_arn=${syntheticStsRole}\n${leaf ? 'source_profile=base' : 'credential_source=Environment'}\nregion=eu-west-1\nrole_session_name=synthetic-env-role\n` + (leaf ? '[profile base]\ncredential_source=Environment\n' : '');
const json = () => Response.json({ output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'consider', signature: 'env-role-private-signature' } } }, { text: 'env-role-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
const binary = () => new Response(bedrockText('env-role-ready', 'end_turn', { inputTokens: 8, outputTokens: 2, totalTokens: 10 }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
beforeEach(() => { for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CREDENTIAL_EXPIRATION', 'AWS_CREDENTIAL_SCOPE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']) vi.stubEnv(key, undefined); vi.stubEnv('AWS_ACCESS_KEY_ID', 'ENVROLESOURCE'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'EnvRoleSecret/+='); vi.stubEnv('AWS_SESSION_TOKEN', 'EnvRoleSession/+='); });
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(leaf = false) { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-env-role-')); roots.push(root); const configFile = path.join(root, 'config'); await writeFile(configFile, role(leaf)); const redactor = new CredentialRedactor(), config: BedrockProviderConfig = { type: 'bedrock', model, region: 'us-west-2', bedrockProfile: { profile: 'chosen', configFile, redactor } }; return { configFile, redactor, config }; }
it.each([false, true])('uses only captured environment source keys for signed role STS and final native JSON/binary/private replay (source-profile leaf=%s)', async leaf => {
  const f = await fixture(leaf); vi.stubEnv('AWS_CREDENTIAL_SCOPE', 'inert-environment-metadata'); const provider = new BedrockProvider(f.config); vi.stubEnv('AWS_ACCESS_KEY_ID', 'LATERMUSTNOTRETARGET');
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body) }); return String(url) === sts ? new Response(syntheticAssumeRoleXml('ENVROLEFINAL')) : String(url).endsWith('/converse-stream') ? binary() : json(); }));
  expect(provider.validateConfig()).toBe(true); expect(provider.canDiscoverModels()).toBe(false); expect(await provider.getAvailableModels()).toEqual([]); expect(calls).toHaveLength(0);
  const first = await provider.chat(messages); let streamed: ChatResponse | undefined; await provider.streamChat(messages, () => {}, result => { streamed = result; });
  expect(first).toMatchObject({ model, content: 'env-role-ready', provider: 'bedrock', usage: { totalTokens: 10 } }); expect(streamed).toMatchObject({ model, content: 'env-role-ready', usage: { totalTokens: 10 } });
  await provider.chat([...messages, { id: 'a', timestamp: new Date(1), role: 'assistant', content: first.content, blocks: first.blocks, provider: first.provider, api: first.api, model }]);
  expect(calls).toHaveLength(4); expect(calls[0].url).toBe(sts); expect(calls[0].headers.get('authorization')).toContain('Credential=ENVROLESOURCE/'); expect(calls[0].headers.get('authorization')).toContain('/eu-west-1/sts/aws4_request'); expect(calls[0].headers.get('x-amz-security-token')).toBe('EnvRoleSession/+=');
  expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: syntheticStsRole, RoleSessionName: 'synthetic-env-role', DurationSeconds: '3600' });
  for (const call of calls.slice(1)) { expect(call.headers.get('authorization')).toContain('Credential=ENVROLEFINAL/'); expect(call.headers.get('authorization')).toContain('/us-west-2/bedrock/aws4_request'); }
  expect(calls[3].body).toContain('env-role-private-signature'); for (const secret of ['ENVROLESOURCE', 'EnvRoleSecret/+=', 'EnvRoleSession/+=', 'ENVROLEFINAL']) expect(f.redactor.redact(secret)).not.toContain(secret);
});
it('refuses missing/invalid/expired environment sources, mixed recipes and offline mint without falling back to raw ambient keys', async () => {
  const f = await fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const env of [{ AWS_SECRET_ACCESS_KEY: undefined }, { AWS_SESSION_TOKEN: 'invalid session' }, { AWS_CREDENTIAL_EXPIRATION: 'not-a-date' }, { AWS_CREDENTIAL_EXPIRATION: '2000-01-01T00:00:00Z' }, { AWS_ACCESS_KEY_ID: 'invalid key' }]) {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'ENVROLESOURCE'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'EnvRoleSecret/+='); vi.stubEnv('AWS_SESSION_TOKEN', 'EnvRoleSession/+='); vi.stubEnv('AWS_CREDENTIAL_EXPIRATION', undefined); vi.stubEnv('AWS_CREDENTIAL_SCOPE', undefined);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  }
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'ENVROLESOURCE'); vi.stubEnv('AWS_CREDENTIAL_SCOPE', undefined); vi.stubEnv('AWS_CREDENTIAL_EXPIRATION', undefined);
  for (const extra of ['source_profile=must-not-select', 'credential_process=must-not-run', 'web_identity_token_file=/must-not-read']) { await writeFile(f.configFile, role() + extra + '\n'); await expect(new BedrockProvider(f.config).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); }
  await writeFile(f.configFile, role()); await expect(new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile!, allowNetwork: false } }).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(fetch).not.toHaveBeenCalled();
});
it('retains a still-valid final role after source expiry, but refuses a new mint after matching403 eviction', async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-15T00:00:00Z')); vi.stubEnv('AWS_CREDENTIAL_EXPIRATION', new Date(Date.now() + 60000).toISOString());
  const provider = new BedrockProvider(f.config); let tokens = 0, calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { if (String(url) === sts) { tokens++; return new Response(syntheticAssumeRoleXml('EXPIRYROLE')); } return ++calls === 3 ? new Response('denied', { status: 403 }) : json(); }));
  await provider.chat(messages); vi.setSystemTime(Date.now() + 120000); await provider.chat(messages); expect(tokens).toBe(1);
  await expect(provider.chat(messages)).rejects.toThrow('Bedrock API error (403).');
  await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(tokens).toBe(1); expect(calls).toBe(3);
});
it('preserves recursive static-source precedence and explicit Bearer/derived ownership without acquiring an environment role', async () => {
  const f = await fixture(true); await writeFile(f.configFile, role(true) + 'aws_access_key_id=FILEWINS\naws_secret_access_key=FileSourceSecret\n');
  const calls: Array<{ url: string; auth: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization') }); return String(url) === sts ? new Response(syntheticAssumeRoleXml('FILEROLE')) : json(); }));
  await new BedrockProvider(f.config).chat(messages); expect(calls[0].auth).toContain('Credential=FILEWINS/');
  await rm(f.configFile); await new BedrockProvider({ ...f.config, apiKey: 'synthetic-explicit-bearer' }).chat(messages); expect(calls.at(-1)?.auth).toBe('Bearer synthetic-explicit-bearer');
  class Derived extends BedrockProvider {} await new Derived(f.config).chat(messages); expect(calls.at(-1)?.auth).toContain('Credential=ENVROLESOURCE/'); expect(calls.filter(call => call.url === sts)).toHaveLength(1);
});
