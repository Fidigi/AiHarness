import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/tool-json-probe.mjs', import.meta.url));
const scenarios = ['print', 'json', 'rpc', 'sdk'].flatMap(mode =>
  ['completions', 'responses', 'anthropic'].flatMap(dialect =>
    ['invalid', 'invalid-text', 'valid'].map(kind => `${mode}/${dialect}/${kind}`)));

describe('emitted CLI and public SDK final tool JSON', () => {
  it.each(scenarios)('%s rejects malformed arguments without executing the valid first tool', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], {
      encoding: 'utf8', timeout: 8_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    const [mode, dialect, kind] = scenario.split('/');
    expect(JSON.parse(result.stdout)).toMatchObject({ result: 'TOOL_JSON_OK', mode, dialect, kind });
  });
});
