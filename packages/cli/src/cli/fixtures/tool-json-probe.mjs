import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicProvider, OpenAiProvider, OpenAiResponsesProvider, ExtensionRegistry, SessionManager,
  JsonlSessionStore, createAgentSession, closeProviderNetworkDispatchers } from '@ai-harness/core';

const [mode, dialect, kind] = process.argv[2].split('/');
assert.ok(['print', 'json', 'rpc', 'sdk'].includes(mode));
assert.ok(['completions', 'responses', 'anthropic'].includes(dialect));
assert.ok(['invalid', 'invalid-text', 'valid'].includes(kind));
const valid = kind === 'valid', text = kind === 'invalid-text' ? 'Visible prefix' : '';
const error = 'The provider tool arguments were invalid JSON.';
const privateArgument = 'private-malformed-tool-argument';
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-tool-json-'));
const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
const effects = path.join(root, 'effects');
await mkdir(cwd); await mkdir(agent);
const sse = (...events) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
let calls = 0, child, fixtureError;
const server = createServer(async (request, response) => {
  try {
    let wire = ''; for await (const chunk of request) { wire += chunk; assert.ok(wire.length < 100_000); }
    const body = JSON.parse(wire); assert.equal(body.stream, true); assert.equal(request.method, 'POST');
    assert.equal(request.url, dialect === 'anthropic' ? '/v1/messages' : dialect === 'responses' ? '/responses' : '/chat/completions');
    const first = calls++ === 0, content = first ? text : 'Final';
    const args = first ? ['{}', valid ? '{"value":1}' : `{"${privateArgument}":`] : [];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (dialect === 'completions') response.end(sse({ choices: [{ delta: { content } }] },
      ...args.map((argument, index) => ({ choices: [{ delta: { tool_calls: [{ index, id: `c-${index}`, type: 'function', function: { name: index ? 'second_effect' : 'first_effect', arguments: argument } }] } }] })),
      { choices: [{ delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
    else if (dialect === 'responses') response.end(sse({ type: 'response.created', response: { id: 'r' } },
      ...(content ? [{ type: 'response.output_text.delta', delta: content }] : []),
      { type: 'response.completed', response: { id: 'r', output: args.map((argument, index) => ({ type: 'function_call', call_id: `c-${index}`, name: index ? 'second_effect' : 'first_effect', arguments: argument })) } }));
    else response.end(sse(...(content ? [{ type: 'content_block_delta', index: 10, delta: { type: 'text_delta', text: content } }] : []),
      ...args.flatMap((argument, index) => [
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `c-${index}`, name: index ? 'second_effect' : 'first_effect', input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argument } },
      ]), { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }));
  } catch (failure) { fixtureError = failure; response.writeHead(500); response.end(); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const expectedEffects = [{ name: 'first_effect', input: {} }, { name: 'second_effect', input: { value: 1 } }];
  if (mode === 'sdk') {
    const registry = new ExtensionRegistry(), executed = [];
    await registry.load('effects', api => {
      for (const name of ['first_effect', 'second_effect']) api.registerTool({ name, description: name,
        execute: input => { executed.push({ name, input }); return { content: 'Effect' }; } });
    });
    const config = { type: 'openai', apiKey: 'disposable', baseUrl, model: 'fixture' };
    const provider = dialect === 'completions' ? new OpenAiProvider(config) : dialect === 'responses'
      ? new OpenAiResponsesProvider({ ...config, transport: 'sse' }) : new AnthropicProvider({ ...config, type: 'anthropic' });
    const sdk = await createAgentSession({ cwd, allowedRoots: [cwd], isProjectTrusted: () => true,
      provider: { kind: 'instance', name: 'tool-json-fixture', provider }, extensionRegistry: registry,
      store: new JsonlSessionStore(sessions), runDefaults: { maxRetries: 3 } });
    try {
      const run = await sdk.promptAndWait('Use the tools.');
      assert.equal(run.phase, valid ? 'completed' : 'failed');
      if (!valid) assert.equal(run.error, error);
      assert.equal(calls, valid ? 2 : 1);
      assert.deepEqual(executed, valid ? expectedEffects : []);
      const events = sdk.events().events;
      assert.equal(events.filter(event => event.type === 'tool.started').length, valid ? 2 : 0);
      assert.equal(events.filter(event => event.type === 'retry.scheduled').length, 0);
      assert.ok(!JSON.stringify({ run, events, history: await sdk.history() }).includes(privateArgument));
      if (text) assert.ok(sdk.messages().some(message => message.content === text && message.metadata?.outputError === error));
      const before = calls;
      assert.equal((await sdk.promptAndWait('New explicit request.')).phase, 'completed');
      assert.equal(calls, before + 1); assert.deepEqual(executed, valid ? expectedEffects : []);
    } finally { await sdk.dispose(); await registry.shutdown(); }
  } else {
    const extension = path.join(agent, 'probe.mjs');
    await writeFile(extension, `import { appendFileSync } from 'node:fs';
      import { OpenAiProvider, OpenAiResponsesProvider, AnthropicProvider } from '@ai-harness/core';
      export default api => {
        api.registerProvider('tool-json-fixture', { defaultConfig: { model: 'fixture' }, create(config) {
          const c = { ...config, type: 'openai', apiKey: 'disposable', baseUrl: ${JSON.stringify(baseUrl)} };
          return ${dialect === 'completions' ? 'new OpenAiProvider(c)' : dialect === 'responses' ? "new OpenAiResponsesProvider({ ...c, transport: 'sse' })" : "new AnthropicProvider({ ...c, type: 'anthropic' })"};
        } });
        for (const name of ['first_effect', 'second_effect']) api.registerTool({ name, description: name,
          execute: input => { appendFileSync(${JSON.stringify(effects)}, JSON.stringify({ name, input }) + '\\n'); return { content: 'Effect' }; } });
      };`);
    const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
    const args = ['--offline', '--approve', '--no-extensions', '-e', extension, '--no-context-files',
      '--no-builtin-tools', '--tools', 'first_effect,second_effect', '--model', 'tool-json-fixture/fixture',
      '--session-dir', sessions, '--session-id', 'tool-json-probe',
      ...(mode === 'print' ? ['-p'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Use the tools.'])];
    child = spawn(process.env.AIH_TOOL_JSON_COMMAND || process.execPath,
      process.env.AIH_TOOL_JSON_COMMAND ? args : [cli, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1' } });
    let stdout = '', stderr = '', pending = '', protocolError;
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      if (mode !== 'rpc') return;
      pending += chunk;
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { if (JSON.parse(line).type === 'agent_settled') child.stdin.end(); }
        catch (failure) { protocolError = failure; child.stdin.end(); }
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    if (mode === 'rpc') child.stdin.write(JSON.stringify({ type: 'prompt', id: 'first', message: 'Use the tools.' }) + '\n');
    else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 6_000);
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    assert.equal(protocolError, undefined);
    assert.deepEqual(exit, { code: valid || mode === 'rpc' ? 0 : 1, signal: null }, JSON.stringify({ exit, stdout, stderr }));
    assert.equal(stderr, valid || mode === 'rpc' ? '' : `Error: ${error}\n`);
    assert.ok(!stdout.includes(privateArgument)); assert.ok(!stderr.includes(privateArgument));
    if (mode === 'print') assert.equal(stdout, valid ? 'Final\n' : '');
    else {
      const records = stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.ok(records.every(record => typeof record.type === 'string'));
      if (mode === 'json') assert.equal(records[0].version, 3);
      assert.equal(records.filter(record => record.type === 'agent_settled').length, 1);
      assert.equal(records.filter(record => record.type === 'tool_execution_start').length, valid ? 2 : 0);
      assert.equal(records.filter(record => record.type === 'auto_retry_start').length, 0);
      const assistants = records.filter(record => record.type === 'message_end' && record.message.role === 'assistant');
      if (valid) assert.equal(assistants.at(-1).message.stopReason, 'stop');
      else { assert.equal(assistants.at(-1).message.stopReason, 'error'); assert.equal(assistants.at(-1).message.errorMessage, error); }
    }
    const observed = await readFile(effects, 'utf8').then(value => value.trim().split('\n').map(line => JSON.parse(line)), failure => {
      if (failure.code === 'ENOENT') return []; throw failure;
    });
    assert.deepEqual(observed, valid ? expectedEffects : []);
    assert.equal(calls, valid ? 2 : 1);
    const manager = new SessionManager({ store: new JsonlSessionStore(sessions) });
    await manager.loadFromStore('tool-json-probe');
    const history = await manager.getRawEntries('tool-json-probe');
    assert.ok(!JSON.stringify(history).includes(privateArgument));
    assert.equal(history.filter(entry => entry.type === 'message' && entry.role === 'tool').length, valid ? 2 : 0);
  }
  assert.equal(fixtureError, undefined);
  console.log(JSON.stringify({ result: 'TOOL_JSON_OK', mode, dialect, kind, calls }));
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await closeProviderNetworkDispatchers();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
