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

function execute(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
}

/** No arguments runs every whole-file lifetime. Explicit arguments retain focused
 * Playwright operation; --all-suites applies flags (e.g. reporter selection) to all. */
export async function runE2e(args, run = execute) {
  const all = args.length === 0 || args.includes('--all-suites');
  const flags = args.filter(arg => arg !== '--all-suites');
  if (all && flags.some(arg => arg === '--config' || arg.startsWith('--config='))) {
    throw new Error('--all-suites cannot replace the owning configurations');
  }
  const plan = all ? suites : [{ name: 'focused' }];
  const results = [];
  const build = await run('npm', ['run', 'build'], {});
  if (build) return { status: build, results: [{ name: 'build', status: build }] };
  for (const { name, config } of plan) {
    const env = { PLAYWRIGHT_HTML_OUTPUT_DIR: `playwright-report/${name}` };
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
    console.log(`E2E suite: ${name}`);
    const status = await run(process.execPath, [
      '--no-maglev', 'node_modules/@playwright/test/cli.js', 'test',
      ...(config ? [`--config=${config}`] : []), ...flags,
      '--workers=1', '--retries=0', ...(all ? [`--output=test-results/${name}`] : []),
    ], env);
    results.push({ name, status });
  }
  return { status: results.find(result => result.status)?.status ?? 0, results };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runE2e(process.argv.slice(2));
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/e2e-suites.json', JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status;
}
