import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentSession, ExtensionRegistry, JsonlSessionStore, SessionManager, getSessionAccounting, registerWorkspaceTools, WorkspaceManager } from '@ai-harness/core';

const [mode, scenario, steeringMode = 'one-at-a-time', followUpMode = 'one-at-a-time'] = process.argv.slice(2);
assert.ok(['print', 'json', 'rpc', 'sdk', 'regular', 'fullscreen'].includes(mode));
assert.ok(['tools', 'overflow', 'length', 'queues'].includes(scenario));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-run-contract-'));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
const secret = 'disposable-run-credential-71fca9';
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT6sAAAAASUVORK5CYII=';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const first = deferred(), release = deferred(), settled = deferred();
let child, pty, sdk, registry, stdout = '', stderr = '', serverError, timer, attempts = 0, summaries = 0;
const inputs = [], records = [];
const expected = [['initial']];
if (scenario === 'queues') for (const [kind, delivery] of [['steer', steeringMode], ['follow-up', followUpMode]]) {
  for (const batch of delivery === 'all' ? [[1, 2, 3]] : [[1], [2], [3]]) {
    const values = batch.map(i => `${kind}-${i}`);
    // RPC's existing all-mode wire/history contract combines one delivery batch.
    expected.push([...expected.at(-1), ...(mode === 'rpc' && batch.length > 1 ? [values.join('\n\n')] : values)]);
  }
}
const server = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) { text += chunk; assert.ok(text.length < 2_000_000); }
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    const body = JSON.parse(text);
    if (!body.stream) {
      summaries++; assert.ok(['overflow', 'length'].includes(scenario)); assert.equal(summaries, 1);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'Earlier facts compressed.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })); return;
    }
    attempts++; inputs.push(body.messages.filter(message => message.role === 'user' && typeof message.content === 'string').map(message => message.content));
    if (scenario === 'queues' && attempts === 1) { first.resolve(); await release.promise; }
    if (scenario === 'overflow' && attempts === 1) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: secret } })); return;
    }
    let delta = { content: `RUN_CONTRACT_OK_${attempts}` }, finish_reason = 'stop';
    if (scenario === 'tools') {
      if (attempts === 1) {
        delta = { tool_calls: ['a', 'b', 'parent', 'mutate'].map((name, index) => ({ index, id: `call-${name}`, type: 'function', function: { name, arguments: '{}' } })) };
        finish_reason = 'tool_calls';
      } else {
        assert.equal(attempts, 2); const results = body.messages.filter(message => message.role === 'tool');
        assert.deepEqual(results.map(message => message.tool_call_id), ['call-a', 'call-b', 'call-parent', 'call-mutate']);
        assert.ok(results[0].content.includes('[Structured result]')); assert.ok(results[0].content.includes('[REDACTED]'));
        assert.ok(results[0].content.includes('Résultat tronqué')); assert.ok(!JSON.stringify(body).includes(secret));
        assert.ok(body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url' && block.image_url.url === pixel)));
        assert.ok(results[2].content.includes('nested complete'));
      }
    } else if (scenario === 'queues') {
      assert.deepEqual(inputs.at(-1), expected[attempts - 1]);
      if (attempts === 1) { delta = { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read', arguments: '{"path":"input.txt"}' } }] }; finish_reason = 'tool_calls'; }
    } else if (scenario === 'length' && attempts === 1) { delta = { content: 'unfinished answer' }; finish_reason = 'length'; }
    else { assert.equal(attempts, 2); assert.equal(summaries, 1); assert.ok(JSON.stringify(body.messages).includes('Earlier facts compressed.')); assert.ok(!JSON.stringify(body.messages).includes('unfinished answer')); }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }], model: 'fixture-model', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { serverError ??= error; response.writeHead(500); response.end('Invalid run fixture'); }
});
const deadline = (promise, phase = 'operation') => Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Run contract deadline: ${mode}/${scenario}/${phase}, attempts=${attempts}\n${stdout.slice(-4000)}`)), 12_000); })]).finally(() => clearTimeout(timer));
try {
  await mkdir(cwd); await mkdir(agent); await writeFile(path.join(cwd, 'input.txt'), 'fixture input');
  const settings = { quietStartup: true, steeringMode, followUpMode, retry: { enabled: false }, compaction: { enabled: ['overflow', 'length'].includes(scenario), keepRecentTokens: 20 } };
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify(settings));
  const store = new JsonlSessionStore(sessions), manager = new SessionManager({ store });
  const session = await manager.create({ title: 'Run contract', cwd });
  if (['overflow', 'length'].includes(scenario)) for (let i = 0; i < 3; i++) {
    await manager.addMessage(session.id, { role: 'user', content: `old-${i}: ${'x'.repeat(2000)}` });
    await manager.addMessage(session.id, { role: 'assistant', content: 'old answer' });
  }
  const extension = path.join(cwd, 'probe.mjs');
  await writeFile(extension, `import assert from 'node:assert/strict';
export default api => {
 let active = 0, done = 0, mutated = false, startB; const both = new Promise(resolve => { startB = resolve; });
 api.before('before:tool', data => ({ ...data, context: { ...data.context, toolCallId: 'spoof', executeTool: async () => { throw new Error('forged authority'); } } }));
 for (const name of ['a', 'b']) api.registerTool({ name, description: name, readOnly: true, execute: async () => {
  active++; assert.equal(mutated, false); if (name === 'b') { assert.equal(active, 2); startB(); }
  await both; if (name === 'a') await new Promise(resolve => setImmediate(resolve)); active--; done++;
  return name === 'a' ? { content: 'long-output-' + 'x'.repeat(60000) + '-FULL_END', structuredContent: { value: ${JSON.stringify(secret)} },
    blocks: [{ type: 'image', mediaType: 'image/png', url: ${JSON.stringify(pixel)} }] } : { content: 'B' };
 } });
 api.registerTool({ name: 'parent', description: 'Nested parent', execute: async (_input, context) => {
  assert.equal(active, 0); assert.equal(done, 2); const child = await context.executeTool('child', {});
  assert.equal(child.isError, false); assert.deepEqual(child.structuredContent, { value: '[REDACTED]' }); return { content: 'nested complete' };
 } });
 api.registerTool({ name: 'child', description: 'Nested child', execute: async (_input, context) => {
  assert.notEqual(context.toolCallId, 'spoof'); await context.onProgress({ version: 1, content: ${JSON.stringify(secret)}, details: { usage: { totalTokens: 9999 } } });
  return { content: 'child', structuredContent: { value: ${JSON.stringify(secret)} }, details: { usage: { totalTokens: 9999 } } };
 } });
 api.registerTool({ name: 'mutate', description: 'Serial mutation', execute: () => { assert.equal(active, 0); assert.equal(done, 2); mutated = true; return { content: 'M' }; } });
};`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const waitUntil = async check => {
    const until = Date.now() + 8_000;
    while (!check()) { if (serverError) throw serverError; assert.ok(Date.now() < until, stdout.slice(-4000)); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const enqueue = async send => {
    for (const kind of ['steer', 'follow-up']) for (let i = 1; i <= 3; i++) await send(kind, `${kind}-${i}`);
    release.resolve();
  };
  if (mode === 'sdk') {
    registry = new ExtensionRegistry();
    if (scenario === 'tools') await registry.load('probe', (await import(pathToFileURL(extension).href)).default);
    else if (scenario === 'queues') { const workspace = new WorkspaceManager({ defaultCwd: cwd, allowedRoots: [cwd] }); await workspace.initialize(); await registerWorkspaceTools(registry, workspace); }
    sdk = await createAgentSession({ cwd, allowedRoots: [cwd], store, session: { kind: 'resume', id: session.id }, extensionRegistry: registry,
      isProjectTrusted: () => true, auth: { secrets: [secret] }, runDefaults: { maxRetries: 0, steeringMode, followUpMode },
      compaction: { settings: settings.compaction, policy: () => attempts > 0, summarize: async () => { summaries++; return { summary: 'Earlier facts compressed.', usage: { totalTokens: 3 } }; } },
      provider: { kind: 'config', config: { type: 'local', model: 'fixture-model', baseUrl: endpoint, apiKey: secret } } });
    const running = sdk.promptAndWait('initial');
    if (scenario === 'queues') { await deadline(first.promise); await enqueue((kind, content) => kind === 'steer' ? sdk.steer(content) : sdk.followUp(content)); }
    const result = await deadline(running); if (serverError) throw serverError;
    assert.equal(result.phase, 'completed', JSON.stringify(result)); await sdk.dispose(); sdk = undefined;
  } else {
    const command = process.env.AIH_RUN_COMMAND;
    const args = [...(command ? [] : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url))]),
      ...(mode === 'print' ? ['--print'] : ['regular', 'fullscreen'].includes(mode) ? ['--tui-mode', mode, '--verbose', '--theme', 'dark'] : ['--mode', mode]),
      '--offline', '--approve', '--no-mcp', '--no-extensions', '--no-context-files', '--session-dir', sessions, '--session-id', session.id,
      ...(scenario === 'tools' ? ['--tools', 'a,b,parent,child,mutate'] : scenario === 'queues' ? ['--tools', 'read'] : ['--no-tools']),
      ...(scenario === 'tools' ? ['-e', extension] : []), '--model', 'local/fixture-model', ...(['rpc', 'regular', 'fullscreen'].includes(mode) ? [] : ['initial'])];
    const env = { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, LOCAL_BASE_URL: endpoint, LOCAL_MODEL: 'fixture-model', LOCAL_API_KEY: secret, TERM: 'xterm-256color', NO_COLOR: '1' };
    if (['regular', 'fullscreen'].includes(mode)) {
      const { spawn } = await import(process.env.AIH_TEST_MODULES_ROOT
        ? pathToFileURL(path.join(process.env.AIH_TEST_MODULES_ROOT, 'node-pty/lib/index.js')).href : 'node-pty'); pty = spawn(command ?? process.execPath, args, { cwd, cols: 140, rows: 35, env });
      const ready = deferred(); pty.onData(text => { stdout += text; if (stdout.includes('editor ready')) ready.resolve(); }); pty.onExit(value => settled.resolve(value));
      await deadline(ready.promise, 'editor'); pty.write('initial\r'); await deadline(first.promise, 'provider');
      let queued = 0;
      for (const kind of ['steer', 'follow-up']) for (let i = 1; i <= 3; i++) {
        pty.write(`${kind}-${i}${kind === 'steer' ? '\r' : '\u0011'}`); queued++;
        await waitUntil(() => stdout.includes(`en file · ${queued}]`));
      }
      release.resolve();
      const final = `RUN_CONTRACT_OK_${expected.length}`;
      await waitUntil(() => attempts === expected.length && stdout.includes(final) && stdout.lastIndexOf('Enter send') > stdout.lastIndexOf(final));
      // Footer readiness is not durable settlement. Observe every billed response
      // in the actual journal before requesting the separately owned SIGTERM exit.
      const until = Date.now() + 8_000;
      for (;;) {
        const entries = (await readFile(path.join(sessions, `${session.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        if (getSessionAccounting(entries, entries.at(-1).id).active.usage.totalTokens === attempts * 5) break;
        assert.ok(Date.now() < until, 'Final provider usage was not durable'); await new Promise(resolve => setTimeout(resolve, 10));
      }
      pty.kill('SIGTERM'); assert.equal((await deadline(settled.promise, 'shutdown')).exitCode, 0);
    } else {
      child = spawn(command ?? process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('exit', (code, signal) => settled.resolve({ code, signal }));
      if (mode === 'rpc') {
        const replies = new Map(); const lines = createInterface({ input: child.stdout });
        lines.on('line', line => { const record = JSON.parse(line); records.push(record);
          if (record.id && replies.has(record.id)) { assert.equal(record.success, true, line); replies.get(record.id)(); replies.delete(record.id); }
          if (record.type === 'agent_settled') child.stdin.end();
        });
        const send = (type, data) => new Promise(resolve => { const id = `request-${replies.size}-${records.length}`; replies.set(id, resolve); child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`); });
        void send('prompt', { message: 'initial' });
        if (scenario === 'queues') { await deadline(first.promise); await enqueue((kind, content) => send(kind === 'steer' ? 'steer' : 'follow_up', { message: content })); }
      } else child.stdin.end();
      const outcome = await deadline(settled.promise); if (serverError) throw serverError;
      assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
    }
    assert.ok(stdout.includes('RUN_CONTRACT_OK'), stdout + stderr); assert.ok(!stdout.includes(secret)); assert.ok(!stderr.includes(secret));
  }
  if (serverError) throw serverError;
  if (mode === 'json' || mode === 'rpc') {
    const wire = mode === 'json' ? stdout.trim().split('\n').map(line => JSON.parse(line)) : records;
    assert.equal(wire.filter(record => record.type === 'agent_settled').length, 1);
    if (scenario === 'tools') {
      const end = wire.find(record => record.type === 'tool_execution_end' && record.toolCallId === 'call-a');
      assert.deepEqual(end.result.details.structuredContent, { value: '[REDACTED]' });
      assert.deepEqual(end.result.content.find(block => block.type === 'image'), { type: 'image', data: pixel.split(',')[1], mimeType: 'image/png' });
    }
  }
  const reloaded = new SessionManager({ store: new JsonlSessionStore(sessions) }); await reloaded.loadAllSessions();
  const raw = await reloaded.getRawEntries(session.id); const disk = await readFile(path.join(sessions, `${session.id}.jsonl`), 'utf8'); assert.ok(!disk.includes(secret));
  if (scenario === 'tools') {
    assert.equal(attempts, 2); const tools = raw.filter(entry => entry.type === 'message' && entry.role === 'tool');
    assert.deepEqual(tools.map(entry => entry.name), ['a', 'b', 'parent', 'mutate']);
    assert.ok(tools[0].blocks.find(block => block.type === 'tool_result').fullContent.includes('FULL_END'));
    assert.equal(tools[2].metadata.nestedTools[0].name, 'child'); assert.equal(tools[2].metadata.nestedTools[0].isError, false);
    assert.equal(getSessionAccounting(raw, reloaded.get(session.id).activeLeafId).active.usage.totalTokens, 10);
  } else if (scenario === 'queues') { assert.deepEqual(inputs, expected); assert.deepEqual(raw.filter(entry => entry.type === 'message' && entry.role === 'user').map(entry => entry.content), expected.at(-1)); }
  else {
    assert.equal(attempts, 2); assert.equal(summaries, 1); assert.ok(raw.some(entry => entry.type === 'custom' && entry.customType === 'run.context_recovery'));
    assert.ok(raw.some(entry => entry.type === 'compaction')); assert.ok(disk.includes('old-0:'));
    if (scenario === 'length') { assert.ok(raw.some(entry => entry.type === 'context_edit')); assert.ok(disk.includes('unfinished answer')); }
  }
  console.log('RUN_CONTRACT_OK');
} finally {
  clearTimeout(timer); release.resolve(); child?.kill('SIGKILL'); pty?.kill(); await sdk?.dispose(); await registry?.unloadAll(); server.closeAllConnections();
  await new Promise(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
}
