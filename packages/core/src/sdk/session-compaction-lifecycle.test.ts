import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentSession, ExtensionRegistry, JsonlSessionStore, MockProvider, SessionManager, type SessionStore } from '@ai-harness/core';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const roots: string[] = [];
afterEach(async context => {
  vi.restoreAllMocks(); const completed = roots.splice(0);
  if (context.task.result?.state === 'fail') console.error('Retained SDK compaction roots:', completed);
  else await Promise.all(completed.map(root => rm(root, { recursive: true, force: true })));
});
type Mode = 'memory' | 'native-backed' | 'structural-backed';
async function fixture(mode: Mode, stage: 'event' | 'prepare' | 'save' = 'event') {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-compaction-lifetime-')); roots.push(cwd);
  const registry = new ExtensionRegistry(), disk = mode === 'memory' ? undefined : new JsonlSessionStore(path.join(cwd, 'sessions'));
  // The supplied registry is privileged: capture its genuine public manager binding, not a facade/private replacement.
  let manager: SessionManager | undefined; const attach = registry.attachSessionBranchHooks.bind(registry);
  vi.spyOn(registry, 'attachSessionBranchHooks').mockImplementation(value => { manager = value; return attach(value); });
  const store: SessionStore | undefined = mode === 'structural-backed' ? {
    setRedaction: (...args) => disk!.setRedaction(...args), listSessionIds: () => disk!.listSessionIds(), loadSession: id => disk!.loadSession(id),
    saveSession: (...args) => disk!.saveSession(...args), getRawEntries: id => disk!.getRawEntries(id), deleteSession: id => disk!.deleteSession(id),
  } : disk;
  const summarize = vi.fn(async () => 'No implicit generation'), provider = new MockProvider({ type: 'mock', model: 'mock-model' });
  const chat = vi.spyOn(provider, 'chat'), stream = vi.spyOn(provider, 'streamChat');
  const sdk = await createAgentSession({ cwd, store, extensionRegistry: registry, provider: { kind: 'instance', name: 'mock', provider },
    session: { kind: 'new', options: { autoCompaction: false, messages: Array.from({ length: 6 }, (_, index) => ({
      id: `seed-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, content: `Seed ${index}`, timestamp: new Date(index + 1),
    })) } }, compaction: { settings: { enabled: false }, summarize }, isProjectTrusted: () => true,
  });
  if (!manager) throw new Error('SDK did not bind its manager.');
  expect(manager).toBeInstanceOf(SessionManager);
  const sibling = await sdk.clone(), entered = latch(), finish = latch(); let armed = false;
  const writes = vi.fn();
  if (disk) {
    const raw = disk.getRawEntries.bind(disk), save = disk.saveSession.bind(disk);
    vi.spyOn(disk, 'getRawEntries').mockImplementation(async id => {
      if (armed && id === sdk.id && stage === 'prepare') { armed = false; entered.release(); await finish.promise; }
      return raw(id);
    });
    vi.spyOn(disk, 'saveSession').mockImplementation(async (session, ...args) => {
      if (session.id === sdk.id) {
        if (armed && stage === 'save') { armed = false; entered.release(); await finish.promise; }
        writes();
      }
      return save(session, ...args);
    });
  }
  let vetoes = 0;
  await registry.load('borrowed-sentinel', api => { api.before('before:session:branch', event => {
    if (event.sourceSessionId === sibling.id) { vetoes++; return false as const; } return undefined;
  }); });
  const events: Array<{ type: string }> = []; sdk.subscribe(event => { events.push(event); });
  return { cwd, registry, disk, manager, sdk, sibling, summarize, chat, stream, writes, entered, finish, events, vetoes: () => vetoes,
    arm: () => { armed = true; }, bytes: () => disk ? readFile(disk.getSessionFilePath(sdk.id)!) : Promise.resolve(undefined) };
}
async function cleanup(f: Awaited<ReturnType<typeof fixture>>) { f.finish.release(); await f.sdk.dispose(); await f.sibling.dispose(); await f.registry.shutdown(); }
const publish = (f: Awaited<ReturnType<typeof fixture>>) => f.sdk.applyCompaction('Provided SDK summary', 'seed-4', { provider: 'mock', model: 'summary-model', usage: { totalTokens: 3 } });
const observe = (run: Promise<void>) => run.then(() => ({ success: true, error: undefined as unknown }), error => ({ success: false, error: error as unknown }));
async function borrowedSibling(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = f.sibling.snapshot(), raw = await f.sibling.history();
  await expect(f.sibling.clone()).rejects.toMatchObject({ name: 'AbortError', code: 'SESSION_BRANCH_CANCELLED' });
  expect(f.vetoes()).toBe(1); expect(f.sibling.snapshot()).toEqual(snapshot); expect(await f.sibling.history()).toEqual(raw);
  expect(f.registry.list().map(item => item.id)).toEqual(['borrowed-sentinel']);
}

for (const mode of ['memory', 'native-backed', 'structural-backed'] as const) describe(`SDK explicit compaction (${mode})`, () => {
  it('keeps caller-summary authority with automatic compaction disabled and a registered generation callback', async () => {
    const f = await fixture(mode);
    try {
      expect(f.sdk.compactionTarget()).toBeNull(); expect(f.sdk.capabilities.compaction).toBe('caller-summary');
      await publish(f); expect(f.summarize).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled();
      expect(f.sdk.messages()).toHaveLength(2); expect(f.sdk.effectiveContext().some(entry => 'content' in entry && entry.content === '[Context Summary] Provided SDK summary')).toBe(true);
      const raw = await f.sdk.history(); expect(raw.filter(entry => entry.type === 'message')).toHaveLength(6);
      expect(raw.filter(entry => entry.type === 'compaction')).toEqual([expect.objectContaining({ summary: 'Provided SDK summary', provider: 'mock', model: 'summary-model', usage: { totalTokens: 3 } })]);
      expect(f.events.map(event => event.type)).toEqual(['compaction.started', 'compaction.completed']);
    } finally { await cleanup(f); }
  });
  it.each(['replace-at-start', 'title'] as const)('retains pre-observer source authority across %s', async action => {
    const f = await fixture(mode), source = structuredClone(f.manager.get(f.sdk.id)), sibling = f.sibling.snapshot(), bytes = await f.bytes();
    const siblingBytes = f.disk ? await readFile(f.disk.getSessionFilePath(f.sibling.id)!) : undefined;
    const replacement = new JsonlSessionStore(path.join(f.cwd, 'replacement'));
    f.sdk.subscribe(event => {
      if (event.type !== 'compaction.started') return;
      if (action === 'replace-at-start') f.manager.setStore(replacement);
      else void f.manager.update(f.sdk.id, { title: 'Valid observer metadata title' });
    });
    try {
      if (action === 'replace-at-start') {
        await expect(publish(f)).rejects.toThrow('Compaction context or policy changed.');
        expect(f.manager.get(f.sdk.id)).toEqual(source); expect(await f.bytes()).toEqual(bytes); expect(f.writes).not.toHaveBeenCalled();
        expect(f.events.map(event => event.type)).toEqual(['compaction.started', 'compaction.failed']);
      } else {
        await publish(f); expect(f.sdk.snapshot().title).toBe('Valid observer metadata title');
        expect(f.manager.get(f.sdk.id)?.metadata?.compactionSummary).toBe('Provided SDK summary');
        expect(f.events.filter(event => event.type.startsWith('compaction.')).map(event => event.type)).toEqual(['compaction.started', 'compaction.completed']);
      }
      expect(await replacement.listSessionIds()).toEqual([]); expect(f.sibling.snapshot()).toEqual(sibling);
      if (f.disk) expect(await readFile(f.disk.getSessionFilePath(f.sibling.id)!)).toEqual(siblingBytes);
      expect(f.registry.list().map(item => item.id)).toEqual(['borrowed-sentinel']);
      expect(f.summarize).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled();
    } finally { await cleanup(f); }
  });
  it.each(['custom-message', 'command', 'branch-summary'] as const)('publishes its genuine nonordinary compactionTarget at %s without implicit generation', async family => {
    const f = await fixture(mode);
    try {
      const target = family === 'custom-message'
        ? await f.manager.appendCustomMessage(f.sdk.id, 'public', 'KEPT_PUBLIC_BOUNDARY', { display: false, details: { secret: 'PRIVATE_DETAILS' } })
        : family === 'branch-summary'
          ? await f.manager.addBranchSummary(f.sdk.id, 'KEPT_PUBLIC_BOUNDARY', 'kept')
          : await f.manager.addCommand(f.sdk.id, { command: 'kept', cwd: f.cwd, output: 'KEPT_PUBLIC_BOUNDARY', status: 'completed' });
      if (!target) throw new Error('Fixture boundary missing.');
      const boundary = family === 'command' ? `context-${target.id}` : target.id;
      await f.manager.appendCustomEntry(f.sdk.id, 'private', { secret: 'PRIVATE_STATE', anchor: boundary });
      f.manager.setCompactionSettings({ enabled: true, keepRecentTokens: 1 });
      const prepared = f.sdk.compactionTarget();
      expect(prepared?.keptEntries[0].id).toBe(boundary);
      const before = (await f.manager.getRawEntries(f.sdk.id)).filter(entry => entry.type !== 'metadata');
      await f.sdk.applyCompaction('Provided SDK boundary summary', boundary);
      expect(f.sdk.messages()).toEqual([]);
      const contents = f.sdk.effectiveContext().flatMap(entry => entry.type === 'message' ? [entry.content] : []);
      expect(contents).toHaveLength(2); expect(contents[0]).toBe('[Context Summary] Provided SDK boundary summary');
      expect(contents[1]).toContain('KEPT_PUBLIC_BOUNDARY'); expect(JSON.stringify(contents)).not.toMatch(/PRIVATE_|Seed/);
      const raw = await f.sdk.history(); for (const entry of before) expect(raw.find(next => next.id === entry.id)).toEqual(entry);
      expect(f.events.map(event => event.type)).toEqual(['compaction.started', 'compaction.completed']);
      const copy = await f.sdk.clone('nonordinary boundary clone');
      try {
        expect(copy.effectiveContext().flatMap(entry => entry.type === 'message' ? [entry.content] : [])).toEqual(contents);
        const privateEntry = (await copy.history()).find(entry => entry.type === 'custom' && entry.customType === 'private');
        expect(privateEntry?.type === 'custom' && privateEntry.data).toEqual({ secret: 'PRIVATE_STATE', anchor: boundary });
      } finally { await copy.dispose(); }
      expect(f.summarize).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled();
      await borrowedSibling(f);
    } finally { await cleanup(f); }
  });
  it('withdraws when its start observer synchronously disposes the handle without stealing the live sibling', async () => {
    const f = await fixture(mode), before = await f.manager.getRawEntries(f.sdk.id), snapshot = structuredClone(f.manager.get(f.sdk.id)), bytes = await f.bytes();
    let disposal: Promise<void> | undefined;
    f.sdk.subscribe(event => { if (event.type === 'compaction.started') disposal = f.sdk.dispose(); });
    try {
      await expect(publish(f)).rejects.toMatchObject({ name: 'AbortError', message: 'Compaction cancelled' });
      expect(disposal).toBeDefined(); expect(f.sdk.dispose()).toBe(disposal); await disposal;
      expect(await f.manager.getRawEntries(f.sdk.id)).toEqual(before); expect(f.manager.get(f.sdk.id)).toEqual(snapshot); expect(await f.bytes()).toEqual(bytes);
      expect(f.writes).not.toHaveBeenCalled(); expect(f.summarize).not.toHaveBeenCalled();
      expect(f.events.map(event => event.type)).toEqual(['compaction.started', 'compaction.failed']);
      await borrowedSibling(f);
    } finally { await cleanup(f); }
  });
});

// Both external persistent forms go through SessionStoreAdapter's structural preparation.
for (const mode of ['native-backed', 'structural-backed'] as const) describe(`SDK compaction ${mode} preparation/admission`, () => {
  it.each(['prepare', 'save'] as const)('disposal during %s withdraws only a not-yet-admitted publication', async stage => {
    const f = await fixture(mode, stage), before = await f.manager.getRawEntries(f.sdk.id), snapshot = structuredClone(f.manager.get(f.sdk.id)), bytes = await f.bytes();
    try {
      f.arm(); const pending = observe(publish(f)); await f.entered.promise;
      let settled = false; const disposal = f.sdk.dispose(); disposal.then(() => { settled = true; });
      expect(f.sdk.dispose()).toBe(disposal); await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
      f.finish.release(); const outcome = await pending; await disposal;
      expect(f.summarize).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled();
      if (stage === 'prepare') {
        expect(outcome.success).toBe(false); expect(outcome.error).toMatchObject({ name: 'AbortError', message: 'Compaction cancelled' });
        expect(f.writes).not.toHaveBeenCalled(); expect(await f.bytes()).toEqual(bytes); expect(await f.manager.getRawEntries(f.sdk.id)).toEqual(before); expect(f.manager.get(f.sdk.id)).toEqual(snapshot);
        expect(f.events.map(event => event.type)).toEqual(['compaction.started', 'compaction.failed']);
      } else {
        expect(outcome.success).toBe(true); expect(f.writes).toHaveBeenCalledTimes(1);
        expect((await f.disk!.loadSession(f.sdk.id))?.metadata?.compactionSummary).toBe('Provided SDK summary');
        expect((await f.disk!.getRawEntries(f.sdk.id)).filter(entry => entry.type === 'message')).toHaveLength(6);
        expect(f.events.map(event => event.type)).toEqual(['compaction.started', 'compaction.completed']);
        expect(f.manager.getEffectiveContext(f.sdk.id).some(entry => 'content' in entry && entry.content === '[Context Summary] Provided SDK summary')).toBe(true);
      }
      await borrowedSibling(f);
    } finally { await cleanup(f); }
  });
});
