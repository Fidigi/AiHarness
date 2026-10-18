import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/length-stop-probe.mjs', import.meta.url));
const scenarios = ['print', 'json', 'rpc'].flatMap(mode =>
  ['partial-length', 'empty-length', 'normal', 'empty-normal'].map(kind => `${mode}/${kind}`));
scenarios.push('print/multiple', 'json/multiple');

describe('emitted CLI output-limit reporting', () => {
  it.each(scenarios)('%s preserves text, usage, history and channel/status semantics', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], {
      encoding: 'utf8', timeout: 8_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    expect(JSON.parse(result.stdout)).toMatchObject({ result: 'LENGTH_STOP_OK',
      mode: scenario.split('/')[0], kind: scenario.split('/')[1] });
  });
});
