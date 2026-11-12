import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { createLocalTLSFixture } from './oauth-local-tls.mjs';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
const { spawn } = await import(process.env.AIH_TEST_PTY_MODULE ?? 'node-pty');
const mode = process.argv[2]; assert(['regular', 'fullscreen', 'print', 'json', 'rpc'].includes(mode));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-copilot-terminal-'));
const cwd = root + '/work', agent = root + '/agent', sessions = root + '/sessions', trace = root + '/transport.jsonl';
const master = 'disposable-copilot-terminal-master', grant = 'private-terminal-github-grant', token = 'private-terminal-inference';
const reference = JSON.parse(await readFile(process.env.AIH_COPILOT_RESPONSE_FILE ?? new URL('../../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8'));
const events = Array.isArray(reference) ? reference : reference.rows.find(row => row.model === 'gpt-5-mini' && row.case === 'user').responseEvents;
let terminal, child, exit, output = '', privacyTail = '', wire, held, hold = true, fixtureError;
const calls = [];
const secrets = [token, grant, 'private-terminal-device'];
const overlap = Math.max(...secrets.map(secret => secret.length)) - 1;
const wait = async (predicate, label) => {
  const end = performance.now() + 5000;
  while (!await predicate()) {
    assert(performance.now() < end, label + ': ' + JSON.stringify({ exit, output: output.slice(-8192),
      calls: calls.map(({ url, method, path }) => ({ url, method, path })), fixtureError: fixtureError?.name,
      transport: await readFile(trace, 'utf8').catch(() => '') }));
    await pause(10);
  }
};
const shown = () => (mode === 'fullscreen' ? output.slice(Math.max(0, output.lastIndexOf('\x1b[2J\x1b[H'))) : output).replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '');
const ready = () => shown().includes('editor ready · Enter send') && /copilot-terminal:\s*$/u.test(shown());
const command = async (text, expected) => {
  output = ''; terminal.write(text + '\r');
  await wait(() => (expected === 'ok' ? /\bok\b/u.test(shown()) : shown().includes(expected)) && ready(), text);
};
const reader = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(agent + '/credentials.enc', master) });
const absent = async () => {
  const credentials = reader(); await credentials.load();
  assert.equal(await credentials.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' }), undefined);
};
try {
  await mkdir(cwd); await mkdir(agent);
  await writeFile(agent + '/settings.json', JSON.stringify({ cacheWarming: 'off' }));
  wire = createServer(await createLocalTLSFixture(root), async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) { body += chunk; assert(body.length < 2000000); }
      calls.push({ url: request.headers['x-fixture-original-url'], path: request.url, method: request.method, authorization: request.headers.authorization, apiKey: request.headers['x-api-key'], body });
      if (request.url === '/responses') {
        assert.equal(request.headers.authorization, `Bearer ${token}`); assert.equal(request.headers['x-api-key'], undefined);
        assert.equal(JSON.parse(body).model, 'gpt-5-mini');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); return;
      }
      const value = request.url === '/login/device/code' ? { device_code: 'private-terminal-device', user_code: 'TERMINAL-CODE', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 0.01 }
        : request.url === '/login/oauth/access_token' ? { access_token: grant }
        : request.url === '/copilot_internal/v2/token' ? { token, expires_at: Math.floor(Date.now() / 1000) + 3600 }
        : request.url === '/models' ? { data: [{ id: 'gpt-5-mini', model_picker_enabled: true }] } : undefined;
      assert(value, 'Unexpected fixture target');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/models' && hold) { held = response; return; }
      response.end(JSON.stringify(value));
    } catch (error) { fixtureError = error; response.writeHead(500).end(); }
  });
  await new Promise(resolve => wire.listen(0, '127.0.0.1', resolve));
  const endpoint = `https://127.0.0.1:${wire.address().port}`;
  const preload = root + '/routing.mjs';
  await writeFile(preload, `import {appendFileSync} from 'node:fs';
  const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const target = new URL(String(input));
    if (target.hostname === 'localhost' && target.port === '11434') return Promise.resolve(Response.json({data:[]}));
    if (!['github.com','api.github.com','api.individual.githubcopilot.com'].includes(target.hostname)) throw new Error('Unexpected fixture host');
    const headers = new Headers(init?.headers); headers.set('x-fixture-original-url', target.href);
    return original(new URL(target.pathname + target.search, ${JSON.stringify(endpoint)}), {...init, headers}).then(response => {
      appendFileSync(${JSON.stringify(trace)},JSON.stringify({url:target.href,status:response.status,now:Date.now()})+'\\n'); return response;
    }).catch(error => {
      appendFileSync(${JSON.stringify(trace)},JSON.stringify({url:target.href,name:error.name,code:error.cause?.code})+'\\n'); throw error;
    });
  };`);
  const bin = process.env.AIH_COPILOT_COMMAND;
  const entry = bin ? [] : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url))];
  const env = { PATH: process.env.PATH, HOME: root + '/home', TERM: 'xterm-256color', NO_COLOR: '1',
    AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_MASTER_KEY: master, NODE_EXTRA_CA_CERTS: root + '/cert.pem', NODE_OPTIONS: '--import=' + preload };
  if (['print', 'json', 'rpc'].includes(mode)) {
    hold = false;
    const run = (args, input = '') => new Promise((resolve, reject) => {
      const current = spawnChild(bin ?? process.execPath, [...entry, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child = current;
      let stdout = '', stderr = '';
      const timer = setTimeout(() => current.kill('SIGKILL'), 15000);
      current.stdout.on('data', text => { stdout += String(text); assert(stdout.length < 1000000); });
      current.stderr.on('data', text => { stderr += String(text); assert(stderr.length < 1000000); });
      current.once('error', error => { clearTimeout(timer); child = undefined; reject(error); });
      current.once('close', (code, signal) => { clearTimeout(timer); child = undefined; resolve({ code, signal, stdout, stderr }); });
      current.stdin.end(input);
    });
    const login = await run(['auth', 'login', 'github-copilot', '--issuer', 'github-copilot']);
    assert.equal(login.code, 0, JSON.stringify(login)); assert.equal(login.signal, null);
    const args = ['--approve', '--no-extensions', '--no-context-files', '--no-tools', '--provider', 'github-copilot', '--model', 'gpt-5-mini',
      '--thinking', 'off', '--session-dir', sessions, '--session-id', 'copilot-terminal', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['probe'])];
    const input = mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'copilot', message: 'probe' }) + '\n' : '';
    const turn = await run(args, input);
    assert.equal(turn.code, 0, JSON.stringify(turn)); assert.equal(turn.signal, null);
    if (mode === 'print') assert.equal(turn.stdout, 'ok\n');
    else assert(turn.stdout.trim().split('\n').map(line => JSON.parse(line)).some(record => record.type === 'message_end'
      && record.message?.role === 'assistant' && record.message.provider === 'github-copilot' && record.message.api === 'openai-responses'));
    const journal = await readFile(sessions + '/copilot-terminal.jsonl', 'utf8');
    assert(journal.trim().split('\n').map(line => JSON.parse(line)).some(record => record.type === 'message' && record.role === 'assistant'
      && record.provider === 'github-copilot' && record.model === 'gpt-5-mini' && record.api === 'openai-responses'));
    assert.equal((await stat(agent + '/credentials.enc')).mode & 0o777, 0o600);
    const encrypted = await readFile(agent + '/credentials.enc', 'utf8');
    const logout = await run(['auth', 'logout', 'github-copilot']); assert.equal(logout.code, 0, JSON.stringify(logout));
    await absent();
    const withdrawn = await run(args, input); assert.notEqual(withdrawn.code, 0); assert.equal(withdrawn.signal, null);
    for (const secret of secrets) assert(!(JSON.stringify([login, turn, logout, withdrawn]) + journal + encrypted).includes(secret));
    assert.equal(fixtureError, undefined); assert.equal(calls.length, 5);
  } else {
  terminal = spawn(bin ?? process.execPath, [...entry,
    '--approve', '--no-extensions', '--no-context-files', '--no-tools', '--provider', 'mock', '--model', 'mock-model', '--thinking', 'off',
    '--session-dir', sessions, '--session-id', 'copilot-terminal', '--name', 'copilot-terminal', '--tui-mode', mode, '--theme', 'dark'], {
    cwd, cols: 120, rows: 40, env,
  });
  terminal.onData(text => {
    output += text; assert(output.length < 1000000);
    const complete = privacyTail + text;
    for (const secret of secrets) assert(!complete.includes(secret));
    privacyTail = complete.slice(-overlap);
  });
  terminal.onExit(value => { exit = value; });
  await wait(ready, 'startup');
  output = ''; terminal.write('/login github-copilot --issuer github-copilot\r');
  await wait(() => held, 'first held catalogue'); terminal.write('\x1b');
  await wait(() => shown().includes('Command failed.') && ready(), 'Escape retires login');
  await absent();
  if (!held.destroyed) held.end('{}'); held = undefined; hold = false;
  await command('/login github-copilot --issuer github-copilot', 'Authentification OAuth réussie');
  const credentials = reader(); await credentials.load();
  assert.equal((await credentials.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' })).credential.refreshToken, grant);
  assert.equal(await credentials.resolve('github-copilot', { env: {} }), undefined);
  assert.equal((await stat(agent + '/credentials.enc')).mode & 0o777, 0o600);
  await command('/model github-copilot/gpt-5-mini', 'gpt-5-mini');
  await command('probe', 'ok');
  const journal = await readFile(sessions + '/copilot-terminal.jsonl', 'utf8');
  assert(journal.trim().split('\n').map(line => JSON.parse(line)).some(entry => entry.type === 'message' && entry.role === 'assistant' && entry.provider === 'github-copilot' && entry.model === 'gpt-5-mini' && entry.api === 'openai-responses'));
  const encrypted = await readFile(agent + '/credentials.enc', 'utf8');
  await command('/logout github-copilot', 'Identifiants supprimés'); await absent();
  hold = true; output = ''; terminal.write('/login github-copilot --issuer github-copilot\r');
  await wait(() => held, 'held shutdown catalogue'); terminal.kill('SIGTERM');
  await wait(() => exit !== undefined, 'shutdown');
  assert.equal(exit.exitCode, 0, JSON.stringify({exit, output})); assert(!exit.signal, JSON.stringify(exit));
  if (!held.destroyed) held.end('{}');
  await absent(); assert.equal(fixtureError, undefined);
  for (const secret of secrets) assert(!(journal + encrypted).includes(secret));
  assert.equal(calls.length, 13);
  assert.deepEqual(calls.map(call => call.url), [...Array(2).fill(['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token', 'https://api.github.com/copilot_internal/v2/token', 'https://api.individual.githubcopilot.com/models']).flat(),
    'https://api.individual.githubcopilot.com/responses', 'https://github.com/login/device/code', 'https://github.com/login/oauth/access_token', 'https://api.github.com/copilot_internal/v2/token', 'https://api.individual.githubcopilot.com/models']);
  }
  assert(calls.filter(call => call.method === 'POST').every(call => call.path.startsWith('/login/') || call.path === '/responses'));
  console.log('COPILOT_INTERACTIVE_OK ' + mode);
} finally {
  if (child) { const pending = child; pending.kill('SIGKILL'); await new Promise(resolve => pending.once('close', resolve)); }
  if (terminal && !exit) { terminal.kill('SIGKILL'); await wait(() => exit !== undefined, 'cleanup'); }
  if (wire) { wire.closeAllConnections(); await new Promise(resolve => wire.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
