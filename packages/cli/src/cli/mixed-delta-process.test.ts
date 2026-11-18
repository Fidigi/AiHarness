import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/mixed-delta-probe.mjs', import.meta.url));
const scenarios = ['print', 'json', 'rpc', 'sdk'].flatMap(mode => ['native', 'combined', 'split'].map(kind => `${mode}/${kind}`));
describe('emitted CLI / public SDK mixed reasoning and text', () => {
  it.each(scenarios)('%s preserves per-delta order, final content and protocol framing', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], { encoding: 'utf8', timeout: 8_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    const [mode, kind] = scenario.split('/');
    expect(JSON.parse(result.stdout)).toMatchObject({ result: 'MIXED_DELTA_OK', mode, kind });
  });
});
