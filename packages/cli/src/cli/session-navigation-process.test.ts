import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/session-navigation-probe.mjs', import.meta.url));

describe('actual CLI/local-provider tree navigation', () => {
  it.each(['plain', 'summary', 'abort', 'eof'])('%s preserves context, framing and explicit provider authority', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], {
      encoding: 'utf8', timeout: 4_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
    });
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);
    expect(result.signal, diagnostic).toBeNull();
    const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ scenario, requests: scenario === 'plain' ? 0 : 1,
      cancelled: scenario === 'abort' || scenario === 'eof', summaries: scenario === 'summary' ? 1 : 0,
      heldClosed: scenario === 'abort' || scenario === 'eof' ? 1 : 0, exit: 0 });
    expect(records[1]).toEqual({ result: 'SESSION_NAVIGATION_PROCESS_OK', node: process.versions.node, cases: 1 });
  });
});
