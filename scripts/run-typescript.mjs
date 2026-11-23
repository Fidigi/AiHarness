import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// Compiler crashes also reproduce with Maglev disabled. Keep optimizing JIT
// tiers off for TypeScript only; application flags, diagnostics and budgets stay
// unchanged. This is a scoped mitigation, not a diagnosis. Never retry a run.
export function runTypeScript(args, run = spawnSync) {
  const result = run(process.execPath, ['--no-maglev', '--no-turbofan', require.resolve('typescript/bin/tsc'), ...args], { stdio: 'inherit' });
  return { status: result.status ?? 1, code: result.status ?? null,
    signal: result.signal ?? null, spawnFailed: !!result.error };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runTypeScript(process.argv.slice(2));
  if (result.signal || result.spawnFailed) {
    console.error(`[TypeScript] compiler failed (code=${result.code}, signal=${result.signal}, spawnFailed=${result.spawnFailed}).`);
  }
  process.exitCode = result.status;
}
