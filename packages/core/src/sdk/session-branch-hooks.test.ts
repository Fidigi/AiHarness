import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentSession, ExtensionRegistry, JsonlSessionStore, SessionManager, SessionBranchCancelledError,
  type AgentSession, type SessionStore } from '@ai-harness/core';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const roots: string[] = [], handles: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
const messages = () => [
  { id: 'root-user', role: 'user' as const, content: 'Root user', timestamp: new Date(1) },
  { id: 'selected-user', role: 'user' as const, content: 'Selected user', timestamp: new Date(2) },
  { id: 'after-user', role: 'assistant' as const, content: 'After selection', timestamp: new Date(3) },
];
async function fixture(mode: 'memory' | 'native' | 'structural') {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-branch-')); roots.push(cwd);
  const registry = new ExtensionRegistry(), disk = mode === 'memory' ? undefined : new JsonlSessionStore(path.join(cwd, 'sessions'));
  const store: SessionStore | undefined = mode !== 'structural' ? disk : {
    setRedaction: (...args) => disk!.setRedaction(...args), listSessionIds: () => disk!.listSessionIds(),
    loadSession: id => disk!.loadSession(id), saveSession: (...args) => disk!.saveSession(...args),
    getRawEntries: id => disk!.getRawEntries(id), deleteSession: id => disk!.deleteSession(id),
  };
  const sdk = await createAgentSession({ cwd, extensionRegistry: registry, store,
    provider: { kind: 'config', config: { type: 'mock', model: 'mock-model' } },
    session: { kind: 'new', options: { messages: messages() } },
  }); handles.push(sdk);
  return { cwd, sdk, registry, disk, store };
}
type Operation = 'fork' | 'branch-before' | 'clone';
async function perform(sdk: AgentSession, operation: Operation): Promise<unknown> {
  if (operation === 'branch-before') return sdk.branchBefore('selected-user');
  const copied = operation === 'fork' ? await sdk.fork('selected-user', { before: true }) : await sdk.clone();
  handles.push(copied); return copied;
}

for (const mode of ['memory', 'native', 'structural'] as const) describe(`SDK branch bridge (${mode})`, () => {
  for (const operation of ['fork', 'branch-before', 'clone'] as const) {
    it(`preserves source snapshots and persistence on a ${operation} veto`, async () => {
      const f = await fixture(mode), before = f.sdk.snapshot(), raw = await f.sdk.history();
      const bytes = f.disk ? await readFile(f.disk.getSessionFilePath(f.sdk.id)!) : undefined;
      let calls = 0;
      await f.registry.load('veto', api => { api.before('before:session:branch', event => {
        expect(event).toMatchObject({ sourceSessionId: f.sdk.id, operation,
          position: operation === 'clone' ? 'at' : 'before', entryId: operation === 'clone' ? 'after-user' : 'selected-user' });
        calls++; return false;
      }); });
      await expect(perform(f.sdk, operation)).rejects.toMatchObject({ name: 'AbortError', code: 'SESSION_BRANCH_CANCELLED' });
      expect(calls).toBe(1); expect(f.sdk.snapshot()).toEqual(before); expect(await f.sdk.history()).toEqual(raw);
      if (f.disk) { expect(await f.disk.listSessionIds()).toEqual([f.sdk.id]); expect(await readFile(f.disk.getSessionFilePath(f.sdk.id)!)).toEqual(bytes); }
      await f.sdk.dispose(); expect(f.registry.list().map(item => item.id)).toEqual(['veto']); await f.registry.shutdown();
    });

    it(`dispose withdraws an unpublished ${operation} without waiting for a non-cooperative hook`, async () => {
      const f = await fixture(mode), entered = latch(), gate = latch(), sourceId = f.sdk.id;
      const raw = await f.sdk.history();
      try {
        await f.registry.load('pending', api => { api.before('before:session:branch', async () => {
          entered.release(); await gate.promise;
        }); });
        const pending = perform(f.sdk, operation), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'SESSION_BRANCH_CANCELLED' });
        await entered.promise; const disposing = f.sdk.dispose();
        expect(f.sdk.dispose()).toBe(disposing); await Promise.all([disposing, rejected]);
        gate.release(); await new Promise<void>(resolve => setImmediate(resolve));
        expect(() => f.sdk.snapshot()).toThrow('Agent session is disposed.');
        if (f.disk) { expect(await f.disk.listSessionIds()).toEqual([sourceId]); expect(await f.disk.getRawEntries(sourceId)).toEqual(raw); }
        expect(f.registry.list().map(item => item.id)).toEqual(['pending']);
      } finally { gate.release(); await f.sdk.dispose(); await f.registry.shutdown(); }
    });

    it(`keeps a live sibling bound when ${operation} abort synchronously reenters parent disposal`, async () => {
      const f = await fixture(mode), sibling = await f.sdk.clone(); handles.push(sibling);
      const snapshot = sibling.snapshot(), raw = await sibling.history(), entered = latch(), gate = latch();
      let reentrant: Promise<void> | undefined, siblingVetoes = 0;
      await f.registry.load('reentrant-disposal', api => { api.before('before:session:branch', async event => {
        if (event.sourceSessionId === sibling.id) { siblingVetoes++; return false as const; }
        expect(event.sourceSessionId).toBe(f.sdk.id); expect(event.operation).toBe(operation);
        event.signal.addEventListener('abort', () => { reentrant = f.sdk.dispose(); }, { once: true });
        entered.release(); await gate.promise; return undefined;
      }); });
      try {
        const pending = perform(f.sdk, operation), rejected = expect(pending).rejects.toMatchObject({ code: 'SESSION_BRANCH_CANCELLED' });
        await entered.promise; const disposal = f.sdk.dispose(); await Promise.all([disposal, rejected]);
        // A live sibling must retain the group's veto lease; promise identity alone misses premature cleanup.
        await expect(perform(sibling, 'clone')).rejects.toMatchObject({ code: 'SESSION_BRANCH_CANCELLED' });
        expect(siblingVetoes).toBe(1); expect(reentrant).toBe(disposal); expect(f.sdk.dispose()).toBe(disposal);
        expect(sibling.snapshot()).toEqual(snapshot); expect(await sibling.history()).toEqual(raw);
        if (f.disk) expect(await f.disk.listSessionIds()).toHaveLength(2);
      } finally { gate.release(); await f.sdk.dispose(); await sibling.dispose(); await f.registry.shutdown(); }
    });
  }
});

it.each(['fork', 'clone'] as const)('completes an already-admitted %s write and keeps its new handle alive through parent disposal', async operation => {
  const f = await fixture('native'), entered = latch(), gate = latch(), sourceId = f.sdk.id;
  const sourceBytes = await readFile(f.disk!.getSessionFilePath(sourceId)!);
  const save = f.disk!.saveSession.bind(f.disk!);
  vi.spyOn(f.disk!, 'saveSession').mockImplementation(async (session, entries, options) => {
    if (session.id !== sourceId) { entered.release(); await gate.promise; }
    await save(session, entries, options);
  });
  try {
    const pending = perform(f.sdk, operation); await entered.promise;
    let disposed = false; const disposal = f.sdk.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(disposed).toBe(false);
    gate.release(); const copied = await pending as AgentSession; await disposal;
    expect(copied.snapshot().id).not.toBe(sourceId); expect(await f.disk!.listSessionIds()).toHaveLength(2);
    expect(await readFile(f.disk!.getSessionFilePath(sourceId)!)).toEqual(sourceBytes);
    await f.registry.load('veto', api => { api.before('before:session:branch', () => false); });
    await expect(copied.clone()).rejects.toMatchObject({ name: 'AbortError', code: 'SESSION_BRANCH_CANCELLED' });
    expect(copied.messages().length).toBeGreaterThan(0); await copied.dispose();
  } finally { gate.release(); await f.sdk.dispose(); await f.registry.shutdown(); }
});

it('borrows a registry without moving or removing its existing host lifecycle and veto binding', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-host-binding-')); roots.push(cwd);
  const registry = new ExtensionRegistry(), host = new SessionManager(), source = await host.create();
  await host.addMessage(source.id, { role: 'user', content: 'Host root' }); const target = source.activeLeafId!;
  await host.addMessage(source.id, { role: 'assistant', content: 'Host abandoned answer' });
  registry.attachSessionManager(host); const created: string[] = [];
  await registry.load('host', api => {
    api.on('session:create', event => { created.push(event.sessionId); });
    api.before('before:session:branch', () => false); api.before('before:session:summary', () => false);
  });
  const sdk = await createAgentSession({ cwd, extensionRegistry: registry,
    provider: { kind: 'config', config: { type: 'mock' } }, session: { kind: 'new', options: { messages: messages() } },
  }); handles.push(sdk);
  expect(created).toEqual([]); await expect(sdk.clone()).rejects.toMatchObject({ code: 'SESSION_BRANCH_CANCELLED' });
  await sdk.dispose(); const next = await host.create(); expect(created).toEqual([next.id]);
  await expect(host.cloneSession(source.id)).rejects.toBeInstanceOf(SessionBranchCancelledError);
  expect(await host.navigateTree(source.id, target, { summarize: true })).toEqual({ status: 'cancelled' }); await registry.shutdown();
});

it('releases a failed factory branch binding instead of exhausting the borrowed registry', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-binding-failure-')); roots.push(cwd);
  const registry = new ExtensionRegistry();
  for (let index = 0; index < 130; index++) await expect(createAgentSession({ cwd, extensionRegistry: registry,
    provider: { kind: 'config', config: { type: 'mock' } }, session: { kind: 'resume', id: 'missing' },
  })).rejects.toThrow('Resume requires a caller SessionStore.');
  const detach = registry.attachSessionBranchHooks(new SessionManager()); detach(); await registry.shutdown();
});
