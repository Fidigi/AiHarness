import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/mcp-management-probe.mjs', import.meta.url));
describe('MCP-01 actual terminal management', () => {
  it.each(['regular', 'fullscreen'])('%s uses shared Test, writes, reconnect and reload', mode => {
    const result = spawnSync(process.execPath, [probe, mode], {
      encoding: 'utf8', timeout: 35_000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ result: 'MCP_MANAGEMENT_OK', mode });
  }, 40_000);
});
