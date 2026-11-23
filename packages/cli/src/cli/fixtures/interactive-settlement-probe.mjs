import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { spawn } = await import(process.env.AIH_TEST_PTY_MODULE ?? 'node-pty');
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';

const [mode] = process.argv.slice(2);
assert.ok(['regular', 'fullscreen'].includes(mode));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-interactive-settlement-'));
const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
await mkdir(cwd); await mkdir(agent);
const entered = path.join(root, 'append-entered'), received = path.join(root, 'term-received'), release = path.join(root, 'release-append');
const receipt = path.join(root, 'shutdown-receipt'), extension = path.join(agent, 'held-write.mjs');
await writeFile(extension, `import { readFile, writeFile } from 'node:fs/promises';
import { JsonlSessionStore, SessionManager } from ${JSON.stringify(import.meta.resolve('@ai-harness/core'))};
export default api => {
  const original = JsonlSessionStore.prototype.saveSession;
  JsonlSessionStore.prototype.saveSession = async function(...args) {
    if (args[0].messages.some(message => message.role === 'user')) {
      await writeFile(${JSON.stringify(entered)}, 'entered');
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => { void readFile(${JSON.stringify(release)}).then(() => {
          clearInterval(timer); resolve();
        }).catch(error => { if (error.code !== 'ENOENT') { clearInterval(timer); reject(error); } }); }, 10);
      });
    }
    return original.apply(this, args);
  };
  process.once('SIGTERM', () => { void writeFile(${JSON.stringify(received)}, 'received'); });
  api.on('system:shutdown', async () => {
    const manager = new SessionManager({ store: new JsonlSessionStore(${JSON.stringify(sessions)}) });
    await manager.loadFromStore('interactive-settlement');
    await writeFile(${JSON.stringify(receipt)}, JSON.stringify(manager.get('interactive-settlement').messages.map(message => [message.role, message.content])));
  });
};`);
const wait = async predicate => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Interactive settlement witness deadline exceeded. Output: ${output.slice(-5_000)}`);
};
const exists = file => readFile(file).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
let terminal, exit, output = '';
try {
  terminal = spawn(process.env.AIH_SETTLEMENT_COMMAND ?? process.execPath, [
    ...(process.env.AIH_SETTLEMENT_COMMAND ? [] : [fileURLToPath(new URL('../../../dist/index.js', import.meta.url))]),
    '--offline', '--no-approve', '--no-extensions', '-e', extension, '--no-context-files', '--no-tools',
    '--model', 'mock/mock-model', '--session-dir', sessions, '--session-id', 'interactive-settlement', '--tui-mode', mode,
    'Must finish admitted append.'], { cwd, cols: 100, rows: 30,
    env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, TERM: 'xterm-256color', NO_COLOR: '1' } });
  terminal.onData(text => { output += text; assert.ok(output.length < 100_000, `PTY output budget exceeded: ${output.slice(0, 5_000)}`); });
  terminal.onExit(value => { exit = value; });
  await wait(() => exists(entered)); terminal.kill('SIGTERM'); await wait(() => exists(received));
  await writeFile(release, 'finish'); await wait(() => exit);
  assert.equal(exit.exitCode, 0, JSON.stringify({ exit, output })); assert.equal(exit.signal ?? 0, 0);
  const expected = [['user', 'Must finish admitted append.']];
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), expected, 'host shutdown must follow durable input settlement');
  const manager = new SessionManager({ store: new JsonlSessionStore(sessions) }); await manager.loadFromStore('interactive-settlement');
  assert.deepEqual(manager.get('interactive-settlement').messages.map(message => [message.role, message.content]), expected);
  console.log('INTERACTIVE_SETTLEMENT_OK');
} finally {
  await writeFile(release, 'finish');
  if (terminal && !exit) { terminal.kill('SIGKILL'); await wait(() => exit); }
  await rm(root, { recursive: true, force: true });
}
