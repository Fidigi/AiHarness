import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { start, stop } from '../index.js';
let root: string | undefined;
afterEach(async () => { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
async function fixture() {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-credential-recovery-')); const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), home = path.join(root, 'home');
  await Promise.all([mkdir(cwd), mkdir(dataDir), mkdir(home)]);
  const master = 'synthetic-recovery-master', file = path.join(dataDir, 'credentials.enc'), endpoint = 'https://synthetic-credential-recovery.test/token';
  for (const key of ['OPENAI_API_KEY', 'AI_HARNESS_OPENAI_API_KEY', 'AI_HARNESS_OPENAI_API_KEY_COMMAND', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ HOME: home, AI_HARNESS_MASTER_KEY: master, AI_HARNESS_AUTH_TOKEN: 'synthetic-recovery-user', AI_HARNESS_ADMIN_TOKEN: 'synthetic-recovery-admin', AI_HARNESS_OAUTH_OPENAI_TOKEN_URL: endpoint, AI_HARNESS_OAUTH_OPENAI_CLIENT_ID: 'synthetic-recovery-client' })) vi.stubEnv(key, value);
  const credentials = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
  await credentials.setOAuth('openai', { accessToken: 'synthetic-expired-access', refreshToken: 'synthetic-recovery-grant', expiresAt: 1 });
  const before = await readFile(file), transport = globalThis.fetch;
  return { cwd, dataDir, master, file, endpoint, before, transport, headers: { authorization: 'Bearer synthetic-recovery-admin' } };
}
it('keeps failed cold credential admission observable but allows a later explicit authorized request to recover without restart', async () => {
  const f = await fixture(); let online = false, calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return f.transport(url, init);
    expect(String(url)).toBe(f.endpoint); calls++;
    return online ? Response.json({ access_token: 'synthetic-recovered-access', expires_in: 3600, token_type: 'Bearer' })
      : new Response('synthetic-private-upstream-body synthetic-recovery-grant', { status: 503 });
  });
  const app = await start({ port: 0, host: '127.0.0.1', dataDir: f.dataDir, allowedRoots: [f.cwd], defaultCwd: f.cwd }), base = `http://127.0.0.1:${app.port}`;
  expect(calls).toBe(0);
  expect((await f.transport(base + '/api/provider-registry/auth')).status).toBe(401); expect(calls).toBe(0);
  const request = () => f.transport(base + '/api/provider-registry/auth', { headers: f.headers });
  const failed = await request(), failure = await failed.text(); expect(failed.status).toBe(500); expect(calls).toBe(1);
  expect(await readFile(f.file)).toEqual(f.before);
  for (const value of ['synthetic-private-upstream-body', 'synthetic-recovery-grant', 'synthetic-expired-access', f.endpoint, f.file]) expect(failure).not.toContain(value);
  online = true;
  const recovered = await request(); expect(recovered.status).toBe(200);
  expect(await recovered.json()).toContainEqual(expect.objectContaining({ type: 'openai', configured: true })); expect(calls).toBe(2);
  expect((await request()).status).toBe(200); expect(calls).toBe(2);
  const fresh = new ProviderCredentialService({ store: new EncryptedCredentialStore(f.file, f.master) }); await fresh.load();
  expect((await fresh.resolve('openai', { env: {}, allowRefresh: false }))?.credential).toMatchObject({ type: 'oauth', accessToken: 'synthetic-recovered-access', refreshToken: 'synthetic-recovery-grant' });
  expect(await readFile(f.file)).not.toEqual(f.before);
}, 15000);
it('retires a held cold refresh with the host and refuses its late encrypted publication', async () => {
  const f = await fixture(); let reached!: () => void, release!: (response: Response) => void, issuerSignal: AbortSignal | null | undefined, calls = 0;
  const entered = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<Response>(resolve => { release = resolve; });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return f.transport(url, init);
    expect(String(url)).toBe(f.endpoint); calls++; issuerSignal = init?.signal; reached(); return held;
  });
  const app = await start({ port: 0, host: '127.0.0.1', dataDir: f.dataDir, allowedRoots: [f.cwd], defaultCwd: f.cwd });
  const pending = f.transport(`http://127.0.0.1:${app.port}/api/provider-registry/auth`, { headers: f.headers }).then(response => response.text(), () => 'closed transport');
  await entered;
  const stopping = stop();
  try { expect(issuerSignal?.aborted).toBe(true); }
  finally { release(Response.json({ access_token: 'synthetic-must-not-publish', expires_in: 3600 })); await stopping; await pending; }
  expect(calls).toBe(1); expect(await readFile(f.file)).toEqual(f.before);
  const fresh = new ProviderCredentialService({ store: new EncryptedCredentialStore(f.file, f.master) }); await fresh.load();
  expect(await fresh.resolve('openai', { env: {}, allowRefresh: false })).toBeUndefined();
  expect(fresh.list()).toContainEqual(expect.objectContaining({ provider: 'openai', type: 'oauth', expiresAt: 1 }));
}, 15000);
