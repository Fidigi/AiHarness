import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('./fixtures/mcp-pattern-probe.mjs', import.meta.url));
const scenarios = ['command', 'core', 'print', 'json', 'rpc'].flatMap(mode => ['global', 'project'].map(scope => `${mode}/${scope}`));
describe('emitted CLI / public Core MCP exposure patterns', () => {
  const selectionScenarios = ['print', 'json', 'rpc'].flatMap(mode => ['global', 'project'].flatMap(scope =>
    ['missing', 'excluded', 'codemode', 'deferred', 'hidden'].map(policy => `${mode}/${scope}/${policy}`)));
  it.each(selectionScenarios)('%s preserves native declarations and refuses undeclared/excluded remote effects', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], { encoding: 'utf8', timeout: 8_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    const [mode, scope, policy] = scenario.split('/');
    expect(JSON.parse(result.stdout)).toEqual({ result: 'MCP_PATTERN_OK', mode, scope, policy });
  });
  it.each(scenarios)('%s preserves effective exposure, exact overrides and native-call boundaries', scenario => {
    const result = spawnSync(process.execPath, [probe, scenario], { encoding: 'utf8', timeout: 8_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    const [mode, scope] = scenario.split('/');
    expect(JSON.parse(result.stdout)).toEqual({ result: 'MCP_PATTERN_OK', mode, scope });
  });
});
