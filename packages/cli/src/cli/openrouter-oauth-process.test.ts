import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { createLocalTLSFixture } from './fixtures/oauth-local-tls.mjs';
const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url)), key = 'synthetic-native-router-key', master = 'synthetic-native-router-master';
it.each(['print', 'json', 'rpc'] as const)('uses OpenRouter PKCE permanent keys in %s across process restart and logout', async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-oauth-cli-')), cwd = root + '/work', agent = root + '/agent', sessions = root + '/sessions'; await mkdir(cwd); await mkdir(agent); await writeFile(agent + '/settings.json', JSON.stringify({ cacheWarming: 'off' }));
  let endpoint = '', failure: unknown, challenge = '', turns = 0; const calls: string[] = [];
  const server = createServer(await createLocalTLSFixture(root), async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(Buffer.byteLength(text)).toBeLessThan(2000000); } const body = JSON.parse(text); calls.push(request.url!);
      if (request.url === '/api/v1/auth/keys') {
        expect(request.headers.authorization).toBeUndefined(); expect(body).toMatchObject({ code: 'synthetic-router-code', code_challenge_method: 'S256' }); expect(Object.keys(body).sort()).toEqual(['code', 'code_challenge_method', 'code_verifier']);
        expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ key })); return;
      }
      expect(request.url).toBe('/inference/v1/chat/completions'); expect(request.headers.authorization).toBe(`Bearer ${key}`); expect(body.model).toBe('openai/gpt-4o'); expect(body.messages.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(turns); turns++;
      response.setHeader('content-type', 'text/event-stream'); response.end('data: ' + JSON.stringify({ id: 'synthetic-router', choices: [{ delta: { content: 'router-native-cli-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { failure = error; response.statusCode = 500; response.end('Invalid synthetic OpenRouter fixture'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Test-only transport mapping: production issuer remains fixed, with verified loopback TLS and no live fallback.
  const preload = root + '/transport.mjs'; await writeFile(preload, `const transport=globalThis.fetch; globalThis.fetch=(input,init)=>{ const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url); if(url.href==='https://openrouter.ai/api/v1/auth/keys')return transport(process.env.SYNTHETIC_ROUTER_ENDPOINT+'/api/v1/auth/keys',init); if(url.origin===process.env.SYNTHETIC_ROUTER_ENDPOINT)return transport(input,init); throw new Error('Outside synthetic OpenRouter transport'); };`);
  const launch = (args: string[], input = '', login = false) => new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, cli, ...args], { cwd, env: { PATH: process.env.PATH, HOME: root + '/home', TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_MASTER_KEY: master, NODE_EXTRA_CA_CERTS: root + '/cert.pem', SYNTHETIC_ROUTER_ENDPOINT: endpoint, OPENROUTER_BASE_URL: endpoint + '/inference' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', callback: Promise<void> | undefined; child.stdout.on('data', text => { stdout += String(text); }); child.stderr.on('data', text => {
      stderr += String(text); const match = stderr.match(/Authorize at (https:\/\/openrouter\.ai\/auth\?[^\s]+)/u); if (!login || !match || callback) return;
      callback = (async () => { const authorization = new URL(match[1]!), target = new URL(authorization.searchParams.get('callback_url')!); challenge = authorization.searchParams.get('code_challenge')!; expect(authorization.searchParams.has('state')).toBe(false);
        const wrong = new URL(target); wrong.pathname += '-wrong'; wrong.searchParams.set('code', 'synthetic-router-code'); expect((await fetch(wrong)).status).toBe(400);
        target.searchParams.set('code', 'synthetic-router-code');
        const foreign = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(target, { headers: { Host: 'foreign.test' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); request.once('error', reject); request.end(); });
        expect(foreign).toBe(400); expect((await fetch(target + '&code=duplicate')).status).toBe(400); expect((await fetch(target)).status).toBe(200);
      })(); void callback.catch(error => { failure = error; child.kill('SIGTERM'); });
    }); child.stdin.end(input);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native OpenRouter CLI child hung')); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); void Promise.resolve(callback).then(() => resolve({ code, signal, stdout, stderr }), reject); });
  });
  try {
    const login = await launch(['auth', 'login', 'openrouter', '--issuer', 'openrouter', ...(mode === 'print' ? ['--method', 'browser'] : []), '--timeout', '5'], '', true); expect(login, login.stderr).toMatchObject({ code: 0, signal: null, stdout: 'Provider credentials encrypted and saved.\n' });
    const credentials = new ProviderCredentialService({ store: new EncryptedCredentialStore(agent + '/credentials.enc', master) }); await credentials.load(); expect((await credentials.resolve('openrouter', { env: {} }))?.credential).toEqual({ version: 1, type: 'api-key', apiKey: key }); expect(credentials.list()).toMatchObject([{ refreshable: false }]);
    const run = () => launch(['--approve', '--no-extensions', '--no-context-files', '--session-dir', sessions, '--session-id', 'native-router', '--model', 'openrouter/openai/gpt-4o', ...(mode === 'print' ? ['--print', 'probe'] : ['--mode', mode, ...(mode === 'rpc' ? [] : ['probe'])])], mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'probe' }) + '\n' : '');
    const first = await run(), second = await run(); for (const result of [first, second]) { expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('router-native-cli-ok'); }
    expect(calls).toEqual(['/api/v1/auth/keys', '/inference/v1/chat/completions', '/inference/v1/chat/completions']);
    const journal = await readFile(sessions + '/native-router.jsonl', 'utf8'), assistants = journal.trim().split('\n').map(line => JSON.parse(line)).filter(message => message.role === 'assistant'); expect(assistants).toHaveLength(2); for (const message of assistants) expect(message).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-4o', api: 'openai-completions', usage: { totalTokens: 10, costUsd: 0.00004 } }); expect((await stat(agent + '/credentials.enc')).mode & 0o777).toBe(0o600);
    for (const secret of [key, 'synthetic-router-code']) expect(login.stdout + login.stderr + first.stdout + first.stderr + second.stdout + second.stderr + journal + await readFile(agent + '/credentials.enc', 'utf8')).not.toContain(secret);
    expect((await launch(['auth', 'logout', 'openrouter'])).code).toBe(0); const refused = await launch(['--approve', '--no-extensions', '--no-context-files', '--model', 'openrouter/openai/gpt-4o', '--print', 'refused']); expect(refused.code).not.toBe(0); expect(calls).toHaveLength(3); expect(failure).toBeUndefined();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30000);
