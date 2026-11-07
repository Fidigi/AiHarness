import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';

const [mode, signal, phase = 'provider'] = process.argv[2].split('/');
assert.ok(['print', 'json', 'rpc'].includes(mode));
assert.ok(['SIGINT', 'SIGTERM'].includes(signal));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-headless-signal-'));
const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
await mkdir(cwd); await mkdir(agent);
const cleanup = path.join(root, 'cleanup.txt'), extension = path.join(agent, 'observer.mjs');
const secondSignal = signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT';
const ready = path.join(root, 'cleanup-ready'), admissionReady = path.join(root, 'admission-ready');
await writeFile(extension, `import { writeFile } from 'node:fs/promises';
export default api => {
  if (${JSON.stringify(phase)} === 'admission') api.before('before:agent', async data => {
    const keepAlive = setInterval(() => {}, 1_000);
    data.signal.addEventListener('abort', () => clearInterval(keepAlive), { once: true });
    await writeFile(${JSON.stringify(admissionReady)}, 'ready');
    // The privileged promise ignores abort; its host continuation must be retired.
    await new Promise(() => {});
  });
  api.on('system:shutdown', async () => {
  const before = process.listenerCount(${JSON.stringify(secondSignal)});
  // A pending signal promise alone does not keep Node's event loop alive.
  // This fixture owns a referenced handle until its bounded parent releases it.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const received = new Promise(resolve => process.once(${JSON.stringify(secondSignal)}, resolve));
    await writeFile(${JSON.stringify(ready)}, 'ready');
    await received;
    const after = process.listenerCount(${JSON.stringify(secondSignal)});
    await writeFile(${JSON.stringify(cleanup)}, JSON.stringify({ before, after }));
  } finally { clearInterval(keepAlive); }
}); };`);
let child, repetitionTimer, calls = 0, fixtureError, transportClosed = false, signalled = false, repeated = false;
function interrupt() {
  if (signalled) return;
  signalled = true;
  assert.equal(child.kill(signal), true);
}
const server = createServer(async (request, response) => {
  try {
    let wire = '';
    for await (const chunk of request) { wire += chunk; assert.ok(wire.length < 100_000); }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(JSON.parse(wire).stream, true);
    calls++;
    response.on('close', () => { transportClosed = true; });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Held fragment 字🙂' }, finish_reason: null }] })}\n\n`);
    // Print deliberately has no incremental stdout; request admission witnesses
    // its live provider. JSON additionally waits for a delivered text record.
    if (mode === 'print') interrupt();
  } catch (error) { fixtureError = error; response.destroy(); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
  const args = ['--offline', '--no-approve', '--no-extensions', '-e', extension, '--no-context-files', '--no-tools',
    '--model', 'local/signal-fixture', '--session-dir', sessions, '--session-id', 'signal-probe',
    ...(mode === 'print' ? ['--print'] : ['--mode', mode]),
    ...(mode === 'rpc' ? [] : ['First prompt.', 'Must never start.'])];
  child = spawn(process.env.AIH_SIGNAL_COMMAND || process.execPath,
    process.env.AIH_SIGNAL_COMMAND ? args : [cli, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
        NO_COLOR: '1', LOCAL_MODEL: 'signal-fixture', LOCAL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } });
  let stdout = '', stderr = '', pending = '', protocolError;
  const records = [];
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
    assert.ok(stdout.length < 100_000);
    if (mode === 'print') return;
    pending += chunk;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const record = JSON.parse(line); records.push(record);
        if (record.type === 'message_update' && record.assistantMessageEvent?.type === 'text_delta') interrupt();
      } catch (error) { protocolError = error; child.kill('SIGKILL'); }
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  // The async shutdown hook is held at an actual file barrier, not a sleep.
  // Its one-shot observer also checks that the host still owns the signal.
  repetitionTimer = setInterval(() => {
    if (phase === 'admission') void readFile(admissionReady).then(interrupt)
      .catch(error => { if (error.code !== 'ENOENT') fixtureError ??= error; });
    void readFile(ready).then(() => {
      if (repeated) return;
      repeated = true;
      assert.equal(child.kill(secondSignal), true);
    }).catch(error => { if (error.code !== 'ENOENT') fixtureError ??= error; });
  }, 10);
  if (mode === 'rpc') child.stdin.write(JSON.stringify({ type: 'prompt', id: 'start', message: 'First prompt.' }) + '\n');
  else child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, nativeSignal) => resolve({ code, signal: nativeSignal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(fixtureError, undefined);
  assert.equal(protocolError, undefined);
  assert.equal(signalled, true, JSON.stringify({ exit, stdout, stderr }));
  const expectedCode = signal === 'SIGINT' ? 130 : 143;
  assert.deepEqual(exit, { code: expectedCode, signal: null }, JSON.stringify({ exit, stdout, stderr }));
  assert.equal(stderr, 'Error: Request interrupted.\n');
  assert.equal(repeated, true);
  assert.equal(calls, phase === 'admission' ? 0 : 1);
  assert.equal(transportClosed, phase !== 'admission');
  const listeners = JSON.parse(await readFile(cleanup, 'utf8'));
  assert.ok(listeners.before >= 1 && listeners.after >= 1, 'owned signal handlers must survive async cleanup');
  if (mode === 'print') assert.equal(stdout, '');
  else {
    assert.equal(pending, '');
    if (mode === 'json') { assert.equal(records[0].type, 'session'); assert.equal(records[0].version, 3); }
    else assert.ok(records.some(record => record.type === 'response' && record.id === 'start'
      && record.success === (phase !== 'admission')));
    if (phase === 'admission') {
      assert.equal(records.some(record => record.type === 'agent_start' || record.type === 'agent_settled'), false);
    } else {
    assert.equal(records.filter(record => record.type === 'agent_end').length, 1);
    assert.equal(records.filter(record => record.type === 'agent_settled').length, 1);
    assert.equal(records.at(-1).type, 'agent_settled');
    const assistant = records.find(record => record.type === 'message_end' && record.message.role === 'assistant');
    assert.equal(assistant.message.stopReason, 'aborted');
    assert.equal(assistant.message.content.filter(block => block.type === 'text').map(block => block.text).join(''), 'Held fragment 字🙂');
    }
  }
  const manager = new SessionManager({ store: new JsonlSessionStore(sessions) });
  await manager.loadFromStore('signal-probe');
  assert.deepEqual(manager.get('signal-probe').messages.map(message => [message.role, message.content]),
    phase === 'admission' ? [] : [['user', 'First prompt.']]);
  console.log(JSON.stringify({ result: 'HEADLESS_SIGNAL_OK', mode, signal, exit: exit.code }));
} finally {
  clearInterval(repetitionTimer);
  if (child && child.exitCode === null) child.kill('SIGKILL');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
