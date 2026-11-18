import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentSession, closeProviderNetworkDispatchers, SessionManager, JsonlSessionStore } from '@ai-harness/core';

const [mode, kind] = process.argv[2].split('/');
assert.ok(['print', 'json', 'rpc', 'sdk'].includes(mode));
assert.ok(['native', 'combined', 'split'].includes(kind));
const order = kind === 'split' ? ['text', 'thinking'] : ['thinking', 'text'];
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mixed-delta-'));
const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
await mkdir(cwd); await mkdir(agent);
let child, requests = 0, fixtureError;
const server = createServer(async (request, response) => {
  try {
    let wire = ''; for await (const chunk of request) { wire += chunk; assert.ok(wire.length < 100_000); }
    assert.equal(JSON.parse(wire).stream, true); assert.equal(request.url, '/chat/completions'); requests++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Answer', reasoning_content: 'Plan' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } catch (failure) { fixtureError = failure; response.writeHead(500); response.end(); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const extension = path.join(agent, 'provider.mjs');
  await writeFile(extension, `import { AiProvider, OpenAiProvider } from ${JSON.stringify(import.meta.resolve('@ai-harness/core'))};
    class CallbackProvider extends AiProvider {
      validateConfig() { return true; }
      async chat() { return { content: 'unused' }; }
      async streamChat(_messages, chunk, complete) {
        ${kind === 'split' ? "await chunk('Answer', { type: 'text_delta' }); await chunk('', { type: 'reasoning_delta', data: { content: 'Plan' } });"
          : "await chunk('Answer', { type: 'reasoning_delta', data: { content: 'Plan' } });"}
        complete?.({ content: 'Answer', reasoning: 'Plan', model: 'fixture' });
      }
    }
    export function create(config = {}) { return ${kind === 'native'
      ? `new OpenAiProvider({ ...config, type: 'openai', baseUrl: ${JSON.stringify(baseUrl)}, apiKey: 'disposable', model: 'fixture' })`
      : "new CallbackProvider({ ...config, type: 'mock', model: 'fixture' })"}; }
    export default api => api.registerProvider('mixed-fixture', { defaultConfig: { model: 'fixture' }, create });`);
  if (mode === 'sdk') {
    const { create } = await import(pathToFileURL(extension).href);
    const sdk = await createAgentSession({ cwd, allowedRoots: [cwd], isProjectTrusted: () => true,
      provider: { kind: 'instance', name: 'mixed-fixture', provider: create() } });
    try {
      assert.equal((await sdk.promptAndWait('Question')).phase, 'completed');
      const deltas = sdk.events().events.filter(event => ['message.delta', 'reasoning.delta'].includes(event.type));
      assert.deepEqual(deltas.map(event => event.type), order.map(type => type === 'text' ? 'message.delta' : 'reasoning.delta'));
      assert.deepEqual(deltas.map(event => event.data.content), order.map(type => type === 'text' ? 'Answer' : 'Plan'));
      const assistant = sdk.messages().find(message => message.role === 'assistant');
      assert.equal(assistant.content, 'Answer');
      assert.deepEqual(assistant.blocks.filter(block => ['text', 'reasoning'].includes(block.type)),
        [{ type: 'reasoning', text: 'Plan' }, { type: 'text', text: 'Answer' }]);
    } finally { await sdk.dispose(); }
  } else {
    const args = ['--offline', '--approve', '--no-extensions', '-e', extension, '--no-context-files',
      '--no-builtin-tools', '--model', 'mixed-fixture/fixture', '--session-dir', sessions, '--session-id', 'mixed-delta',
      ...(mode === 'print' ? ['-p'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Question'])];
    child = spawn(process.env.AIH_MIXED_DELTA_COMMAND || process.execPath, process.env.AIH_MIXED_DELTA_COMMAND
      ? args : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url)), ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1' } });
    let stdout = '', stderr = '', pending = '', protocolError;
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk; if (mode !== 'rpc') return; pending += chunk;
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { if (JSON.parse(line).type === 'agent_settled') child.stdin.end(); }
        catch (failure) { protocolError = failure; child.stdin.end(); }
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    if (mode === 'rpc') child.stdin.write(JSON.stringify({ type: 'prompt', id: 'p', message: 'Question' }) + '\n');
    else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 6_000);
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    assert.equal(protocolError, undefined); assert.deepEqual(exit, { code: 0, signal: null }, JSON.stringify({ exit, stdout, stderr }));
    assert.equal(stderr, '');
    if (mode === 'print') assert.equal(stdout, 'Answer\n');
    else {
      const records = stdout.trim().split('\n').map(line => JSON.parse(line));
      if (mode === 'json') assert.equal(records[0].version, 3);
      const deltas = records.filter(record => record.type === 'message_update').map(record => record.assistantMessageEvent)
        .filter(event => ['text_delta', 'thinking_delta'].includes(event.type));
      assert.deepEqual(deltas.map(event => event.type), order.map(type => `${type}_delta`));
      assert.deepEqual(deltas.map(event => event.delta), order.map(type => type === 'text' ? 'Answer' : 'Plan'));
      assert.deepEqual(deltas.map(event => event.contentIndex), [0, 1]);
      const assistant = records.find(record => record.type === 'message_end' && record.message.role === 'assistant').message;
      assert.equal(assistant.stopReason, 'stop'); assert.deepEqual(assistant.content.map(block => block.type), order);
      assert.equal(records.filter(record => record.type === 'agent_settled').length, 1);
      assert.equal(records.filter(record => record.type === 'auto_retry_start').length, 0);
    }
    const manager = new SessionManager({ store: new JsonlSessionStore(sessions) });
    await manager.loadFromStore('mixed-delta');
    const assistant = (await manager.getRawEntries('mixed-delta')).find(entry => entry.type === 'message' && entry.role === 'assistant');
    assert.equal(assistant.content, 'Answer');
    assert.deepEqual(assistant.blocks.filter(block => ['text', 'reasoning'].includes(block.type)),
      [{ type: 'reasoning', text: 'Plan' }, { type: 'text', text: 'Answer' }]);
  }
  assert.equal(requests, kind === 'native' ? 1 : 0); assert.equal(fixtureError, undefined);
  console.log(JSON.stringify({ result: 'MIXED_DELTA_OK', mode, kind, requests }));
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await closeProviderNetworkDispatchers(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
