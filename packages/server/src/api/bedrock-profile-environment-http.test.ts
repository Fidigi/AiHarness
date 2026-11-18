import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { getProxy, start, stop } from '../index.js';
import { syntheticStsRole, syntheticStsSecret, syntheticStsSession, syntheticAssumeRoleXml } from '../../../../tests/fixtures/sts-web-identity.js';
import { bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';
let root: string | undefined;
afterEach(async () => { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
it('uses a trusted explicit Environment-role source through real HTTP, preserving passive metadata, final-key cache/usage and shutdown ownership', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-env-role-http-')); const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), configFile = path.join(root, 'profile'), home = path.join(root, 'home'); await Promise.all([mkdir(cwd), mkdir(home)]);
  const model = 'anthropic.claude-opus-4-6-v1', endpoint = 'https://synthetic-env-role-http.test/prefix', sts = 'https://sts.eu-west-1.amazonaws.com/';
  for (const key of ['AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_CREDENTIAL_EXPIRATION', 'AWS_CREDENTIAL_SCOPE', 'AWS_DEFAULT_REGION', 'AI_HARNESS_BEDROCK_API_KEY_COMMAND']) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ HOME: home, AWS_ACCESS_KEY_ID: 'HTTPENVSOURCE', AWS_SECRET_ACCESS_KEY: 'HttpEnvSecret', AWS_SESSION_TOKEN: 'HttpEnvSession', AWS_REGION: 'us-west-2', AI_HARNESS_MASTER_KEY: 'synthetic-env-role-http-master', AI_HARNESS_AUTH_TOKEN: 'env-role-user', AI_HARNESS_ADMIN_TOKEN: 'env-role-admin' })) vi.stubEnv(key, value);
  await writeFile(configFile, Buffer.from([0xff])); const transport = globalThis.fetch; let tokens = 0, calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return transport(url, init);
    const auth = new Headers(init?.headers).get('authorization');
    if (String(url) === sts) { tokens++; expect(auth).toContain('Credential=HTTPENVSOURCE/'); expect(auth).toContain('/eu-west-1/sts/'); return new Response(syntheticAssumeRoleXml('HTTPENVROLE')); }
    expect(String(url)).toBe(endpoint + '/model/' + encodeURIComponent(model) + '/converse-stream'); expect(auth).toContain('Credential=HTTPENVROLE/'); expect(auth).toContain('/us-west-2/bedrock/'); calls++;
    return new Response(bedrockText(`env-http-ready HTTPENVSOURCE HttpEnvSecret HttpEnvSession HTTPENVROLE ${syntheticStsSecret} ${syntheticStsSession}`, 'end_turn', { inputTokens: 8, outputTokens: 2, totalTokens: 10 }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
  });
  const app = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd }), base = `http://127.0.0.1:${app.port}`;
  const request = (route: string, body?: unknown, method = 'POST') => transport(base + route, { method, headers: { authorization: 'Bearer env-role-admin', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect((await request('/api/provider-registry/auth', undefined, 'GET')).status).toBe(200);
  getProxy().setBedrockProfile({ type: 'bedrock', model, baseUrl: endpoint, region: 'us-west-2', bedrockProfile: { profile: 'chosen', configFile } });
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'LATERMUSTNOTRETARGET');
  const statuses = await request('/api/provider-registry/auth', undefined, 'GET').then(response => response.json()); expect(statuses).toContainEqual(expect.objectContaining({ type: 'bedrock', environmentVariable: 'AWS_PROFILE', disconnectSupported: false })); expect(tokens).toBe(0); expect(calls).toBe(0);
  await writeFile(configFile, `[profile chosen]\nrole_arn=${syntheticStsRole}\ncredential_source=Environment\nrole_session_name=synthetic-http-env-role\nregion=eu-west-1\n`);
  await request('/api/workspaces/trust', { cwd, confirm: true }); await request('/api/tools', { enabledTools: [], toolPreset: 'chat-only', powershellEnabled: false, codemodeEnabled: false }, 'PATCH');
  let sessionId: string | undefined;
  for (let i = 0; i < 2; i++) { const response = await request('/api/agent/runs', { cwd, provider: 'bedrock', model, input: 'environment role probe', thinking: 'off', autoCompaction: false, ...(sessionId ? { sessionId } : {}) }); expect(response.status).toBe(202); const { run } = await response.json() as { run: { id: string; sessionId: string } }; sessionId = run.sessionId; await vi.waitFor(async () => expect(await request('/api/agent/runs/' + run.id, undefined, 'GET').then(result => result.json())).toMatchObject({ phase: 'completed' }), { timeout: 5000 }); }
  expect(tokens).toBe(1); expect(calls).toBe(2); const state = await request('/api/agent/sessions/' + sessionId + '/state', undefined, 'GET').then(response => response.json()); expect(state).toMatchObject({ session: { usage: { totalTokens: 20 } } });
  const journal = await readFile(path.join(dataDir, 'sessions', sessionId + '.jsonl'), 'utf8');
  for (const secret of ['HTTPENVSOURCE', 'HttpEnvSecret', 'HttpEnvSession', 'HTTPENVROLE', syntheticStsSecret, syntheticStsSession, configFile]) expect(JSON.stringify(state) + JSON.stringify(statuses) + journal).not.toContain(secret);
  const retired = getProxy().getAgentProvider('bedrock')!; await stop(); await expect(retired.chat([])).rejects.toThrow(/closed|Bedrock profile/u); expect(tokens).toBe(1); expect(calls).toBe(2);
}, 20000);
