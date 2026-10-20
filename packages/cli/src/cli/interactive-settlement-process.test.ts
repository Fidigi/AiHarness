import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/interactive-settlement-probe.mjs', import.meta.url));

describe('real interactive durable shutdown', () => {
  it.each(['regular', 'fullscreen'])('joins an admitted append before shutdown and process exit (%s)', mode => {
    const result = spawnSync(process.execPath, [probe, mode], { encoding: 'utf8', timeout: 8_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('INTERACTIVE_SETTLEMENT_OK\n');
  });
});
