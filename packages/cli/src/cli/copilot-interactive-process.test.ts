import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const probe = fileURLToPath(new URL('./fixtures/copilot-interactive-probe.mjs', import.meta.url));
it.each(['regular', 'fullscreen'])('native Copilot %s terminal owns login, Escape, inference, logout and shutdown', async mode => {
  const result = await promisify(execFile)(process.execPath, [probe, mode], { timeout: 25000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME } }).catch((error: unknown) => {
    const child = error as { code?: unknown; signal?: unknown; killed?: boolean };
    console.error('[copilot-interactive] Probe failed.', { mode, code: child.code, signal: child.signal, killed: child.killed });
    throw error;
  });
  expect(result).toEqual({ stdout: `COPILOT_INTERACTIVE_OK ${mode}\n`, stderr: '' });
}, 30000);
