import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunSnapshot, ExtensionRuntimeContext } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

/** Real disposable Express + Core runtime + JSONL + executable loader, not a mocked queue/router. */
describe('ordered interaction queue HTTP', () => {
  let root: string; let cwd: string; let data: string; let base: string; let services: RuntimeServices;
  const headers = { Authorization: 'Bearer queue-admin', 'Content-Type': 'application/json' };
  const post = (url: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/${url}`, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  const state = async (sessionId: string) => fetch(`${base}/api/agent/sessions/${sessionId}/state`, { headers }).then(response => response.json());
  const respond = (sessionId: string, id: string, body: unknown, extra?: Record<string, string>) => post(`agent/sessions/${sessionId}/interactions/${id}`, body, extra);
  async function begin() {
    let context!: ExtensionRuntimeContext;
    await services.extensionRegistry.load('http-ask', api => api.registerTool({ name: 'http_ask', description: 'Concurrent HTTP ask', execute: async (_input, ctx) => {
      context = ctx;
      const results = await Promise.all([
        ctx.requestInteraction!({ kind: 'confirm', title: 'First' }),
        ctx.requestInteraction!({ kind: 'custom', title: 'Second', fields: [{ name: 'mode', label: 'Mode', type: 'select', required: true,
          options: [{ value: 'safe', label: 'Safe' }] }] }),
      ]);
      return { content: JSON.stringify(results) };
    } }));
    const response = await post('agent/runs', { cwd, provider: 'mock', toolPreset: 'full', input: 'ask HTTP', autoCompaction: false });
    expect(response.status).toBe(202);
    const { run } = await response.json() as { run: AgentRunSnapshot };
    await vi.waitFor(() => expect(services.agentRuntime.getRun(run.id)?.extensionRequests).toHaveLength(2));
    return { run, context };
  }
  beforeAll(async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'queue-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'queue-admin');
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-interaction-http-')); cwd = path.join(root, 'workspace'); data = path.join(root, 'data');
    await mkdir(cwd); await mkdir(path.join(data, 'extensions'), { recursive: true });
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: data, allowedRoots: [root], defaultCwd: cwd,
      runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
    base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/workspaces/default`, { headers })).status).toBe(200);
    await services.trustManager.trust(cwd);
    const provider = services.resolveProvider('mock')!;
    vi.spyOn(provider, 'streamChat').mockImplementation(async (messages, _chunk, complete) => {
      complete?.(messages.some(message => message.role === 'tool') ? { content: 'done' } : {
        content: '', toolCalls: [{ id: 'http-outer', name: 'http_ask', input: {} }],
      });
    });
  });
  afterEach(async () => {
    for (const run of services.agentRuntime.listRunning()) { services.agentRuntime.stop(run.id); await services.agentRuntime.wait(run.id); }
    await services.extensionRegistry.unload('http-ask');
    await rm(path.join(data, 'extensions', 'reload.js'), { force: true });
  });
  afterAll(async () => { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it('exposes ordered snapshots/SSE, isolates response IDs, validates each schema, closes individually and persists Promise.all results', async () => {
    const { run } = await begin();
    const initial = await state(run.sessionId);
    const [first, second] = initial.run.extensionRequests;
    expect(initial.run.extensionRequest.id).toBe(first.id);
    const other = await services.sessionManager.create({ title: 'Other', cwd });
    expect((await respond(other.id, first.id, { cancelled: true })).status).toBe(404);
    expect((await respond(run.sessionId, second.id, { cancelled: false, value: { mode: 'unsafe' } })).status).toBe(400);
    expect((await respond(run.sessionId, first.id, { cancelled: false, value: 'true' })).status).toBe(400);
    expect((await respond(run.sessionId, first.id, { cancelled: true }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await respond(run.sessionId, first.id, { cancelled: true }, { Origin: 'https://evil.test' })).status).toBe(403);
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/agent/sessions/${run.sessionId}/events?after=0`, { headers, signal: controller.signal });
    const reader = stream.body!.getReader();
    try {
      let text = '';
      await vi.waitFor(async () => {
        text += new TextDecoder().decode((await reader.read()).value);
        expect(text).toContain('connection.ready');
        expect(text).toContain('"extensionRequests"'); expect(text).toContain(first.id); expect(text).toContain(second.id);
      });
    } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
    const response = await respond(run.sessionId, second.id, { cancelled: false, value: { mode: 'safe' } });
    expect(response.status).toBe(200);
    const remaining = await response.json();
    expect(remaining.extensionRequests.map((item: { id: string }) => item.id)).toEqual([first.id]);
    expect(remaining.extensionRequest.id).toBe(first.id);
    expect((await respond(run.sessionId, second.id, { cancelled: true })).status).toBe(404);
    expect((await respond(run.sessionId, first.id, { cancelled: true })).status).toBe(200);
    expect((await services.agentRuntime.wait(run.id))!.phase).toBe('completed');
    const final = await state(run.sessionId);
    expect(final.run.extensionRequests).toEqual([]); expect(final.run.extensionRequest).toBeUndefined();
    expect(final.session.messages.find((message: { role: string }) => message.role === 'tool').content)
      .toBe('[{"cancelled":true},{"cancelled":false,"value":{"mode":"safe"}}]');
    const disk = await readFile(path.join(data, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
    expect(disk).toContain('http-outer'); expect(disk).toContain('safe');
  });

  it('stops through HTTP, clears every request exactly once and publishes terminal state after durable interruption', async () => {
    const { run } = await begin();
    const before = await state(run.sessionId);
    const response = await post(`agent/runs/${run.id}/stop`, {});
    expect(response.status).toBe(202); expect((await response.json()).phase).toBe('stopped');
    await services.agentRuntime.wait(run.id);
    const final = await state(run.sessionId);
    expect(final.run.extensionRequests).toEqual([]); expect(final.run.extensionRequest).toBeUndefined();
    expect(final.session.messages.filter((message: { role: string }) => message.role === 'tool')).toHaveLength(1);
    const disk = await readFile(path.join(data, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
    expect(disk).toContain('interrupted');
    const events = services.agentRuntime.journal.replay(run.sessionId).events;
    const terminal = events.find(event => event.type === 'run.stopped')!;
    expect(events.filter(event => event.type === 'extension.ui' && (event.data as { action: string }).action === 'resolved')).toHaveLength(2);
    expect(events.find(event => event.type === 'tool.failed')!.sequence).toBeLessThan(terminal.sequence);
    for (const request of before.run.extensionRequests) expect((await respond(run.sessionId, request.id, { cancelled: true })).status).toBe(404);
  });

  it('retains requests on failed executable rebuild, clears only successful rebuilds and rejects old context/IDs', async () => {
    const { run, context } = await begin();
    const before = await state(run.sessionId);
    await writeFile(path.join(data, 'extensions', 'reload.js'), 'export default syntax error');
    const failed = await post('plugins/reload', { cwd, sessionId: run.sessionId });
    expect(failed.status).toBe(200); expect((await failed.json()).reload.restartRequired).toBe(true);
    expect((await state(run.sessionId)).run.extensionRequests).toEqual(before.run.extensionRequests);
    await writeFile(path.join(data, 'extensions', 'reload.js'), 'export default function(api) { api.registerCommand("queue_generation", { description: "New", handler: () => "ok" }); }');
    const succeeded = await post('plugins/reload', { cwd, sessionId: run.sessionId });
    expect(succeeded.status).toBe(200); expect((await succeeded.json()).reload.restartRequired).toBe(false);
    expect((await state(run.sessionId)).run.extensionRequests).toEqual([]);
    expect(await context.requestInteraction!({ kind: 'confirm', title: 'Stale callback' })).toEqual({ cancelled: true });
    for (const request of before.run.extensionRequests) expect((await respond(run.sessionId, request.id, { cancelled: true })).status).toBe(404);
    await services.agentRuntime.wait(run.id);
    const events = services.agentRuntime.journal.replay(run.sessionId).events;
    const resolved = events.filter(event => event.type === 'extension.ui' && (event.data as { action: string }).action === 'resolved');
    expect(resolved).toHaveLength(2);
    expect(resolved.every(event => event.sequence < events.find(item => item.type === 'run.completed')!.sequence)).toBe(true);
  });
});
