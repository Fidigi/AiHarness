import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/extension-execution-probe.mjs', import.meta.url));
it.each(['print', 'json', 'rpc', 'regular', 'fullscreen'])('native extension transformations and continuations in emitted %s', async mode => {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  expect(result, JSON.stringify(result)).toEqual({ code: 0, signal: null, stdout: 'EXTENSION_EXECUTION_OK\n', stderr: '' });
}, 25_000);
