import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BedrockProvider, CredentialRedactor, resolveBedrockProfileEnvironment, type BedrockProfileConfig, type ChatResponse, type Message } from '../../dist/index.js';
import { bedrockFrame } from '../../../../tests/fixtures/bedrock-event-stream.js';
import { syntheticAssumeRoleXml, syntheticStsSession } from '../../../../tests/fixtures/sts-web-identity.js';
const roots: string[] = [], model = 'anthropic.claude-opus-4-6-v1';
const messages: Message[] = [{ id: 'u', role: 'user', content: 'synthetic executable profile', timestamp: new Date(0) }];
const credentials = (key = 'PROCESSKEY') => ({ Version: 1, AccessKeyId: key, SecretAccessKey: 'ProcessSecret/+=', SessionToken: 'ProcessSession/+=', Expiration: new Date(Date.now() + 3600000).toISOString() });
const json = () => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'process-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
const binary = () => new Response(Buffer.concat([bedrockFrame('messageStart', { role: 'assistant' }), bedrockFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'process-ready' } }), bedrockFrame('contentBlockStop', { contentBlockIndex: 0 }), bedrockFrame('messageStop', { stopReason: 'end_turn' }), bedrockFrame('metadata', { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } })]), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-profile-process-')); roots.push(root); vi.stubEnv('HOME', root); vi.stubEnv('AWS_REGION', ''); vi.stubEnv('AWS_DEFAULT_REGION', '');
  const file = path.join(root, 'credentials'), script = path.join(root, 'helper.mjs'), output = path.join(root, 'output.json'), marker = path.join(root, 'executions');
  const command = [process.execPath, '--no-maglev', script].map(value => JSON.stringify(value)).join(' ');
  await writeFile(output, JSON.stringify(credentials()));
  await writeFile(script, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'x');process.stderr.write('synthetic-helper-stderr-secret');process.stdout.write(fs.readFileSync(${JSON.stringify(output)}));`);
  const save = (suffix = '') => writeFile(file, '[chosen]\ncredential_process=' + command + suffix + '\nregion=eu-west-1\n'); await save();
  const create = (extra: Partial<BedrockProfileConfig> = {}) => new BedrockProvider({ type: 'bedrock', model, bedrockProfile: { profile: 'chosen', credentialsFile: file, ...extra } });
  return { root, file, script, output, marker, command, save, create, count: async () => (await readFile(marker, 'utf8').catch(() => '')).length };
}
it('runs only explicitly opted-in AWS Version1 stdout, caches current file-bound credentials and signs native JSON/binary without passing sensitive environment', async () => {
  const f = await fixture(), redactor = new CredentialRedactor(); vi.stubEnv('AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION', '1'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'MUST_NOT_INHERIT'); vi.stubEnv('AI_HARNESS_MASTER_KEY', 'MUST_NOT_INHERIT');
  await writeFile(f.script, `import fs from 'node:fs';if(process.env.AWS_SECRET_ACCESS_KEY||process.env.AI_HARNESS_MASTER_KEY||process.env.AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION)process.exit(9);fs.appendFileSync(${JSON.stringify(f.marker)},'x');process.stderr.write('synthetic-helper-stderr-secret');process.stdout.write(fs.readFileSync(${JSON.stringify(f.output)}));`);
  const provider = f.create({ allowProcess: true, redactor }), fetch = vi.fn(async (url, init) => { const headers = new Headers(init?.headers); expect(headers.get('authorization')).toContain('Credential=PROCESSKEY/'); expect(headers.get('authorization')).toContain('/eu-west-1/bedrock/aws4_request'); expect(headers.get('x-amz-security-token')).toBe('ProcessSession/+='); return String(url).endsWith('/converse-stream') ? binary() : json(); }); vi.stubGlobal('fetch', fetch);
  expect(provider.validateConfig()).toBe(true); expect(provider.getPublishedModels()?.length).toBe(194); expect(await provider.getAvailableModels()).toEqual([]); expect(await f.count()).toBe(0);
  expect((await provider.chat(messages)).usage?.totalTokens).toBe(10); let result: ChatResponse | undefined; await provider.streamChat(messages, () => {}, value => { result = value; }); expect(result?.usage?.totalTokens).toBe(10); expect(await f.count()).toBe(1); expect(fetch).toHaveBeenCalledTimes(2);
  expect(redactor.redact('PROCESSKEY ProcessSecret/+= ProcessSession/+=')).not.toMatch(/PROCESSKEY|ProcessSecret|ProcessSession/); expect(await readFile(f.file, 'utf8')).toContain(f.command); expect(await stat(path.join(f.root, 'credentials.enc')).catch(() => undefined)).toBeUndefined();
});
it('does not execute default-off, file-authored opt-ins, offline, explicit credential priority or derived sources', async () => {
  const f = await fixture(), fetch = vi.fn(async () => json()); vi.stubGlobal('fetch', fetch);
  for (const extra of [{}, { allowProcess: false }, { allowProcess: true, allowNetwork: false }]) await expect(f.create(extra).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  await writeFile(f.file, '[chosen]\ncredential_process=' + f.command + '\nallow_process=true\nallowProcess=true\n'); await expect(f.create().chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  const profile = { profile: 'chosen', credentialsFile: f.file, allowProcess: true }; class Derived extends BedrockProvider {}
  await expect(new Derived({ type: 'bedrock', model, bedrockProfile: profile }).chat(messages)).rejects.toThrow('AWS Bedrock credentials are required');
  await new BedrockProvider({ type: 'bedrock', model, apiKey: 'synthetic-direct', bedrockProfile: profile }).chat(messages);
  await new BedrockProvider({ type: 'bedrock', model, accessKeyId: 'DIRECTKEY', secretAccessKey: 'DirectSecret', bedrockProfile: profile }).chat(messages);
  expect(await f.count()).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
});
it('remints on current INI change/eager expiry or exact auth failure, supports nonexpiring output and never persists process credentials', async () => {
  const f = await fixture(), fetch = vi.fn(async () => json()); vi.stubGlobal('fetch', fetch); const provider = f.create({ allowProcess: true });
  await provider.chat(messages); await writeFile(f.output, JSON.stringify(credentials('ROTATEDPROCESS'))); await f.save(' '); await provider.chat(messages); expect(await f.count()).toBe(2);
  fetch.mockResolvedValueOnce(new Response('', { status: 403 })); await expect(provider.chat(messages, { maxRetries: 0 })).rejects.toThrow(); await provider.chat(messages); expect(await f.count()).toBe(3);
  await writeFile(f.output, JSON.stringify({ ...credentials(), Expiration: new Date(Date.now() + 120000).toISOString() })); await f.save('  '); await provider.chat(messages); await provider.chat(messages); expect(await f.count()).toBe(5);
  const permanent = { Version: 1, AccessKeyId: 'PERMANENTPROCESS', SecretAccessKey: 'ProcessSecret' }; await writeFile(f.output, JSON.stringify(permanent)); await f.save('   '); await provider.chat(messages); await provider.chat(messages); expect(await f.count()).toBe(6);
});
it('rejects malformed, expired, unsupported-scoped, oversized, invalid UTF8 and failed process results without inference or output/path disclosure', async () => {
  const f = await fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const invalid = [{ ...credentials(), Version: '1' }, { ...credentials(), Expiration: 'not-a-date' }, { ...credentials(), Expiration: new Date(0).toISOString() }, { ...credentials(), CredentialScope: 'unsupported-scope' }, { ...credentials(), AccessKeyId: 'bad key' }, { ...credentials(), SessionToken: 'bad token' }, { ...credentials(), SecretAccessKey: undefined }, null];
  for (const value of invalid) { await writeFile(f.output, JSON.stringify(value)); const error = await f.create({ allowProcess: true }).chat(messages).catch(error => error); expect(error.message).toBe('Bedrock profile authentication failed.'); expect(error.message).not.toContain(f.root); }
  for (const value of [Buffer.alloc(128 * 1024 + 1, 32), Buffer.from([0xff])]) { await writeFile(f.output, value); await expect(f.create({ allowProcess: true }).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); }
  await writeFile(f.script, `process.stderr.write('synthetic-secret-failure');process.exit(7);`); await expect(f.create({ allowProcess: true }).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(await f.count()).toBe(invalid.length + 2); expect(fetch).not.toHaveBeenCalled();
});
it('admits process permission only from exact trusted operator environment value while profile metadata reads remain passive', async () => {
  const f = await fixture(), redactor = new CredentialRedactor();
  redactor.addEnvironment({ AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION: '1', AWS_SECRET_ACCESS_KEY: 'synthetic-seed-secret' });
  expect(redactor.redact('model-v1 synthetic-seed-secret')).toBe('model-v1 [REDACTED]');
  const collision = new CredentialRedactor(); collision.addEnvironment({ AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION: '1', AWS_SECRET_ACCESS_KEY: '1' }); expect(collision.redact('model-v1')).toBe('model-v[REDACTED]');
  for (const flag of [undefined, '0', 'true', '1']) {
    const config = await resolveBedrockProfileEnvironment({ HOME: f.root, AWS_PROFILE: 'chosen', AWS_SHARED_CREDENTIALS_FILE: f.file, AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION: flag });
    expect(config?.bedrockProfile?.allowProcess).toBe(flag === '1' ? true : undefined); expect(await f.count()).toBe(0);
  }
});
it('rejects process-authority withdrawal before spawn and after mint before native inference', async () => {
  const f = await fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch); let retired = false;
  const before = f.create({ allowProcess: true, redactor: { add(value) { if (value === f.command && !retired) { retired = true; writeFileSync(f.file, '[chosen]\ncredential_process=must-not-execute\n'); } } } });
  await expect(before.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(await f.count()).toBe(0);
  await f.save(); retired = false;
  const after = f.create({ allowProcess: true, redactor: { add(value) { if (value === 'PROCESSKEY' && !retired) { retired = true; writeFileSync(f.file, '[withdrawn]\n'); } } } });
  await expect(after.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(await f.count()).toBe(1); expect(fetch).not.toHaveBeenCalled();
});
it('cancels a held process independently of another successful caller and rejects future work after owner retirement', async () => {
  const f = await fixture(), lifetime = new AbortController(), caller = new AbortController(), fetch = vi.fn(async () => json()); vi.stubGlobal('fetch', fetch);
  await writeFile(f.script, `import fs from 'node:fs';if(!fs.existsSync(${JSON.stringify(f.marker)})){fs.writeFileSync(${JSON.stringify(f.marker)},'x');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}else{fs.appendFileSync(${JSON.stringify(f.marker)},'x');process.stdout.write(fs.readFileSync(${JSON.stringify(f.output)}));}`);
  const provider = f.create({ allowProcess: true, signal: lifetime.signal }), pending = provider.chat(messages, { signal: caller.signal }).then(() => 'unexpected-success', error => error.message);
  const limit = Date.now() + 2000; while (!await f.count()) { if (Date.now() > limit) throw new Error('Synthetic process did not enter'); await new Promise(resolve => setTimeout(resolve, 10)); }
  try { expect((await provider.chat(messages)).usage?.totalTokens).toBe(10); } finally { caller.abort(); }
  expect(await pending).toBe('Bedrock profile authentication failed.'); await provider.chat(messages); expect(await f.count()).toBe(2); expect(fetch).toHaveBeenCalledTimes(2);
  lifetime.abort(); await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
});
it('uses a permitted process source_profile leaf only for signed role vending and caches only the final role for JSON/binary', async () => {
  const f = await fixture(), role = 'arn:aws:iam::123456789012:role/SyntheticProcessRole', now = Date.now();
  await writeFile(f.output, JSON.stringify({ ...credentials(), Expiration: new Date(now + 60000).toISOString() }));
  await writeFile(f.file, '[chosen]\nrole_arn=' + role + '\nsource_profile=leaf\nrole_session_name=process-role-session\nregion=eu-west-1\n[leaf]\ncredential_process=' + f.command + '\nregion=ap-south-1\n');
  let mints = 0; const fetch = vi.fn(async (url, init) => { const headers = new Headers(init?.headers); if (String(url) === 'https://sts.eu-west-1.amazonaws.com/') { mints++; expect(headers.get('authorization')).toContain('Credential=PROCESSKEY/'); expect(headers.get('authorization')).toContain('/eu-west-1/sts/aws4_request'); expect(headers.get('x-amz-security-token')).toBe('ProcessSession/+='); expect(new URLSearchParams(String(init?.body)).get('RoleArn')).toBe(role); return new Response(syntheticAssumeRoleXml('FINALPROCESSROLE')); } expect(headers.get('authorization')).toContain('Credential=FINALPROCESSROLE/'); expect(headers.get('x-amz-security-token')).toBe(syntheticStsSession); return String(url).endsWith('/converse-stream') ? binary() : json(); }); vi.stubGlobal('fetch', fetch);
  const provider = f.create({ allowProcess: true }); expect((await provider.chat(messages)).usage?.totalTokens).toBe(10); vi.spyOn(Date, 'now').mockReturnValue(now + 120000); let streamed: ChatResponse | undefined; await provider.streamChat(messages, () => {}, value => { streamed = value; }, error => { throw error; }); expect(streamed?.usage?.totalTokens).toBe(10); expect(await f.count()).toBe(1); expect(mints).toBe(1); expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockResolvedValueOnce(new Response('', { status: 401 })); await expect(provider.chat(messages, { maxRetries: 0 })).rejects.toThrow();
  await expect(provider.chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(await f.count()).toBe(2); expect(mints).toBe(1); expect(fetch).toHaveBeenCalledTimes(4);
});
it('keeps process role leaves opt-in/offline/mixed-source guarded and complete recursive static keys ahead of an unused process recipe', async () => {
  const f = await fixture(), role = 'arn:aws:iam::123456789012:role/SyntheticProcessRole', recipe = '[chosen]\nrole_arn=' + role + '\nsource_profile=leaf\n[leaf]\ncredential_process=' + f.command + '\n'; await writeFile(f.file, recipe); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const options of [{}, { allowProcess: false }, { allowProcess: true, allowNetwork: false }]) await expect(f.create(options).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.');
  await writeFile(f.file, recipe + 'sso_session=must-not-combine\n'); await expect(f.create({ allowProcess: true }).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(await f.count()).toBe(0); expect(fetch).not.toHaveBeenCalled();
  await writeFile(f.file, recipe + 'aws_access_key_id=STATICROLELEAF\naws_secret_access_key=StaticRoleSecret\n'); fetch.mockImplementation(async (url, init) => { if (String(url).startsWith('https://sts.')) { expect(new Headers(init?.headers).get('authorization')).toContain('Credential=STATICROLELEAF/'); return new Response(syntheticAssumeRoleXml('STATICFINALROLE')); } return json(); }); await f.create().chat(messages); expect(await f.count()).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
});
it('fences process role-leaf command/current INI before spawn and after mint before STS without cached source credential fallback', async () => {
  const f = await fixture(), recipe = '[chosen]\nrole_arn=arn:aws:iam::123456789012:role/SyntheticProcessRole\nsource_profile=leaf\n[leaf]\ncredential_process=' + f.command + '\n', fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await writeFile(f.file, recipe); let changed = false;
  const make = (trigger: string) => f.create({ allowProcess: true, redactor: { add(value) { if (!changed && value === trigger) { changed = true; writeFileSync(f.file, '[withdrawn]\n'); } } } });
  await expect(make(f.command).chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(await f.count()).toBe(0); await writeFile(f.file, recipe); changed = false;
  await expect(make('PROCESSKEY').chat(messages)).rejects.toThrow('Bedrock profile authentication failed.'); expect(await f.count()).toBe(1); expect(fetch).not.toHaveBeenCalled();
});
