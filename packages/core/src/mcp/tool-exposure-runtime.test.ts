import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { ProjectTrustManager } from '../security/project-trust.js';
import { SessionManager } from '../sessions/session-manager.js';
import { createAgentToolLoadout } from '../tools/tool-search.js';
import { inspectMcpConfig, readMcpServerTestTarget, type McpConfigScope, type McpExposure } from './config-inventory.js';
import { McpSessionHost } from './session-host.js';
import { McpServerTester } from './server-test.js';

const fixture = fileURLToPath(new URL('./fixtures/test-server.mjs', import.meta.url));
const roots: string[] = [];
const resourceNames = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].map(name => `mcp__fixture__${name}`);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(scope: McpConfigScope, toolExposure: Record<string, McpExposure>, exposure: McpExposure | null = 'hidden') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-pattern-')); roots.push(root);
  const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project'), log = path.join(root, 'calls.jsonl');
  await Promise.all([mkdir(agentDir), mkdir(path.join(cwd, '.ai-harness'), { recursive: true })]);
  const trustManager = new ProjectTrustManager(path.join(agentDir, 'trust.json')); await trustManager.load();
  const configPath = path.join(scope === 'global' ? agentDir : path.join(cwd, '.ai-harness'), 'mcp.json');
  const save = async (overrides: Record<string, McpExposure>) => writeFile(configPath, JSON.stringify({ version: 1,
    mcpServers: { fixture: { command: process.execPath, args: [fixture], env: { MCP_TEST_CALL_LOG: log }, exposure: exposure ?? undefined, toolExposure: overrides } },
  }));
  await save(toolExposure);
  const calls = async (): Promise<string[]> => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const host = new McpSessionHost({ agentDir, trustManager, startupWaitMs: 2_000, requestTimeoutMs: 2_000, closeWaitMs: 500 });
  const context = { sessionManager: new SessionManager(), notify: () => undefined };
  return { agentDir, cwd, trustManager, host, context, save, calls };
}

describe('real stdio MCP pattern exposure', () => {
  it.each([null, 'direct', 'codemode', 'deferred', 'hidden'] as const)('keeps native selection above %s exposure, including forged restored activation', async mode => {
    const w = await setup('global', {}, mode);
    const lookup = 'mcp__fixture__lookup', mutate = 'mcp__fixture__mutate';
    try {
      const prepared = await w.host.prepareForPrompt({ sessionId: 'selection', cwd: w.cwd });
      const source = { directTools: prepared.tools, hasPotentialSearchableTools: prepared.hasPotentialDiscoverableTools ?? false,
        currentSearchableTools: () => prepared.currentDiscoverableTools?.() ?? [],
        waitForSearchableTools: (signal?: AbortSignal) => prepared.waitForDiscoverableTools?.(signal) ?? Promise.resolve([]),
        has: (name: string) => prepared.has(name) };
      await source.waitForSearchableTools();
      const loadout = createAgentToolLoadout({ staticTools: [], dynamicSource: source,
        selection: { allowedTools: ['tool_search', 'codemode', lookup, mutate], excludedTools: [mutate] },
        initialLoadedTools: [mutate], codemode: { enabled: true } });
      const direct = mode === null || mode === 'direct';
      expect(prepared.tools.map(tool => tool.name)).toEqual(direct ? [...resourceNames, lookup, mutate] : []);
      if (mode === 'codemode' || mode === 'deferred') {
        expect((await loadout.executeToolSearch({ query: 'documentation state' }, w.context)).details).toEqual({ loaded: [lookup] });
      }
      const names = loadout.getTools().map(tool => tool.name);
      expect(names.includes(lookup)).toBe(direct || mode === 'deferred');
      expect(names).not.toContain(mutate);
      expect(loadout.getTools().find(tool => tool.name === 'codemode')?.description).not.toContain(mutate);
      const registry = new ExtensionRegistry();
      const result = await loadout.executeCodemode({ code: `text(await tools.${lookup}({})); text(typeof tools.${mutate});` },
        w.context, (name, input, context, signal) => registry.executeHostedTool(name, input, context,
          (hostInput, hostContext, hostSignal) => prepared.execute(name, hostInput, hostContext, hostSignal), signal));
      expect(Boolean(result.isError)).toBe(mode === 'hidden');
      if (mode !== 'hidden') expect(result.content).toContain('undefined');
      expect(await w.calls()).toEqual(mode === 'hidden' ? [] : ['lookup']);
      const unselected = createAgentToolLoadout({ staticTools: [], dynamicSource: source,
        selection: { allowedTools: ['tool_search', 'codemode'] }, initialLoadedTools: [lookup], codemode: { enabled: true } });
      expect(unselected.getTools().some(tool => tool.name === lookup || tool.name === mutate)).toBe(false);
      expect((await unselected.executeCodemode({ code: `await tools.${lookup}({})` }, w.context,
        (name, input, context, signal) => prepared.execute(name, input, context, signal))).isError).toBe(true);
      expect(await w.calls()).toEqual(mode === 'hidden' ? [] : ['lookup']);
      const disabled = createAgentToolLoadout({ staticTools: [], dynamicSource: source, selection: { allowedTools: [] },
        initialLoadedTools: [lookup, mutate], codemode: { enabled: true } });
      expect(disabled.getTools()).toEqual([]);
      await expect(disabled.executeCodemode({ code: `await tools.${lookup}({})` }, w.context,
        (name, input, context, signal) => prepared.execute(name, input, context, signal))).rejects.toThrow('disabled');
      expect(await w.calls()).toEqual(mode === 'hidden' ? [] : ['lookup']);
    } finally { await w.host.shutdown(); }
  });
  it.each(['global', 'project'] as const)('shares original-name policy across Test, prompt/discovery and fresh reload (%s)', async scope => {
    const w = await setup(scope, { 'look*': 'deferred', '*': 'hidden' });
    const tester = new McpServerTester();
    const target = () => readMcpServerTestTarget({ agentDir: w.agentDir, scope, name: 'fixture', defaultCwd: w.cwd,
      ...(scope === 'project' ? { cwd: w.cwd } : {}), trustManager: w.trustManager });
    try {
      if (scope === 'project') {
        expect((await inspectMcpConfig({ agentDir: w.agentDir, cwd: w.cwd, trustManager: w.trustManager })).files[1]?.contentRead).toBe(false);
        await expect(target()).rejects.toMatchObject({ code: 'trust-required' });
        expect((await w.host.prepareForPrompt({ sessionId: scope, cwd: w.cwd })).tools).toEqual([]);
        expect(await w.calls()).toEqual([]);
        await w.trustManager.setDecision(w.cwd, true);
      }
      const tested = await tester.test(await target());
      expect(tested.state).toBe('connected');
      expect(tested.tools.map(tool => [tool.name, tool.exposure])).toEqual([['lookup', 'deferred'], ['mutate', 'hidden']]);
      expect(await w.calls()).toEqual([]); // Explicit Test still invokes no tool.
      const prepared = await w.host.prepareForPrompt({ sessionId: scope, cwd: w.cwd });
      expect(prepared.tools).toEqual([]);
      expect((await prepared.waitForDiscoverableTools?.())?.map(tool => [tool.name, tool.exposure]))
        .toEqual([['mcp__fixture__lookup', 'deferred']]);
      await expect(prepared.execute('mcp__fixture__mutate', {}, w.context)).rejects.toThrow('Unknown or disabled');
      await prepared.execute('mcp__fixture__lookup', {}, w.context);
      expect(await w.calls()).toEqual(['lookup']);
      await w.save({ '*': 'hidden' });
      const refreshed = await w.host.prepareForPrompt({ sessionId: scope, cwd: w.cwd });
      expect(refreshed.tools).toEqual([]);
      expect(await refreshed.waitForDiscoverableTools?.()).toEqual([]);
      await expect(prepared.execute('mcp__fixture__lookup', {}, w.context)).rejects.toThrow('not connected');
      expect(await w.calls()).toEqual(['lookup']);
    } finally { await tester.shutdown(); await w.host.shutdown(); }
  });

  it('honors the first broad match rather than a later more-specific grant', async () => {
    const w = await setup('global', { '*': 'hidden', 'look*': 'direct' }, 'direct');
    try {
      const prepared = await w.host.prepareForPrompt({ sessionId: 'first', cwd: w.cwd });
      expect(prepared.tools).toEqual([]); expect(await prepared.waitForDiscoverableTools?.()).toEqual([]);
      await expect(prepared.execute('mcp__fixture__lookup', {}, w.context)).rejects.toThrow('Unknown or disabled');
      expect(await w.calls()).toEqual([]);
    } finally { await w.host.shutdown(); }
  });

  it('keeps an exact grant ahead of a leading hidden pattern', async () => {
    const w = await setup('global', { '*': 'hidden', lookup: 'direct' });
    try {
      const prepared = await w.host.prepareForPrompt({ sessionId: 'exact', cwd: w.cwd });
      expect(prepared.tools.map(tool => tool.name)).toEqual(['mcp__fixture__lookup']);
      await prepared.execute('mcp__fixture__lookup', {}, w.context);
      await expect(prepared.execute('mcp__fixture__mutate', {}, w.context)).rejects.toThrow('Unknown or disabled');
      expect(await w.calls()).toEqual(['lookup']);
    } finally { await w.host.shutdown(); }
  });

  it('matches the original remote name, never the model namespace, and preserves read-only filtering', async () => {
    const w = await setup('global', { 'mcp__fixture__look*': 'hidden', 'look*': 'deferred', '*': 'direct' });
    try {
      const prepared = await w.host.prepareForPrompt({ sessionId: 'readonly', cwd: w.cwd, preset: 'read-only' });
      expect(prepared.tools.map(tool => tool.name)).toEqual(resourceNames);
      expect((await prepared.waitForDiscoverableTools?.())?.map(tool => tool.name)).toEqual(['mcp__fixture__lookup']);
      await expect(prepared.execute('mcp__fixture__mutate', {}, w.context)).rejects.toThrow('Unknown or disabled');
      expect(await w.calls()).toEqual([]);
      const full = await w.host.prepareForPrompt({ sessionId: 'readonly', cwd: w.cwd, preset: 'full' });
      expect(full.tools.map(tool => tool.name)).toEqual([...resourceNames, 'mcp__fixture__mutate']);
      await full.execute('mcp__fixture__mutate', {}, w.context);
      expect(await w.calls()).toEqual(['mutate']);
    } finally { await w.host.shutdown(); }
  });
});
