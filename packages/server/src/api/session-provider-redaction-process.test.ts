import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./session-provider-redaction.process.mjs', import.meta.url));

it.each(['cold', 'boundary'])('emitted public Server preserves provider metadata at the %s credential boundary', async kind => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [probe, kind], {
    cwd: os.tmpdir(), timeout: 15_000, maxBuffer: 256_000,
  });
  expect(stderr).toBe('');
  expect(stdout.split('\n').filter(line => line.startsWith('SESSION_PROVIDER_HTTP_OK ')))
    .toEqual([`SESSION_PROVIDER_HTTP_OK ${kind}`]);
}, 20_000);
