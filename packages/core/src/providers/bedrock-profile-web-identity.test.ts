import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BedrockProvider, CredentialRedactor, createProviderNetworkScope, closeProviderNetworkDispatchers, PROVIDER_NETWORK_SCOPE, type ChatResponse, type Message } from '../../dist/index.js';
import { bedrockFrame } from '../../../../tests/fixtures/bedrock-event-stream.js';
import { syntheticStsRole, syntheticStsSecret, syntheticStsSession, syntheticStsXml } from '../../../../tests/fixtures/sts-web-identity.js';
const roots: string[] = [], scopes: ReturnType<typeof createProviderNetworkScope>[] = [], model = 'anthropic.claude-opus-4-6-v1';
const messages: Message[] = [{ id: 'u', role: 'user', timestamp: new Date(0), content: 'profile web identity' }];
const json = () => Response.json({ output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'consider', signature: 'profile-web-private-signature' } } }, { text: 'profile-web-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
const binary = () => new Response(Buffer.concat([bedrockFrame('messageStart', { role: 'assistant' }), bedrockFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'profile-web-ready' } }), bedrockFrame('contentBlockStop', { contentBlockIndex: 0 }), bedrockFrame('messageStop', { stopReason: 'end_turn' }), bedrockFrame('metadata', { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } })]), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
beforeEach(() => { for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION']) vi.stubEnv(key, ''); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(scopes.splice(0).map(scope => closeProviderNetworkDispatchers(scope, { permanent: true }))); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-profile-web-')); roots.push(root);
  const configFile = path.join(root, 'config'), credentialsFile = path.join(root, 'credentials'), file = path.join(root, 'projected-token'), target = path.join(root, 'token-current');
  await writeFile(target, 'synthetic.profile.jwt.A'); await symlink(target, file); const scope = createProviderNetworkScope(); scopes.push(scope); const redactor = new CredentialRedactor();
  const recipe = (session = 'synthetic-profile-session', region = 'us-west-2') => `[profile chosen]\nregion=${region}\nrole_arn=${syntheticStsRole}\nweb_identity_token_file=${file}\nrole_session_name=${session}\nduration_seconds=900\n`;
  await writeFile(configFile, recipe());
  const config = { type: 'bedrock', model, bedrockProfile: { profile: 'chosen', configFile, credentialsFile, redactor }, [PROVIDER_NETWORK_SCOPE]: scope };
  return { root, file, target, configFile, credentialsFile, config, redactor, recipe, create: () => new BedrockProvider(config) };
}
it('uses selected INI web identity lazily with fixed unsigned STS, cached native JSON/binary/private replay and current JWT rotation', async () => {
  const f = await fixture(), provider = f.create(); let tokens = 0, calls = 0, revision = 'A';
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (String(url) === 'https://sts.us-west-2.amazonaws.com/') {
      tokens++; expect(headers.get('authorization')).toBeNull(); expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: syntheticStsRole, RoleSessionName: 'synthetic-profile-session', WebIdentityToken: 'synthetic.profile.jwt.' + revision });
      return new Response(syntheticStsXml('PROFILEWEB' + revision));
    }
    calls++; expect(String(url)).toContain('bedrock-runtime.us-west-2.amazonaws.com/model/'); expect(headers.get('authorization')).toContain('Credential=PROFILEWEB' + revision + '/'); expect(headers.get('x-amz-security-token')).toBe(syntheticStsSession);
    return String(url).endsWith('/converse-stream') ? binary() : json();
  }); vi.stubGlobal('fetch', fetch);
  expect(provider.validateConfig()).toBe(true); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getPublishedModels()).toEqual(new BedrockProvider({ type: 'bedrock', model, apiKey: 'synthetic-metadata-key' }).getPublishedModels()); expect(fetch).not.toHaveBeenCalled();
  const completedCaller = new AbortController(), first = await provider.chat(messages, { signal: completedCaller.signal }); expect(first).toMatchObject({ content: 'profile-web-ready', usage: { totalTokens: 10 } });
  const history: Message[] = [...messages, { id: 'a', timestamp: new Date(1), role: 'assistant', content: first.content, blocks: first.blocks, provider: first.provider, model: first.model, api: first.api }], before = structuredClone(history);
  let streamed: ChatResponse | undefined; await provider.streamChat(history, () => {}, result => { streamed = result; }); expect(streamed).toMatchObject({ content: 'profile-web-ready', usage: { totalTokens: 10 } }); expect(history).toEqual(before);
  expect(tokens).toBe(1); completedCaller.abort(); revision = 'B'; await writeFile(f.target, 'synthetic.profile.jwt.B'); await provider.chat(history); expect(tokens).toBe(2); expect(calls).toBe(3);
  expect(f.redactor.redact(`synthetic.profile.jwt.A synthetic.profile.jwt.B PROFILEWEBA PROFILEWEBB ${syntheticStsSecret} ${syntheticStsSession}`)).not.toMatch(/synthetic\.profile|PROFILEWEB|SyntheticSTS/u);
});
it('binds whole INI scope, metadata merge and web STS region to explicit configuration before file defaults, with static-key priority over unused complete web recipes', async () => {
  const f = await fixture(); await writeFile(f.credentialsFile, '[chosen]\nrole_session_name=credentials-file-session\nregion=ap-southeast-2\n'); let tokens = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://sts.eu-west-1.amazonaws.com/') { tokens++; expect(new URLSearchParams(String(init?.body)).get('RoleSessionName')).toBe('credentials-file-session'); return new Response(syntheticStsXml('PROFILEEXPLICIT')); }
    expect(String(url)).toContain('bedrock-runtime.eu-west-1.'); expect(new Headers(init?.headers).get('authorization')).toContain('Credential=PROFILEEXPLICIT/'); return json();
  })); await new BedrockProvider({ ...f.config, region: 'eu-west-1' }).chat(messages); expect(tokens).toBe(1);
  await writeFile(f.credentialsFile, '[chosen]\naws_access_key_id=STATICWINNER\naws_secret_access_key=StaticWinnerSecret\nregion=eu-west-1\n'); await rm(f.target);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => { expect(String(url)).toContain('/model/'); expect(new Headers(init?.headers).get('authorization')).toContain('Credential=STATICWINNER/'); return json(); }));
  await new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile, allowNetwork: false } }).chat(messages);
});
it('evicts only matching web credentials on the next operation and refuses current INI/file withdrawal without leaking paths or falling back', async () => {
  const f = await fixture(), provider = f.create(); let tokens = 0, calls = 0, denied = false;
  const fetch = vi.fn(async (url: string | URL | Request) => { if (String(url).startsWith('https://sts.')) { tokens++; return new Response(syntheticStsXml('CACHEDPROFILE' + tokens)); } calls++; if (!denied) { denied = true; return new Response('', { status: 403 }); } return json(); }); vi.stubGlobal('fetch', fetch);
  await expect(provider.chat(messages)).rejects.toThrow(); expect(tokens).toBe(1); expect(calls).toBe(1); await provider.chat(messages); expect(tokens).toBe(2); await provider.chat(messages); expect(tokens).toBe(2);
  await writeFile(f.configFile, f.recipe('changed-profile-session')); await provider.chat(messages); expect(tokens).toBe(3);
  await rm(f.target); await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(tokens).toBe(3); expect(calls).toBe(4);
  await writeFile(f.target, 'synthetic.profile.jwt.A'); await rm(f.configFile); await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(tokens).toBe(3);
});
it('keeps a held old INI authority from dispatching or replacing a newer successful source cache', async () => {
  const f = await fixture(), provider = f.create(); let tokens = 0, calls = 0, release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => { if (String(url).startsWith('https://sts.')) { tokens++; if (tokens === 1) return held; expect(new URLSearchParams(String(init?.body)).get('RoleSessionName')).toBe('new-profile-session'); return new Response(syntheticStsXml('NEWPROFILE')); } calls++; expect(new Headers(init?.headers).get('authorization')).toContain('Credential=NEWPROFILE/'); return json(); }));
  const old = provider.chat(messages).catch(error => error); await vi.waitFor(() => expect(tokens).toBe(1)); await writeFile(f.configFile, f.recipe('new-profile-session'));
  expect((await provider.chat(messages)).content).toBe('profile-web-ready'); release(new Response(syntheticStsXml('OLDPROFILE'))); expect(await old).toMatchObject({ message: 'Bedrock profile authentication failed.' });
  await provider.chat(messages); expect(tokens).toBe(2); expect(calls).toBe(2);
});
it('rechecks selected INI authority after reading the JWT and before sending it to STS', async () => {
  const f = await fixture(), fetch = vi.fn(async () => new Response(syntheticStsXml('MUSTNOTMINT'))); vi.stubGlobal('fetch', fetch); let changed = false;
  const provider = new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile, redactor: { add(value: string) {
    if (!changed && value === 'synthetic.profile.jwt.A') { changed = true; writeFileSync(f.configFile, f.recipe('withdrawn-before-sts')); }
  } } } });
  await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(changed).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
it('refuses offline vending, mixed/invalid authority and preflight-invalid requests before JWT or network acquisition', async () => {
  const f = await fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await rm(f.target);
  const offline = new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile, allowNetwork: false } }); expect(offline.getPublishedModels()).toEqual(new BedrockProvider({ type: 'bedrock', model, apiKey: 'synthetic-metadata-key' }).getPublishedModels()); await expect(offline.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  for (const extra of ['credential_source=Environment\n', 'credential_process=must-not-execute\n', 'mfa_serial=not-supported\n', 'aws_credential_scope=not-supported\n', 'source_profile=missing\n']) {
    await writeFile(f.configFile, f.recipe() + extra); await expect(f.create().chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  }
  await writeFile(f.configFile, f.recipe().replace(syntheticStsRole, 'not-a-role'));
  await expect(f.create().chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); await expect(f.create().chat(messages, { maxTokens: 0 })).rejects.toThrow('Provider native output policy is invalid.'); expect(fetch).not.toHaveBeenCalled();
});
