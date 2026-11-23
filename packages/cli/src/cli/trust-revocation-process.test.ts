import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/trust-revocation-probe.mjs', import.meta.url));
for (const mode of ['print', 'json', 'rpc', 'sdk']) for (const mutation of ['refuse', 'remove']) {
  it(`${mode} refuses a model write after external trust ${mutation}`, async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [probe, mode, mutation], {
      cwd: os.tmpdir(), timeout: 12_000, maxBuffer: 256_000,
    });
    expect(stderr).toBe(''); expect(stdout.trim()).toBe('TRUST_REVOCATION_OK');
  }, 15_000);
}
