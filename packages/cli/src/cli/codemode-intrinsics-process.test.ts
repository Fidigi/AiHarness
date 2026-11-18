import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/codemode-intrinsics-probe.mjs', import.meta.url));
const cases = ['core', 'print', 'json', 'rpc'].flatMap(mode =>
  ['freeze', 'globals', 'error', 'schema', 'options', 'output', 'configured', 'image', ...(mode === 'core' ? ['deadline', 'abort'] : [])].map(scenario => [mode, scenario]));
describe('A3-CLI-05 public QuickJS worker/bridge compatibility', () => {
  it.each(cases)('%s/%s preserves intrinsics, data authority, bounds and channels', async (mode, scenario) => {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [probe, mode!, scenario!], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    expect(result, result.stderr).toEqual({ code: 0, signal: null, stdout: 'codemode intrinsics OK\n', stderr: '' });
  }, 25_000);
});
