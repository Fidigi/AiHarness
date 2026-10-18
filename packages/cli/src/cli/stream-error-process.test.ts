import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/stream-error-probe.mjs', import.meta.url));
const scenarios = ['print', 'json', 'rpc', 'sdk'].flatMap(mode =>
  ['recover', 'exhausted', 'prefix', 'queued', 'normal'].map(kind => `${mode}/${kind}`));
describe('emitted CLI and public SDK explicit SSE errors', () => {
  it.each(scenarios)('%s retains error/retry boundaries without tool effects or false success', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], {
      encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    const [mode, kind] = scenario.split('/');
    expect(JSON.parse(result.stdout)).toEqual({ result: 'STREAM_ERROR_OK', mode, kind });
  }, 20_000);
});
