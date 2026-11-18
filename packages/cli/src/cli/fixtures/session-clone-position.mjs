import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
assert.ok(['memory', 'durable'].includes(mode));
const root = await mkdtemp(path.join(os.tmpdir(), 'rpc-clone-position-'));
console.log(JSON.stringify({ root, mode, node: process.versions.node }));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
const entry = path.join(agent, 'position.mjs'), trace = path.join(root, 'trace.jsonl');
await mkdir(cwd); await mkdir(agent);
await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true }));
await writeFile(entry, `
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
const trace = ${JSON.stringify(trace)};
const revisions = entries => entries.filter(entry => entry.type === 'custom').map(entry => entry.data.revision);
export default api => {
  api.registerCommand('position-seed', { description: 'Select a private-only current position', handler: async (_args, context) => {
    const manager = context.sessionManager, id = context.currentSessionId;
    assert.equal(id, 'position-source'); assert.equal(manager.get(id).messages.length, 0);
    const current = await manager.appendCustomEntry(id, 'fixture:position', { revision: 1, private: 'PRIVATE_POSITION' });
    assert.equal(manager.get(id).activeLeafId, current.id);
    const copied = await manager.cloneSession(id, 'Direct Core copy'); assert.ok(copied);
    assert.deepEqual(revisions(await manager.getRawEntries(copied.id)), [1]);
    assert.deepEqual(revisions(await manager.getActiveBranchEntries(copied.id)), [1]);
    assert.equal(manager.get(id).activeLeafId, current.id);
    await appendFile(trace, JSON.stringify({ sourceId: id, currentLeafId: current.id, sourceMessages: 0, directCoreCopyId: copied.id }) + '\\n');
    return 'CURRENT_PRIVATE_POSITION_SELECTED';
  }});
  api.registerCommand('position-verify', { description: 'Inspect the RPC-selected clone through its privileged manager', handler: async (_args, context) => {
    const manager = context.sessionManager, id = context.currentSessionId;
    assert.notEqual(id, 'position-source'); assert.equal(manager.get(id).messages.length, 0);
    assert.deepEqual(revisions(await manager.getRawEntries(id)), [1], 'Raw conservation must pass before the active reader');
    const active = await manager.getActiveBranchEntries(id);
    assert.deepEqual(revisions(active), [1]); assert.equal(active.at(-1).id, manager.get(id).activeLeafId);
    assert.equal(active.at(-1).data.private, 'PRIVATE_POSITION');
    assert.ok(!JSON.stringify(manager.getEffectiveContext(id)).includes('PRIVATE_POSITION'));
    assert.deepEqual(revisions(await manager.getActiveBranchEntries('position-source')), [1]);
    await appendFile(trace, JSON.stringify({ verifiedId: id, verifiedLeaf: manager.get(id).activeLeafId,
      sourceLeaf: manager.get('position-source').activeLeafId, inventory: manager.list().map(session => session.id) }) + '\\n');
    return 'RPC_PRIVATE_POSITION_VERIFIED';
  }});
};
`);
const cli = process.env.AIH_STATE_CLI ?? fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const child = spawn(process.env.AIH_STATE_COMMAND ?? process.execPath, [
  ...(process.env.AIH_STATE_COMMAND ? [] : [cli]), '--mode', 'rpc', '--offline', '--approve',
  '--no-context-files', '--no-extensions', '-e', entry, '--model', 'mock/mock-model', '--session-dir', sessions,
  '--session-id', 'position-source', ...(mode === 'memory' ? ['--no-session'] : []),
], { cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1' },
  stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '', passed = false, sequence = 0;
const pending = new Map(), output = [];
child.stderr.on('data', value => { stderr += value; });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const value = JSON.parse(line); output.push(value);
  if (value.type === 'response' && pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); }
});
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
const deadline = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 5_000);
  })]).finally(() => clearTimeout(timer));
};
const request = async (type, fields = {}) => {
  const id = `position-${++sequence}`, response = new Promise(resolve => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ type, id, ...fields }) + '\n'); return deadline(response, type + '/' + stderr);
};
try {
  const seed = await request('prompt', { message: '/position-seed' });
  assert.equal(seed.success, true, JSON.stringify({ seed, stderr })); assert.equal(seed.data.disposition, 'handled');
  const selected = JSON.parse((await readFile(trace, 'utf8')).trim());
  assert.equal(selected.sourceMessages, 0); assert.ok(selected.currentLeafId); assert.ok(selected.directCoreCopyId);
  const file = path.join(sessions, 'position-source.jsonl');
  const original = mode === 'durable' ? await readFile(file) : undefined;
  const entries = await request('get_entries'); assert.equal(entries.success, true);
  assert.equal(entries.data.leafId, selected.currentLeafId);
  assert.ok(entries.data.entries.some(item => item.type === 'custom' && item.id === selected.currentLeafId));
  const clone = await request('clone');
  assert.equal(clone.success, true, JSON.stringify({ clone, selected, stderr })); assert.equal(clone.data.cancelled, false);
  const copied = await request('get_entries'); assert.equal(copied.success, true);
  assert.notEqual(copied.data.leafId, selected.currentLeafId);
  const leaf = copied.data.entries.find(item => item.id === copied.data.leafId); assert.equal(leaf.type, 'custom');
  assert.equal(Object.hasOwn(leaf, 'data'), false, 'Private custom data is absent from the RPC projection');
  const verify = await request('prompt', { message: '/position-verify' });
  assert.equal(verify.success, true, JSON.stringify({ verify, stderr })); assert.equal(verify.data.disposition, 'handled');
  const verified = JSON.parse((await readFile(trace, 'utf8')).trim().split('\n').at(-1));
  assert.equal(verified.verifiedLeaf, copied.data.leafId); assert.equal(verified.sourceLeaf, selected.currentLeafId);
  assert.notEqual(verified.verifiedId, selected.directCoreCopyId); assert.equal(verified.inventory.length, 3);
  if (original) assert.deepEqual(await readFile(file), original);
  child.stdin.end(); assert.deepEqual(await deadline(exited, 'clean EOF'), { code: 0, signal: null }, stderr);
  assert.equal(output.filter(value => value.type === 'extension_error').length, 0);
  passed = true; console.log('RPC_CURRENT_PRIVATE_POSITION_CLONE_OK');
} finally {
  if (!passed) child.kill('SIGKILL');
  else await rm(root, { recursive: true, force: true });
}
