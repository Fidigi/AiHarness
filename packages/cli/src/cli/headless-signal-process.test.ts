import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/headless-signal-probe.mjs', import.meta.url));

describe('CLI-01 emitted headless cancellation', () => {
  it.each(['print/SIGINT', 'print/SIGTERM', 'json/SIGINT', 'json/SIGTERM', 'rpc/SIGINT', 'rpc/SIGTERM',
    'print/SIGINT/admission', 'print/SIGTERM/admission', 'json/SIGINT/admission', 'json/SIGTERM/admission',
    'rpc/SIGINT/admission', 'rpc/SIGTERM/admission'])(
    'settles, flushes and cleans up before exiting (%s)', scenario => {
      const result = spawnSync(process.execPath, [probe, scenario], {
        encoding: 'utf8', timeout: 8_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.signal, result.stderr).toBeNull();
      expect(JSON.parse(result.stdout)).toMatchObject({ result: 'HEADLESS_SIGNAL_OK',
        mode: scenario.split('/')[0], signal: scenario.split('/')[1] });
    });
});
