import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.env.AIH_RPC_CLI ?? fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const scenario = process.argv[2];
assert.ok(['boundary', 'held-overflow'].includes(scenario));
const root = await mkdtemp(path.join(tmpdir(), 'rpc-input-probe-'));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
const marker = path.join(root, 'lifecycle.txt');
let child;
try {
  await mkdir(cwd); await mkdir(agent);
  const extension = path.join(agent, 'held.mjs');
  await writeFile(extension, `import { appendFile } from 'node:fs/promises';
    export default api => {
      api.registerProvider('held', { defaultConfig: { model: 'held-model' }, create(config) { return {
        config, validateConfig() { return true; }, getProviderType() { return 'held'; },
        getConfiguredModel() { return 'held-model'; }, setConfiguredModel() {},
        async streamChat(_messages, onChunk, _complete, onError, options) {
          await onChunk('admitted');
          await new Promise(resolve => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener('abort', resolve, { once: true });
          });
          await appendFile(${JSON.stringify(marker)}, 'provider-stopped\\n');
          onError(new Error('Fixture stopped'));
        }
      }; } });
      return async () => { await appendFile(${JSON.stringify(marker)}, 'extension-closed\\n'); };
    };`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|^AI_HARNESS_|^AIH_/.test(key)));
  const args = ['--mode', 'rpc', '--offline', '--no-context-files', '--no-extensions', '--no-tools',
    '--no-skills', '--no-prompt-templates', '--approve', '--session-dir', sessions, '--session-id', 'probe',
    ...(scenario === 'held-overflow' ? ['--extension', extension, '--provider', 'held', '--model', 'held-model'] : ['--model', 'mock/mock-model'])];
  child = spawn(process.execPath, [cli, ...args], {
    cwd, env: { ...env, HOME: root, AI_HARNESS_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const records = [];
  let tail = '';
  let notify = () => {};
  child.stdout.on('data', chunk => {
    stdout += chunk.toString(); tail += chunk.toString();
    while (tail.includes('\n')) {
      const end = tail.indexOf('\n'); records.push(JSON.parse(tail.slice(0, end))); tail = tail.slice(end + 1);
    }
    notify();
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let inputFailure;
  child.stdin.on('error', error => { inputFailure = error.code; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { resolve({ code, signal }); notify(); });
  });
  const deadline = (promise, label) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`RPC probe timed out: ${label}`)), 8000);
    })]).finally(() => clearTimeout(timer));
  };
  const waitFor = async predicate => {
    while (!predicate()) {
      assert.equal(child.exitCode, null, `RPC exited early: ${stderr}`);
      await deadline(new Promise(resolve => { notify = resolve; }), 'record');
    }
  };
  const write = async buffer => {
    for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
      if (!child.stdin.write(buffer.subarray(offset, offset + 64 * 1024))) {
        await deadline(once(child.stdin, 'drain'), 'input drain');
      }
    }
  };
  if (scenario === 'boundary') {
    // Retired input cannot create messages, even when interleaved with canonical commands.
    await write(Buffer.from(JSON.stringify({ id: 'retired', method: 'chat.send', params: { content: 'must-not-run' } }) + '\n'));
    const exact = Buffer.alloc(32 * 1024 * 1024, 32);
    Buffer.from(JSON.stringify({ type: 'get_messages', id: 'exact' })).copy(exact);
    await write(exact); await write(Buffer.from('\r\n'));
    const utf8 = Buffer.from(JSON.stringify({ type: 'get_state', id: 'é😀\u2028\u2029' }));
    for (const byte of utf8) child.stdin.write(Buffer.from([byte]));
    child.stdin.end(); // Final non-LF frame is valid.
    const result = await deadline(exited, 'clean EOF');
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, ''); assert.equal(inputFailure, undefined);
    assert.equal(tail, ''); assert.equal(records.length, 3);
    assert.deepEqual(records[0], { error: { code: 'INVALID_REQUEST', message: 'Legacy method/params RPC is not supported. Use type commands.' } });
    assert.deepEqual(records[1], { id: 'exact', type: 'response', command: 'get_messages', success: true, data: { messages: [] } });
    assert.equal(records[2].id, 'é😀\u2028\u2029'); assert.equal(records[2].success, true);
  } else {
    await write(Buffer.from(JSON.stringify({ type: 'prompt', id: 'accepted', message: 'accepted' }) + '\n'));
    await waitFor(() => records.some(record => record.type === 'message_update'));
    const rejected = Buffer.alloc(32 * 1024 * 1024 + 1, 32);
    Buffer.from(JSON.stringify({ type: 'prompt', id: 'refused-private-marker', message: 'must-not-run' })).copy(rejected);
    await write(rejected); // No LF: the overflow must be detected during accumulation.
    child.stdin.end();
    const result = await deadline(exited, 'fatal overflow cleanup');
    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(stderr, /RPC_FRAME_TOO_LARGE/);
    assert.ok(!stdout.includes('refused-private-marker') && !stderr.includes('refused-private-marker'));
    assert.ok(!stdout.includes('must-not-run') && !stderr.includes('must-not-run'));
    assert.equal(await readFile(marker, 'utf8'), 'provider-stopped\nextension-closed\n');
    const journal = (await readFile(path.join(sessions, 'probe.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(journal.filter(entry => entry.type === 'message' && entry.role === 'user').map(entry => entry.content), ['accepted']);
  }
  console.log(`RPC_INPUT_OK ${scenario}`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
