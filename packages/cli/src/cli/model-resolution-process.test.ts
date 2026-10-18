import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/model-resolution-probe.mjs', import.meta.url));
describe('A3-CLI-09 actual provider/model resolution', () => {
  for (const mode of ['print', 'json', 'rpc']) for (const scenario of ['one', 'two', 'none', 'qualified', 'native', 'pin', 'scope', 'warning', 'selected-warning', 'unmatched']) {
    it(`${mode}/${scenario}: credentials, ambiguity, plural scopes and framing`, async () => {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [probe, mode, scenario], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      });
      expect(result, result.stderr).toEqual({ code: 0, signal: null, stdout: 'model resolution OK\n', stderr: '' });
    }, 25_000);
  }
});
