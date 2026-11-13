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
const requestedMode = process.argv[2], privateMode = /^private-([acr])-(print|json|rpc)$/u.exec(requestedMode);
const mode = privateMode ? privateMode[2] : requestedMode; assert(['regular', 'fullscreen', 'print', 'json', 'rpc'].includes(mode));
const model = privateMode?.[1] === 'a' ? 'claude-fable-5.1' : privateMode?.[1] === 'c' ? 'gemini-3.5-flash' : 'gpt-5-mini';
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-copilot-terminal-'));
const cwd = root + '/work', agent = root + '/agent', sessions = root + '/sessions', trace = root + '/transport.jsonl';
const master = 'disposable-copilot-terminal-master', grant = 'private-terminal-github-grant', token = 'private-terminal-inference';
const reference = JSON.parse(await readFile(process.env.AIH_COPILOT_RESPONSE_FILE ?? new URL('../../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8'));
const events = Array.isArray(reference) ? reference : reference.rows.find(row => row.model === model && row.case === 'user').responseEvents;
const continuation = privateMode ? JSON.parse(await readFile(process.env.AIH_COPILOT_CONTINUATION_FILE ?? new URL('../../../../../tests/fixtures/github-copilot-continuation-reference.json', import.meta.url), 'utf8')) : undefined;
const row = continuation?.rows.find(row => row.model === model && (row.api !== 'openai-completions' || row.lane === 'details'));
const payload = (value, secret) => JSON.parse(JSON.stringify(value).replace(/opaque-copilot-(redacted|c-sensitive-one|sensitive-tail)/gu,
  (_match, suffix) => `opaque-${secret}-copilot-${suffix}`));
const redact = value => payload(value, '[REDACTED]');
const privateFinal = row?.seed.events.filter(event => row.api === 'anthropic-messages' ? event.index !== row.seed.blocks.findIndex(block => block.type === 'tool_call')
  : row.api !== 'openai-responses' || event.output_index !== row.seed.blocks.findIndex(block => block.type === 'tool_call'))
  .map(event => {
    if (event.type === 'message_delta') return { ...event, delta: { ...event.delta, stop_reason: 'end_turn' } };
    if (event.choices) return { ...event, choices: event.choices.map(choice => {
      const delta = { ...choice.delta }; delete delta.tool_calls;
      return { ...choice, delta, finish_reason: choice.finish_reason === 'tool_calls' ? 'stop' : choice.finish_reason };
    }) };
    if (event.type === 'response.completed') return { ...event, response: { ...event.response, output: event.response.output.filter(item => item.type !== 'function_call') } };
    return event;
  });
let privateTurns = 0;
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
      if (['/responses', '/chat/completions', '/v1/messages?beta=true'].includes(request.url)) {
        assert.equal(request.headers.authorization, `Bearer ${token}`); assert.equal(request.headers['x-api-key'], undefined);
        assert.equal(JSON.parse(body).model, model);
        assert.equal(request.url, !row || row.api === 'openai-responses' ? '/responses' : row.api === 'openai-completions' ? '/chat/completions' : '/v1/messages?beta=true');
        const selected = !row ? events : ++privateTurns === 1 ? payload(row.seed.events, token) : privateTurns === 2 ? payload(privateFinal, token) : events;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(selected.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (selected[0].type ? '' : 'data: [DONE]\n\n')); return;
      }
      const value = request.url === '/login/device/code' ? { device_code: 'private-terminal-device', user_code: 'TERMINAL-CODE', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 0.01 }
        : request.url === '/login/oauth/access_token' ? { access_token: grant }
        : request.url === '/copilot_internal/v2/token' ? { token, expires_at: Math.floor(Date.now() / 1000) + 3600 }
        : request.url === '/models' ? { data: [{ id: model, model_picker_enabled: true }] } : undefined;
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
    if (privateMode) {
      const extension = cwd + '/echo.mjs', effects = root + '/echo-effects', journalFile = sessions + '/copilot-terminal.jsonl';
      await writeFile(extension, `import { appendFile } from 'node:fs/promises';
        export default api => api.registerTool({ ...${JSON.stringify(continuation.tools[0])}, execute: async input => {
          if (input.x !== 1) throw new Error('Invalid fixture input.');
          await appendFile(${JSON.stringify(effects)}, 'effect\\n'); return { content: 'result' };
        } });`);
      const args = (resume, prompt) => ['--approve', '--no-extensions', '--no-context-files', '-e', extension, '--tools', 'echo',
        '--provider', 'github-copilot', '--model', model, '--thinking', 'off', '--session-dir', sessions,
        ...(resume ? ['--session', journalFile] : ['--session-id', 'copilot-terminal']),
        ...(mode === 'print' ? ['--print', prompt] : ['--mode', mode, ...(mode === 'rpc' ? [] : [prompt])])];
      const input = prompt => mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'copilot', message: prompt }) + '\n' : '';
      const history = body => {
        const items = body[row.api === 'openai-responses' ? 'input' : 'messages'];
        if (row.api === 'anthropic-messages') return items;
        assert.equal(items[0].role, row.api === 'openai-responses' ? 'developer' : 'system'); assert.equal(typeof items[0].content, 'string');
        return items.slice(1);
      };
      const exact = redact(history(row.cases.find(item => item.name === 'same').body));
      const assistant = structuredClone(exact.find(item => item.role === 'assistant') ?? {});
      if (row.api === 'anthropic-messages') assistant.content = assistant.content.filter(item => item.type !== 'tool_use'); else delete assistant.tool_calls;
      const final = row.api === 'openai-responses' ? exact.slice(1, -1).filter(item => item.type !== 'function_call') : [assistant];
      const user = { ...exact[0], content: row.api === 'openai-responses' ? [{ type: 'input_text', text: 'continue' }] : 'continue' };
      const expected = resume => {
        const items = structuredClone(resume ? [...exact, ...final, user] : exact);
        if (row.api === 'anthropic-messages') {
          const last = items.at(-1); if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
          last.content.at(-1).cache_control = { type: 'ephemeral' };
        }
        return items;
      };
      const blocks = redact(row.seed.blocks), finalBlocks = blocks.filter(block => block.type !== 'tool_call');
      const bodies = () => calls.filter(call => ['/responses', '/chat/completions', '/v1/messages?beta=true'].includes(call.path)).map(call => JSON.parse(call.body));
      const first = await run(args(false, 'probe'), input('probe')); assert.equal(first.code, 0, JSON.stringify(first)); assert.equal(first.signal, null);
      if (mode === 'print') assert.equal(first.stdout, blocks.filter(block => block.type === 'text').map(block => block.text).join('') + '\n');
      else assert.equal(first.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.type === 'message_end' && record.message?.role === 'assistant' && record.message.api === row.api).length, 2);
      assert.equal(bodies().length, 2); assert.deepEqual(history(bodies()[1]), expected(false)); assert.equal(await readFile(effects, 'utf8'), 'effect\n');
      const journal = await readFile(journalFile, 'utf8'), records = journal.trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records.filter(record => record.type === 'message' && record.role === 'assistant').map(record => record.blocks), [blocks, finalBlocks]);
      assert(records.some(record => record.type === 'message' && record.role === 'tool' && record.toolCallId === blocks.find(block => block.type === 'tool_call').id && record.content === 'result'));
      assert.equal((await stat(journalFile)).mode & 0o777, 0o600); assert(journal.includes('opaque-[REDACTED]-copilot'));
      const exports = [];
      for (const complete of [false, true]) {
        const file = cwd + '/' + (complete ? 'complete' : 'ordinary') + '.json';
        const exported = await run(['export', '--session', journalFile, '--session-dir', sessions, '--format', 'json', '--output', file, '--approve', ...(complete ? ['--include-opaque-continuations'] : [])]);
        assert.equal(exported.code, 0, JSON.stringify(exported)); assert.equal(exported.signal, null);
        const bytes = await readFile(file, 'utf8'); assert.equal(bytes.includes('opaque-'), complete); assert.equal(bytes.includes('thinkingSignature'), complete);
        if (row.api === 'openai-responses') assert.equal(bytes.includes('textSignature'), complete);
        assert.equal((await stat(file)).mode & 0o777, 0o600); exports.push(bytes, JSON.stringify(exported)); assert.equal(await readFile(journalFile, 'utf8'), journal);
      }
      const resumed = await run(args(true, 'continue'), input('continue')); assert.equal(resumed.code, 0, JSON.stringify(resumed)); assert.equal(resumed.signal, null);
      assert.equal(bodies().length, 3); assert.deepEqual(history(bodies()[2]), expected(true)); assert.equal(await readFile(effects, 'utf8'), 'effect\n');
      const restarted = await readFile(journalFile, 'utf8'), assistants = restarted.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.type === 'message' && record.role === 'assistant');
      assert.equal(assistants.length, 3); assert.deepEqual(assistants.slice(0, 2).map(record => record.blocks), [blocks, finalBlocks]);
      assert.equal(assistants[2].content, 'ok'); assert.equal(assistants[2].provider, 'github-copilot'); assert.equal(assistants[2].api, row.api); assert.equal(assistants[2].model, model);
      if (mode === 'print') assert.equal(resumed.stdout, 'ok\n');
      else {
        const completed = resumed.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.type === 'message_end' && record.message?.role === 'assistant');
        assert.equal(completed.length, 1); assert.equal(completed[0].message.api, row.api); assert.deepEqual(completed[0].message.content, [{ type: 'text', text: 'ok' }]);
      }
      const encrypted = await readFile(agent + '/credentials.enc', 'utf8'); assert.equal((await stat(agent + '/credentials.enc')).mode & 0o777, 0o600);
      const logout = await run(['auth', 'logout', 'github-copilot']); assert.equal(logout.code, 0); await absent();
      const count = calls.length, withdrawn = await run(args(true, 'withdrawn'), input('withdrawn')); assert.notEqual(withdrawn.code, 0); assert.equal(withdrawn.signal, null);
      assert.equal(calls.length, count); assert.equal(privateTurns, 3); assert.equal(await readFile(effects, 'utf8'), 'effect\n');
      const publicOutput = JSON.stringify([login, first, resumed, logout, withdrawn]); assert(!publicOutput.includes('opaque-')); assert(!publicOutput.includes('thinkingSignature')); assert(!publicOutput.includes('textSignature'));
      for (const secret of secrets) assert(!(publicOutput + journal + restarted + encrypted + exports.join('\n')).includes(secret));
      assert.equal(fixtureError, undefined); assert.equal(calls.length, 7);
    } else {
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
    }
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
  assert(calls.filter(call => call.method === 'POST').every(call => call.path.startsWith('/login/') || ['/responses', '/chat/completions', '/v1/messages?beta=true'].includes(call.path)));
  console.log('COPILOT_INTERACTIVE_OK ' + requestedMode);
} finally {
  if (child) { const pending = child; pending.kill('SIGKILL'); await new Promise(resolve => pending.once('close', resolve)); }
  if (terminal && !exit) { terminal.kill('SIGKILL'); await wait(() => exit !== undefined, 'cleanup'); }
  if (wire) { wire.closeAllConnections(); await new Promise(resolve => wire.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
