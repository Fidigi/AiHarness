import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiProvider, ExtensionRegistry, SessionManager, JsonlSessionStore, createAgentSession, closeProviderNetworkDispatchers } from '@ai-harness/core';

const [mode, kind] = process.argv[2].split('/');
assert.ok(['print', 'json', 'rpc', 'sdk'].includes(mode));
assert.ok(['recover', 'exhausted', 'prefix', 'queued', 'normal'].includes(kind));
const failed = ['exhausted', 'prefix', 'queued'].includes(kind), failure = 'The provider reported a streaming error.';
const secret = 'synthetic-private-upstream-details', prefix = kind === 'prefix' ? 'Visible prefix' : '';
const attempts = mode === 'sdk' ? 3 : 4;
const expectedRequests = kind === 'recover' ? 2 : kind === 'exhausted' || kind === 'queued' ? attempts : 1;
const expectedRetries = expectedRequests - 1;
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-stream-error-'));
const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions'), effects = path.join(root, 'effects');
await mkdir(cwd); await mkdir(agent);
const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
let calls = 0, followup = false, child, fixtureError;
const server = createServer(async (request, response) => {
  try {
    let wire = ''; for await (const chunk of request) { wire += chunk; assert.ok(wire.length < 100_000); }
    const body = JSON.parse(wire); assert.equal(body.stream, true); assert.equal(request.url, '/chat/completions');
    const attempt = ++calls;
    const complete = followup || kind === 'normal' || kind === 'recover' && attempt > 1 || body.messages.some(message => message.role === 'tool');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(sse(complete ? [{ choices: [{ delta: { content: 'Final' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }] : [
      ...(prefix ? [{ choices: [{ delta: { content: prefix } }] }] : []),
      ...(kind === 'queued' ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'effect-call', type: 'function', function: { name: 'effect', arguments: '{}' } }] } }] }] : []),
      { error: { type: 'server_error', code: 'capacity_exceeded', message: secret } },
    ]));
  } catch (error) { fixtureError = error; response.writeHead(500); response.end(); }
});
const observedEffects = async () => readFile(effects, 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), error => {
  if (error.code === 'ENOENT') return []; throw error;
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (mode === 'sdk') {
    const registry = new ExtensionRegistry(), executed = [];
    await registry.load('effects', api => {
      api.before('before:tool', () => { executed.push('hook'); });
      api.registerTool({ name: 'effect', description: 'Effect', execute: () => { executed.push('effect'); return { content: 'Effect' }; } });
    });
    const sdk = await createAgentSession({ cwd, allowedRoots: [cwd], isProjectTrusted: () => true,
      provider: { kind: 'instance', name: 'stream-error-fixture', provider: new OpenAiProvider({ type: 'openai', model: 'fixture', apiKey: 'disposable', baseUrl }) },
      extensionRegistry: registry, store: new JsonlSessionStore(sessions) });
    try {
      const run = await sdk.promptAndWait('Use the provider.');
      assert.deepEqual(executed, []);
      assert.equal(run.phase, failed ? 'failed' : 'completed'); if (failed) assert.equal(run.error, failure);
      assert.equal(calls, expectedRequests);
      const events = sdk.events().events;
      assert.equal(events.filter(event => event.type === 'retry.scheduled').length, expectedRetries);
      assert.equal(events.filter(event => event.type === 'tool.started').length, 0);
      assert.ok(!JSON.stringify({ run, events, history: await sdk.history() }).includes(secret));
      if (prefix) assert.ok(sdk.messages().some(message => message.content === prefix && message.metadata?.outputError === failure));
      followup = true;
      assert.equal((await sdk.promptAndWait('Explicit follow-up.')).phase, 'completed');
      assert.equal(calls, expectedRequests + 1); assert.deepEqual(executed, []);
    } finally { await sdk.dispose(); await registry.shutdown(); }
  } else {
    const extension = path.join(agent, 'provider.mjs');
    await writeFile(extension, `import { appendFileSync } from 'node:fs';
      import { OpenAiProvider } from ${JSON.stringify(import.meta.resolve('@ai-harness/core'))};
      export default api => {
        api.registerProvider('stream-error-fixture', { defaultConfig: { model: 'fixture' }, create: config => new OpenAiProvider({ ...config, type: 'openai', apiKey: 'disposable', baseUrl: ${JSON.stringify(baseUrl)} }) });
        api.before('before:tool', () => { appendFileSync(${JSON.stringify(effects)}, JSON.stringify('hook')+'\\n'); });
        api.registerTool({ name: 'effect', description: 'Effect', execute: () => { appendFileSync(${JSON.stringify(effects)}, JSON.stringify('effect')+'\\n'); return { content: 'Effect' }; } });
      };`);
    const args = ['--offline', '--approve', '--no-extensions', '-e', extension, '--no-context-files', '--no-builtin-tools', '--tools', 'effect',
      '--model', 'stream-error-fixture/fixture', '--session-dir', sessions, '--session-id', 'stream-error-probe',
      ...(mode === 'print' ? ['-p'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Use the provider.'])];
    child = spawn(process.env.AIH_STREAM_ERROR_COMMAND || process.execPath, process.env.AIH_STREAM_ERROR_COMMAND ? args : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url)), ...args], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1' },
    });
    let stdout = '', stderr = '', pending = '', settled = 0, protocolError;
    const records = [];
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') protocolError = error; });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk; if (mode !== 'rpc') return; pending += chunk;
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const record = JSON.parse(line); records.push(record);
          if (record.type === 'agent_settled') {
            if (++settled === 1) child.stdin.write(JSON.stringify({ type: 'get_messages', id: 'history' })+'\n');
            else child.stdin.end();
          }
          if (record.type === 'response' && record.id === 'history') {
            followup = true; child.stdin.write(JSON.stringify({ type: 'prompt', id: 'second', message: 'Explicit follow-up.' })+'\n');
          }
        } catch (error) { protocolError = error; child.stdin.end(); }
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    if (mode === 'rpc') child.stdin.write(JSON.stringify({ type: 'prompt', id: 'first', message: 'Use the provider.' })+'\n'); else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 18_000);
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
    assert.equal(protocolError, undefined); assert.deepEqual(await observedEffects(), []);
    assert.deepEqual(exit, { code: failed && mode !== 'rpc' ? 1 : 0, signal: null }, JSON.stringify({ exit, stdout, stderr }));
    assert.equal(stderr, failed && mode !== 'rpc' ? `Error: ${failure}\n` : '');
    assert.ok(!stdout.includes(secret)); assert.ok(!stderr.includes(secret));
    assert.equal(calls, expectedRequests + (mode === 'rpc' ? 1 : 0));
    if (mode === 'print') assert.equal(stdout, failed ? '' : 'Final\n');
    else {
      if (mode === 'json') { records.push(...stdout.trim().split('\n').map(line => JSON.parse(line))); assert.equal(records[0].version, 3); }
      else {
        assert.equal(pending, '');
        assert.ok(records.some(record => record.type === 'response' && record.id === 'history' && record.success));
        assert.ok(records.some(record => record.type === 'response' && record.id === 'second' && record.success));
      }
      assert.equal(records.filter(record => record.type === 'agent_settled').length, mode === 'rpc' ? 2 : 1);
      assert.equal(records.filter(record => record.type === 'auto_retry_start').length, expectedRetries);
      assert.equal(records.filter(record => record.type === 'tool_execution_start').length, 0);
      const assistants = records.filter(record => record.type === 'message_end' && record.message.role === 'assistant');
      assert.equal(assistants[0].message.stopReason, failed ? 'error' : 'stop');
      if (failed) assert.equal(assistants[0].message.errorMessage, failure);
      if (prefix) assert.equal(assistants[0].message.content.filter(block => block.type === 'text').map(block => block.text).join(''), prefix);
      if (mode === 'rpc') assert.equal(assistants.at(-1).message.stopReason, 'stop');
    }
    const manager = new SessionManager({ store: new JsonlSessionStore(sessions) }); await manager.loadFromStore('stream-error-probe');
    const history = await manager.getRawEntries('stream-error-probe');
    assert.ok(!JSON.stringify(history).includes(secret)); assert.equal(history.filter(entry => entry.type === 'message' && entry.role === 'tool').length, 0);
    // CLI durable error-prefix retention is an explicitly recorded remaining audit gap;
    // this narrow parser regression verifies streamed records above, not a persistence fix.
  }
  assert.equal(fixtureError, undefined);
  console.log(JSON.stringify({ result: 'STREAM_ERROR_OK', mode, kind }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closeProviderNetworkDispatchers(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
