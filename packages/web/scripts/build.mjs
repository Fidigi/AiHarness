import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function executable(packageName, binName) {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return path.resolve(path.dirname(manifestPath), manifest.bin[binName]);
}

// TypeScript still crashes with Maglev disabled: disable its optimizing JIT
// tiers without changing the bundler, application runtime or sandbox budgets.
// This scoped mitigation does not diagnose every native failure. Never retry.
export function runWebBuild(run = spawnSync) {
  const steps = [
    ['TypeScript', executable('typescript', 'tsc'), []],
    ['Vite', executable('vite', 'vite'), ['build']],
    ['bundle budgets', fileURLToPath(new URL('./check-bundle-budget.mjs', import.meta.url)), []],
  ];
  for (const [phase, file, args] of steps) {
    const flags = phase === 'TypeScript' ? ['--no-maglev', '--no-turbofan'] : ['--no-maglev'];
    const result = run(process.execPath, [...flags, file, ...args], { stdio: 'inherit' });
    if (result.error || result.signal || result.status !== 0) {
      return { status: result.status || 1, phase, code: result.status ?? null,
        signal: result.signal ?? null, spawnFailed: !!result.error };
    }
  }
  return { status: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runWebBuild();
  if (result.status) {
    console.error(`[Web build] ${result.phase} failed (code=${result.code}, signal=${result.signal}, spawnFailed=${result.spawnFailed}).`);
  }
  process.exitCode = result.status;
}
