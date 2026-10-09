import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runMcpCommand } from './mcp-command.js';

const roots: string[] = [];
const originalAgentDir = process.env.AI_HARNESS_AGENT_DIR;
const fixturePath = fileURLToPath(new URL('../../../core/src/mcp/fixtures/test-server.mjs', import.meta.url));

afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.AI_HARNESS_AGENT_DIR;
  else process.env.AI_HARNESS_AGENT_DIR = originalAgentDir;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('top-level MCP command', () => {
  it('uses shared Core mutations and performs a bounded one-shot test', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-cli-mcp-'));
    roots.push(root);
    const cwd = path.join(root, 'project');
    const agentDir = path.join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    process.env.AI_HARNESS_AGENT_DIR = agentDir;
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      cwd,
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    };

    expect(await runMcpCommand(['add', 'fixture', '--', process.execPath, fixturePath], io)).toBe(0);
    expect(errors).toEqual([]);
    output.length = 0;

    expect(await runMcpCommand(['test', 'fixture', '--json'], io)).toBe(0);
    const tested = JSON.parse(output.join('')) as { result: { state: string; toolCount: number } };
    expect(tested.result).toMatchObject({ state: 'connected', toolCount: 2 });
    output.length = 0;

    expect(await runMcpCommand(['disable', 'fixture', '--json'], io)).toBe(0);
    output.length = 0;
    expect(await runMcpCommand(['list', '--json'], io)).toBe(0);
    const inventory = JSON.parse(output.join('')) as { servers: Array<{ name: string; enabled: boolean }> };
    expect(inventory.servers).toEqual([expect.objectContaining({ name: 'fixture', enabled: false })]);
    output.length = 0;

    expect(await runMcpCommand(['exposure', 'fixture', 'deferred'], io)).toBe(0);
    expect(await runMcpCommand(['exposure', 'fixture', 'hidden', '--tool', 'mutate'], io)).toBe(0);
    expect(JSON.parse(await readFile(path.join(agentDir, 'mcp.json'), 'utf8'))).toMatchObject({ mcpServers: { fixture: {
      exposure: 'deferred', toolExposure: { mutate: 'hidden' },
    } } });
    expect(await runMcpCommand(['exposure', 'fixture', 'hidden'], io)).toBe(0);
    expect(JSON.parse(await readFile(path.join(agentDir, 'mcp.json'), 'utf8'))).toMatchObject({ mcpServers: { fixture: { exposure: 'hidden' } } });
    output.length = 0;
    expect(await runMcpCommand(['remove', 'fixture', '--json'], io)).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ name: 'fixture', scope: 'global' });
  });
});
