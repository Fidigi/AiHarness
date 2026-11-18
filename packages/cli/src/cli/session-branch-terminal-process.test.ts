import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/session-branch-terminal.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
for (const scenario of ['regular-memory', 'regular-durable', 'fullscreen-memory', 'fullscreen-durable']) {
  it(`emitted terminal ${scenario}: owns cancellation, summary overrides, exact copies and restart`, () => {
    const result = spawnSync(process.execPath, [fixture, scenario], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, AIH_STATE_CLI: cli, AIH_STATE_COMMAND: '' },
    });
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    expect(result.error, diagnostic).toBeUndefined(); expect(result.signal, diagnostic).toBeNull(); expect(result.status, diagnostic).toBe(0);
    expect(result.stdout).toContain('TERMINAL_BRANCH_LIFETIME_OK');
  }, 35_000);
}
