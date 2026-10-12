import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

describe('live session snapshots', () => {
  let root: string;
  let base: string;
  let services: RuntimeServices;
  const json = { 'Content-Type': 'application/json' };
  const request = (route: string, method = 'GET', body?: unknown) => fetch(`${base}${route}`, {
    method, headers: json, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-live-sessions-'));
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, '.data'),
      allowedRoots: [root], defaultCwd: root, enableMockProvider: true,
      runtimeServicesFactory: async (proxy, options) => {
        services = await createRuntimeServices(proxy, options);
        return services;
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    expect((await request('/api/workspaces/trust', 'POST', { cwd: root, confirm: true })).status).toBe(200);
  });
  afterAll(async () => { await stop(); await rm(root, { recursive: true, force: true }); });

  it('forks and clones stable persisted prefixes without stopping the source or switching its active leaf', async () => {
    const source = await services.sessionManager.create({ cwd: root, title: 'Source' });
    await services.sessionManager.addMessage(source.id, { role: 'user', content: 'Original question' });
    const targetId = source.activeLeafId!;
    await services.sessionManager.addMessage(source.id, { role: 'assistant', content: 'Original answer' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stream = vi.spyOn(MockProvider.prototype, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      await gate; complete?.({ content: 'Source keeps running' });
    });
    let runId: string | undefined;
    try {
      const response = await request('/api/agent/runs', 'POST', { sessionId: source.id, cwd: root,
        provider: 'mock', input: 'Continue source' });
      expect(response.status).toBe(202);
      const { run } = await response.json() as { run: { id: string } };
      runId = run.id;
      await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());
      const activeLeaf = source.activeLeafId;
      for (const action of ['fork', 'clone']) {
        expect((await request(`/api/sessions/${source.id}/${action}`, 'POST', {})).status).toBe(409);
        expect((await request(`/api/sessions/${source.id}/${action}`, 'POST', { messageId: 'stream:unwritten' })).status).toBe(404);
        const snapshot = await request(`/api/sessions/${source.id}/${action}`, 'POST', { messageId: targetId });
        expect(snapshot.status).toBe(201);
        const copy = await snapshot.json() as { messages: Array<{ content: string }>; parentId?: string };
        expect(copy.messages.map(message => message.content)).toEqual(['Original question']);
        expect(copy.parentId).toBe(action === 'fork' ? source.id : undefined);
      }
      const edit = await request(`/api/sessions/${source.id}/fork`, 'POST', { messageId: targetId, before: true });
      expect(edit.status).toBe(201);
      expect((await edit.json()).messages).toEqual([]);
      expect((await request(`/api/sessions/${source.id}/fork`, 'POST', { messageId: targetId, before: 'true' })).status).toBe(400);
      expect((await request(`/api/sessions/${source.id}`, 'PATCH', { activeLeafId: targetId })).status).toBe(409);
      expect(source.activeLeafId).toBe(activeLeaf);
      expect(services.agentRuntime.getRun(run.id)?.phase).toBe('streaming');
      release();
      await services.agentRuntime.wait(run.id);
      expect(source.messages.map(message => message.content)).toEqual([
        'Original question', 'Original answer', 'Continue source', 'Source keeps running',
      ]);
    } finally {
      release();
      if (runId) await services.agentRuntime.wait(runId);
      stream.mockRestore();
    }
  });

  it('refuses a target removed between HTTP validation and the serialized copy snapshot', async () => {
    const source = await services.sessionManager.create({ cwd: root });
    await services.sessionManager.addMessage(source.id, { role: 'user', content: 'Target to abandon' });
    const target = source.activeLeafId!;
    await services.sessionManager.addMessage(source.id, { role: 'assistant', content: 'Answer' });
    const fork = services.sessionManager.forkSession.bind(services.sessionManager);
    const intercepted = vi.spyOn(services.sessionManager, 'forkSession').mockImplementationOnce(async (...args) => {
      await services.sessionManager.branchBeforeEntry(source.id, target);
      return fork(...args);
    });
    try {
      const count = services.sessionManager.list().length;
      const response = await request(`/api/sessions/${source.id}/fork`, 'POST', { messageId: target });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'MESSAGE_TARGET_CHANGED' });
      expect(services.sessionManager.list()).toHaveLength(count);
    } finally { intercepted.mockRestore(); }
  });

  it('bounds Stop acknowledgements without publishing terminal state before an uncooperative tool settles', async () => {
    const source = await services.sessionManager.create({ cwd: root });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await services.extensionRegistry.load('uncooperative-tool', api => api.registerTool({ name: 'hold', description: 'Wait',
      execute: async () => { await gate; return { content: 'Late output must not survive Stop' }; } }));
    const stream = vi.spyOn(MockProvider.prototype, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      complete?.({ content: '', toolCalls: [{ id: 'pending-tool', name: 'hold', input: {} }] });
    });
    let runId: string | undefined;
    try {
      const started = await request('/api/agent/runs', 'POST', { sessionId: source.id, cwd: root, provider: 'mock', input: 'wait' });
      expect(started.status).toBe(202);
      const { run } = await started.json() as { run: { id: string } };
      runId = run.id;
      await vi.waitFor(() => expect(services.agentRuntime.getRun(run.id)?.phase).toBe('tool'));
      const startedAt = Date.now();
      const stopped = await request(`/api/agent/runs/${run.id}/stop`, 'POST');
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(stopped.status).toBe(202);
      expect(await stopped.json()).toMatchObject({ phase: 'tool' });
      expect(services.agentRuntime.getRun(run.id)?.completedAt).toBeUndefined();
      expect(services.agentRuntime.journal.replay(source.id).events.some(event => event.type === 'run.stopped')).toBe(false);
      expect(() => services.agentRuntime.enqueue(run.id, 'steer', 'late')).toThrow('terminée');
      expect(services.agentRuntime.stop(run.id).phase).toBe('stopped');
      expect(await services.agentRuntime.requestExtensionInteraction(source.id, { kind: 'confirm', title: 'Late dialog' }))
        .toEqual({ cancelled: true });
      release();
      await services.agentRuntime.wait(run.id);
      expect(source.messages.at(-1)).toMatchObject({ role: 'tool', isError: true,
        content: 'Tool execution interrupted.', metadata: { interrupted: true } });
      expect(services.agentRuntime.journal.replay(source.id).events.at(-1)?.type).toBe('run.stopped');
    } finally {
      release();
      if (runId) await services.agentRuntime.wait(runId);
      stream.mockRestore();
      await services.extensionRegistry.unload('uncooperative-tool');
    }
  }, 15_000);

  it('rejects running command prefixes and edits targeting non-user entries', async () => {
    const source = await services.sessionManager.create({ cwd: root });
    await services.sessionManager.addCommand(source.id, { command: 'pending', cwd: root, status: 'running', output: '' });
    await services.sessionManager.addMessage(source.id, { role: 'user', content: 'Target' });
    const target = source.activeLeafId;
    for (const action of ['fork', 'clone']) {
      const response = await request(`/api/sessions/${source.id}/${action}`, 'POST', { messageId: target });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'RUNNING_COMMAND_SOURCE' });
    }
    const other = await services.sessionManager.create({ cwd: root });
    await services.sessionManager.addMessage(other.id, { role: 'assistant', content: 'Not editable' });
    expect((await request(`/api/sessions/${other.id}/fork`, 'POST', { messageId: other.activeLeafId, before: true })).status).toBe(400);
  });
});
