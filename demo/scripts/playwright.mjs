import { spawn } from 'node:child_process';
import { baselineDigests, collectBaselineDelta } from './baselines.mjs';
const args = process.argv.slice(2);
const update = args.some(arg => /^(?:--update-snapshots|--update-snapshots=(?:all|changed|missing))$/.test(arg));
const before = update ? await baselineDigests('/app/demo/visual-baselines') : null;
const child = spawn('/app/node_modules/.bin/playwright', ['test', '--config', 'demo/playwright.config.ts', '--workers=1', '--retries=0', ...args], { stdio: 'inherit' });
const status = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
});
let exportStatus = 0;
if (update) {
  try {
    console.log('Demo baseline delta:', await collectBaselineDelta('/app/demo/visual-baselines', before, '/app/demo/.baseline-delta'));
  } catch (error) { console.error(error); exportStatus = 1; }
}
process.exitCode = status || exportStatus;
