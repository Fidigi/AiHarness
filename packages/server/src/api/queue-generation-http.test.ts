import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunSnapshot, ExtensionRuntimeContext } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

const toolSource = (version: number) => `export default function(api) {
  api.registerTool({ name: 'managed_generation_ask', description: 'Managed tool generation ${version}',
    execute: async (_input, context) => {
      const results = await Promise.all([
        context.requestInteraction({ kind: 'confirm', title: 'Managed first' }),
        context.requestInteraction({ kind: 'confirm', title: 'Managed second' }),
      ]);
      return { content: JSON.stringify({ version: ${version}, results }) };
    }
  });
}`;

/** Actual services, public registry hooks, managed on-disk modules, Express and durable Core runs. */
describe('managed tool generation interaction authority HTTP', () => {
  let root: string; let cwd: string; let nextCwd: string; let data: string; let base: string;
  let services: RuntimeServices;
  let callback: NonNullable<ExtensionRuntimeContext['requestInteraction']>;
  let releaseProvider: () => void;
  let providerWaiting: boolean;
  const headers = { Authorization: 'Bearer generation-admin', 'Content-Type': 'application/json' };
  const post = (url: string, body: unknown) => fetch(`${base}/api/${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const state = (id: string) => fetch(`${base}/api/agent/sessions/${id}/state`, { headers }).then(response => response.json());
  const extensionFile = (workspace: string) => path.join(workspace, '.ai-harness', 'extensions', 'generation.js');

  beforeEach(async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'generation-admin');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'generation-admin');
    vi.stubEnv('AI_HARNESS_PROVIDER_RENAME_EXCLUSIVE_HOST', '');
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-managed-generation-'));
    cwd = path.join(root, 'workspace'); nextCwd = path.join(root, 'next-workspace'); data = path.join(root, 'data');
    for (const workspace of [cwd, nextCwd]) await mkdir(path.dirname(extensionFile(workspace)), { recursive: true });
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: data, allowedRoots: [cwd, nextCwd], defaultCwd: cwd,
      runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
    base = `http://127.0.0.1:${server.port}`;
    cwd = await services.workspaceManager.resolve(cwd, { kind: 'directory' });
    nextCwd = await services.workspaceManager.resolve(nextCwd, { kind: 'directory' });
    await services.trustManager.trust(cwd);
    await services.trustManager.trust(nextCwd);
    expect(await services.trustManager.isTrusted(nextCwd)).toBe(true);
    expect(await readFile(path.join(data, 'trust.json'), 'utf8')).toContain(nextCwd);
    await writeFile(extensionFile(cwd), toolSource(1));
    const initial = await services.reloadResources({ cwd });
    expect(initial.errors).toEqual([]);
    expect(initial.loadedExtensions).toHaveLength(1);
    // Capture the actual tool context via a public observer, not a replacement executor/requester.
    await services.extensionRegistry.load('generation-observer', api => api.before('before:tool', event => {
      if (event.tool === 'managed_generation_ask') callback = event.context.requestInteraction!;
    }));
    const heldProvider = new Promise<void>(resolve => { releaseProvider = resolve; });
    providerWaiting = false;
    vi.spyOn(services.resolveProvider('mock')!, 'streamChat').mockImplementation(async (messages, _chunk, complete) => {
      if (messages.some(message => message.role === 'tool')) {
        providerWaiting = true;
        await heldProvider;
        complete?.({ content: 'done' });
      } else complete?.({ content: '', toolCalls: [{ id: 'managed-generation-call', name: 'managed_generation_ask', input: {} }] });
    });
  });

  afterEach(async () => {
    releaseProvider?.();
    if (services) {
      for (const run of services.agentRuntime.listRunning()) { services.agentRuntime.stop(run.id); await services.agentRuntime.wait(run.id); }
      // Restore both the fixture cwd and its managed generation before releasing the host.
      await rm(extensionFile(cwd), { force: true });
      await rm(extensionFile(nextCwd), { force: true });
      expect((await services.reloadResources({ cwd })).errors).toEqual([]);
      await services.extensionRegistry.unload('generation-observer');
    }
    await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function begin() {
    const response = await post('agent/runs', { cwd, provider: 'mock', input: 'Run managed tool', toolPreset: 'full', autoCompaction: false });
    expect(response.status).toBe(202);
    const { run } = await response.json() as { run: AgentRunSnapshot };
    await vi.waitFor(() => expect(services.agentRuntime.getRun(run.id)?.extensionRequests).toHaveLength(2));
    return run;
  }

  async function assertRevoked(run: AgentRunSnapshot, ids: string[], old: typeof callback) {
    await vi.waitFor(() => expect(providerWaiting).toBe(true));
    // The run is still active: immediate cancellation here proves epoch revocation, not run termination.
    expect(services.agentRuntime.listRunning().map(item => item.id)).toContain(run.id);
    const sequence = services.agentRuntime.journal.lastSequence(run.sessionId);
    const late = old({ kind: 'confirm', title: 'Old managed tool callback after generation boundary' });
    expect(await late).toEqual({ cancelled: true });
    expect(late.close!()).toBe(false);
    expect(late.update!({ kind: 'confirm', title: 'Cannot update stale handle' })).toBe(false);
    expect(services.agentRuntime.journal.lastSequence(run.sessionId)).toBe(sequence);
    expect((await state(run.sessionId)).run.extensionRequests).toEqual([]);
    for (const id of ids) {
      expect((await post(`agent/sessions/${run.sessionId}/interactions/${id}`, { cancelled: true })).status).toBe(404);
      const resolved = services.agentRuntime.journal.replay(run.sessionId).events.filter(event => event.type === 'extension.ui'
        && (event.data as { action: string; requestId: string }).action === 'resolved'
        && (event.data as { requestId: string }).requestId === id);
      expect(resolved).toHaveLength(1);
      expect((resolved[0].data as { cancelled: boolean }).cancelled).toBe(true);
    }
    releaseProvider();
    expect((await services.agentRuntime.wait(run.id))?.phase).toBe('completed');
    const final = await state(run.sessionId);
    const results = final.session.messages.filter((message: { role: string }) => message.role === 'tool');
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].content)).toEqual({ version: 1, results: [{ cancelled: true }, { cancelled: true }] });
    expect(await readFile(path.join(data, 'sessions', `${run.sessionId}.jsonl`), 'utf8')).toContain('managed-generation-call');
    for (const id of ids) expect(services.agentRuntime.journal.replay(run.sessionId).events.filter(event => event.type === 'extension.ui'
      && (event.data as { action: string; requestId: string }).action === 'resolved'
      && (event.data as { requestId: string }).requestId === id)).toHaveLength(1);
  }

  it.each(['agent/reload', 'plugins/reload'])('%s preserves same-workspace failed candidates, then commits a genuine managed TOOL generation and clears once', async route => {
    const run = await begin(); const old = callback;
    const initial = (await state(run.sessionId)).run.extensionRequests;
    const originalTool = services.extensionRegistry.getTools().find(tool => tool.name === 'managed_generation_ask')!;
    const owner = originalTool.extensionId;
    const clear = vi.spyOn(services.agentRuntime, 'clearExtensionInteractions');
    const settled = vi.fn();
    try {
      for (const source of ['export default syntax error', 'export default function() { throw new Error("reject factory"); }']) {
        await writeFile(extensionFile(cwd), source);
        const failed = await post(route, { cwd, sessionId: run.sessionId });
        expect(failed.status).toBe(200);
        const body = await failed.json();
        expect(route === 'agent/reload' ? body.errors : body.reload.errors).not.toEqual([]);
        expect((await state(run.sessionId)).run.extensionRequests).toEqual(initial);
        expect(clear).not.toHaveBeenCalled();
        expect(services.extensionRegistry.getTools().find(tool => tool.name === 'managed_generation_ask')!.extensionId).toBe(owner);
      }
      const authorized = old({ kind: 'confirm', title: 'Tool callback remains authorized after both failures' });
      const pending = authorized.then(value => { settled(value); return value; });
      expect((await state(run.sessionId)).run.extensionRequests).toHaveLength(3);
      expect(settled).not.toHaveBeenCalled();
      expect(authorized.id).toBeTypeOf('string');
      const ids: string[] = [...initial.map((item: { id: string }) => item.id), authorized.id!];
      await writeFile(extensionFile(cwd), toolSource(2));
      const succeeded = await post(route, { cwd, sessionId: run.sessionId });
      expect(succeeded.status).toBe(200);
      const body = await succeeded.json();
      expect(route === 'agent/reload' ? body.errors : body.reload.errors).toEqual([]);
      expect(clear).toHaveBeenCalledOnce();
      const committed = services.extensionRegistry.getTools().find(tool => tool.name === 'managed_generation_ask')!;
      expect(committed.description).toBe('Managed tool generation 2');
      expect(committed.extensionId).toBe(owner); // Ownership stays the canonical module path across generations.
      expect(committed.execute).not.toBe(originalTool.execute);
      expect(await pending).toEqual({ cancelled: true });
      expect(settled).toHaveBeenCalledOnce();
      expect(authorized.close!()).toBe(false);
      await assertRevoked(run, ids, old);
      expect(settled).toHaveBeenCalledOnce();
      // Execute the replacement managed tool through a new real provider/tool turn, not just inventory metadata.
      const replacementRun = await begin();
      const replacementRequests = (await state(replacementRun.sessionId)).run.extensionRequests;
      for (const request of replacementRequests) expect((await post(`agent/sessions/${replacementRun.sessionId}/interactions/${request.id}`,
        { cancelled: false, value: true })).status).toBe(200);
      expect((await services.agentRuntime.wait(replacementRun.id))?.phase).toBe('completed');
      const replacementResults = (await state(replacementRun.sessionId)).session.messages.filter((message: { role: string }) => message.role === 'tool');
      expect(replacementResults).toHaveLength(1);
      expect(JSON.parse(replacementResults[0].content)).toEqual({ version: 2, results: [{ cancelled: false, value: true }, { cancelled: false, value: true }] });
      expect(clear).toHaveBeenCalledOnce();
    } finally { clear.mockRestore(); }
  });

  it.each(['agent/reload', 'plugins/reload'])('%s failed candidate in a canonical allowed, saved-trusted next cwd successfully safety-clears the old tool generation once', async route => {
    const run = await begin(); const old = callback;
    const before = (await state(run.sessionId)).run.extensionRequests;
    const clear = vi.spyOn(services.agentRuntime, 'clearExtensionInteractions');
    const pendingHandle = old({ kind: 'confirm', title: 'Pending at workspace switch' });
    const settled = vi.fn();
    const pending = pendingHandle.then(value => { settled(value); return value; });
    try {
      await writeFile(extensionFile(nextCwd), 'export default function() { throw new Error("next workspace candidate rejected"); }');
      // Do not send the old session ID: the HTTP adapter correctly rejects cross-workspace session reloads.
      const response = await post(route, { cwd: path.join(nextCwd, '..', path.basename(nextCwd)) });
      expect(response.status).toBe(200);
      const body = await response.json();
      const errors = route === 'agent/reload' ? body.errors : body.reload.errors;
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('<generation>');
      expect(errors[0].message).toContain('next workspace candidate rejected');
      expect(clear).toHaveBeenCalledOnce();
      expect(services.extensionRegistry.getTools().some(tool => tool.name === 'managed_generation_ask')).toBe(false);
      expect(services.extensionRegistry.getTools().some(tool => tool.name === 'read')).toBe(true);
      expect(await pending).toEqual({ cancelled: true });
      expect(settled).toHaveBeenCalledOnce();
      expect(pendingHandle.close!()).toBe(false);
      expect(pendingHandle.id).toBeTypeOf('string');
      await assertRevoked(run, [...before.map((item: { id: string }) => item.id), pendingHandle.id!], old);
      expect(settled).toHaveBeenCalledOnce();
    } finally { clear.mockRestore(); }
  });
});
