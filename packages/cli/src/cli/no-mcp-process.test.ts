import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/no-mcp-probe.mjs', import.meta.url));
function run(mode: string, scenario: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [probe, mode, scenario], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

for (const mode of ['print', 'json', 'rpc', 'regular', 'fullscreen']) {
  it(`${mode}: no-MCP wins over explicit capability IDs and live settings without disabling ordinary sources`, async () => {
    expect(await run(mode, 'suppressed')).toEqual({ code: 0, signal: null, stdout: 'native no-MCP OK\n', stderr: '' });
  }, 45_000);
}
it('control: the same actual MCP fixture starts without the flag and closes before process completion', async () => {
  expect(await run('print', 'control')).toEqual({ code: 0, signal: null, stdout: 'native no-MCP OK\n', stderr: '' });
}, 45_000);
