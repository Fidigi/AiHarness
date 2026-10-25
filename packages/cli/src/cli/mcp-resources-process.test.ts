import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const probe = fileURLToPath(new URL('./fixtures/mcp-resources-probe.mjs', import.meta.url));
describe('emitted CLI MCP resources and rich results', () => {
  it.each(['print', 'json', 'rpc'].flatMap(mode => ['global', 'project'].map(scope => `${mode}/${scope}`)))('%s transports actual resources, images and private binary references', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], { encoding: 'utf8', timeout: 8000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(result.signal, result.stderr).toBeNull();
    const [mode, scope] = scenario.split('/'); expect(JSON.parse(result.stdout)).toEqual({ result: 'MCP_RESOURCES_OK', mode, scope });
  });
});
