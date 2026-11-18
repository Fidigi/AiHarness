import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/mcp-inheritance-probe.mjs', import.meta.url));
describe('emitted CLI / public Core targetless project MCP inheritance', () => {
  it.each(['command', 'core', 'print', 'json', 'rpc'])('%s preserves global authority and project-only controls', mode => {
    const result = spawnSync(process.execPath, [probe, mode], {
      encoding: 'utf8', timeout: 12_000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0); expect(result.signal, result.stderr).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ result: 'MCP_INHERITANCE_OK', mode, scope: 'project' });
  }, 15_000);
});
