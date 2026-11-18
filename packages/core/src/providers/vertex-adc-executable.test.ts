import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { VertexGeminiProvider, CredentialRedactor, resolveVertexAdcEnvironment, type VertexProviderConfig, type ChatResponse } from '../../dist/index.js';
const roots: string[] = [], sts = 'https://sts.googleapis.com/v1/token', audience = '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/synthetic/providers/synthetic', prefix = 'urn:ietf:params:oauth:token-type:', model = 'gemini-2.5-flash';
const token = (type = 'id_token', value = 'private-executable-subject', expires = true) => ({ version: 1, success: true, token_type: prefix + type, [type === 'saml2' ? 'saml_response' : 'id_token']: value, ...(expires ? { expiration_time: Math.floor(Date.now() / 1000) + 3600 } : {}) });
const minted = () => Response.json({ access_token: 'private-executable-access', expires_in: 3600, token_type: 'Bearer' });
const reply = (url: unknown) => { const data = { candidates: [{ content: { role: 'model', parts: [{ text: 'executable-ready' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 } }; return String(url).includes('streamGenerateContent') ? new Response('data: ' + JSON.stringify(data) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }) : Response.json(data); };
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
async function fixture(type = 'id_token', cached = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-adc-executable-')); roots.push(root); vi.stubEnv('HOME', root);
  const file = path.join(root, 'adc.json'), script = path.join(root, 'helper with spaces.mjs'), output = path.join(root, 'stdout.json'), cache = path.join(root, 'cached.json'), marker = path.join(root, 'executions'), environment = path.join(root, 'environment.json');
  const command = [process.execPath, '--no-maglev', script].map(value => JSON.stringify(value)).join(' ');
  const doc = { type: 'external_account', audience, subject_token_type: prefix + type, credential_source: { executable: { command, timeout_millis: 5000, ...(cached ? { output_file: cache } : {}) } }, quota_project_id: 'synthetic-quota' };
  await writeFile(file, JSON.stringify(doc)); await writeFile(output, JSON.stringify(token(type)));
  await writeFile(script, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'x');fs.writeFileSync(${JSON.stringify(environment)},JSON.stringify(process.env));const data=fs.readFileSync(${JSON.stringify(output)});if(process.env.GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE)fs.writeFileSync(process.env.GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE,data);process.stderr.write('private-executable-diagnostic');process.stdout.write(data);`);
  const redactor = new CredentialRedactor(), config: VertexProviderConfig = { type: 'vertex', model, project: 'synthetic-project', location: 'global', baseUrl: 'https://executable.synthetic/proxy', customHeaders: { 'x-inference-only': 'private-inference-header' }, vertexAdc: { credentialsFile: file, redactor, allowExecutable: true } };
  return { root, file, script, output, cache, marker, environment, command, doc, redactor, config, create: () => new VertexGeminiProvider(config), count: async () => (await readFile(marker, 'utf8').catch(() => '')).length };
}
it('uses opted-in JWT/OIDC/SAML helpers with exact noninteractive Google environment, isolated STS and native JSON/SSE/cache accounting', async () => {
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'must-not-inherit'); vi.stubEnv('AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION', '1'); vi.stubEnv('GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL', 'ambient-must-not-inherit');
  for (const type of ['jwt', 'id_token', 'saml2']) {
    const f = await fixture(type), provider = f.create(); let exchanges = 0;
    if (type === 'jwt') await writeFile(f.output, JSON.stringify(token(type, 'private-executable-subject', false)));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { const headers = new Headers(init?.headers); if (String(url) === sts) { exchanges++; const fields = new URLSearchParams(String(init?.body)); expect(fields.get('subject_token')).toBe('private-executable-subject'); expect(fields.get('subject_token_type')).toBe(prefix + type); expect(fields.get('audience')).toBe(audience); expect(headers.has('authorization')).toBe(false); expect(headers.has('x-inference-only')).toBe(false); return minted(); } expect(headers.get('authorization')).toBe('Bearer private-executable-access'); expect(headers.get('x-goog-user-project')).toBe('synthetic-quota'); expect(headers.get('x-inference-only')).toBe('private-inference-header'); return reply(url); });
    expect(await provider.getAvailableModels()).toContain(model); expect(await f.count()).toBe(0); expect(fetch).not.toHaveBeenCalled(); expect((await provider.chat([])).usage?.totalTokens).toBe(10);
    let response: ChatResponse | undefined; await provider.streamChat([], () => {}, value => { response = value; }, error => { throw error; }); expect(response?.usage?.totalTokens).toBe(10); expect(exchanges).toBe(1); expect(await f.count()).toBe(1);
    const env = JSON.parse(await readFile(f.environment, 'utf8')); expect(env).toMatchObject({ GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE: audience, GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE: prefix + type, GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE: '0' }); for (const name of ['AI_HARNESS_MASTER_KEY', 'AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION', 'GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE', 'GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL']) expect(env).not.toHaveProperty(name);
    expect(f.redactor.redact('private-executable-subject private-executable-access')).toBe('[REDACTED] [REDACTED]'); fetch.mockRestore();
  }
});
it('honors advisory output caches before execution, accepts helper cache publication and binds rotation/removal without Core writing credentials', async () => {
  const f = await fixture('id_token', true), provider = f.create(), subjects: string[] = []; await writeFile(f.cache, JSON.stringify(token('id_token', 'cached-one')));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { if (String(url) === sts) { subjects.push(new URLSearchParams(String(init?.body)).get('subject_token')!); return minted(); } return reply(url); });
  await provider.chat([]); await provider.chat([]); expect(subjects).toEqual(['cached-one']); expect(await f.count()).toBe(0);
  await writeFile(f.cache, JSON.stringify(token('id_token', 'cached-two'))); await provider.chat([]); expect(subjects).toEqual(['cached-one', 'cached-two']); expect(await f.count()).toBe(0);
  await writeFile(f.cache, JSON.stringify({ ...token(), expiration_time: 1 })); await provider.chat([]); expect(subjects.at(-1)).toBe('private-executable-subject'); expect(await f.count()).toBe(1); expect(JSON.parse(await readFile(f.environment, 'utf8')).GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE).toBe(f.cache);
  await provider.chat([]); expect(await f.count()).toBe(1); await rm(f.cache); await provider.chat([]); expect(await f.count()).toBe(2); expect(await stat(path.join(f.root, 'credentials.enc')).catch(() => undefined)).toBeUndefined();
  const issued = subjects.length; await rm(f.cache); await writeFile(f.output, JSON.stringify(token('id_token', 'private-executable-subject', false))); await expect(provider.chat([])).rejects.toThrow('Vertex ADC authentication failed.'); expect(subjects).toHaveLength(issued);
  await rm(f.cache); await writeFile(f.output, JSON.stringify(token())); await writeFile(f.script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(f.cache)},${JSON.stringify(JSON.stringify(token('id_token', 'different-cache-identity')))});process.stdout.write(fs.readFileSync(${JSON.stringify(f.output)}));`);
  await expect(provider.chat([])).rejects.toThrow('Vertex ADC authentication failed.'); expect(subjects).toHaveLength(issued);
});
it('keeps default-off/file-authored/ambient upstream opt-ins inert and preserves direct key, derived and exact trusted host admission boundaries', async () => {
  const f = await fixture(), fetch = vi.spyOn(globalThis, 'fetch'); vi.stubEnv('GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES', '1');
  for (const allowExecutable of [undefined, false]) await expect(new VertexGeminiProvider({ ...f.config, vertexAdc: { ...f.config.vertexAdc!, allowExecutable } }).chat([])).rejects.toThrow('Vertex ADC authentication failed.');
  await writeFile(f.file, JSON.stringify({ ...f.doc, allowExecutable: true, allow_executable: true })); await expect(new VertexGeminiProvider({ ...f.config, vertexAdc: { credentialsFile: f.file } }).chat([])).rejects.toThrow('Vertex ADC authentication failed.');
  class Derived extends VertexGeminiProvider {} await expect(new Derived(f.config).chat([])).rejects.toThrow(); expect(await f.count()).toBe(0); expect(fetch).not.toHaveBeenCalled(); fetch.mockImplementation(async url => reply(url));
  await new VertexGeminiProvider({ ...f.config, apiKey: 'direct-token' }).chat([]); expect(await f.count()).toBe(0);
  for (const flag of [undefined, '0', 'true', '1']) { const config = await resolveVertexAdcEnvironment({ HOME: f.root, GOOGLE_CLOUD_PROJECT: 'synthetic-project', GOOGLE_CLOUD_LOCATION: 'global', GOOGLE_APPLICATION_CREDENTIALS: f.file, AI_HARNESS_ALLOW_CREDENTIAL_EXECUTION: flag }); expect(config?.vertexAdc?.allowExecutable).toBe(flag === '1' ? true : undefined); }
});
it('refuses invalid executable recipes, malformed/expired/mismatched stdout and invalid output caches without issuer/inference or secret disclosure', async () => {
  const f = await fixture(), fetch = vi.spyOn(globalThis, 'fetch');
  for (const executable of [{ command: '' }, { command: '"unclosed' }, { command: f.command, timeout_millis: 4999 }, { command: f.command, timeout_millis: 120001 }, { command: f.command, timeout_millis: '5000' }, { command: f.command, output_file: 1 }]) { await writeFile(f.file, JSON.stringify({ ...f.doc, credential_source: { executable } })); await expect(f.create().chat([])).rejects.toThrow('Vertex ADC authentication failed.'); }
  expect(await f.count()).toBe(0); await writeFile(f.file, JSON.stringify(f.doc));
  for (const value of [{ ...token(), version: '1' }, { ...token(), success: 'true' }, { ...token(), token_type: prefix + 'saml2' }, { ...token(), expiration_time: 1 }, { ...token(), expiration_time: '9999999999' }, { version: 1, success: false, code: 'private-code', message: 'private-failure' }, { ...token(), id_token: '' }, null]) { await writeFile(f.output, JSON.stringify(value)); const error = await f.create().chat([]).catch(error => error); expect(error.message).toBe('Vertex ADC authentication failed.'); }
  expect(await f.count()).toBe(8);
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(128 * 1024 + 1, 32)]) { await writeFile(f.output, bytes); await expect(f.create().chat([])).rejects.toThrow('Vertex ADC authentication failed.'); }
  await writeFile(f.file, JSON.stringify({ ...f.doc, credential_source: { executable: { ...f.doc.credential_source.executable, output_file: f.cache } } })); await writeFile(f.cache, 'not-json'); const executions = await f.count(); await expect(f.create().chat([])).rejects.toThrow('Vertex ADC authentication failed.'); expect(await f.count()).toBe(executions); expect(fetch).not.toHaveBeenCalled();
});
it('fences executable/file authority before spawn and after producer return before STS', async () => {
  const f = await fixture(), fetch = vi.spyOn(globalThis, 'fetch'); let changed = false;
  const make = (trigger: string) => new VertexGeminiProvider({ ...f.config, vertexAdc: { ...f.config.vertexAdc!, redactor: { add(value) { if (value === trigger && !changed) { changed = true; writeFileSync(f.file, '{}'); } } } } });
  await expect(make(f.command).chat([])).rejects.toThrow('Vertex ADC authentication failed.'); expect(await f.count()).toBe(0); await writeFile(f.file, JSON.stringify(f.doc)); changed = false;
  await expect(make('private-executable-subject').chat([])).rejects.toThrow('Vertex ADC authentication failed.'); expect(await f.count()).toBe(1); expect(fetch).not.toHaveBeenCalled();
  await writeFile(f.file, JSON.stringify(f.doc)); let armed = false;
  fetch.mockImplementation(async url => String(url) === sts ? minted() : reply(url));
  const cached = new VertexGeminiProvider({ ...f.config, vertexAdc: { ...f.config.vertexAdc!, redactor: { add(value) { if (armed && value === f.command) { armed = false; writeFileSync(f.file, '{}'); } } } } });
  await cached.chat([]); armed = true; await expect(cached.chat([])).rejects.toThrow('Vertex ADC authentication failed.'); expect(fetch).toHaveBeenCalledTimes(2);
});
it('passes validated external impersonation email to the helper and keeps STS/IAM/final token, quota and current-file checks separate', async () => {
  const f = await fixture(), url = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/synthetic@project.iam.gserviceaccount.com:generateAccessToken'; await writeFile(f.file, JSON.stringify({ ...f.doc, service_account_impersonation_url: url }));
  const calls: string[] = []; let withdraw = false; vi.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => { calls.push(String(target)); const headers = new Headers(init?.headers); if (String(target) === sts) { if (withdraw) await writeFile(f.file, '{}'); return minted(); } if (String(target) === url) { expect(headers.get('authorization')).toBe('Bearer private-executable-access'); return Response.json({ accessToken: 'private-executable-final', expireTime: new Date(Date.now() + 3600000).toISOString() }); } expect(headers.get('authorization')).toBe('Bearer private-executable-final'); return reply(target); });
  await f.create().chat([]); expect(JSON.parse(await readFile(f.environment, 'utf8')).GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL).toBe('synthetic@project.iam.gserviceaccount.com'); expect(calls).toHaveLength(3); expect(f.redactor.redact('private-executable-final')).toBe('[REDACTED]');
  withdraw = true; await expect(f.create().chat([])).rejects.toThrow('Vertex ADC authentication failed.'); expect(calls).toHaveLength(4);
});
it('cancels a hostile helper independently of another caller, preserves newest token cache and retires its parent lifetime', async () => {
  const f = await fixture(), caller = new AbortController(), owner = new AbortController(); let exchanges = 0;
  await writeFile(f.script, `import fs from 'node:fs';if(!fs.existsSync(${JSON.stringify(f.marker)})){fs.writeFileSync(${JSON.stringify(f.marker)},'x');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}else{fs.appendFileSync(${JSON.stringify(f.marker)},'x');process.stdout.write(fs.readFileSync(${JSON.stringify(f.output)}));}`);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => { if (String(url) === sts) { exchanges++; return minted(); } return reply(url); }); const provider = new VertexGeminiProvider({ ...f.config, vertexAdc: { ...f.config.vertexAdc!, signal: owner.signal } });
  const pending = provider.chat([], { signal: caller.signal }).then(() => 'unexpected-success', error => error.message); const limit = Date.now() + 2000; while (!await f.count()) { if (Date.now() > limit) throw new Error('Synthetic helper did not enter'); await new Promise(resolve => setTimeout(resolve, 10)); }
  try { expect((await provider.chat([])).usage?.totalTokens).toBe(10); } finally { caller.abort(); }
  expect(await pending).toBe('Vertex ADC authentication failed.'); await provider.chat([]); expect(exchanges).toBe(1); expect(await f.count()).toBe(2); owner.abort(); await expect(provider.chat([])).rejects.toThrow('Vertex ADC authentication failed.'); await new Promise(resolve => setTimeout(resolve, 600));
});
