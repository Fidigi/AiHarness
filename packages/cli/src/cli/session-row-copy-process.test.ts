import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['memory', 'durable', 'external', 'policy', 'group', 'title'])('uses emitted public native row copy%s from a disposable cwd', async scenario => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-row-copy-emitted-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/session-row-copy-probe.mjs', import.meta.url)), scenario], {
      cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    expect({ code: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr })
      .toEqual({ code: 0, signal: null, error: undefined, stdout: 'session row copy OK\n', stderr: '' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 25_000);
