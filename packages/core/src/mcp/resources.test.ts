import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { McpSessionHost } from './session-host.js';
import { ProjectTrustManager } from '../security/project-trust.js';
import { SessionManager } from '../sessions/session-manager.js';
import { createAgentToolLoadout } from '../tools/tool-search.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const roots: string[] = [], hosts: McpSessionHost[] = [];
const peer = fileURLToPath(new URL('./fixtures/resource-server.mjs', import.meta.url));
const context: ExtensionRuntimeContext = { sessionManager: new SessionManager(), notify() {} };
const name = (operation: string, server = 'docs') => `mcp__${server}__${operation}`;
async function setup(exposure = 'direct', projectScope = false, redactText?: (text: string) => string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-resources-')); roots.push(root);
  const agent = path.join(root, 'agent'), cwd = path.join(root, 'project'), log = path.join(root, 'requests.jsonl');
  await mkdir(agent); await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
  const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.setDecision(cwd, true);
  const config = { version: 1, mcpServers: { docs: { command: process.execPath, args: [peer], exposure,
    env: { MCP_RESOURCE_LOG: log, MCP_SECRET: 'disposable-resource-secret', MCP_RICH_TOOL: 'yes' } } } };
  const file = path.join(projectScope ? path.join(cwd, '.ai-harness') : agent, 'mcp.json'); await writeFile(file, JSON.stringify(config));
  const host = new McpSessionHost({ agentDir: agent, trustManager: trust, startupWaitMs: 2000, closeWaitMs: 500, redactText }); hosts.push(host);
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { host, cwd, trust, config, file, calls };
}
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.shutdown())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('native MCP resources and rich payloads', () => {
  it.each([false, true])('lists bounded pages/templates and reads text/image/binary without automatic resource I/O (project=%s)', async project => {
    const f = await setup('direct', project);
    f.config.mcpServers.docs.env.MCP_RICH_TOOL = ''; await writeFile(f.file, JSON.stringify(f.config));
    const prepared = await f.host.prepareForPrompt({ sessionId: 'one', cwd: f.cwd, preset: 'read-only' });
    expect(prepared.tools.map(tool => tool.name)).toEqual(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].map(op => name(op)));
    expect(await f.calls()).toEqual([]);
    const page = await prepared.execute(name('list_mcp_resources'), {}, context);
    expect(page.structuredContent).toEqual({ resources: [{ uri: 'fixture://text', name: 'Text', mimeType: 'text/plain' }], nextCursor: 'page2', omitted: 1 });
    expect((await prepared.execute(name('list_mcp_resources'), { cursor: 'page2' }, context)).structuredContent).toMatchObject({ resources: [{ uri: 'fixture://image' }] });
    expect((await prepared.execute(name('list_mcp_resource_templates'), {}, context)).structuredContent).toEqual({ resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'By id' }] });
    const text = await prepared.execute(name('read_mcp_resource'), { uri: 'fixture://text' }, context);
    expect(text.content).toContain('Resource text'); expect(text.content).not.toContain('disposable-resource-secret');
    const image = await prepared.execute(name('read_mcp_resource'), { uri: 'fixture://image' }, context);
    expect(image.blocks?.[0]).toMatchObject({ type: 'image', mediaType: 'image/png', url: expect.stringContaining('data:image/png;base64,') });
    const binary = await prepared.execute(name('read_mcp_resource'), { uri: 'fixture://audio' }, context);
    const id = /mcp-content:([a-f0-9-]{36})/u.exec(binary.content)![1]!;
    expect(binary.content).not.toContain(Buffer.from('disposable-audio').toString('base64'));
    expect((await f.host.readRetainedContent('one', id))?.data.toString()).toBe('disposable-audio');
    expect(await f.host.readRetainedContent('other', id)).toBeUndefined();
    await f.host.releaseSession('one'); expect(await f.host.readRetainedContent('one', id)).toBeUndefined();
  });

  it('preserves structured tool results/images and retains audio without UI metadata or credential leaks', async () => {
    const f = await setup(); const prepared = await f.host.prepareForPrompt({ sessionId: 'rich', cwd: f.cwd });
    const result = await prepared.execute(name('rich'), {}, context);
    expect(result.structuredContent).toEqual({ answer: 42, secret: '•••' }); expect(result.blocks).toHaveLength(1);
    expect(result.content).toContain('rich text'); expect(result.content).toContain('mcp-content:');
    expect(JSON.stringify(result)).not.toContain('ui://app'); expect(JSON.stringify(result)).not.toContain('disposable-resource-secret');
  });

  it.each(['codemode', 'deferred', 'hidden'])('retains %s exposure, exclusions and restored-name filtering for resource helpers', async exposure => {
    const f = await setup(exposure); const prepared = await f.host.prepareForPrompt({ sessionId: exposure, cwd: f.cwd, preset: 'read-only' });
    expect(prepared.tools).toEqual([]);
    await prepared.waitForDiscoverableTools?.();
    const read = name('read_mcp_resource');
    const source = { directTools: [], hasPotentialSearchableTools: prepared.hasPotentialDiscoverableTools ?? false,
      currentSearchableTools: () => prepared.currentDiscoverableTools?.() ?? [],
      waitForSearchableTools: (signal?: AbortSignal) => prepared.waitForDiscoverableTools?.(signal) ?? Promise.resolve([]), has: (tool: string) => prepared.has(tool) };
    const loadout = createAgentToolLoadout({ staticTools: [], dynamicSource: source,
      selection: { allowedTools: ['codemode', 'tool_search', read], excludedTools: [read], preset: 'read-only' },
      initialLoadedTools: [read], codemode: { enabled: true } });
    expect(loadout.getTools().some(tool => tool.name === read)).toBe(false);
    const result = await loadout.executeCodemode({ code: `await tools.${read}({uri:'fixture://text'})` }, context,
      (tool, input, ctx, signal) => prepared.execute(tool, input, ctx, signal));
    expect(result.isError).toBe(true); expect((await f.calls()).some(call => call.method.startsWith('resources/'))).toBe(false);
    if (exposure === 'hidden') expect(await f.calls()).toEqual([]);
    else {
      expect(prepared.currentDiscoverableTools?.()).toHaveLength(4);
      const allowed = createAgentToolLoadout({ staticTools: [], dynamicSource: source,
        selection: { allowedTools: ['codemode', read, name('rich')], preset: 'read-only' }, codemode: { enabled: true } });
      const result = await allowed.executeCodemode({ code: `text(await tools.${read}({uri:'fixture://text'})); await tools.${read}({uri:'fixture://image'}); text(await tools.${name('rich')}({}));` }, context,
        (tool, input, ctx, signal) => prepared.execute(tool, input, ctx, signal));
      expect(result.isError).toBeFalsy(); expect(result.content).toContain('Resource text');
      expect(result.content).toContain('"answer":42'); expect(result.blocks).toHaveLength(2);
      const reduced = createAgentToolLoadout({ staticTools: [], dynamicSource: source,
        selection: { allowedTools: ['codemode', read] }, codemode: { enabled: true, limits: { outputBytes: 64 } } });
      const denied = await reduced.executeCodemode({ code: `await tools.${read}({uri:'fixture://image'})` }, context,
        (tool, input, ctx, signal) => prepared.execute(tool, input, ctx, signal));
      expect(denied.isError).toBe(true); expect(denied.blocks).toBeUndefined();
    }
  });

  it('refuses untrusted/stale reads, cross-context invocation, malformed URI, Apps and chat-only tools', async () => {
    const f = await setup('direct', true); const prepared = await f.host.prepareForPrompt({ sessionId: 'guarded', cwd: f.cwd });
    const read = name('read_mcp_resource');
    for (const uri of ['ui://app', 'javascript:alert(1)', 'bad uri', 'data:text/html,script']) await expect(prepared.execute(read, { uri }, context)).rejects.toThrow();
    await expect(prepared.execute(read, { uri: 'fixture://text' }, { ...context, currentSessionId: 'other' })).rejects.toThrow();
    expect((await f.calls()).filter(call => call.method === 'resources/read')).toEqual([]);
    await expect(prepared.execute(read, { uri: 'fixture://app' }, context)).rejects.toThrow();
    await f.trust.setDecision(f.cwd, false);
    await expect(prepared.execute(read, { uri: 'fixture://text' }, context)).rejects.toThrow();
    await f.trust.setDecision(f.cwd, true); f.config.mcpServers.docs.exposure = 'hidden'; await writeFile(f.file, JSON.stringify(f.config));
    await expect(prepared.execute(read, { uri: 'fixture://text' }, context)).rejects.toThrow();
    expect((await f.host.prepareForPrompt({ sessionId: 'chat', cwd: f.cwd, preset: 'chat-only' })).tools).toEqual([]);
  });

  it('separates physical connection generations and ignores an old close for a replacement artifact', async () => {
    const f = await setup(), closed: Array<() => void> = [];
    const host = new McpSessionHost({ agentDir: path.dirname(f.file), connect: async (_target, _signal, options) => {
      closed.push(options.callbacks.onClose);
      return { tools: [], redact: text => text, close: async () => undefined, callTool: async () => ({ content: [] }), resources: {
        listResources: async () => ({ resources: [] }), listTemplates: async () => ({ resourceTemplates: [] }),
        readResource: async () => ({ contents: [{ uri: 'fixture://audio', mimeType: 'audio/wav', blob: 'eA==' }] }),
      } };
    } }); hosts.push(host);
    const read = async () => {
      const prepared = await host.prepareForPrompt({ sessionId: 'generation', cwd: f.cwd });
      const result = await prepared.execute(name('read_mcp_resource'), { uri: 'fixture://audio' }, context);
      return /mcp-content:([a-f0-9-]{36})/u.exec(result.content)![1]!;
    };
    const first = await read(); closed[0]!(); expect(await host.readRetainedContent('generation', first)).toBeUndefined();
    const replacement = await read(); expect(closed).toHaveLength(2); closed[0]!();
    expect((await host.readRetainedContent('generation', replacement))?.data.toString()).toBe('x');
    expect(await host.readRetainedContent('generation', first)).toBeUndefined();
  });

  it('withdraws a read whose exact configuration changes while the peer is answering', async () => {
    const f = await setup(); let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reached = resolve; });
    const host = new McpSessionHost({ agentDir: path.dirname(f.file), trustManager: f.trust, connect: async () => ({
      tools: [], redact: text => text, close: async () => undefined, callTool: async () => ({ content: [] }), resources: {
        listResources: async () => ({ resources: [] }), listTemplates: async () => ({ resourceTemplates: [] }),
        readResource: async () => { reached(); await gate; return { contents: [{ uri: 'fixture://audio', mimeType: 'audio/wav', blob: 'eA==' }] }; },
      },
    }) }); hosts.push(host);
    try {
      const prepared = await host.prepareForPrompt({ sessionId: 'stale-answer', cwd: f.cwd });
      const pending = prepared.execute(name('read_mcp_resource'), { uri: 'fixture://audio' }, context);
      await started; f.config.mcpServers.docs.exposure = 'hidden'; await writeFile(f.file, JSON.stringify(f.config)); release();
      await expect(pending).rejects.toThrow('no longer authorized');
    } finally { release(); }
  });

  it('applies newly known host credentials to retained binary reads and later payload admission', async () => {
    let secret = ''; const f = await setup('direct', false, text => secret ? text.replaceAll(secret, '[redacted]') : text);
    const prepared = await f.host.prepareForPrompt({ sessionId: 'credentials', cwd: f.cwd });
    const result = await prepared.execute(name('read_mcp_resource'), { uri: 'fixture://audio' }, context);
    const id = /mcp-content:([a-f0-9-]{36})/u.exec(result.content)![1]!;
    expect(await f.host.readRetainedContent('credentials', id)).toBeDefined();
    secret = 'disposable-audio'; expect(await f.host.readRetainedContent('credentials', id)).toBeUndefined();
    await expect(prepared.execute(name('read_mcp_resource'), { uri: 'fixture://audio' }, context)).rejects.toThrow();
  });

  it('cancels an actual held stdio read without publishing a late result', async () => {
    const f = await setup(); const prepared = await f.host.prepareForPrompt({ sessionId: 'abort', cwd: f.cwd });
    const controller = new AbortController();
    const pending = prepared.execute(name('read_mcp_resource'), { uri: 'fixture://held' }, context, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((await prepared.execute(name('read_mcp_resource'), { uri: 'fixture://text' }, context)).content).toContain('Resource text');
  });
});
