import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { createLocalTLSFixture } from './oauth-local-tls.mjs';
const { spawn } = await import(process.env.AIH_TEST_PTY_MODULE ?? 'node-pty');
const mode = process.argv[2];
assert(['regular', 'fullscreen', 'print', 'json', 'rpc', 'deadline', 'sigint', 'sigterm', 'logout', 'replace', 'rpc-refresh'].includes(mode));
const root = await mkdtemp(os.tmpdir() + '/aih-codex-cli-');
const cwd = root + '/work', agent = root + '/agent', sessions = root + '/sessions';
const master = 'disposable-codex-cli-master', refresh = 'private-codex-cli-refresh', account = 'cli-codex-account', model = 'gpt-6.1-sol';
const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url') + '.c2ln';
const events = JSON.parse(await readFile(process.env.AIH_CODEX_RESPONSE_FILE ?? new URL('../../../../../tests/fixtures/openai-codex-reference.json', import.meta.url), 'utf8')).responseEvents;
const secrets = [token, refresh, 'private-codex-device', 'private-codex-code', 'private-codex-verifier'];
let wire, terminal, exit, output = '', privacyTail = '', held, hold = false, fixtureError;
const calls = [], children = new Set();
const wait = async (predicate, label) => {
  const end = performance.now() + 5000;
  while (!await predicate()) {
    assert(performance.now() < end, label + ': ' + JSON.stringify({ exit, output: output.slice(-4096), calls: calls.map(call => call.url), fixtureError: fixtureError?.name }));
    await pause(10);
  }
};
const reader = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(agent + '/credentials.enc', master) });
const absent = async () => { const credentials = reader(); await credentials.load(); assert.equal(await credentials.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }), undefined); };
const shown = () => (mode === 'fullscreen' ? output.slice(Math.max(0, output.lastIndexOf('\x1b[2J\x1b[H'))) : output).replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '');
const ready = () => shown().includes('editor ready · Enter send') && /codex-terminal:\s*$/u.test(shown());
const command = async (text, expected) => { output = ''; terminal.write(text + '\r'); await wait(() => (expected === 'ok' ? /\bok\b/u.test(shown()) : shown().includes(expected)) && ready(), text); };
try {
  await mkdir(cwd); await mkdir(agent);
  await writeFile(agent + '/settings.json', JSON.stringify({ cacheWarming: 'off' }));
  wire = createServer(await createLocalTLSFixture(root), async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) { body += chunk; assert(body.length < 2000000); }
      calls.push({ url: request.headers['x-fixture-original-url'], method: request.method, body });
      const url = new URL(request.headers['x-fixture-original-url']);
      if (url.hostname === 'auth.openai.com') {
        assert.equal(request.method, 'POST'); assert.equal(request.headers.authorization, undefined);
        const data = url.pathname.endsWith('/usercode') ? { device_auth_id: 'private-codex-device', user_code: 'CODEX-CODE', interval: 1 }
          : url.pathname.endsWith('/deviceauth/token') ? { authorization_code: 'private-codex-code', code_verifier: 'private-codex-verifier' }
          : url.pathname === '/oauth/token' ? { access_token: token, refresh_token: refresh, expires_in: 3600 } : undefined;
        assert(data, 'Unexpected issuer target'); response.setHeader('content-type', 'application/json');
        if (url.pathname === '/oauth/token' && hold) { held = response; return; }
        response.end(JSON.stringify(data)); return;
      }
      assert.equal(request.headers.authorization, `Bearer ${token}`); assert.equal(request.headers['chatgpt-account-id'], account);
      assert.equal(request.headers['x-api-key'], undefined);
      if (url.pathname === '/backend-api/codex/models') {
        assert.equal(url.search, '?client_version=0.167.2'); assert.equal(request.method, 'GET');
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ models: [{ slug: model, visibility: 'list' }] })); return;
      }
      assert.equal(url.href, 'https://chatgpt.com/backend-api/codex/responses'); assert.equal(request.method, 'POST');
      assert.equal(JSON.parse(body).model, model); assert.equal(JSON.parse(body).store, false);
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { fixtureError = error; response.writeHead(500).end(); }
  });
  await new Promise(resolve => wire.listen(0, '127.0.0.1', resolve));
  const endpoint = `https://127.0.0.1:${wire.address().port}`, preload = root + '/routing.mjs';
  await writeFile(preload, `const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const target = new URL(String(input));
    if (target.hostname === 'localhost' && target.port === '11434') return Promise.resolve(Response.json({data:[]}));
    if (!['auth.openai.com','chatgpt.com'].includes(target.hostname)) throw new Error('Unexpected fixture host');
    const headers = new Headers(init?.headers); headers.set('x-fixture-original-url', target.href);
    return original(new URL(target.pathname + target.search, ${JSON.stringify(endpoint)}), {...init, headers});
  };`);
  const bin = process.env.AIH_CODEX_COMMAND;
  const entry = bin ? [] : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url))];
  const env = { PATH: process.env.PATH, HOME: root + '/home', TERM: 'xterm-256color', NO_COLOR: '1',
    AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_MASTER_KEY: master, NODE_EXTRA_CA_CERTS: root + '/cert.pem', NODE_OPTIONS: '--import=' + preload,
    AI_HARNESS_OAUTH_OPENAI_CODEX_DEVICE_URL: 'https://unrelated.invalid/device', AI_HARNESS_OAUTH_OPENAI_CODEX_TOKEN_URL: 'https://unrelated.invalid/token', AI_HARNESS_OAUTH_OPENAI_CODEX_CLIENT_ID: 'not-authority' };
  const launch = (args, input = '') => {
    const current = spawnChild(bin ?? process.execPath, [...entry, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(current);
    let stdout = '', stderr = '';
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => current.kill('SIGKILL'), 15000);
      current.stdout.on('data', text => { stdout += String(text); assert(stdout.length < 1000000); });
      current.stderr.on('data', text => { stderr += String(text); assert(stderr.length < 1000000); });
      current.once('error', error => { clearTimeout(timer); children.delete(current); reject(error); });
      current.once('close', (code, signal) => { clearTimeout(timer); children.delete(current); resolve({ code, signal, stdout, stderr }); });
      current.stdin.end(input);
    });
    return { current, done };
  };
  const run = (args, input) => launch(args, input).done;
  const login = ['auth', 'login', 'openai-codex', '--issuer', 'openai-codex'];
  const turn = ['--approve', '--no-extensions', '--no-context-files', '--no-tools', '--provider', 'openai-codex', '--model', model,
    '--thinking', 'off', '--session-dir', sessions, '--session-id', 'codex-terminal', ...(mode === 'print' ? ['--print', 'probe'] : ['--mode', mode === 'rpc-refresh' ? 'rpc' : mode, ...(mode === 'rpc' || mode === 'rpc-refresh' ? [] : ['probe'])])];
  if (['deadline', 'sigint', 'sigterm', 'logout', 'replace', 'rpc-refresh'].includes(mode)) {
    if (mode === 'rpc-refresh') {
      assert.equal((await run(login)).code, 0);
      const credentials = reader(); await credentials.load();
      const original = (await credentials.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).credential;
      await credentials.setOAuth('openai-codex', { ...original, expiresAt: 1 });
    }
    hold = true;
    const previous = await readFile(agent + '/credentials.enc', 'utf8').catch(() => undefined);
    const pending = launch(mode === 'rpc-refresh' ? turn : [...login, '--timeout', mode === 'deadline' ? '1' : '30']);
    await wait(() => held, 'held token exchange');
    if (mode === 'sigint') pending.current.kill('SIGINT');
    else if (mode === 'sigterm' || mode === 'rpc-refresh') pending.current.kill('SIGTERM');
    else if (mode === 'logout') assert.equal((await run(['auth', 'logout', 'openai-codex'])).code, 0);
    else if (mode === 'replace') await reader().setApiKey('openai-codex', 'replacement-key');
    if (mode === 'logout' || mode === 'replace') held.end(JSON.stringify({ access_token: token, refresh_token: refresh, expires_in: 3600 }));
    const result = await pending.done;
    assert.equal(result.signal, null); assert.equal(result.code, mode === 'deadline' ? 124 : mode === 'rpc-refresh' ? 143 : mode === 'sigint' || mode === 'sigterm' ? 130 : 1, JSON.stringify(result));
    if (mode === 'rpc-refresh') assert.equal(await readFile(agent + '/credentials.enc', 'utf8'), previous);
    else await absent();
    if (mode === 'replace') { const credentials = reader(); await credentials.load(); assert.equal((await credentials.resolve('openai-codex', { env: {} })).credential.apiKey, 'replacement-key'); }
    for (const secret of secrets) assert(!JSON.stringify(result).includes(secret));
  } else if (['print', 'json', 'rpc'].includes(mode)) {
    const authorized = await run(login); assert.equal(authorized.code, 0, JSON.stringify(authorized)); assert.equal(authorized.signal, null);
    assert(authorized.stderr.includes('https://auth.openai.com/codex/device')); assert(authorized.stderr.includes('CODEX-CODE'));
    if (mode === 'print') {
      const offline = await run(['--list-models', 'openai-codex', '--offline']); assert.equal(offline.code, 0); assert(!offline.stdout.includes(model));
      const listed = await run(['--list-models', 'openai-codex']); assert.equal(listed.code, 0, JSON.stringify(listed)); assert(listed.stdout.includes(model)); assert(!listed.stdout.includes('gpt-5.3-codex-spark'));
    }
    const input = mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'codex', message: 'probe' }) + '\n' : '';
    const result = await run(turn, input); assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.signal, null);
    if (mode === 'print') assert.equal(result.stdout, 'ok\n');
    else assert(result.stdout.trim().split('\n').map(line => JSON.parse(line)).some(record => record.type === 'message_end' && record.message?.provider === 'openai-codex' && record.message.api === 'openai-codex-responses'));
    const journal = await readFile(sessions + '/codex-terminal.jsonl', 'utf8');
    assert(journal.trim().split('\n').map(line => JSON.parse(line)).some(record => record.type === 'message' && record.role === 'assistant' && record.provider === 'openai-codex' && record.model === model && record.api === 'openai-codex-responses'));
    assert.equal((await stat(agent + '/credentials.enc')).mode & 0o777, 0o600);
    const encrypted = await readFile(agent + '/credentials.enc', 'utf8');
    const logout = await run(['auth', 'logout', 'openai-codex']); assert.equal(logout.code, 0); await absent();
    const count = calls.length, withdrawn = await run(turn, input); assert.notEqual(withdrawn.code, 0); assert.equal(withdrawn.signal, null); assert.equal(calls.length, count);
    for (const secret of secrets) assert(!(JSON.stringify([authorized, result, logout, withdrawn]) + journal + encrypted).includes(secret));
  } else {
    terminal = spawn(bin ?? process.execPath, [...entry, '--approve', '--no-extensions', '--no-context-files', '--no-tools', '--provider', 'mock', '--model', 'mock-model', '--thinking', 'off',
      '--session-dir', sessions, '--session-id', 'codex-terminal', '--name', 'codex-terminal', '--tui-mode', mode, '--theme', 'dark'], { cwd, cols: 120, rows: 40, env });
    terminal.onData(text => { output += text; assert(output.length < 1000000); const complete = privacyTail + text; for (const secret of secrets) assert(!complete.includes(secret)); privacyTail = complete.slice(-(Math.max(...secrets.map(secret => secret.length)) - 1)); });
    terminal.onExit(value => { exit = value; }); await wait(ready, 'startup');
    hold = true; output = ''; terminal.write('/login openai-codex --issuer openai-codex\r');
    await wait(() => held, 'held login'); terminal.write('\x1b'); await wait(() => shown().includes('Command failed.') && ready(), 'Escape retires login'); await absent();
    if (!held.destroyed) held.end('{}'); held = undefined; hold = false;
    await command('/login openai-codex --issuer=openai-codex', 'Authentification OAuth réussie');
    await command('/model openai-codex/' + model, model); await command('probe', 'ok');
    const journal = await readFile(sessions + '/codex-terminal.jsonl', 'utf8');
    assert(journal.trim().split('\n').map(line => JSON.parse(line)).some(record => record.type === 'message' && record.role === 'assistant' && record.provider === 'openai-codex' && record.api === 'openai-codex-responses' && record.model === model));
    const encrypted = await readFile(agent + '/credentials.enc', 'utf8'); assert.equal((await stat(agent + '/credentials.enc')).mode & 0o777, 0o600);
    await command('/logout openai-codex', 'Identifiants supprimés'); await absent();
    hold = true; output = ''; terminal.write('/login openai-codex --issuer openai-codex\r'); await wait(() => held, 'held shutdown login'); terminal.kill('SIGTERM');
    await wait(() => exit !== undefined, 'shutdown'); assert.equal(exit.exitCode, 0, JSON.stringify(exit)); assert(!exit.signal, JSON.stringify(exit)); await absent();
    for (const secret of secrets) assert(!(journal + encrypted).includes(secret));
  }
  assert.equal(fixtureError, undefined);
  assert(calls.every(call => /^https:\/\/auth\.openai\.com\/(?:api\/accounts\/deviceauth\/(?:usercode|token)|oauth\/token)$/u.test(call.url)
    || /^https:\/\/chatgpt\.com\/backend-api\/codex\/(?:models\?client_version=0\.167\.2|responses)$/u.test(call.url)));
  console.log('CODEX_CLI_OK ' + mode);
} finally {
  await Promise.all([...children].map(pending => { pending.kill('SIGKILL'); return new Promise(resolve => pending.once('close', resolve)); }));
  if (terminal && !exit) { terminal.kill('SIGKILL'); await wait(() => exit !== undefined, 'cleanup'); }
  if (wire) { wire.closeAllConnections(); await new Promise(resolve => wire.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
