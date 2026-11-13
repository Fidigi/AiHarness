import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runWebBuild } from '../packages/web/scripts/build.mjs';
import { runTypeScript } from '../scripts/run-typescript.mjs';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('Docker context excludes checkout Git metadata, whether a directory or pointer file', async () => {
  await assert.rejects(lstat(path.join(root, '.git')), { code: 'ENOENT' });
});

test('test image contains emitted entries and declarations for every process-test dependency', async () => {
  for (const file of [
    'packages/core/dist/index.js', 'packages/core/dist/index.d.ts',
    'packages/cli/dist/index.js', 'packages/cli/dist/index.d.ts',
    'packages/server/dist/index.js', 'packages/server/dist/index.d.ts',
    'packages/server/dist/config/config-store.js', 'packages/server/dist/runtime/services.js',
    'packages/web/dist/index.html',
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

test('all workspace and parity typechecks retain arguments without optimizing compiler JIT', async () => {
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(rootManifest.scripts['typecheck:parity'], 'node scripts/run-typescript.mjs --noEmit -p tests/functional-parity/tsconfig.json');
  for (const name of ['core', 'cli', 'server', 'web']) {
    const manifest = JSON.parse(await readFile(path.join(root, `packages/${name}/package.json`), 'utf8'));
    assert.equal(manifest.scripts.typecheck, 'node ../../scripts/run-typescript.mjs --noEmit');
    if (name !== 'web') assert.ok(manifest.scripts.build.startsWith('node ../../scripts/run-typescript.mjs'));
  }
  let calls = 0;
  assert.deepEqual(runTypeScript(['--noEmit', '-p', 'tests/functional-parity/tsconfig.json'], (command, args, options) => {
    calls++;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['--no-maglev', '--no-turbofan', path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tests/functional-parity/tsconfig.json']);
    assert.deepEqual(options, { stdio: 'inherit' });
    return { status: 0 };
  }), { status: 0, code: 0, signal: null, spawnFailed: false });
  assert.equal(calls, 1);
});

test('TypeScript launcher preserves compiler failure evidence and never retries', () => {
  for (const failure of [{ status: 7 }, { status: null, signal: 'SIGSEGV' },
    { status: null, error: { code: 'ENOENT' } }]) {
    let calls = 0;
    const result = runTypeScript([], () => { calls++; return failure; });
    assert.equal(calls, 1);
    assert.deepEqual(result, { status: failure.status ?? 1, code: failure.status ?? null,
      signal: failure.signal ?? null, spawnFailed: !!failure.error });
  }
});

test('Web build disables optimizing compiler JIT without changing bundler or budget-check flags', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'packages/web/package.json'), 'utf8'));
  assert.equal(manifest.scripts.build, 'node scripts/build.mjs');
  const calls = [];
  assert.deepEqual(runWebBuild((command, args, options) => {
    calls.push({ command, args, options }); return { status: 0 };
  }), { status: 0 });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.args[0], '--no-maglev');
    assert.deepEqual(call.options, { stdio: 'inherit' });
  }
  assert.deepEqual(calls[0].args, ['--no-maglev', '--no-turbofan', path.join(root, 'node_modules/typescript/bin/tsc')]);
  assert.deepEqual(calls[1].args.slice(1), [path.join(root, 'node_modules/vite/bin/vite.js'), 'build']);
  assert.deepEqual(calls[2].args.slice(1), [path.join(root, 'packages/web/scripts/check-bundle-budget.mjs')]);
});

test('Web build stops at the first failed phase without retries or lost termination evidence', () => {
  for (const failedPhase of [0, 1, 2]) {
    for (const failure of [{ status: 7 }, { status: null, signal: 'SIGSEGV' },
      { status: null, error: { code: 'ENOENT' } }]) {
      let calls = 0;
      const result = runWebBuild(() => calls++ === failedPhase ? failure : { status: 0 });
      assert.equal(calls, failedPhase + 1);
      assert.deepEqual(result, { status: failure.status || 1,
        phase: ['TypeScript', 'Vite', 'bundle budgets'][failedPhase],
        code: failure.status ?? null, signal: failure.signal ?? null, spawnFailed: !!failure.error });
    }
  }
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
