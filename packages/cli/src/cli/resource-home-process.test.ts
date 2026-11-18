import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/resource-home-probe.mjs', import.meta.url));
describe('A3-CLI-16 actual home selectors and empty arguments', () => {
  for (const mode of ['core', 'sdk', 'print', 'json', 'rpc']) for (const scope of ['global', 'project', 'explicit']) for (const policy of ['allow', 'refuse']) {
    it(`${mode}/${scope}/${policy}: exact home includes, exclusions and conserved arguments`, async () => {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [probe, mode, scope, policy], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      });
      expect(result, result.stderr).toEqual({ code: 0, signal: null, stdout: 'resource home/arguments OK\n', stderr: '' });
    }, 25_000);
  }
});
