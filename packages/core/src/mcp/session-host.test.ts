import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { ProjectTrustManager } from '../security/project-trust.js';
import { inspectMcpConfig } from './config-inventory.js';
import { McpSessionHost, type McpHostConnect } from './session-host.js';

const fixturePath = fileURLToPath(new URL('./fixtures/test-server.mjs', import.meta.url));
const roots: string[] = [];

async function workspace(): Promise<{
  agentDir: string;
  project: string;
  trust: ProjectTrustManager;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-mcp-host-'));
  roots.push(root);
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  await Promise.all([mkdir(agentDir), mkdir(project)]);
  const trust = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
  await trust.load();
  return { agentDir, project, trust };
}

async function writeConfig(agentDir: string, servers: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ version: 1, mcpServers: servers }));
}

const context = {} as ExtensionRuntimeContext;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('McpSessionHost', () => {
  it('keeps a stdio connection across prompts, enforces read-only exposure, invokes tools, and redacts output', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, {
      fixture: {
        command: process.execPath,
        args: [fixturePath],
        env: { MCP_TEST_SECRET: 'host-secret' },
      },
    });
    const host = new McpSessionHost({
      agentDir,
      trustManager: trust,
      startupWaitMs: 2_000,
      requestTimeoutMs: 2_000,
      closeWaitMs: 500,
    });

    const prepared = await host.prepareForPrompt({ sessionId: 'one', cwd: project, preset: 'read-only' });
    expect(prepared.tools.map(tool => tool.name)).toEqual(['mcp__fixture__lookup']);
    const result = await prepared.execute('mcp__fixture__lookup', { topic: 'docs' }, context);
    expect(result).toMatchObject({ isError: false });
    expect(result.content).toContain('lookup:{"topic":"docs"}:•••');
    expect(result.content).not.toContain('host-secret');

    const second = await host.prepareForPrompt({ sessionId: 'one', cwd: project, preset: 'full' });
    expect(second.tools.map(tool => tool.name)).toEqual([
      'mcp__fixture__lookup',
      'mcp__fixture__mutate',
    ]);
    const inventory = host.decorateInventory(await inspectMcpConfig({ agentDir }));
    expect(inventory.servers[0]?.runtimeStatus).toMatchObject({
      state: 'connected', sessionId: 'one', toolCount: 2,
    });
    await host.shutdown();
  });

  it('connects deferred servers in the background and reveals schemas only on explicit discovery', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, {
      direct: { command: 'node', exposure: 'direct' },
      docs: { command: 'node', exposure: 'deferred' },
      code: { command: 'node', exposure: 'codemode' },
    });
    let releaseIndirect!: () => void;
    const indirectGate = new Promise<void>(resolve => { releaseIndirect = resolve; });
    const connect = vi.fn<McpHostConnect>(async target => {
      if (target.name !== 'direct') await indirectGate;
      return {
        tools: [{
          name: 'lookup', remoteName: 'lookup', description: 'Search product documentation',
          parameters: { type: 'object' }, readOnly: true,
        }],
        redact: value => value,
        callTool: async () => ({ content: [{ type: 'text', text: `${target.name}:ok` }] }),
        close: async () => undefined,
      };
    });
    const host = new McpSessionHost({ agentDir, trustManager: trust, startupWaitMs: 1_000, connect });

    const prepared = await host.prepareForPrompt({ sessionId: 'deferred', cwd: project });
    expect(prepared.tools.map(tool => tool.name)).toEqual(['mcp__direct__lookup']);
    expect(prepared.currentDiscoverableTools?.()).toEqual([]);
    expect(prepared.hasPotentialDiscoverableTools).toBe(true);

    releaseIndirect();
    const discoverable = await prepared.waitForDiscoverableTools?.();
    expect(discoverable?.map(tool => ({ name: tool.name, exposure: tool.exposure }))).toEqual([
      { name: 'mcp__docs__lookup', exposure: 'deferred' },
      { name: 'mcp__code__lookup', exposure: 'codemode' },
    ]);
    const result = await prepared.execute('mcp__docs__lookup', {}, context);
    expect(result.content).toBe('docs:ok');
    await host.shutdown();
  });

  it('reuses unchanged connections, closes disabled entries, and disambiguates normalized name collisions', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, {
      'same name': { command: 'node', enabled: true },
      same_name: { command: 'node', enabled: true },
    });
    const close = vi.fn(async () => undefined);
    const connect = vi.fn<McpHostConnect>(async _target => ({
      tools: [{
        name: 'Do Thing', remoteName: 'Do Thing', description: 'Does it', parameters: { type: 'object' }, readOnly: true,
      }],
      redact: value => value,
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close,
    }));
    const host = new McpSessionHost({ agentDir, trustManager: trust, startupWaitMs: 1_000, connect });

    const first = await host.prepareForPrompt({ sessionId: 'collision', cwd: project });
    expect(first.tools).toHaveLength(2);
    expect(first.tools.every(tool => /^mcp__same_name__do_thing__[a-f0-9]{10}$/u.test(tool.name))).toBe(true);
    await host.prepareForPrompt({ sessionId: 'collision', cwd: project });
    expect(connect).toHaveBeenCalledTimes(2);

    const inventory = await inspectMcpConfig({ agentDir });
    const revision = inventory.files[0]!.revision!;
    await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
      version: 1,
      mcpServers: {
        'same name': { command: 'node', enabled: false },
        same_name: { command: 'node', enabled: false },
      },
    }));
    expect(revision).toBeTruthy();
    const disabled = await host.prepareForPrompt({ sessionId: 'collision', cwd: project });
    expect(disabled.tools).toEqual([]);
    expect(close).toHaveBeenCalledTimes(2);
    await host.shutdown();
  });

  it('reconnects a server on the next prompt after a transport disconnect', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, { docs: { command: 'node' } });
    let disconnect = (): void => undefined;
    const connect = vi.fn<McpHostConnect>(async (_target, _signal, options) => {
      disconnect = options.callbacks.onClose;
      return {
        tools: [{
          name: 'lookup', remoteName: 'lookup', description: 'Lookup',
          parameters: { type: 'object' }, readOnly: true,
        }],
        redact: value => value,
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        close: async () => undefined,
      };
    });
    const host = new McpSessionHost({ agentDir, trustManager: trust, startupWaitMs: 1_000, connect });
    expect((await host.prepareForPrompt({ sessionId: 'retry', cwd: project })).tools).toHaveLength(1);
    disconnect();
    expect((await host.prepareForPrompt({ sessionId: 'retry', cwd: project })).tools).toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(2);
    await host.shutdown();
  });

  it('withdraws a prepared read-only binding when a tool-list update removes its safety hint', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, { docs: { command: 'node' } });
    let updateTools = (_tools: Array<{
      name: string; remoteName: string; description: string;
      parameters: Record<string, unknown>; readOnly: boolean;
    }>): void => undefined;
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const host = new McpSessionHost({
      agentDir,
      trustManager: trust,
      startupWaitMs: 1_000,
      connect: async (_target, _signal, options) => {
        updateTools = options.callbacks.onToolsChanged;
        return {
          tools: [{
            name: 'lookup', remoteName: 'lookup', description: 'Lookup',
            parameters: { type: 'object' }, readOnly: true,
          }],
          redact: value => value,
          callTool,
          close: async () => undefined,
        };
      },
    });
    const prepared = await host.prepareForPrompt({
      sessionId: 'read-only-refresh', cwd: project, preset: 'read-only',
    });
    expect(prepared.tools).toHaveLength(1);

    updateTools([{
      name: 'lookup', remoteName: 'lookup', description: 'Lookup',
      parameters: { type: 'object' }, readOnly: false,
    }]);

    await expect(prepared.execute('mcp__docs__lookup', {}, context))
      .rejects.toThrow('is not allowed in a read-only session');
    expect(callTool).not.toHaveBeenCalled();
    expect(host.getPreparedTools('read-only-refresh', 'read-only').tools).toEqual([]);
    await host.shutdown();
  });

  it('retains connections during a prompt and closes them after the explicit idle window', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, { idle: { command: 'node' } });
    const close = vi.fn(async () => undefined);
    const host = new McpSessionHost({
      agentDir,
      trustManager: trust,
      startupWaitMs: 1_000,
      idleMs: 20,
      connect: async () => ({
        tools: [{
          name: 'read', remoteName: 'read', description: 'Read',
          parameters: { type: 'object' }, readOnly: true,
        }],
        redact: value => value,
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        close,
      }),
    });
    await host.prepareForPrompt({ sessionId: 'idle', cwd: project });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(close).not.toHaveBeenCalled();
    host.finishPrompt('idle');
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(host.getPreparedTools('idle').tools).toEqual([]);
    const inventory = host.decorateInventory(await inspectMcpConfig({ agentDir }));
    expect(inventory.servers[0]?.runtimeStatus).toMatchObject({ state: 'closed', sessionId: 'idle' });
    await host.shutdown();
  });

  it('lets an abort stop the startup wait without waiting for a transport deadline', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, { slow: { command: 'node' } });
    const connect: McpHostConnect = (_target, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    const host = new McpSessionHost({
      agentDir,
      trustManager: trust,
      startupWaitMs: 10_000,
      deadlineMs: 10_000,
      connect,
    });
    const controller = new AbortController();
    const started = Date.now();
    const preparing = host.prepareForPrompt({ sessionId: 'abort', cwd: project, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1_000);
    await host.shutdown();
  });

  it('does not start a detached connection when a session is released during target resolution', async () => {
    const { agentDir, project, trust } = await workspace();
    await writeConfig(agentDir, { slow: { command: 'node', cwd: '.' } });
    let continueResolution!: () => void;
    let resolutionStarted!: () => void;
    const started = new Promise<void>(resolve => { resolutionStarted = resolve; });
    const gate = new Promise<void>(resolve => { continueResolution = resolve; });
    const connect = vi.fn<McpHostConnect>(async () => ({
      tools: [],
      redact: value => value,
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
    }));
    const host = new McpSessionHost({
      agentDir,
      trustManager: trust,
      resolveWorkingDirectory: async () => {
        resolutionStarted();
        await gate;
        return project;
      },
      connect,
    });

    const preparing = host.prepareForPrompt({ sessionId: 'released', cwd: project });
    await started;
    await host.releaseSession('released');
    continueResolution();

    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(connect).not.toHaveBeenCalled();
    await host.shutdown();
  });
});
