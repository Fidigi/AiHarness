import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const master = 'synthetic-radius-oauth-cli-master-key', initial = 'synthetic-radius-initial', rotated = 'synthetic-radius-rotated';
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-native-cli-')), cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
  const calls: Array<{ url?: string; auth?: string; form?: Record<string, string>; body?: Record<string, any> }> = []; let failure: unknown, count = 0, authorizationUrl: URL | undefined;
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) { text += chunk; expect(Buffer.byteLength(text)).toBeLessThan(2000000); }
      const form = req.url === '/v1/oauth/token' || req.url === '/v1/oauth/device' ? Object.fromEntries(new URLSearchParams(text)) : undefined;
      const body = text && !form ? JSON.parse(text) : undefined; calls.push({ url: req.url, auth: req.headers.authorization, form, body });
      const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/oauth') { res.end(JSON.stringify({ authorizationEndpoint: gateway + '/authorize' })); return; }
      if (req.url === '/v1/oauth/device') {
        expect(req.method).toBe('POST'); expect(req.headers.authorization).toBeUndefined(); expect(form).toEqual({ client_id: 'pi-gateway', scope: 'gateway offline_access' });
        res.end(JSON.stringify({ device_code: 'synthetic-private-device', user_code: 'VISIBLE-CODE', verification_uri: gateway + '/verify', expires_in: 600, interval: 1 })); return;
      }
      if (req.url === '/v1/oauth/token') {
        expect(form?.client_id).toBe('pi-gateway'); expect(req.headers.authorization).toBeUndefined();
        if (form?.grant_type === 'refresh_token') expect(form.refresh_token).toBe('synthetic-private-refresh');
        else if (form?.grant_type === 'authorization_code') {
          expect(form.redirect_uri).toBe('http://127.0.0.1:1456/oauth/callback'); expect(form.code).toBe('synthetic-private-code');
          expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(authorizationUrl?.searchParams.get('code_challenge'));
        } else expect(form).toEqual({ client_id: 'pi-gateway', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'synthetic-private-device' });
        res.end(JSON.stringify({ access_token: form?.grant_type === 'refresh_token' ? rotated : initial, refresh_token: 'synthetic-private-refresh', expires_in: 3600 })); return;
      }
      expect(req.headers.authorization).toBe(`Bearer ${count === 0 ? initial : rotated}`);
      if (req.url === '/v1/config') {
        res.end(JSON.stringify({ baseUrl: gateway + '/p/v1', models: [{ id: 'account-only', name: 'Native OAuth', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 131072, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] })); return;
      }
      expect(req.url).toBe('/p/v1/messages'); expect(body?.model).toBe('account-only');
      const old = body!.context.messages.filter((message: { role: string }) => message.role === 'assistant'); expect(old).toHaveLength(count);
      for (let index = 0; index < count; index++) expect(old[index].content).toEqual([{ type: 'thinking', thinking: 'thought', thinkingSignature: `native-thinking-${index + 1}` }, { type: 'text', text: 'radius-oauth-ok', textSignature: `native-text-${index + 1}` }]);
      count++; res.setHeader('content-type', 'text/event-stream');
      res.end([{ type: 'start' }, { type: 'thinking_start', contentIndex: 0 }, { type: 'thinking_delta', contentIndex: 0, delta: 'thought' }, { type: 'thinking_end', contentIndex: 0, content: 'thought', contentSignature: `native-thinking-${count}` },
        { type: 'text_start', contentIndex: 1 }, { type: 'text_delta', contentIndex: 1, delta: 'radius-oauth-ok' }, { type: 'text_end', contentIndex: 1, content: 'radius-oauth-ok', contentSignature: `native-text-${count}` },
        { type: 'done', reason: 'stop', usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { failure = error; res.statusCode = 500; res.end('Invalid native Radius fixture'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const launch = (args: string[], input = '', login = false) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_MASTER_KEY: master, ...(login ? { RADIUS_GATEWAY: gateway } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', text => { stdout += String(text); }); child.stderr.on('data', text => { stderr += String(text); }); child.stdin.end(input);
    const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native Radius CLI child hung')); }, 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    }); return { child, done, stderr: () => stderr };
  };
  const credentials = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(agent, 'credentials.enc'), master) });
  return { root, cwd, agent, sessions, calls, credentials, launch, failure: () => failure, authorize: (url: URL) => { authorizationUrl = url; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
it.each(['print', 'json', 'rpc'] as const)('uses native Radius OAuth through %s with fresh-process refresh/private replay/offline cache/logout', async mode => {
  const f = await fixture();
  try {
    const login = await f.launch(['auth', 'login', 'radius', '--issuer', 'radius', '--timeout', '5'], '', true).done;
    expect(login).toMatchObject({ code: 0, signal: null, stdout: 'Provider credentials encrypted and saved.\n' }); expect(login.stderr).toContain('User code: VISIBLE-CODE');
    const service = f.credentials(); await service.load(); const first = (await service.resolve('radius', { env: {}, subscriptionProvider: 'radius' }))!.credential;
    expect(first).toMatchObject({ type: 'oauth', accessToken: initial, subscription: { provider: 'radius' } }); expect(await service.resolve('radius', { env: {} })).toBeUndefined();
    const run = (offline = false) => f.launch(['--approve', '--no-extensions', '--no-context-files', ...(offline ? ['--offline'] : []), '--session-dir', f.sessions, '--session-id', 'native-radius', '--model', 'radius/account-only', '--thinking', 'off',
      ...(mode === 'print' ? ['--print', 'probe'] : ['--mode', mode, ...(mode === 'rpc' ? [] : ['probe'])])], mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'probe' }) + '\n' : '').done;
    const one = await run(); expect(one, one.stderr).toMatchObject({ code: 0, signal: null }); expect(one.stdout).toContain('radius-oauth-ok');
    if (first.type !== 'oauth') throw new Error('Expected synthetic OAuth'); await service.setOAuth('radius', { ...first, expiresAt: 1 });
    const two = await run(); expect(two, two.stderr).toMatchObject({ code: 0, signal: null }); expect(two.stdout).toContain('radius-oauth-ok');
    const three = await run(true); expect(three, three.stderr).toMatchObject({ code: 0, signal: null }); expect(three.stdout).toContain('radius-oauth-ok');
    expect(f.calls.map(call => call.url)).toEqual(['/v1/oauth/device', '/v1/oauth/token', '/v1/config', '/p/v1/messages', '/v1/oauth/token', '/v1/config', '/p/v1/messages', '/p/v1/messages']);
    await service.load(); const fresh = (await service.resolve('radius', { env: {}, subscriptionProvider: 'radius' }))!.credential; expect(fresh).toMatchObject({ accessToken: rotated, subscription: first.subscription });
    const journal = await readFile(path.join(f.sessions, 'native-radius.jsonl'), 'utf8');
    const assistants = journal.trim().split('\n').map(line => JSON.parse(line)).filter(message => message.role === 'assistant'); expect(assistants).toHaveLength(3);
    for (const message of assistants) expect(message).toMatchObject({ provider: 'radius', model: 'account-only', api: 'pi-messages', usage: { totalTokens: 10, costUsd: 0.001 } });
    const cache = path.join(f.agent, 'radius-models'); expect(await readdir(cache)).toHaveLength(1); expect((await stat(path.join(f.agent, 'credentials.enc'))).mode & 0o777).toBe(0o600);
    const outputs = login.stdout + login.stderr + one.stdout + one.stderr + two.stdout + two.stderr + three.stdout + three.stderr;
    expect(outputs).not.toContain('native-thinking-'); expect(outputs).not.toContain('native-text-');
    for (const secret of [initial, rotated, 'synthetic-private-refresh', 'synthetic-private-device']) expect(outputs + journal + await readFile(path.join(f.agent, 'credentials.enc'), 'utf8')).not.toContain(secret);
    expect((await f.launch(['auth', 'logout', 'radius']).done).code).toBe(0);
    const rejected = await f.launch(['--approve', '--no-extensions', '--no-context-files', '--model', 'radius/account-only', '--print', 'refused']).done;
    expect(rejected.code).not.toBe(0); expect(f.calls).toHaveLength(8); expect(f.failure()).toBeUndefined();
  } finally { await f.close(); }
}, 30000);

it.each(['success', 'cancel', 'occupied'] as const)('owns the fixed native Radius browser callback during %s', async mode => {
  const f = await fixture(), occupied = mode === 'occupied' ? createServer((_req, res) => res.end()) : undefined;
  try {
    if (occupied) await new Promise<void>(resolve => occupied.listen(1456, '127.0.0.1', resolve));
    const process = f.launch(['auth', 'login', 'radius', '--issuer', 'radius', '--method', 'browser', '--timeout', '5'], '', true);
    if (mode === 'occupied') { expect(await process.done).toMatchObject({ code: 1, signal: null, stdout: '' }); expect(f.calls.map(call => call.url)).toEqual(['/v1/oauth']); return; }
    const deadline = Date.now() + 5000;
    while (!process.stderr().includes('Authorize at ') && Date.now() < deadline) await Promise.race([process.done.then(result => { throw new Error(`Browser exited ${result.code}: ${result.stderr}`); }), new Promise(resolve => setTimeout(resolve, 10))]);
    const url = new URL(process.stderr().trim().split('Authorize at ')[1]!); f.authorize(url);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1456/oauth/callback');
    const callback = (state: string) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:1456/oauth/callback?state=${encodeURIComponent(state)}&code=synthetic-private-code`, res => { let body = ''; res.on('data', text => { body += String(text); }); res.once('end', () => resolve({ status: res.statusCode, body })); }); req.once('error', reject); req.end();
    });
    expect((await callback('wrong-state')).status).toBe(400); expect(f.calls).toHaveLength(1);
    if (mode === 'cancel') process.child.kill('SIGINT'); else expect((await callback(url.searchParams.get('state')!)).status).toBe(200);
    const result = await process.done; expect(result).toMatchObject({ code: mode === 'cancel' ? 130 : 0, signal: null });
    expect(f.calls.map(call => call.url)).toEqual(mode === 'cancel' ? ['/v1/oauth'] : ['/v1/oauth', '/v1/oauth/token']);
    const service = f.credentials(); await service.load(); expect(Boolean(await service.resolve('radius', { env: {}, subscriptionProvider: 'radius' }))).toBe(mode === 'success');
    expect(result.stdout + result.stderr).not.toContain('synthetic-private-code'); expect(f.failure()).toBeUndefined();
  } finally { if (occupied) { occupied.closeAllConnections(); await new Promise<void>(resolve => occupied.close(() => resolve())); } await f.close(); }
}, 15000);
