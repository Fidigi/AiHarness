import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';

const cli = process.env.AIH_NAVIGATION_CLI ?? fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const allScenarios = ['plain', 'summary', 'abort', 'eof'];
const scenarios = process.argv[2] ? [process.argv[2]] : allScenarios;
assert.ok(scenarios.every(scenario => allScenarios.includes(scenario)));
const summaries = [];
for (const scenario of scenarios) {
  const root = await mkdtemp(path.join(tmpdir(), 'navigation-process-'));
  let child;
  const requests = [];
  let heldClosed = 0;
  let gotRequest;
  const requested = new Promise(resolve => { gotRequest = resolve; });
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    const body = JSON.parse(text);
    requests.push(body);
    gotRequest();
    assert.ok(!body.tools?.length, 'No executable tool declarations in a summary request');
    if (scenario === 'abort' || scenario === 'eof') {
      response.on('close', () => { if (!response.writableEnded) heldClosed++; });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'synthetic-summary', object: 'chat.completion', model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic navigation summary.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const deadline = (promise, label) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${scenario}/${label}`)), 5_000);
    })]).finally(() => clearTimeout(timer));
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    await mkdir(cwd); await mkdir(agent);
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, enabledModels: ['local/*'],
      branchSummary: { reserveTokens: 8_192 } }));
    const manager = new SessionManager({ store: new JsonlSessionStore(sessions) });
    const session = await manager.create({ title: 'Native navigation', cwd });
    await manager.addMessage(session.id, { role: 'user', content: 'Common root' });
    await manager.appendCustomEntry(session.id, 'state', { privateData: 'Never send this extension state' });
    await manager.appendCustomMessage(session.id, 'notice', 'Useful custom context', { display: false,
      details: { privateDetail: 'Never send these details' } });
    const target = session.activeLeafId;
    await manager.addMessage(session.id, { role: 'user', content: 'Abandoned request' });
    await manager.addMessage(session.id, { role: 'assistant', content: 'Reading the abandoned branch',
      toolCalls: [{ id: 'observed-only', name: 'read', input: { path: 'not-executed-by-this-probe' } }] });
    await manager.addMessage(session.id, { role: 'tool', toolCallId: 'observed-only', content: 'Recorded inert tool result' });
    await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned outcome' });
    const source = session.activeLeafId;
    const port = server.address().port;
    const command = process.env.AIH_NAVIGATION_COMMAND;
    child = spawn(command ?? process.execPath, [...(command ? [] : [cli]), '--mode', 'rpc', '--offline', '--no-approve', '--no-extensions',
      '--no-context-files', '--model', 'local/fixture-model', '--session-dir', sessions, '--session-id', session.id], {
      cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
        LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, LOCAL_MODEL: 'fixture-model', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const records = [];
    const waiting = new Map();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const record = JSON.parse(line);
      records.push(record);
      if (record.type === 'response' && waiting.has(record.id)) {
        waiting.get(record.id)(record); waiting.delete(record.id);
      }
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const rpc = request => {
      const response = new Promise(resolve => waiting.set(request.id, resolve));
      child.stdin.write(`${JSON.stringify(request)}\n`);
      return deadline(response, request.id);
    };
    const initial = await rpc({ type: 'get_tree', id: 'initial' });
    assert.equal(initial.success, true, JSON.stringify({ initial, stderr }));
    assert.equal(initial.data.leafId, source);
    const navigation = rpc({ type: 'navigate_tree', id: 'navigation', entryId: target,
      ...(scenario !== 'plain' ? { summarize: true, customInstructions: 'Preserve observed failures' } : {}) });
    if (scenario === 'abort' || scenario === 'eof') {
      await deadline(requested, 'provider request');
      if (scenario === 'abort') assert.equal((await rpc({ type: 'abort', id: 'abort' })).success, true);
      else child.stdin.end();
    }
    const response = await navigation;
    assert.equal(response.success, true, JSON.stringify({ response, stderr }));
    assert.equal(response.data.cancelled, scenario === 'abort' || scenario === 'eof');
    if (scenario !== 'eof') child.stdin.end();
    assert.deepEqual(await deadline(exited, 'exit'), { code: 0, signal: null }, stderr);
    assert.equal(requests.length, scenario === 'plain' ? 0 : 1);
    const reloaded = new SessionManager({ store: new JsonlSessionStore(sessions) });
    await reloaded.loadFromStore(session.id);
    const raw = await reloaded.getRawEntries(session.id);
    assert.ok(raw.some(entry => entry.id === source), 'Abandoned history survives navigation');
    const context = reloaded.getEffectiveContext(session.id).map(entry => entry.content);
    const branchSummaries = raw.filter(entry => entry.type === 'branch_summary');
    if (scenario === 'summary') {
      assert.equal(branchSummaries.length, 1);
      assert.equal(branchSummaries[0].parentEntryId, target);
      assert.equal(branchSummaries[0].fromEntryId, source);
      assert.equal(branchSummaries[0].provider, 'local');
      assert.equal(branchSummaries[0].model, 'fixture-model');
      assert.equal(branchSummaries[0].usage.inputTokens, 19);
      assert.deepEqual(context, ['Common root', '[Custom Message: notice]\nUseful custom context',
        '[Branch Summary: Native navigation]\nSynthetic navigation summary.']);
      const serialized = JSON.stringify(requests[0].messages);
      assert.ok(serialized.includes('Abandoned outcome'));
      assert.ok(serialized.includes('Recorded inert tool result'));
      assert.ok(!serialized.includes('Never send'));
    } else if (scenario === 'plain') {
      assert.deepEqual(context, ['Common root', '[Custom Message: notice]\nUseful custom context']);
      assert.equal(branchSummaries.length, 0);
    } else {
      assert.equal(reloaded.get(session.id).activeLeafId, source);
      assert.equal(branchSummaries.length, 0);
      await deadline(new Promise(resolve => {
        const check = () => heldClosed > 0 ? resolve() : setTimeout(check, 5);
        check();
      }), 'held socket closure');
    }
    summaries.push({ scenario, requests: requests.length, cancelled: response.data.cancelled,
      summaries: branchSummaries.length, heldClosed, exit: 0 });
    console.log(JSON.stringify(summaries.at(-1)));
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ result: 'SESSION_NAVIGATION_PROCESS_OK', node: process.versions.node, cases: summaries.length }));
