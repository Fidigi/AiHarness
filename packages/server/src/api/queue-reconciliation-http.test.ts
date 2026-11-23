import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunSnapshot, ExtensionRuntimeContext } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

describe('real HTTP command interaction generation authority', () => {
  let root: string; let cwd: string; let data: string; let base: string; let services: RuntimeServices;
  let callback: NonNullable<ExtensionRuntimeContext['requestInteraction']>;
  const headers = { Authorization: 'Bearer reconciliation-admin', 'Content-Type': 'application/json' };
  const post = (url: string, body: unknown) => fetch(`${base}/api/${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const state = (id: string) => fetch(`${base}/api/agent/sessions/${id}/state`, { headers }).then(response => response.json());
  async function begin(sessionId?: string) {
    const response = await post('agent/runs', { cwd, sessionId, provider: 'mock', toolPreset: 'full', input: 'hold', autoCompaction: false });
    expect(response.status).toBe(202);
    const { run } = await response.json() as { run: AgentRunSnapshot };
    await vi.waitFor(() => expect(services.agentRuntime.getRun(run.id)?.phase).toBe('tool'));
    expect((await post(`agent/sessions/${run.sessionId}/commands/capture_queue`, {})).status).toBe(200);
    return run;
  }
  beforeAll(async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'reconciliation-admin'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'reconciliation-admin');
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-command-queue-')); cwd = path.join(root, 'workspace'); data = path.join(root, 'data');
    await mkdir(cwd); await mkdir(path.join(data, 'extensions'), { recursive: true });
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: data, allowedRoots: [root], defaultCwd: cwd,
      runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
    base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/workspaces/default`, { headers })).status).toBe(200);
    await services.trustManager.trust(cwd);
    await services.extensionRegistry.load('command-queue', api => {
      api.registerCommand('capture_queue', { description: 'Capture real route context', handler: (_args, context) => { callback = context.requestInteraction!; return 'captured'; } });
      api.registerTool({ name: 'hold_queue', description: 'Wait for stop', execute: async (_args, _context, signal) => {
        await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
        return { content: 'stopped' };
      } });
    });
    vi.spyOn(services.resolveProvider('mock')!, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      complete?.({ content: '', toolCalls: [{ id: 'hold-command-queue', name: 'hold_queue', input: {} }] });
    });
  });
  afterEach(async () => {
    for (const run of services.agentRuntime.listRunning()) { services.agentRuntime.stop(run.id); await services.agentRuntime.wait(run.id); }
    await rm(path.join(data, 'extensions', 'generation.js'), { force: true });
  });
  afterAll(async () => { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it('HTTP command-triggered registry reload preserves failed candidates and revokes only the committed generation', async () => {
    const run = await begin();
    const old = callback;
    await services.extensionRegistry.load('callback-generation-probe', api => api.registerCommand('invoke_generation', {
      description: 'Invoke the actual injected registry reload handler',
      handler: async () => { await services.extensionRegistry.reload(); return 'reloaded'; },
    }));
    const clear = vi.spyOn(services.agentRuntime, 'clearExtensionInteractions');
    const settled = vi.fn();
    try {
      const pending = old({ kind: 'confirm', title: 'Registry callback generation request' }).then(value => { settled(value); return value; });
      const before = (await state(run.sessionId)).run.extensionRequests;
      await writeFile(path.join(data, 'extensions', 'generation.js'), 'export default syntax error');
      expect((await post(`agent/sessions/${run.sessionId}/commands/invoke_generation`, {})).status).toBe(200);
      expect(clear).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      expect((await state(run.sessionId)).run.extensionRequests).toEqual(before);
      const stillAuthorized = old({ kind: 'confirm', title: 'Callback survives rejected candidate' });
      expect((await state(run.sessionId)).run.extensionRequests).toHaveLength(2);
      const ids = (await state(run.sessionId)).run.extensionRequests.map((item: { id: string }) => item.id);
      await writeFile(path.join(data, 'extensions', 'generation.js'), 'export default function(api) { api.registerCommand("registry_generation", { description: "Committed", handler: () => "ok" }); }');
      expect((await post(`agent/sessions/${run.sessionId}/commands/invoke_generation`, {})).status).toBe(200);
      expect(clear).toHaveBeenCalledOnce();
      expect(await pending).toEqual({ cancelled: true });
      expect(await stillAuthorized).toEqual({ cancelled: true });
      expect(settled).toHaveBeenCalledOnce();
      expect(services.agentRuntime.getRun(run.id)?.phase).toBe('tool');
      expect(await old({ kind: 'confirm', title: 'Revoked registry callback' })).toEqual({ cancelled: true });
      expect((await state(run.sessionId)).run.extensionRequests).toEqual([]);
      for (const id of ids) {
        expect((await post(`agent/sessions/${run.sessionId}/interactions/${id}`, { cancelled: true })).status).toBe(404);
        expect(services.agentRuntime.journal.replay(run.sessionId).events.filter(event => event.type === 'extension.ui'
          && (event.data as { action: string; requestId: string }).action === 'resolved'
          && (event.data as { requestId: string }).requestId === id)).toHaveLength(1);
      }
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      clear.mockRestore();
      await services.extensionRegistry.unload('callback-generation-probe');
    }
  });

  it('old command callback cannot reopen after clear, replacement run or successful agent reload', async () => {
    const first = await begin();
    const old = callback;
    const request = old({ kind: 'confirm', title: 'Before clear' });
    expect((await state(first.sessionId)).run.extensionRequests).toHaveLength(1);
    services.agentRuntime.clearExtensionInteractions();
    expect(await request).toEqual({ cancelled: true });
    const lateClear = old({ kind: 'confirm', title: 'Old after clear' });
    expect((await state(first.sessionId)).run.extensionRequests).toEqual([]);
    expect(await lateClear).toEqual({ cancelled: true });
    expect((await post(`agent/runs/${first.id}/stop`, {})).status).toBe(202);
    await services.agentRuntime.wait(first.id);
    const second = await begin(first.sessionId);
    const lateNewRun = old({ kind: 'confirm', title: 'Old after new run' });
    expect((await state(second.sessionId)).run.extensionRequests).toEqual([]);
    expect(await lateNewRun).toEqual({ cancelled: true });
    const current = callback;
    const pending = current({ kind: 'confirm', title: 'Before reload' });
    const response = await post('agent/reload', { cwd });
    expect(response.status).toBe(200); expect((await response.json()).errors).toEqual([]);
    expect(await pending).toEqual({ cancelled: true });
    const lateReload = current({ kind: 'confirm', title: 'Old after reload' });
    expect((await state(second.sessionId)).run.extensionRequests).toEqual([]);
    expect(await lateReload).toEqual({ cancelled: true });
  });

  it('failed import/factory candidates and passive metadata reads retain requests; committed generation clears', async () => {
    const run = await begin();
    const request = callback({ kind: 'confirm', title: 'Preserve this request' });
    const before = (await state(run.sessionId)).run.extensionRequests;
    for (const url of ['agent/palette', 'plugins', 'tools']) expect((await fetch(`${base}/api/${url}`, { headers })).status).toBe(200);
    expect((await state(run.sessionId)).run.extensionRequests).toEqual(before);
    for (const source of ['export default syntax error', 'export default function() { throw new Error("reject candidate"); }']) {
      await writeFile(path.join(data, 'extensions', 'generation.js'), source);
      const response = await post('agent/reload', { cwd });
      expect(response.status).toBe(200); expect((await response.json()).errors).not.toEqual([]);
      expect((await state(run.sessionId)).run.extensionRequests).toEqual(before);
    }
    const afterFailure = callback({ kind: 'confirm', title: 'Same callback remains authorized after failure' });
    expect((await state(run.sessionId)).run.extensionRequests).toHaveLength(2);
    await writeFile(path.join(data, 'extensions', 'generation.js'), 'export default function(api) { api.registerCommand("new_queue_generation", { description: "New", handler: () => "ok" }); }');
    const response = await post('agent/reload', { cwd });
    expect(response.status).toBe(200); expect((await response.json()).errors).toEqual([]);
    expect(await request).toEqual({ cancelled: true });
    expect(await afterFailure).toEqual({ cancelled: true });
    expect((await state(run.sessionId)).run.extensionRequests).toEqual([]);
    expect((await post(`agent/sessions/${run.sessionId}/interactions/${before[0].id}`, { cancelled: true })).status).toBe(404);
  });
  it('exact queue: route captures requester authority before asynchronous trust can straddle reload', async () => {
    const run = await begin();
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<boolean>(resolve => { release = () => resolve(true); });
    const original = services.trustManager.isTrusted.bind(services.trustManager);
    let first = true;
    const trust = vi.spyOn(services.trustManager, 'isTrusted').mockImplementation(cwd => {
      if (first) { first = false; entered(); return gate; }
      return original(cwd);
    });
    const command = post(`agent/sessions/${run.sessionId}/commands/capture_queue`, {});
    try {
      await waiting;
      const reload = await post('agent/reload', { cwd });
      expect(reload.status).toBe(200); expect((await reload.json()).errors).toEqual([]);
      release();
      expect((await command).status).toBe(200);
      const stale = callback({ kind: 'confirm', title: 'Must not inherit post-reload authority' });
      expect((await state(run.sessionId)).run.extensionRequests).toEqual([]);
      expect(await stale).toEqual({ cancelled: true });
      expect(stale.close!()).toBe(false);
      // Causal positive control: an actually new HTTP command binds the new generation.
      expect((await post(`agent/sessions/${run.sessionId}/commands/capture_queue`, {})).status).toBe(200);
      const fresh = callback({ kind: 'confirm', title: 'New command after reload' });
      expect((await state(run.sessionId)).run.extensionRequests.map((entry: { title: string }) => entry.title)).toEqual(['New command after reload']);
      expect(fresh.close!()).toBe(true); expect(await fresh).toEqual({ cancelled: true });
    } finally { release(); await command; trust.mockRestore(); }
  });

});
