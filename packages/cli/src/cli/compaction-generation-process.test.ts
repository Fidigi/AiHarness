import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/compaction-generation-probe.mjs', import.meta.url));
const cases = ['print', 'json'].flatMap(mode => ['valid', 'exact-output-bound', 'length-capped',
  'pending-tools', 'over-output-bound', 'over-input-bound'].map(kind => `${mode}/${kind}`));

describe('actual CLI automatic compaction generation', () => {
  it.each(cases)('%s conserves history and refuses invalid summary publication', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], {
      encoding: 'utf8', timeout: 4_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
    });
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);
    expect(result.signal, diagnostic).toBeNull();
    const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter(value => Object.hasOwn(value, 'phase')).map(value => value.phase)).toEqual([
      'setup', 'seed-history', 'prepare-context', 'cli', 'verify-history', 'cleanup',
    ]);
    const row = records.find(value => Object.hasOwn(value, 'ok'));
    expect(row).toMatchObject({ node: process.versions.node, mode: scenario.split('/')[0],
      kind: scenario.split('/')[1], sourceMessages: scenario.endsWith('/over-input-bound') ? 50 : 4,
      ordinaryCalls: 1, rawConserved: true, exit: 0, ok: true });
    const valid = ['valid', 'exact-output-bound'].includes(scenario.split('/')[1]);
    expect(row?.published).toBe(valid ? 1 : 0);
    if (scenario.endsWith('/over-input-bound')) {
      expect(row?.summaryCalls).toBe(0);
      expect(row?.sourcePrefixBytes).toBeGreaterThan(2_000_000);
    } else {
      // Invalid output can be attempted at both existing user/assistant threshold checks.
      // This regression owns refusal, not deduplication or settled-work accounting.
      if (valid) expect(row?.summaryCalls).toBe(1);
      else expect(row?.summaryCalls).toBeGreaterThanOrEqual(1);
      expect(row?.maxTokens).toBe(4096);
    }
    expect(records.at(-1)).toEqual({ result: 'CLI_AUTOMATIC_GENERATION_OK', scenario, node: process.versions.node });
  });
});
