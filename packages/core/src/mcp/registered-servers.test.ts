import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type ExtensionAPI, type ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { ExtensionModuleLoader } from '../extensions/module-loader.js';
import { ProjectTrustManager } from '../security/project-trust.js';
import { SessionManager } from '../sessions/session-manager.js';
import { createAgentToolLoadout } from '../tools/tool-search.js';
import { inspectMcpConfig } from './config-inventory.js';
import { McpSessionHost, type McpHostConnect } from './session-host.js';

const roots: string[] = [], hosts: McpSessionHost[] = [], registries: ExtensionRegistry[] = [];
const context: ExtensionRuntimeContext = { sessionManager: new SessionManager(), notify() {} };
const peer = fileURLToPath(new URL('./fixtures/resource-server.mjs', import.meta.url));
async function setup(connect?: McpHostConnect) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-registration-')); roots.push(root);
  const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'work');
  await mkdir(agentDir); await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
  const trust = new ProjectTrustManager(path.join(agentDir, 'trust.json')); await trust.load(); await trust.setDecision(cwd, true);
  const registry = new ExtensionRegistry(); registries.push(registry);
  const host = new McpSessionHost({ agentDir, registeredServers: registry.mcpServers, trustManager: trust,
    startupWaitMs: 2000, closeWaitMs: 500, connect }); hosts.push(host);
  let api!: ExtensionAPI; await registry.load('owner', value => { api = value; });
  return { root, agentDir, cwd, trust, registry, host, api,
    overview: async () => host.decorateInventory(await inspectMcpConfig({ agentDir, cwd, trustManager: trust })),
    prepare: (sessionId = 'one', preset?: 'read-only' | 'chat-only') => host.prepareForPrompt({ sessionId, cwd, preset }) };
}
function mockConnection(call = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))) {
  return { tools: [
    { name: 'lookup', remoteName: 'lookup', description: 'Read', parameters: {}, readOnly: true },
    { name: 'write', remoteName: 'write', description: 'Write', parameters: {}, readOnly: false },
  ], redact: (text: string) => text, callTool: call, close: vi.fn(async () => undefined) };
}
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.unloadAll()));
  await Promise.all(hosts.splice(0).map(host => host.shutdown()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('owned extension MCP registrations', () => {
  it('owns bounded inert configuration, rejects foreign conflicts, and keeps inventory passive and value-free', async () => {
    const connect = vi.fn<McpHostConnect>(); const f = await setup(connect);
    const config = { command: 'node', env: { TOKEN: 'registration-private-secret' } };
    const staleDispose = f.api.registerMcpServer('docs', config); config.env.TOKEN = 'changed-after-registration';
    const row = (await f.overview()).servers[0]!;
    expect(row).toMatchObject({ exposure: 'direct', registration: { extensionId: 'owner', shadowedByFile: false }, envNames: ['TOKEN'] });
    expect(JSON.stringify(row)).not.toMatch(/registration-private-secret|changed-after-registration/u);
    expect((await f.registry.mcpServers.resolve(row, await inspectMcpConfig({ agentDir: f.agentDir }), f.cwd)) as object).toMatchObject({ env: { TOKEN: 'registration-private-secret' } });
    await f.registry.load('foreign', api => {
      expect(api.unregisterMcpServer('docs')).toBe(false);
      expect(() => api.registerMcpServer('docs', { command: 'other' })).toThrow('already registered');
    });
    let accessed = false;
    expect(() => f.api.registerMcpServer('getter', { get command() { accessed = true; return 'node'; } })).toThrow('Invalid');
    expect(accessed).toBe(false);
    expect(() => f.api.registerMcpServer('bad', { command: 'node', exposure: 'foreign' } as never)).toThrow('Invalid');
    f.api.registerMcpServer('docs', { command: 'replacement' }); staleDispose();
    expect((await f.overview()).servers).toHaveLength(1); expect(connect).not.toHaveBeenCalled();
    for (let i = 1; i < 32; i++) f.api.registerMcpServer(`server${i}`, { command: 'node' });
    expect(() => f.api.registerMcpServer('overflow', { command: 'node' })).toThrow('limit');
    await f.registry.unload('owner'); expect((await f.overview()).servers).toEqual([]);
    expect(() => f.api.registerMcpServer('late', { command: 'node' })).toThrow('retired');
    expect(() => f.api.unregisterMcpServer('docs')).toThrow('retired');
    expect(connect).not.toHaveBeenCalled();
  });

  it('hosts actual resource-only stdio peers, redacts results, and synchronously withdraws tools and binary references', async () => {
    const f = await setup();
    f.api.registerMcpServer('docs', { command: process.execPath, args: [peer], env: { MCP_SECRET: 'disposable-resource-secret' } });
    const prepared = await f.prepare('one', 'read-only');
    expect(prepared.tools.map(tool => tool.name)).toEqual(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].map(op => `mcp__docs__${op}`));
    const read = 'mcp__docs__read_mcp_resource';
    expect((await prepared.execute(read, { uri: 'fixture://text' }, context)).content).not.toContain('disposable-resource-secret');
    const result = await prepared.execute(read, { uri: 'fixture://audio' }, context);
    const id = /mcp-content:([a-f0-9-]{36})/u.exec(result.content)![1]!;
    expect((await f.host.readRetainedContent('one', id))?.data.toString()).toBe('disposable-audio');
    expect(f.api.unregisterMcpServer('docs')).toBe(true);
    expect(await f.host.readRetainedContent('one', id)).toBeUndefined();
    await expect(prepared.execute(read, { uri: 'fixture://text' }, context)).rejects.toThrow();
    expect(f.host.getPreparedTools('one').tools).toEqual([]);
    await expect(readFile(path.join(f.agentDir, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(f.cwd, '.ai-harness', 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retires all sessions before slow cleanup, fences stale disposers and does not reconnect on registration', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const connections: ReturnType<typeof mockConnection>[] = [];
    const connect = vi.fn<McpHostConnect>(async () => { const c = mockConnection(); connections.push(c); return c; });
    const f = await setup(connect); const oldDispose = f.api.registerMcpServer('docs', { command: 'first' });
    const first = await f.prepare('one'); await f.prepare('two');
    connections.forEach(c => c.close.mockImplementation(() => gate));
    f.api.registerMcpServer('docs', { command: 'second' }); oldDispose();
    expect(connect).toHaveBeenCalledTimes(2); expect(connections.every(c => c.close.mock.calls.length === 1)).toBe(true);
    expect(f.host.getPreparedTools('one').tools).toEqual([]); expect(f.host.getPreparedTools('two').tools).toEqual([]);
    await expect(first.execute('mcp__docs__lookup', {}, context)).rejects.toThrow();
    release(); const current = await f.prepare(); await current.execute('mcp__docs__lookup', {}, context);
    expect(connect).toHaveBeenCalledTimes(3); expect(connections[0]!.callTool).not.toHaveBeenCalled();
    expect(connections[2]!.callTool).toHaveBeenCalledTimes(1);
  });

  it.each(['global', 'project', 'invalid', 'malformed'])('gives %s files precedence without effects or rewriting them', async scope => {
    const connection = mockConnection(); const connect = vi.fn<McpHostConnect>(async () => connection); const f = await setup(connect);
    f.api.registerMcpServer('docs', { command: 'registered' }); const old = await f.prepare();
    const file = path.join(scope === 'project' ? path.join(f.cwd, '.ai-harness') : f.agentDir, 'mcp.json');
    const bytes = scope === 'malformed' ? 'not JSON' : JSON.stringify({ mcpServers: { docs: scope === 'invalid' ? { command: false } : { command: 'file', enabled: false } } });
    await writeFile(file, bytes);
    await expect(old.execute('mcp__docs__lookup', {}, context)).rejects.toThrow();
    expect((await f.overview()).servers.find(server => server.registration)?.registration?.shadowedByFile).toBe(true);
    expect((await f.prepare()).tools).toEqual([]); expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.callTool).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe(bytes);
    await rm(file); expect((await f.prepare()).tools).toHaveLength(2); expect(connect).toHaveBeenCalledTimes(2);
  });

  it('fences an in-flight response and a late connection after withdrawal', async () => {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reached = resolve; });
    const connection = mockConnection(vi.fn(async () => { reached(); await gate; return { content: [{ type: 'text' as const, text: 'late-result' }] }; }));
    const f = await setup(async () => connection); f.api.registerMcpServer('docs', { command: 'node' });
    const prepared = await f.prepare(); const pending = prepared.execute('mcp__docs__lookup', {}, context);
    await started; f.api.unregisterMcpServer('docs'); release(); await expect(pending).rejects.toThrow();
    let finish!: () => void; const connecting = new Promise<void>(resolve => { finish = resolve; });
    const late = mockConnection(); const second = await setup(async () => { await connecting; return late; });
    second.api.registerMcpServer('docs', { command: 'node', exposure: 'deferred' }); const snapshot = await second.prepare();
    second.api.unregisterMcpServer('docs'); finish(); await snapshot.waitForDiscoverableTools?.();
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1)); expect(second.host.getPreparedTools('one').tools).toEqual([]);
  });

  it('revalidates loader provenance, fresh trust and workspace ownership across successful/failed reloads', async () => {
    const connection = mockConnection(); const f = await setup(async () => connection);
    const entry = path.join(f.cwd, 'extension.mjs');
    const source = (command: string, fail = false) => `export default api => { api.registerMcpServer('docs', {command:${JSON.stringify(command)}}); ${fail ? "throw new Error('candidate failed');" : ''} };`;
    await writeFile(entry, source('first'));
    const loader = new ExtensionModuleLoader(f.registry, { cwd: f.cwd, paths: [entry], includeGlobalLocation: false,
      includeProjectLocation: false, includeEnvironmentPaths: false, isProjectTrusted: () => f.trust.isTrusted(f.cwd) });
    expect((await loader.loadAll()).committed).toBe(true); const first = await f.prepare();
    const oldKey = (await f.overview()).servers[0]!.configKey;
    const other = path.join(f.root, 'other'); await mkdir(other); await f.trust.setDecision(other, true);
    expect((await f.host.prepareForPrompt({ sessionId: 'other', cwd: other })).tools).toEqual([]);
    await expect(first.execute('mcp__docs__lookup', {}, { ...context, currentSessionId: 'other' })).rejects.toThrow();
    await writeFile(entry, source('bad', true)); expect((await loader.reload()).committed).toBe(false);
    await expect(first.execute('mcp__docs__lookup', {}, context)).rejects.toThrow();
    expect((await f.overview()).servers[0]!.configKey).not.toBe(oldKey);
    const restored = await f.prepare(); await restored.execute('mcp__docs__lookup', {}, context);
    await writeFile(entry, source('second')); expect((await loader.reload()).committed).toBe(true);
    await expect(restored.execute('mcp__docs__lookup', {}, context)).rejects.toThrow();
    const second = await f.prepare(); await f.trust.setDecision(f.cwd, false);
    await expect(second.execute('mcp__docs__lookup', {}, context)).rejects.toThrow();
    expect((await f.prepare()).tools).toEqual([]); expect(connection.callTool).toHaveBeenCalledTimes(1);
    await loader.clear(); expect((await f.overview()).servers).toEqual([]);
  });

  it.each(['direct', 'codemode', 'deferred', 'hidden'] as const)('keeps %s exposure subordinate to native selection and presets', async exposure => {
    const connection = mockConnection(); const connect = vi.fn<McpHostConnect>(async () => connection); const f = await setup(connect);
    f.api.registerMcpServer('docs', { command: 'node', exposure });
    const prepared = await f.prepare('one', 'read-only'); await prepared.waitForDiscoverableTools?.();
    const read = 'mcp__docs__lookup';
    const tools = [...prepared.tools, ...prepared.currentDiscoverableTools?.() ?? []];
    expect(tools.map(tool => tool.name)).toEqual(exposure === 'hidden' ? [] : [read]);
    const loadout = createAgentToolLoadout({ staticTools: prepared.tools,
      dynamicSource: { directTools: prepared.tools, hasPotentialSearchableTools: prepared.hasPotentialDiscoverableTools ?? false,
        currentSearchableTools: () => prepared.currentDiscoverableTools?.() ?? [],
        waitForSearchableTools: signal => prepared.waitForDiscoverableTools?.(signal) ?? Promise.resolve([]), has: name => prepared.has(name) },
      selection: { allowedTools: ['codemode', 'tool_search', read], excludedTools: [read], preset: 'read-only' }, initialLoadedTools: [read], codemode: { enabled: true } });
    expect(loadout.getTools().some(tool => tool.name === read)).toBe(false);
    const denied = await loadout.executeCodemode({ code: `await tools.${read}({})` }, context,
      (name, input, ctx, signal) => prepared.execute(name, input, ctx, signal));
    expect(denied.isError).toBe(true); expect(connection.callTool).not.toHaveBeenCalled();
    expect((await f.prepare('chat', 'chat-only')).tools).toEqual([]);
    if (exposure === 'hidden') expect(connect).not.toHaveBeenCalled();
  });
});
