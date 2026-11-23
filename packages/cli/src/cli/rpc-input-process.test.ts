import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/rpc-input-probe.mjs', import.meta.url));

describe('emitted CLI RPC input contract', () => {
  it.each(['boundary', 'held-overflow'])('%s preserves framing, privacy and admitted-write cleanup', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], {
      encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, NO_COLOR: '1' },
    });
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);
    expect(result.signal, diagnostic).toBeNull();
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`RPC_INPUT_OK ${scenario}\n`);
  }, 20_000);
});
