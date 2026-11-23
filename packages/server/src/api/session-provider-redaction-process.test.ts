import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./session-provider-redaction.process.mjs', import.meta.url));

it.each(['cold', 'boundary'])('emitted public Server preserves provider metadata at the %s credential boundary', async kind => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [probe, kind], {
    cwd: os.tmpdir(), timeout: 15_000, maxBuffer: 256_000,
  }).catch((error: unknown) => {
    const failure = error as { code?: unknown; signal?: unknown; killed?: boolean };
    // Preserve the original failure; never log child channels or credential data.
    console.error('[session-provider-redaction] Child failed.', {
      kind, code: typeof failure.code === 'number' ? failure.code : null,
      signal: typeof failure.signal === 'string' ? failure.signal : null,
      killed: failure.killed === true,
      spawnErrorCode: typeof failure.code === 'string' ? failure.code : null,
    });
    throw error;
  });
  expect(stderr).toBe('');
  expect(stdout.split('\n').filter(line => line.startsWith('SESSION_PROVIDER_HTTP_OK ')))
    .toEqual([`SESSION_PROVIDER_HTTP_OK ${kind}`]);
}, 20_000);
