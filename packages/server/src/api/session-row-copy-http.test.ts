import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, MockProvider, SessionManager } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

describe('real HTTP exact saved-entry copies, not generic clone tightening', () => {
  let root: string, base: string, services: RuntimeServices;
  const token = 'row-copy-admin-fixture';
  const request = (id: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${token}` }) => fetch(`${base}/api/sessions/${id}/clone`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  beforeAll(async () => {
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', token); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'row-copy-ordinary-fixture');
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-row-copy-http-'));
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, '.data'), allowedRoots: [root], defaultCwd: root,
      enableMockProvider: true, runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
    base = `http://127.0.0.1:${server.port}`;
    // Complete normal credential/redaction bootstrap before creating an idle foreign source.
    expect((await fetch(`${base}/api/providers`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });
  afterAll(async () => { await stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  const seed = async (manager = services.sessionManager, title = 'Displayed source') => {
    const source = await manager.create({ title, cwd: root, workspaceId: 'captured-workspace' });
    await manager.addMessage(source.id, { role: 'user', content: 'Selected root' });
    const entry = await manager.appendCustomEntry(source.id, 'row-copy:state', { revision: 1 });
    const target = entry!.id;
    await manager.addMessage(source.id, { role: 'assistant', content: 'Later source only' });
    return { source, target, file: services.sessionStore.getSessionFilePath(source.id)! };
  };

  it('publishes only the canonical child hint in metadata-only row summaries, never arbitrary private metadata', async () => {
    const parent = await services.sessionManager.create({ cwd: root, metadata: { privateValue: 'PRIVATE_LIST_MARKER' } });
    const child = await services.sessionManager.create({ cwd: root, metadata: { subagent: true, privateValue: 'PRIVATE_LIST_MARKER' } });
    const response = await fetch(`${base}/api/sessions?cwd=${encodeURIComponent(root)}&messageLimit=0&includeCommands=false`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.find((item: { id: string }) => item.id === parent.id).metadata).toBeUndefined();
    expect(body.find((item: { id: string }) => item.id === child.id).metadata).toEqual({ subagent: true });
    expect(JSON.stringify(body)).not.toContain('PRIVATE_LIST_MARKER');
    for (const item of body) { expect(item.messages).toEqual([]); expect(item.commands).toBeUndefined(); }
  });

  it('quietly clones the selected custom leaf from disk without source import/provider/agent work or writes', async () => {
    const writer = new SessionManager({ store: services.sessionStore }), f = await seed(writer), bytes = await readFile(f.file);
    const load = vi.spyOn(services.sessionManager, 'loadFromStore'), startRun = vi.spyOn(services.agentRuntime, 'start');
    const chat = vi.spyOn(MockProvider.prototype, 'chat'), stream = vi.spyOn(MockProvider.prototype, 'streamChat');
    try {
      expect(services.sessionManager.get(f.source.id)).toBeUndefined();
      const response = await request(f.source.id, { entryId: f.target, expectedCwd: root }); expect(response.status).toBe(201);
      const copy = await response.json();
      expect(copy).toMatchObject({ title: 'Displayed source (clone)', cwd: root, workspaceId: 'captured-workspace', metadata: { clonedFromSessionId: f.source.id } });
      expect(copy.parentId).toBeUndefined(); expect(copy.id).not.toBe(f.source.id); expect(copy.activeLeafId).not.toBe(f.target);
      expect(copy.messages.map((message: { content: string }) => message.content)).toEqual(['Selected root']);
      expect((await services.sessionManager.getActiveBranchEntries(copy.id)).at(-1)).toMatchObject({ type: 'custom', data: { revision: 1 } });
      expect(services.sessionManager.get(f.source.id)).toBeUndefined(); expect(load).not.toHaveBeenCalled();
      expect(startRun).not.toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
      expect(await readFile(f.file)).toEqual(bytes);
    } finally { load.mockRestore(); startRun.mockRestore(); chat.mockRestore(); stream.mockRestore(); }
  });

  it('keeps edited model input and private historical checkpoints across actual HTTP runs, compaction, copies and DTOs', async () => {
    const manager = services.sessionManager, session = await manager.create({ cwd: root });
    await manager.addMessage(session.id, { role: 'user', content: 'Original user' });
    await manager.addMessage(session.id, { role: 'assistant', content: 'ORIGINAL_HTTP_ANSWER' });
    const target = session.activeLeafId!;
    await manager.recordSessionLoadout(session.id, { provider: 'mock', model: 'mock-model', thinking: null,
      systemPrompt: 'PRIVATE_HTTP_HISTORICAL_PROMPT', tools: [] });
    await manager.appendContextEdit(session.id, { targetEntryId: target, replacement: 'HTTP_MODEL_REPLACEMENT' });
    const copied = await request(session.id, { entryId: session.activeLeafId }); expect(copied.status).toBe(201);
    const copy = await copied.json();
    expect(copy.messages.at(-1).content).toBe('ORIGINAL_HTTP_ANSWER');
    expect(JSON.stringify(copy)).not.toContain('PRIVATE_HTTP_HISTORICAL_PROMPT');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/api/workspaces/trust`, { method: 'POST', headers, body: JSON.stringify({ cwd: root, confirm: true }) })).status).toBe(200);
    const stream = vi.spyOn(MockProvider.prototype, 'streamChat').mockImplementation(async (messages, _chunk, complete, _error, options) => {
      const payload = JSON.stringify(messages);
      expect(payload).toContain('HTTP_MODEL_REPLACEMENT'); expect(payload).not.toContain('ORIGINAL_HTTP_ANSWER');
      expect(JSON.stringify(options)).not.toContain('PRIVATE_HTTP_HISTORICAL_PROMPT');
      complete?.({ content: 'Finished HTTP run', model: 'mock-model' });
    });
    const chat = vi.spyOn(MockProvider.prototype, 'chat').mockImplementation(async messages => {
      expect(JSON.stringify(messages)).toContain('HTTP_MODEL_REPLACEMENT');
      expect(JSON.stringify(messages)).not.toContain('PRIVATE_HTTP_HISTORICAL_PROMPT');
      return { content: 'HTTP summary', model: 'mock-model', usage: { promptTokens: 11, completionTokens: 2, totalTokens: 13, costUsd: 0.02 } };
    });
    try {
      const started = await fetch(`${base}/api/agent/runs`, { method: 'POST', headers,
        body: JSON.stringify({ sessionId: copy.id, cwd: root, provider: 'mock', input: 'Continue' }) });
      expect(started.status).toBe(202); await services.agentRuntime.wait((await started.json()).run.id);
      expect(stream).toHaveBeenCalledOnce();
      const compacted = await fetch(`${base}/api/agent/sessions/${copy.id}/compact`, { method: 'POST', headers, body: JSON.stringify({ provider: 'mock' }) });
      expect(compacted.status).toBe(200); expect(JSON.stringify(await compacted.json())).not.toContain('PRIVATE_HTTP_HISTORICAL_PROMPT');
      const compact = (await manager.getRawEntries(copy.id)).findLast(entry => entry.type === 'compaction');
      expect(compact).toMatchObject({ provider: 'mock', model: 'mock-model', usage: { inputTokens: 11, outputTokens: 2, costUsd: 0.02 },
        checkpoint: { loadout: { provider: 'mock' } } });
      const reloaded = new SessionManager({ store: services.sessionStore }); await reloaded.loadFromStore(copy.id);
      expect(reloaded.getEffectiveContext(copy.id)).toEqual(manager.getEffectiveContext(copy.id));
      expect((await reloaded.getRawEntries(copy.id)).some(entry => entry.type === 'message' && entry.content === 'ORIGINAL_HTTP_ANSWER')).toBe(true);
    } finally { stream.mockRestore(); chat.mockRestore(); }
  });

  it('copies the exact current saved leaf during a real run without stopping/restarting/changing the source', async () => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/api/workspaces/trust`, { method: 'POST', headers, body: JSON.stringify({ cwd: root, confirm: true }) })).status).toBe(200);
    const f = await seed(); let release!: () => void, runId: string | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stream = vi.spyOn(MockProvider.prototype, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      await gate; complete?.({ content: 'Source independently finished' });
    });
    try {
      const started = await fetch(`${base}/api/agent/runs`, { method: 'POST', headers,
        body: JSON.stringify({ sessionId: f.source.id, cwd: root, provider: 'mock', input: 'Continue source' }) });
      expect(started.status).toBe(202); runId = (await started.json()).run.id;
      await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());
      const entryId = f.source.activeLeafId!, before = structuredClone(f.source), bytes = await readFile(f.file);
      const response = await request(f.source.id, { entryId }); expect(response.status).toBe(201);
      const copy = await response.json(); expect(copy.messages.at(-1).content).toBe('Continue source');
      expect(f.source).toEqual(before); expect(await readFile(f.file)).toEqual(bytes);
      expect(services.agentRuntime.getRun(runId!)?.phase).toBe('streaming'); expect(stream).toHaveBeenCalledOnce();
      release(); await services.agentRuntime.wait(runId!);
      expect(f.source.messages.at(-1)?.content).toBe('Source independently finished');
      expect(copy.messages.some((message: { content: string }) => message.content === 'Source independently finished')).toBe(false);
    } finally { release(); if (runId) await services.agentRuntime.wait(runId); stream.mockRestore(); }
  });

  it.each(['missing', 'foreign', 'child', 'unsaved', 'incomplete'] as const)('refuses%s saved-entry intent without a new destination', async kind => {
    const f = await seed(); let id = f.source.id, entryId = f.target;
    if (kind === 'missing') entryId = 'missing';
    if (kind === 'foreign') entryId = (await seed()).target;
    if (kind === 'child') await services.sessionManager.update(id, { metadata: { ...f.source.metadata, subagent: true } });
    if (kind === 'unsaved') {
      services.sessionManager.setStore(new JsonlSessionStore(path.join(root, '.unsaved'), false));
      try {
        const ephemeral = await services.sessionManager.create({ messages: [{ id: 'ephemeral-leaf', role: 'user', content: 'Unsaved', timestamp: new Date(1) }] });
        id = ephemeral.id; entryId = ephemeral.activeLeafId!;
      } finally { services.sessionManager.setStore(services.sessionStore); }
    }
    if (kind === 'incomplete') {
      const updated = await services.sessionManager.addMessage(id, { role: 'assistant', content: '', toolCalls: [{ id: 'unanswered', name: 'read', input: {} }] });
      entryId = updated!.activeLeafId!;
      expect(entryId).not.toBe(id);
      expect((await services.sessionStore.getSessionSnapshot(id))!.entries.find(entry => entry.id === entryId))
        .toMatchObject({ type: 'message', role: 'assistant', toolCalls: [{ id: 'unanswered' }] });
    }
    const before = (await services.sessionStore.listSessionIds()).sort(), bytes = await readFile(f.file);
    const response = await request(id, { entryId }); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Session entry is unavailable.', code: 'ENTRY_TARGET_UNAVAILABLE' });
    expect((await services.sessionStore.listSessionIds()).sort()).toEqual(before); expect(await readFile(f.file)).toEqual(bytes);
  });

  it('refuses changed captured workspace scope instead of copying to a later source cwd', async () => {
    const f = await seed(), before = (await services.sessionStore.listSessionIds()).sort(), bytes = await readFile(f.file);
    const response = await request(f.source.id, { entryId: f.target, expectedCwd: '/different-workspace' });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'ENTRY_TARGET_UNAVAILABLE' });
    expect((await services.sessionStore.listSessionIds()).sort()).toEqual(before); expect(await readFile(f.file)).toEqual(bytes);
  });

  it.each([{ entryId: null }, { entryId: '' }, { entryId: 'bad\nentry' }, { entryId: 'x'.repeat(257) },
    { entryId: 'target', expectedCwd: null }, { entryId: 'target', expectedCwd: 'x'.repeat(4_097) },
    { entryId: 'target', messageId: 'other' }, { entryId: 'target', messageIndex: 0 }, { entryId: 'target', sourceStore: '/PRIVATE_NOT_AUTHORITY' }])('rejects malformed/ambiguous intent%j before any destination', async body => {
    const f = await seed(), before = (await services.sessionStore.listSessionIds()).sort();
    const response = await request(f.source.id, body); expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid clone request.' });
    expect((await services.sessionStore.listSessionIds()).sort()).toEqual(before);
  });

  it('preserves real authentication and foreign-Origin refusal without a destination', async () => {
    const f = await seed(), before = (await services.sessionStore.listSessionIds()).sort();
    expect((await request(f.source.id, { entryId: f.target }, {})).status).toBe(401);
    expect((await request(f.source.id, { entryId: f.target }, { Authorization: `Bearer ${token}`, Origin: 'https://foreign.invalid' })).status).toBe(403);
    expect((await services.sessionStore.listSessionIds()).sort()).toEqual(before);
  });

  it('retains already-bound cancel-only policy for a quiet source', async () => {
    const f = await seed(new SessionManager({ store: services.sessionStore })), before = (await services.sessionStore.listSessionIds()).sort();
    const remove = services.sessionManager.onBeforeBranch(event => { expect(event.entryId).toBe(f.target); expect(event.externalSource).toBe(true); return false; });
    try {
      const response = await request(f.source.id, { entryId: f.target }); expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'SESSION_BRANCH_CANCELLED' });
      expect((await services.sessionStore.listSessionIds()).sort()).toEqual(before);
    } finally { remove(); }
  });

  it.each(['partial', 'orphan', 'duplicate', 'complete'] as const)('checks the real saved%s tool-group target instead of a missing session ID', async kind => {
    const f = await seed();
    await services.sessionManager.addMessage(f.source.id, { role: 'assistant', content: '',
      toolCalls: [{ id: 'one', name: 'read', input: { path: 'first' } }, { id: 'two', name: 'read', input: { path: 'second' } }] });
    await services.sessionManager.addMessage(f.source.id, { role: 'tool', content: 'First result', toolCallId: kind === 'orphan' ? 'foreign' : 'one' });
    if (kind === 'duplicate' || kind === 'complete') await services.sessionManager.addMessage(f.source.id,
      { role: 'tool', content: 'Second result', toolCallId: kind === 'duplicate' ? 'one' : 'two' });
    const entryId = f.source.activeLeafId!;
    expect(entryId).not.toBe(f.source.id);
    expect((await services.sessionStore.getSessionSnapshot(f.source.id))!.entries.some(entry => entry.id === entryId)).toBe(true);
    const before = (await services.sessionStore.listSessionIds()).sort(), bytes = await readFile(f.file);
    const response = await request(f.source.id, { entryId, expectedCwd: root });
    expect(response.status).toBe(kind === 'complete' ? 201 : 409);
    if (kind === 'complete') {
      const copy = await response.json();
      expect(copy.messages.slice(-3).map((message: { role: string }) => message.role)).toEqual(['assistant', 'tool', 'tool']);
      expect(copy.messages.at(-3).toolCalls.map((call: { input: unknown }) => call.input)).toEqual([{ path: 'first' }, { path: 'second' }]);
      expect(copy.metadata.clonedFromEntryId).toBe(entryId);
      expect((await services.sessionStore.listSessionIds()).sort()).toEqual([...before, copy.id].sort());
    } else {
      expect(await response.json()).toEqual({ error: 'Session entry is unavailable.', code: 'ENTRY_TARGET_UNAVAILABLE' });
      expect((await services.sessionStore.listSessionIds()).sort()).toEqual(before);
    }
    expect(await readFile(f.file)).toEqual(bytes);
  });

  it('does not change the unrelated legacy generic-clone behavior', async () => {
    const f = await seed();
    await services.sessionManager.addMessage(f.source.id, { role: 'assistant', content: '', toolCalls: [{ id: 'legacy-call', name: 'read', input: {} }] });
    const response = await request(f.source.id, {}); expect(response.status).toBe(201);
    expect((await response.json()).messages.at(-1).toolCalls).toHaveLength(1);
  });
});
