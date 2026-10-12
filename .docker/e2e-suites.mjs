import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These files require their owning production-preview or independent static host.
// They are excluded from Vite development discovery, never from the full runner.
export const dedicatedSpecs = Object.freeze([
  'interaction-single-asset-load.spec.ts', 'interaction-queue.spec.ts',
  'interaction-admission.spec.ts', 'interaction-asset-load.spec.ts',
  'settings-locale-asset-load.spec.ts', 'workspace-asset-load.spec.ts',
  'pane-lifetime.spec.ts', 'linked-modal-boundary.spec.ts',
  'tool-progress.spec.ts', 'demo.spec.ts',
]);
export const suites = Object.freeze([
  ['standard', 'playwright.config.ts'],
  ['interactions', 'e2e/interaction-queue.config.ts'],
  ['locale', 'e2e/settings-locale-asset-load.config.ts'],
  ['workspace', 'e2e/workspace-asset-load.config.ts'],
  ['pane', 'e2e/pane-lifetime.config.ts'],
  ['linked', 'e2e/linked-modal-boundary.config.ts'],
  ['title', 'e2e/session-title-production.config.ts'],
  ['progress', 'e2e/tool-progress.config.ts'],
  ['demo', 'demo/playwright.config.ts'],
].map(([name, config]) => Object.freeze({ name, config })));

// Each CI job has its own checkout/container/server/quota. Only the standard
// fullyParallel suite is sharded; serial/owning-host suites stay whole.
export const ciPartitions = Object.freeze([
  ['interactions'],
  ['linked', 'pane'],
  ['locale', 'workspace', 'title'],
  ['progress', 'demo'],
].map((names, index) => Object.freeze({
  index: index + 1, total: 4, suites: Object.freeze(names),
})));

function execute(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
}

/** No arguments runs every whole-file lifetime. Explicit arguments retain focused
 * Playwright operation; --ci-partition=N/4 selects a complete isolated CI job. */
export async function runE2e(args, run = execute) {
  const selectors = args.filter(arg => arg.startsWith('--ci-partition'));
  let partition;
  if (selectors.length) {
    const match = selectors.length === 1 && /^--ci-partition=([1-4])\/4$/.exec(selectors[0]);
    if (!match) throw new Error('Expected exactly one --ci-partition=N/4 with N between 1 and 4');
    partition = ciPartitions[Number(match[1]) - 1];
  }
  const flags = args.filter(arg => arg !== '--all-suites' && !selectors.includes(arg));
  if (partition && (args.includes('--all-suites')
    || flags.some(arg => arg !== '--list' && !/^--reporter=\S+$/.test(arg)))) {
    throw new Error('CI partitions cannot filter tests or override owning configurations, shards, workers or retries');
  }
  const all = !!partition || args.length === 0 || args.includes('--all-suites');
  if (all && flags.some(arg => arg === '--config' || arg.startsWith('--config='))) {
    throw new Error('--all-suites cannot replace the owning configurations');
  }
  const plan = partition ? suites.filter(suite => suite.name === 'standard' || partition.suites.includes(suite.name))
    : all ? suites : [{ name: 'focused' }];
  const results = [];
  const build = await run('npm', ['run', 'build'], {});
  if (build) return { status: build, results: [{ name: 'build', status: build }] };
  for (const { name, config } of plan) {
    const artifact = `${partition ? `partition-${partition.index}/` : ''}${name}`;
    // Reporter environment paths must be absolute: JSON resolves relative names
    // from each config directory, which would strand preview/demo reports outside
    // the directories collected by Make and uploaded by GitHub.
    const env = { PLAYWRIGHT_HTML_OUTPUT_DIR: path.resolve(`playwright-report/${artifact}`),
      PLAYWRIGHT_JSON_OUTPUT_NAME: path.resolve(`test-results/${artifact}/report.json`) };
    if (name === 'demo' || config === 'demo/playwright.config.ts'
      || flags.some(arg => arg.includes('demo/playwright.config'))) {
      env.DEMO_BASE = process.env.DEMO_BASE ?? '/AiHarness/';
      // Policy tests build several bases. Rebuild the selected base last.
      const preparation = [
        [process.execPath, ['--test', 'demo/tests/demo.test.mjs']],
        [process.execPath, ['--test', '.docker/test-fonts.test.mjs']],
        [process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'demo/tsconfig.json']],
        [process.execPath, ['demo/scripts/build.mjs']],
      ];
      let failed = 0;
      for (const [command, argv] of preparation) {
        failed = await run(command, argv, env);
        if (failed) break;
      }
      if (failed) { results.push({ name, status: failed }); continue; }
    }
    const shard = partition && name === 'standard' ? `${partition.index}/${partition.total}` : undefined;
    console.log(`E2E suite: ${name}${shard ? ` (shard ${shard})` : ''}`);
    const status = await run(process.execPath, [
      '--no-maglev', 'node_modules/@playwright/test/cli.js', 'test',
      ...(config ? [`--config=${config}`] : []), ...flags,
      ...(shard ? [`--shard=${shard}`] : []),
      '--workers=1', '--retries=0', ...(all ? [`--output=test-results/${artifact}`] : []),
    ], env);
    results.push({ name, status, ...(shard ? { shard } : {}) });
  }
  return { status: results.find(result => result.status)?.status ?? 0, results,
    ...(partition ? { partition: { index: partition.index, total: partition.total } } : {}) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runE2e(process.argv.slice(2));
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/e2e-suites.json', JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status;
}
