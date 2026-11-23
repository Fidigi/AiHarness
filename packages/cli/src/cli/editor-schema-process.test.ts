import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('uses actual emitted public Core and all five built editor schemas from a disposable cwd', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-editor-emitted-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/editor-schema-probe.mjs', import.meta.url))], {
      cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    expect({ code: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr })
      .toEqual({ code: 0, signal: null, error: undefined, stdout: 'native editor schemas OK\n', stderr: '' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 25_000);
