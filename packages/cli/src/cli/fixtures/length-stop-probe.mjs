import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';

const [mode, kind] = process.argv[2].split('/');
assert.ok(['print', 'json', 'rpc'].includes(mode));
assert.ok(['partial-length', 'empty-length', 'normal', 'empty-normal', 'multiple'].includes(kind));
const limited = kind.endsWith('-length') || kind === 'multiple';
const text = kind.startsWith('empty-') ? '' : 'Retained fragment 字🙂';
const warning = 'Warning: Model output limit reached; the response may be incomplete.\n';
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-length-stop-'));
const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
await mkdir(cwd); await mkdir(agent);
let child, calls = 0, fixtureError;
const server = createServer(async (request, response) => {
  try {
    let wire = '';
    for await (const chunk of request) { wire += chunk; assert.ok(wire.length < 100_000); }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    const body = JSON.parse(wire);
    assert.equal(body.stream, true);
    const first = calls++ === 0;
    const content = first ? text : 'Complete follow-up';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: first && limited ? 'length' : 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { fixtureError = error; response.writeHead(500); response.end(); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
  const args = ['--offline', '--no-approve', '--no-extensions', '--no-context-files', '--no-tools',
    '--model', 'local/length-fixture', '--session-dir', sessions, '--session-id', 'length-probe',
    ...(mode === 'print' ? ['-p'] : ['--mode', mode]),
    ...(mode === 'rpc' ? [] : ['The word length is not a stop reason.', ...(kind === 'multiple' ? ['Second prompt.'] : [])])];
  child = spawn(process.env.AIH_LENGTH_COMMAND || process.execPath,
    process.env.AIH_LENGTH_COMMAND ? args : [cli, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
        NO_COLOR: '1', LOCAL_MODEL: 'length-fixture', LOCAL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } });
  let stdout = '', stderr = '', pending = '', settled = 0;
  const events = [];
  let protocolError;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
    if (mode !== 'rpc') return;
    pending += chunk;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const record = JSON.parse(line); events.push(record);
        if (record.type === 'agent_settled') {
          settled++;
          if (settled === 1) child.stdin.write(JSON.stringify({ type: 'get_messages', id: 'history' }) + '\n');
          else child.stdin.end();
        }
        if (record.type === 'response' && record.id === 'history') {
          child.stdin.write(JSON.stringify({ type: 'prompt', id: 'second', message: 'Complete follow-up' }) + '\n');
        }
      } catch (error) { protocolError = error; child.stdin.end(); }
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  if (mode === 'rpc') child.stdin.write(JSON.stringify({ type: 'prompt', id: 'first', message: 'The word length is not a stop reason.' }) + '\n');
  else child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(fixtureError, undefined);
  assert.equal(protocolError, undefined);
  assert.deepEqual(exit, { code: limited && mode !== 'rpc' ? 1 : 0, signal: null }, JSON.stringify({ mode, kind, exit, stdout, stderr }));
  assert.equal(stderr, limited && mode !== 'rpc' ? warning : '');
  assert.equal(calls, mode === 'rpc' || kind === 'multiple' ? 2 : 1);
  if (mode === 'print') assert.equal(stdout, (kind === 'multiple' ? 'Complete follow-up' : text) + '\n');
  else {
    const records = mode === 'rpc' ? events : stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.every(record => typeof record.type === 'string'));
    const assistants = records.filter(record => record.type === 'message_end' && record.message.role === 'assistant');
    assert.equal(assistants.length, calls);
    assert.equal(assistants[0].message.stopReason, limited ? 'length' : 'stop');
    assert.equal(assistants[0].message.content.filter(block => block.type === 'text').map(block => block.text).join(''), text);
    assert.equal(assistants[0].message.usage.totalTokens, 10);
    assert.equal(records.filter(record => record.type === 'agent_settled').length, calls);
    assert.equal(records.filter(record => record.type === 'agent_end').length, calls);
    if (mode === 'json') assert.equal(records[0].version, 3);
    if (mode === 'rpc') {
      assert.equal(pending, '');
      const history = records.find(record => record.type === 'response' && record.id === 'history');
      assert.equal(history.success, true);
      const stored = history.data.messages.find(message => message.role === 'assistant');
      if (text || limited) assert.equal(stored.stopReason, limited ? 'length' : 'stop');
      else assert.equal(stored, undefined);
      assert.ok(records.some(record => record.type === 'response' && record.id === 'second' && record.success));
      assert.equal(assistants[1].message.stopReason, 'stop');
    }
  }
  const manager = new SessionManager({ store: new JsonlSessionStore(sessions) });
  await manager.loadFromStore('length-probe');
  const firstAssistant = manager.get('length-probe').messages.find(message => message.role === 'assistant');
  // An empty ordinary completion is intentionally not persisted; an empty capped one is.
  if (text || limited) {
    assert.equal(firstAssistant.content, text);
    assert.equal(firstAssistant.metadata?.stopReason, limited ? 'length' : undefined);
    assert.equal(firstAssistant.usage.totalTokens, 10);
  }
  console.log(JSON.stringify({ result: 'LENGTH_STOP_OK', mode, kind, calls, exit: exit.code }));
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
