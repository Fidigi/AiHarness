import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/context-settings-probe.mjs', import.meta.url));

describe('actual CLI context-settings file reload', () => {
  it.each(['thresholds', 'gates', 'untrusted', 'trusted', 'saved-trust', 'abort', 'eof',
    'print-below', 'print-above', 'json-below', 'json-above', 'native-rpc', 'native-print', 'native-json'])(
    '%s preserves scoped authority, effective policy, framing and durable history', scenario => {
      const result = spawnSync(process.execPath, [probe, scenario], {
        encoding: 'utf8', timeout: 4_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
      });
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      expect(result.error, diagnostic).toBeUndefined();
      expect(result.status, diagnostic).toBe(0);
      expect(result.signal, diagnostic).toBeNull();
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      const headless = scenario.startsWith('print-') || scenario.startsWith('json-');
      expect(records).toEqual([
        { scenario, requests: scenario.startsWith('native-') ? 1 : headless ? scenario.endsWith('above') ? 2 : 1
          : ['thresholds', 'gates'].includes(scenario) ? 4 : 0,
          compactions: ['thresholds', 'gates'].includes(scenario) || scenario.endsWith('above') ? 1 : 0,
          summaries: scenario === 'thresholds' ? 1 : 0, exit: 0 },
        { result: 'CONTEXT_SETTINGS_PROCESS_OK', node: process.versions.node, cases: 1 },
      ]);
    });
});
