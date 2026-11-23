import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('public emitted Core and Server recover an unavailable default without selecting a workspace or loading its extensions', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['e2e/workspace-default-server.mjs', '--check'], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)), timeout: 15_000, maxBuffer: 256_000,
  });
  expect(stderr).toBe('');
  expect(stdout.split('\n').filter(line => line.startsWith('WORKSPACE_PUBLIC_OK '))).toEqual([
    'WORKSPACE_PUBLIC_OK relative', 'WORKSPACE_PUBLIC_OK missing', 'WORKSPACE_PUBLIC_OK removed-during-start',
  ]);
}, 20_000);
