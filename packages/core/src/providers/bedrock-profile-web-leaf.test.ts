import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BedrockProvider, CredentialRedactor, createProviderNetworkScope, closeProviderNetworkDispatchers, PROVIDER_NETWORK_SCOPE, type Message } from '../../dist/index.js';
import { syntheticStsRole, syntheticStsSecret, syntheticStsSession, syntheticStsXml, syntheticAssumeRoleXml } from '../../../../tests/fixtures/sts-web-identity.js';
const roots: string[] = [], scopes: ReturnType<typeof createProviderNetworkScope>[] = [], model = 'anthropic.claude-opus-4-6-v1';
const webSts = 'https://sts.us-west-2.amazonaws.com/', roleSts = 'https://sts.eu-west-1.amazonaws.com/', leafRole = 'arn:aws:iam::123456789012:role/SyntheticWebLeaf', middleRole = 'arn:aws:iam::123456789012:role/SyntheticMiddle';
const messages: Message[] = [{ id: 'u', timestamp: new Date(0), role: 'user', content: 'synthetic leaf probe' }];
const json = () => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'web-leaf-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
beforeEach(() => { for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION']) vi.stubEnv(key, ''); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(scopes.splice(0).map(scope => closeProviderNetworkDispatchers(scope, { permanent: true }))); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-profile-leaf-')); roots.push(root); const configFile = path.join(root, 'config'), credentialsFile = path.join(root, 'credentials'), file = path.join(root, 'subject');
  const recipe = (nested = false) => `[profile chosen]\nrole_arn=${syntheticStsRole}\nsource_profile=${nested ? 'middle' : 'web'}\nrole_session_name=synthetic-final\nregion=eu-west-1\n${nested ? `[profile middle]\nrole_arn=${middleRole}\nsource_profile=web\nrole_session_name=synthetic-middle\nregion=ap-south-1\n` : ''}[profile web]\nrole_arn=${leafRole}\nweb_identity_token_file=${file}\nrole_session_name=synthetic-leaf\nregion=ap-northeast-1\n`;
  await writeFile(configFile, recipe()); await writeFile(file, 'synthetic.leaf.jwt.A'); const scope = createProviderNetworkScope(); scopes.push(scope); const redactor = new CredentialRedactor();
  const config = { type: 'bedrock', model, region: 'us-west-2', bedrockProfile: { profile: 'chosen', configFile, credentialsFile, redactor }, [PROVIDER_NETWORK_SCOPE]: scope };
  return { file, configFile, credentialsFile, recipe, config, redactor, create: () => new BedrockProvider(config) };
}
it('resolves unsigned web leaf then bounded signed role steps, preserving distinct STS regions, final-only inference and cached usage', async () => {
  const f = await fixture(); await writeFile(f.configFile, f.recipe(true)); let tokens = 0, calls = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers), body = new URLSearchParams(String(init?.body));
    if (String(url) === webSts) { tokens++; expect(headers.get('authorization')).toBeNull(); expect(Object.fromEntries(body)).toEqual({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: leafRole, RoleSessionName: 'synthetic-leaf', WebIdentityToken: 'synthetic.leaf.jwt.A' }); return new Response(syntheticStsXml('LEAFKEY')); }
    if (String(url) === roleSts) { tokens++; expect(body.get('Action')).toBe('AssumeRole'); expect(body.get('RoleArn')).toBe(tokens === 2 ? middleRole : syntheticStsRole); expect(headers.get('authorization')).toContain('Credential=' + (tokens === 2 ? 'LEAFKEY' : 'MIDDLEKEY') + '/'); expect(headers.get('authorization')).toContain('/eu-west-1/sts/'); expect(headers.get('x-amz-security-token')).toBe(syntheticStsSession); expect(body.has('WebIdentityToken')).toBe(false); return new Response(syntheticAssumeRoleXml(tokens === 2 ? 'MIDDLEKEY' : 'FINALKEY')); }
    calls++; expect(String(url)).toContain('bedrock-runtime.us-west-2.'); expect(headers.get('authorization')).toContain('Credential=FINALKEY/'); return json();
  }); vi.stubGlobal('fetch', fetch); const provider = f.create();
  expect((await provider.chat(messages)).usage?.totalTokens).toBe(10); expect((await provider.chat(messages)).usage?.totalTokens).toBe(10); expect(tokens).toBe(3); expect(calls).toBe(2);
  for (const secret of ['synthetic.leaf.jwt.A', 'LEAFKEY', 'MIDDLEKEY', 'FINALKEY', syntheticStsSecret, syntheticStsSession]) expect(f.redactor.redact(secret)).not.toContain(secret);
});
it('binds final cache to the current leaf JWT and INI, evicts matching403 and keeps recursive static credentials ahead of an unused web recipe', async () => {
  const f = await fixture(), provider = f.create(); let tokens = 0, calls = 0, revision = 'A';
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === webSts) { tokens++; expect(new URLSearchParams(String(init?.body)).get('WebIdentityToken')).toBe('synthetic.leaf.jwt.' + revision); return new Response(syntheticStsXml('LEAF' + revision)); }
    if (String(url) === roleSts) { tokens++; expect(new Headers(init?.headers).get('authorization')).toContain('Credential=LEAF' + revision + '/'); return new Response(syntheticAssumeRoleXml('FINAL' + revision)); }
    calls++; if (calls === 2) return new Response('', { status: 403 }); return json();
  })); await provider.chat(messages); await expect(provider.chat(messages)).rejects.toThrow('Bedrock API error (403).'); expect(tokens).toBe(2); await provider.chat(messages); expect(tokens).toBe(4);
  revision = 'B'; await writeFile(f.file, 'synthetic.leaf.jwt.B'); await provider.chat(messages); expect(tokens).toBe(6); await rm(f.file); await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(tokens).toBe(6);
  await writeFile(f.credentialsFile, '[web]\naws_access_key_id=STATICLEAF\naws_secret_access_key=StaticLeafSecret\n');
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { if (String(url) === roleSts) { expect(new Headers(init?.headers).get('authorization')).toContain('Credential=STATICLEAF/'); return new Response(syntheticAssumeRoleXml('STATICFINAL')); } expect(String(url)).toContain('/model/'); expect(new Headers(init?.headers).get('authorization')).toContain('Credential=STATICFINAL/'); return json(); }); vi.stubGlobal('fetch', fetch);
  await provider.chat(messages); expect(fetch).toHaveBeenCalledTimes(2);
});
it('blocks withdrawn INI before leaf STS and missing JWT between WebIdentity and signed role authority', async () => {
  const f = await fixture(), fetch = vi.fn(async () => new Response(syntheticStsXml('MUSTNOTMINT'))); vi.stubGlobal('fetch', fetch); let changed = false;
  const provider = new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile, redactor: { add(value: string) { if (!changed && value === 'synthetic.leaf.jwt.A') { changed = true; writeFileSync(f.configFile, f.recipe().replace('synthetic-final', 'changed-final')); } } } } });
  await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(changed).toBe(true); expect(fetch).not.toHaveBeenCalled();
  fetch.mockImplementation(async () => { await rm(f.file); return new Response(syntheticStsXml('WITHDRAWNLEAF')); });
  await expect(f.create().chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(fetch).toHaveBeenCalledTimes(1);
});
it('abandons held leaf XML on caller cancellation without revoking an independent later role acquisition', async () => {
  const f = await fixture(), provider = f.create(), caller = new AbortController(); let entered!: () => void, tokens = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; }), cancel = vi.fn(() => new Promise<void>(() => {}));
  const fetch = vi.fn(async (url: string | URL | Request) => { if (++tokens === 1) return new Response(new ReadableStream({ pull() { entered(); return new Promise(() => {}); }, cancel })); return String(url) === webSts ? new Response(syntheticStsXml('RECOVERYLEAF')) : String(url) === roleSts ? new Response(syntheticAssumeRoleXml('RECOVERYFINAL')) : json(); }); vi.stubGlobal('fetch', fetch);
  const pending = provider.chat(messages, { signal: caller.signal }).catch(error => error); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); await ready; caller.abort(); expect(await pending).toMatchObject({ message: 'Bedrock profile authentication failed.' }); expect(cancel).toHaveBeenCalledTimes(1); expect((await provider.chat(messages)).content).toBe('web-leaf-ready'); expect(fetch).toHaveBeenCalledTimes(4);
});
it('refuses offline leaf acquisition and mixed/unsupported leaf scopes without executing commands or falling back', async () => {
  const f = await fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await rm(f.file);
  await expect(new BedrockProvider({ ...f.config, bedrockProfile: { ...f.config.bedrockProfile, allowNetwork: false } }).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  for (const extra of ['credential_source=Environment\n', 'credential_process=must-not-run\n', 'mfa_serial=not-supported\n', 'role_arn=duplicate-authority\n', 'source_profile=chosen\n']) { await writeFile(f.configFile, f.recipe() + extra); await expect(f.create().chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); }
  expect(fetch).not.toHaveBeenCalled();
});
