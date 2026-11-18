import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { JsonlSessionStore, SessionManager, serializeSession, createAgentSession } from '@ai-harness/core';

const mode = process.argv[2];
assert.ok(['print', 'json', 'rpc', 'sdk'].includes(mode));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-session-context-'));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
const requests = [], sockets = new Set();
let serverError, child, sdk;
const server = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) { text += chunk; assert.ok(text.length < 2_000_000); }
    const body = JSON.parse(text); requests.push(body);
    assert.ok(!text.includes('ORIGINAL_ANSWER')); assert.ok(!text.includes('PRIVATE_OLD_SYSTEM'));
    assert.ok(text.includes('REPLACEMENT_ANSWER'));
    if (body.stream) {
      assert.ok(text.includes('PRIVATE_CURRENT_SYSTEM'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }], model: 'fixture-model',
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Summary' }, finish_reason: 'stop' }], model: 'fixture-model',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    }
  } catch (error) { serverError = error; response.writeHead(500); response.end('Invalid fixture request'); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
let timer;
const deadline = promise => Promise.race([promise, new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error('Context state process deadline')), 8_000);
})]).finally(() => clearTimeout(timer));
try {
  await mkdir(cwd); await mkdir(agent);
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ sessionDir: sessions, compaction: { enabled: false } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const store = new JsonlSessionStore(sessions), manager = new SessionManager({ store });
  const session = await manager.create({ cwd });
  await manager.addMessage(session.id, { role: 'user', content: 'Root' });
  await manager.addMessage(session.id, { role: 'assistant', content: 'ORIGINAL_ANSWER', usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 } });
  const target = session.activeLeafId;
  await manager.addMessage(session.id, { role: 'user', content: 'Kept user' });
  await manager.addMessage(session.id, { role: 'assistant', content: 'Kept answer' });
  await manager.recordSessionLoadout(session.id, { provider: 'local', model: 'fixture-model', thinking: null,
    systemPrompt: 'PRIVATE_OLD_SYSTEM', tools: [] });
  if (mode !== 'rpc') await manager.appendContextEdit(session.id, { targetEntryId: target, replacement: 'REPLACEMENT_ANSWER' });
  if (mode === 'sdk') {
    sdk = await createAgentSession({ cwd, allowedRoots: [root], store, session: { kind: 'resume', id: session.id }, isProjectTrusted: () => true,
      provider: { kind: 'config', config: { type: 'local', model: 'fixture-model', baseUrl: endpoint } } });
    await sdk.editContext({ targetEntryId: target, replacement: 'REPLACEMENT_ANSWER' });
    assert.equal((await sdk.promptAndWait('Next', { systemPrompt: 'PRIVATE_CURRENT_SYSTEM', model: 'fixture-model' })).phase, 'completed');
    assert.ok(!JSON.stringify(sdk.exportSession()).includes('PRIVATE_CURRENT_SYSTEM'));
    await sdk.dispose(); sdk = undefined;
  } else {
    const command = process.env.AIH_CONTEXT_STATE_COMMAND;
    child = spawn(command ?? process.execPath, [...(command ? [] : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url))]),
      ...(mode === 'print' ? ['--print'] : ['--mode', mode]), '--offline', '--no-approve', '--no-context-files', '--no-tools',
      '--model', 'local/fixture-model', '--session-id', session.id, '--system-prompt', 'PRIVATE_CURRENT_SYSTEM', ...(mode === 'rpc' ? [] : ['Next'])], {
      cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, LOCAL_BASE_URL: endpoint,
        LOCAL_MODEL: 'fixture-model', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    if (mode === 'rpc') {
      const waiting = new Map(), records = [], eventWaiters = [];
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        const record = JSON.parse(line); records.push(record); assert.ok(records.length < 256);
        if (record.id && waiting.has(record.id)) { waiting.get(record.id)(record); waiting.delete(record.id); }
        for (const waiter of eventWaiters.splice(0)) waiter();
      });
      let sequence = 0;
      const send = async (type, fields = {}) => {
        const id = `request-${sequence++}`, result = new Promise(resolve => waiting.set(id, resolve));
        child.stdin.write(JSON.stringify({ type, id, ...fields }) + '\n');
        const response = await deadline(result); assert.equal(response.success, true, JSON.stringify(response)); return response.data;
      };
      await send('context_edit', { targetEntryId: target, replacement: 'REPLACEMENT_ANSWER' });
      await send('prompt', { message: 'Next' });
      while (!records.some(record => record.type === 'agent_settled')) {
        await deadline(new Promise(resolve => eventWaiters.push(resolve)));
      }
      await send('compact');
      const entries = await send('get_entries');
      assert.ok(entries.entries.some(entry => entry.type === 'context_edit'));
      assert.ok(!JSON.stringify(entries).includes('PRIVATE_CURRENT_SYSTEM'));
      assert.ok(!JSON.stringify(entries).includes('PRIVATE_OLD_SYSTEM'));
      child.stdin.end();
    } else child.stdin.end();
    assert.deepEqual(await deadline(exited), { code: 0, signal: null }, stderr);
    if (mode === 'print') assert.equal(stdout, 'Done\n');
    if (mode === 'json') assert.ok(stdout.trim().split('\n').map(line => JSON.parse(line)).some(record => record.type === 'agent_end'));
  }
  assert.equal(serverError, undefined, String(serverError)); assert.equal(requests.length, mode === 'rpc' ? 2 : 1);
  const reload = new SessionManager({ store }); await reload.loadFromStore(session.id);
  const raw = await reload.getRawEntries(session.id);
  assert.ok(raw.some(entry => entry.type === 'message' && entry.content === 'ORIGINAL_ANSWER'));
  assert.ok(raw.some(entry => entry.type === 'context_edit'));
  const effectiveSystem = requests.find(request => request.stream).messages.find(message => message.role === 'system').content;
  assert.ok(effectiveSystem.includes('PRIVATE_CURRENT_SYSTEM'));
  assert.equal(reload.getSessionLoadout(session.id).systemPrompt, effectiveSystem);
  if (mode !== 'rpc') await reload.applyCompaction(session.id, 'Summary', reload.get(session.id).messages.at(-2).id);
  const compact = (await reload.getRawEntries(session.id)).findLast(entry => entry.type === 'compaction');
  assert.equal(compact.checkpoint.loadout.systemPrompt, effectiveSystem);
  const clone = await reload.cloneSession(session.id);
  assert.equal(reload.getSessionLoadout(clone.id).systemPrompt, effectiveSystem);
  assert.ok(!JSON.stringify(serializeSession(clone)).includes('PRIVATE_CURRENT_SYSTEM'));
  console.log('session context state OK');
} finally {
  clearTimeout(timer); await sdk?.dispose(); if (child?.exitCode === null) child.kill('SIGKILL');
  for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
