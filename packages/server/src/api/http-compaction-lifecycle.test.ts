import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, MockProvider, SessionManager, type Message, type ChatResponse } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function host(exclusive = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-http-compaction-'));
  const cwd = path.join(root, 'workspace');
  const { mkdir } = await import('node:fs/promises'); await mkdir(cwd);
  let services!: RuntimeServices;
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), allowedRoots: [cwd], defaultCwd: cwd,
    enableMockProvider: true, providerRenameExclusiveHost: exclusive,
    runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
  const base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${base}/api/sessions`)).status).toBe(200);
  return { root, cwd, base, services };
}
type Host = Awaited<ReturnType<typeof host>>;
async function fixture(h: Host) {
  const manager = h.services.sessionManager, store = h.services.sessionStore;
  manager.setCompactionSettings({ enabled: false, keepRecentTokens: 20000 });
  const session = await manager.create({ cwd: h.cwd, autoCompaction: false });
  for (let index = 0; index < 6; index++) await manager.addMessage(session.id,
    { role: index % 2 ? 'assistant' : 'user', content: `Seed ${index}` }, { skipAutoCompaction: true });
  await manager.appendCustomEntry(session.id, 'private', { revision: 1 });
  const id = session.id, events: string[] = [], terminal = latch();
  const publish = h.services.agentRuntime.publishSessionEvent.bind(h.services.agentRuntime);
  vi.spyOn(h.services.agentRuntime, 'publishSessionEvent').mockImplementation((...args) => {
    const event = publish(...args);
    if (args[0] === id) { events.push(args[1]); if (args[1] === 'compaction.completed' || args[1] === 'compaction.failed') terminal.release(); }
    return event;
  });
  const request = () => fetch(`${h.base}/api/agent/sessions/${id}/compact`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'mock' }) });
  const rawRequest = () => {
    const ended = latch(); let status: number | undefined;
    const body = JSON.stringify({ provider: 'mock' });
    const client = httpRequest(`${h.base}/api/agent/sessions/${id}/compact`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      status = response.statusCode; response.resume(); response.once('end', ended.release);
    });
    client.on('error', ended.release); client.end(body);
    return { client, ended: ended.promise, status: () => status };
  };
  return { manager, store, session, id, events, terminal, request, rawRequest,
    bytes: () => readFile(store.getSessionFilePath(id)!) };
}
const answer = (): ChatResponse => ({ content: 'HTTP_LIFETIME_SUMMARY', model: 'mock-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });

for (const exclusive of [false, true]) describe(`real HTTP compaction, exclusive=${exclusive}`, () => {
  let h: Host, failed = false;
  beforeAll(async () => { h = await host(exclusive); });
  afterEach(context => { if (context.task.result?.state === 'fail') failed = true; vi.restoreAllMocks(); });
  afterAll(async () => {
    await stop();
    if (h && !failed) await rm(h.root, { recursive: true, force: true });
    else if (h) console.error('Retained HTTP compaction root:', h.root);
  });

  it.each(['normal-body', 'same-store', 'title'] as const)('conserves explicit publication across %s with automatic disabled', async action => {
    const f = await fixture(h), entered = latch(), finish = latch(); let signal: AbortSignal | undefined;
    const chat = vi.spyOn(MockProvider.prototype, 'chat').mockImplementation(async (_messages, options) => {
      signal = options?.signal; entered.release(); await finish.promise; return answer();
    });
    const usage = vi.spyOn(h.services, 'recordUsage'); const pending = f.request();
    try {
      await entered.promise; expect(signal).toBeInstanceOf(AbortSignal); expect(signal?.aborted).toBe(false);
      if (action === 'same-store') f.manager.setStore(f.store);
      if (action === 'title') await f.manager.update(f.id, { title: 'Current completion title' });
      finish.release(); const response = await pending;
      expect(response.status).toBe(200); expect(chat).toHaveBeenCalledOnce(); expect(usage).toHaveBeenCalledOnce();
      expect(f.session.messages).toHaveLength(2); expect(f.session.metadata?.compactionSummary).toBe('HTTP_LIFETIME_SUMMARY');
      expect(f.events.filter(type => type.startsWith('compaction.'))).toEqual(['compaction.started', 'compaction.completed']);
      if (action === 'title') expect(f.session.title).toBe('Current completion title');
    } finally { finish.release(); await pending; }
  });

  it.each(['store-aba', 'journal', 'manager-binding'] as const)('withdraws an unpublished %s source without redirected persistence', async action => {
    const f = await fixture(h), entered = latch(), finish = latch(), replacement = new SessionManager();
    const disk = new JsonlSessionStore(path.join(h.root, `replacement-${f.id}`));
    vi.spyOn(MockProvider.prototype, 'chat').mockImplementation(async () => { entered.release(); await finish.promise; return answer(); });
    const pending = f.request();
    try {
      await entered.promise;
      if (action === 'store-aba') { f.manager.setStore(disk); f.manager.setStore(f.store); }
      if (action === 'journal') await f.manager.appendCustomEntry(f.id, 'private', { revision: 2 });
      if (action === 'manager-binding') h.services.sessionManager = replacement;
      const before = await f.manager.getRawEntries(f.id), bytes = await f.bytes(), leaf = f.session.activeLeafId;
      finish.release(); expect((await pending).status).toBe(409);
      expect(await f.manager.getRawEntries(f.id)).toEqual(before); expect(await f.bytes()).toEqual(bytes); expect(f.session.activeLeafId).toBe(leaf);
      expect(await disk.listSessionIds()).toEqual([]); expect(replacement.list()).toEqual([]);
      expect(f.events.filter(type => type.startsWith('compaction.'))).toEqual(['compaction.started', 'compaction.failed']);
    } finally { finish.release(); await pending; h.services.sessionManager = f.manager; }
  });

  it('withdraws disconnect before publication but holds the real operation lease until a non-cooperative provider settles', async () => {
    const f = await fixture(h), entered = latch(), finish = latch(), aborted = latch(); let signal: AbortSignal | undefined;
    const before = await f.manager.getRawEntries(f.id), bytes = await f.bytes();
    vi.spyOn(MockProvider.prototype, 'chat').mockImplementation(async (_messages, options) => {
      signal = options?.signal; signal?.addEventListener('abort', aborted.release, { once: true }); entered.release(); await finish.promise; return answer();
    });
    const settled = latch(), operation = h.services.providerAdministration.withOperation.bind(h.services.providerAdministration);
    vi.spyOn(h.services.providerAdministration, 'withOperation').mockImplementation(async <T>(run: () => Promise<T>): Promise<T> => {
      try { return await operation(run); } finally { settled.release(); }
    });
    const usage = vi.spyOn(h.services, 'recordUsage'), request = f.rawRequest();
    try {
      await entered.promise; request.client.destroy(); await aborted.promise; expect(signal?.aborted).toBe(true);
      expect(f.events.filter(type => type.startsWith('compaction.'))).toEqual(['compaction.started']);
      expect(usage).not.toHaveBeenCalled();
      if (exclusive) await expect(h.services.providerAdministration.rename('unused-provider', async () => undefined))
        .rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
      finish.release(); await f.terminal.promise; await request.ended; await settled.promise;
      expect(await f.manager.getRawEntries(f.id)).toEqual(before); expect(await f.bytes()).toEqual(bytes);
      expect(usage).toHaveBeenCalledOnce();
      expect(f.events.filter(type => type.startsWith('compaction.'))).toEqual(['compaction.started', 'compaction.failed']);
      if (exclusive) {
        const rename = vi.fn(async () => 'must stay unavailable');
        await expect(h.services.providerAdministration.rename('unused-provider', rename))
          .rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_STORE_UNAVAILABLE' });
        expect(rename).not.toHaveBeenCalled();
      }
    } finally { finish.release(); request.client.destroy(); }
  });

  it.each(['normal', 'disconnect', 'store-retirement'] as const)('finishes an admitted native save across %s', async action => {
    const f = await fixture(h), entered = latch(), finish = latch(), disk = new JsonlSessionStore(path.join(h.root, `retired-${f.id}`));
    vi.spyOn(MockProvider.prototype, 'chat').mockResolvedValue(answer());
    const save = f.store.saveSession.bind(f.store);
    const writes = vi.spyOn(f.store, 'saveSession').mockImplementation(async (session, ...args) => {
      if (session.id === f.id) { entered.release(); await finish.promise; } return save(session, ...args);
    });
    const request = f.rawRequest();
    try {
      await entered.promise;
      if (action === 'disconnect') request.client.destroy();
      if (action === 'store-retirement') f.manager.setStore(disk);
      finish.release(); await f.terminal.promise; await request.ended;
      expect(writes).toHaveBeenCalledOnce(); expect((await f.store.loadSession(f.id))?.metadata?.compactionSummary).toBe('HTTP_LIFETIME_SUMMARY');
      expect(await disk.listSessionIds()).toEqual([]);
      expect(f.events.filter(type => type.startsWith('compaction.'))).toEqual(['compaction.started', 'compaction.completed']);
      if (action !== 'disconnect') expect(request.status()).toBe(200);
    } finally { finish.release(); request.client.destroy(); f.manager.setStore(f.store); }
  });

  it('uses owned complete model input, not UI-only messages or private custom history', async () => {
    const f = await fixture(h);
    await f.manager.applyCompaction(f.id, 'PRIOR_BACKGROUND', f.session.messages.at(-2)!.id);
    await f.manager.appendCustomMessage(f.id, 'notice', 'PUBLIC_CUSTOM', { display: false, details: { secret: 'PRIVATE_DETAILS' } });
    await f.manager.appendCustomEntry(f.id, 'private', { secret: 'PRIVATE_STATE' });
    await f.manager.addCommand(f.id, { command: 'public', cwd: h.cwd, status: 'completed', output: 'PUBLIC_COMMAND' });
    await f.manager.addBranchSummary(f.id, 'PUBLIC_BRANCH', 'branch');
    await f.manager.addMessage(f.id, { role: 'assistant', content: 'PUBLIC_DECLARATION', toolCalls: [{ id: 'owned-tool', name: 'tool', input: { value: 7 } }] }, { skipAutoCompaction: true });
    await f.manager.addMessage(f.id, { role: 'tool', toolCallId: 'owned-tool', content: 'PUBLIC_RESULT' }, { skipAutoCompaction: true });
    for (const role of ['user', 'assistant'] as const) await f.manager.addMessage(f.id, { role, content: `KEPT_${role}` }, { skipAutoCompaction: true });
    const expected = f.manager.getEffectiveContext(f.id).filter(entry => entry.type === 'message').slice(0, -2).map(entry => entry.id);
    const before = (await f.manager.getRawEntries(f.id)).filter(entry => entry.type !== 'metadata');
    let input: Message[] = [];
    vi.spyOn(MockProvider.prototype, 'chat').mockImplementation(async messages => { input = structuredClone(messages); return answer(); });
    expect((await f.request()).status).toBe(200);
    expect(input.map(message => message.id)).toEqual(expected);
    for (const marker of ['PRIOR_BACKGROUND','PUBLIC_CUSTOM','PUBLIC_COMMAND','PUBLIC_BRANCH','PUBLIC_DECLARATION','PUBLIC_RESULT']) expect(JSON.stringify(input)).toContain(marker);
    expect(JSON.stringify(input)).not.toMatch(/PRIVATE_|KEPT_/);
    expect(input.find(message => message.toolCalls?.length)?.toolCalls).toEqual([{ id: 'owned-tool', name: 'tool', input: { value: 7 } }]);
    expect(input.find(message => message.role === 'tool')?.toolCallId).toBe('owned-tool');
    const after = await f.manager.getRawEntries(f.id); for (const entry of before) expect(after.find(next => next.id === entry.id)).toEqual(entry);
  });

  it('rejects retired compact in every host mode without inventing reference-owner admission', async () => {
    const chat = vi.spyOn(MockProvider.prototype, 'chat');
    const response = await fetch(`${h.base}/api/chat/compact`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mock', messages: Array.from({ length: 4 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message-${index}` })) }) });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'Not found' }); expect(chat).not.toHaveBeenCalled();
  });
});
