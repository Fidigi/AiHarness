import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/session-clone-position.mjs', import.meta.url));
for (const mode of ['memory', 'durable']) {
  it(`clones the actual RPC private-only current position (${mode})`, async () => {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [fixture, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain('RPC_CURRENT_PRIVATE_POSITION_CLONE_OK');
  }, 25_000);
}
