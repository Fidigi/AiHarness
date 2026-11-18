import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/session-context-state-probe.mjs', import.meta.url));
describe('native context state through actual hosts', () => {
  it.each(['print', 'json', 'rpc', 'sdk'])('%s preserves edited model input, private loadout and restart/copy checkpoints', mode => {
    const result = spawnSync(process.execPath, [probe, mode], { encoding: 'utf8', timeout: 12_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' } });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('session context state OK\n');
  }, 15_000);
});
