import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { createLocalTLSFixture } from './fixtures/oauth-local-tls.mjs';
const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const master = 'synthetic-kimi-native-cli-master', initial = 'synthetic-kimi-initial', rotated = 'synthetic-kimi-rotated';
it.each(['print', 'json', 'rpc'] as const)('uses native Kimi OAuth in %s with encrypted refresh/private restart/offline resolution and logout', async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-kimi-native-cli-')), cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
  const calls: Array<{ url?: string; body?: Record<string, any> }> = []; let failure: unknown, turns = 0, endpoint = '';
  const server = createServer(await createLocalTLSFixture(root), async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) { text += chunk; expect(Buffer.byteLength(text)).toBeLessThan(2000000); }
      const form = req.url?.startsWith('/api/oauth/') ? Object.fromEntries(new URLSearchParams(text)) : undefined, body = text && !form ? JSON.parse(text) : undefined;
      calls.push({ url: req.url, body }); res.setHeader('content-type', 'application/json');
      if (req.url === '/api/oauth/device_authorization') {
        expect(form).toEqual({ client_id: '17e5f671-d194-4dfb-9706-5516cb48c098' }); expect(req.headers.authorization).toBeUndefined();
        res.end(JSON.stringify({ device_code: 'synthetic-private-kimi-device', user_code: 'VISIBLE-CODE', verification_uri: endpoint + '/verify', verification_uri_complete: endpoint + '/verify?code=VISIBLE-CODE', expires_in: 600, interval: 0.01 })); return;
      }
      if (req.url === '/api/oauth/token') {
        expect(form?.client_id).toBe('17e5f671-d194-4dfb-9706-5516cb48c098'); expect(req.headers.authorization).toBeUndefined();
        expect(form).toEqual(form?.grant_type === 'refresh_token' ? { client_id: '17e5f671-d194-4dfb-9706-5516cb48c098', grant_type: 'refresh_token', refresh_token: 'synthetic-private-kimi-refresh' }
          : { client_id: '17e5f671-d194-4dfb-9706-5516cb48c098', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'synthetic-private-kimi-device' });
        res.end(JSON.stringify({ access_token: form?.grant_type === 'refresh_token' ? rotated : initial, refresh_token: 'synthetic-private-kimi-refresh', expires_in: 3600 })); return;
      }
      expect(req.url).toBe('/coding/v1/messages'); expect(req.headers.authorization).toBe(`Bearer ${turns === 0 ? initial : rotated}`); expect(req.headers['x-api-key']).toBeUndefined(); expect(body.model).toBe('k3');
      const assistants = body.messages.filter((message: Record<string, any>) => message.role === 'assistant'); expect(assistants).toHaveLength(turns);
      for (let index = 0; index < turns; index++) expect(assistants[index].content).toContainEqual({ type: 'thinking', thinking: 'thought', signature: `native-kimi-signature-${index + 1}` });
      expect(JSON.stringify(body)).not.toContain('ai-harness:kimi-oauth'); turns++; res.setHeader('content-type', 'text/event-stream');
      res.end([{ type: 'message_start', message: { id: 'native', type: 'message', role: 'assistant', model: 'k3', content: [], usage: { input_tokens: 8, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thought' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `native-kimi-signature-${turns}` } }, { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'kimi-native-cli-ok' } }, { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { failure = error; res.statusCode = 500; res.end('Invalid native Kimi fixture'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const launch = (args: string[], input = '', login = false) => new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_MASTER_KEY: master, NODE_EXTRA_CA_CERTS: path.join(root, 'cert.pem'), KIMI_CODING_BASE_URL: endpoint + '/coding', ...(login ? { KIMI_CODE_OAUTH_HOST: endpoint } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', text => { stdout += String(text); }); child.stderr.on('data', text => { stderr += String(text); }); child.stdin.end(input);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native Kimi CLI child hung')); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  try {
    const login = await launch(['auth', 'login', 'kimi-coding', '--issuer', 'kimi-coding', '--timeout', '5'], '', true); expect(login).toMatchObject({ code: 0, signal: null, stdout: 'Provider credentials encrypted and saved.\n' }); expect(login.stderr).toContain('User code: VISIBLE-CODE');
    const service = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(agent, 'credentials.enc'), master) }); await service.load();
    expect(await service.resolve('kimi-coding', { env: {} })).toBeUndefined(); const first = (await service.resolve('kimi-coding', { env: {}, subscriptionProvider: 'kimi-coding' }))!.credential; expect(first).toMatchObject({ type: 'oauth', accessToken: initial, subscription: { provider: 'kimi-coding', oauthHost: endpoint } });
    const run = (offline = false) => launch(['--approve', '--no-extensions', '--no-context-files', ...(offline ? ['--offline'] : []), '--session-dir', sessions, '--session-id', 'native-kimi', '--model', 'kimi-coding/k3', '--thinking', 'off', ...(mode === 'print' ? ['--print', 'probe'] : ['--mode', mode, ...(mode === 'rpc' ? [] : ['probe'])])], mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'probe' }) + '\n' : '');
    const one = await run(); expect(one, one.stderr).toMatchObject({ code: 0, signal: null }); expect(one.stdout).toContain('kimi-native-cli-ok');
    if (first.type !== 'oauth') throw new Error('Expected synthetic OAuth'); await service.setOAuth('kimi-coding', { ...first, expiresAt: 1 });
    const two = await run(); expect(two, two.stderr).toMatchObject({ code: 0, signal: null }); expect(two.stdout).toContain('kimi-native-cli-ok'); const three = await run(true); expect(three, three.stderr).toMatchObject({ code: 0, signal: null }); expect(three.stdout).toContain('kimi-native-cli-ok');
    expect(calls.map(call => call.url)).toEqual(['/api/oauth/device_authorization', '/api/oauth/token', '/coding/v1/messages', '/api/oauth/token', '/coding/v1/messages', '/coding/v1/messages']);
    await service.load(); expect((await service.resolve('kimi-coding', { env: {}, subscriptionProvider: 'kimi-coding' }))?.credential).toMatchObject({ accessToken: rotated, subscription: first.subscription });
    const journal = await readFile(path.join(sessions, 'native-kimi.jsonl'), 'utf8'), assistants = journal.trim().split('\n').map(line => JSON.parse(line)).filter(message => message.role === 'assistant'); expect(assistants).toHaveLength(3);
    for (const message of assistants) expect(message).toMatchObject({ provider: 'kimi-coding', model: 'k3', api: 'anthropic-messages', usage: { totalTokens: 10, costUsd: 0.000054 } }); expect((await stat(path.join(agent, 'credentials.enc'))).mode & 0o777).toBe(0o600);
    const outputs = login.stdout + login.stderr + one.stdout + one.stderr + two.stdout + two.stderr + three.stdout + three.stderr; expect(outputs).not.toContain('native-kimi-signature-');
    for (const secret of [initial, rotated, 'synthetic-private-kimi-refresh', 'synthetic-private-kimi-device']) expect(outputs + journal + await readFile(path.join(agent, 'credentials.enc'), 'utf8')).not.toContain(secret);
    expect((await launch(['auth', 'logout', 'kimi-coding'])).code).toBe(0); const refused = await launch(['--approve', '--no-extensions', '--no-context-files', '--model', 'kimi-coding/k3', '--print', 'refused']); expect(refused.code).not.toBe(0); expect(calls).toHaveLength(6); expect(failure).toBeUndefined();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30000);
