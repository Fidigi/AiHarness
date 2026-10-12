import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('test image contains emitted entries and declarations for every process-test dependency', async () => {
  for (const file of [
    'packages/core/dist/index.js', 'packages/core/dist/index.d.ts',
    'packages/cli/dist/index.js', 'packages/cli/dist/index.d.ts',
    'packages/server/dist/index.js', 'packages/server/dist/index.d.ts',
    'packages/server/dist/config/config-store.js', 'packages/server/dist/runtime/services.js',
  ]) {
    const target = path.join(root, file);
    assert.ok((await stat(target)).isFile(), `Missing emitted input: ${file}`);
    assert.ok((await readFile(target)).length > 0, `Empty emitted input: ${file}`);
  }
  for (const file of ['packages/cli/dist/index.js', 'packages/server/dist/web-cli.js']) {
    assert.equal((await stat(path.join(root, file))).mode & 0o777, 0o755, `Nonexecutable bin: ${file}`);
  }
});

test('emitted Core export and Server configuration module load in Node without TypeScript aliases', async () => {
  const core = await import('../packages/core/dist/index.js');
  const server = await import('../packages/server/dist/config/config-store.js');
  assert.equal(typeof core.AgentRuntime, 'function');
  assert.equal(typeof core.ExtensionRegistry, 'function');
  assert.equal(typeof server.ConfigurationStore, 'function');
});

test('emitted CLI provides inert help from outside the checkout', async () => {
  const { stdout, stderr } = await execute(process.execPath, [path.join(root, 'packages/cli/dist/index.js'), '--help'], {
    cwd: os.tmpdir(), timeout: 5000, env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(stderr, '');
  assert.match(stdout, /ai-harness \[options\]/);
  assert.match(stdout, /auth --help/);
  assert.match(stdout, /export --help/);
});
