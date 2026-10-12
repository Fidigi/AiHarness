import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dedicatedSpecs, suites, runE2e } from './e2e-suites.mjs';

function recorder(fail = () => 0) {
  const calls = [];
  return { calls, run: async (command, args, env) => {
    const call = { command, args, env }; calls.push(call); return fail(call);
  } };
}

test('container E2E entry point and preparation inputs survive the Docker build context', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(packageJson.scripts['test:e2e'], 'node .docker/e2e-suites.mjs');
  for (const file of [
    '.docker/e2e-suites.mjs', '.docker/e2e-suites.d.mts', '.docker/run-e2e.mjs',
    '.docker/baseline-artifacts.mjs', '.docker/test-fonts.test.mjs', '.docker/test-fonts.conf',
    'playwright.config.ts', 'demo/tests/demo.test.mjs', 'demo/scripts/build.mjs',
    'demo/tsconfig.json', '.github/workflows/demo-pages.yml',
  ]) assert.ok((await readFile(file)).length > 0, `Missing container input: ${file}`);
});

test('every excluded development file belongs to a mandatory whole-file suite', async () => {
  const owners = new Set();
  for (const { config } of suites.filter(suite => suite.name !== 'standard')) {
    const source = await readFile(config, 'utf8');
    for (const file of dedicatedSpecs) if (source.includes(file)) owners.add(file);
    if (config === 'demo/playwright.config.ts' && source.includes("testMatch: 'demo*.spec.ts'")) owners.add('demo.spec.ts');
  }
  assert.match(await readFile('e2e/tool-progress.config.ts', 'utf8'), /npm run preview.*--port 3080/);
  assert.match(await readFile('.docker/Dockerfile.test', 'utf8'), /ARG NODE_VERSION=24\.15\.0/);
  // The pane config inherits an explicitly cleared ignore list from workspace.
  assert.deepEqual([...owners].sort(), [...dedicatedSpecs].sort());
  for (const config of ['interaction-asset-load', 'tool-progress', 'settings-locale-asset-load',
    'workspace-asset-load', 'linked-modal-boundary']) {
    assert.match(await readFile(`e2e/${config}.config.ts`, 'utf8'), /testIgnore: \[\]/);
  }
});

test('default executes every owning configuration with zero retries, one worker and separate artifacts', async () => {
  const { calls, run } = recorder();
  const result = await runE2e([], run);
  assert.equal(result.status, 0);
  assert.deepEqual(result.results.map(result => result.name), suites.map(suite => suite.name));
  const browser = calls.filter(call => call.args.includes('node_modules/@playwright/test/cli.js'));
  assert.equal(browser.length, suites.length);
  for (const call of browser) {
    assert.equal(call.args[0], '--no-maglev');
    assert.ok(call.args.includes('--workers=1')); assert.ok(call.args.includes('--retries=0'));
    assert.ok(call.args.some(arg => arg.startsWith('--output=test-results/')));
  }
});

test('failed suite remains a failure and does not erase sibling lifetimes', async () => {
  const { run } = recorder(call => call.args.includes('--config=e2e/interaction-queue.config.ts') ? 7 : 0);
  const result = await runE2e([], run);
  assert.equal(result.status, 7);
  assert.equal(result.results.length, suites.length);
  assert.equal(result.results.find(result => result.name === 'interactions').status, 7);
  assert.equal(result.results.at(-1).name, 'demo');
});

test('demo policy tests precede rebuilding the selected artifact base', async () => {
  const { calls, run } = recorder(); await runE2e([], run);
  const policy = calls.findIndex(call => call.args.includes('demo/tests/demo.test.mjs'));
  const build = calls.findIndex(call => call.args.includes('demo/scripts/build.mjs'));
  const browser = calls.findIndex(call => call.args.includes('--config=demo/playwright.config.ts'));
  assert.ok(policy > 0 && build > policy && browser > build);
  assert.equal(calls[build].env.DEMO_BASE, process.env.DEMO_BASE ?? '/AiHarness/');
});

test('explicit focused configuration is not replaced by an unrelated suite', async () => {
  const { calls, run } = recorder();
  const result = await runE2e(['--config=e2e/tool-progress.config.ts', '--workers=4', '--retries=2'], run);
  assert.deepEqual(result.results, [{ name: 'focused', status: 0 }]);
  assert.deepEqual(calls.at(-1).args.slice(-2), ['--workers=1', '--retries=0']);
  assert.equal(calls.at(-1).args.filter(arg => arg.startsWith('--config=')).length, 1);
});

test('all-suite flags cannot replace each owning configuration with one filtered suite', async () => {
  const { calls, run } = recorder();
  await assert.rejects(runE2e(['--all-suites', '--config=e2e/tool-progress.config.ts'], run), /owning configurations/);
  assert.equal(calls.length, 0);
});

test('failed build prevents starting tests and is not reported as green', async () => {
  const { calls, run } = recorder(call => call.command === 'npm' ? 9 : 0);
  assert.deepEqual(await runE2e([], run), { status: 9, results: [{ name: 'build', status: 9 }] });
  assert.equal(calls.length, 1);
});
