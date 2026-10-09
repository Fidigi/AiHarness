import { spawn } from 'node:child_process';
import path from 'node:path';
import { collectChangedBaselines, snapshotBaselineDigests } from './baseline-artifacts.mjs';

const root = process.cwd();
try {
  const before = await snapshotBaselineDigests(root);
  const status = await new Promise(resolve => {
    const child = spawn('npm', ['run', 'test:e2e', '--', ...process.argv.slice(2)], { stdio: 'inherit' });
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  await collectChangedBaselines(root, before, path.join(root, '.e2e-updated-baselines'));
  process.exitCode = status;
} catch {
  console.error('Unable to collect isolated Playwright snapshot artifacts.');
  process.exitCode = 1;
}
