import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from './session-manager.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function seed(redactText?: (value: string) => string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-compaction-admission-'));
  roots.push(root);
  const store = new JsonlSessionStore(root);
  const manager = new SessionManager({ store, redactText });
  manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 60 });
  const session = await manager.create({ autoCompaction: false });
  for (let index = 0; index < 6; index++) {
    await manager.addMessage(session.id, { role: 'user', content: `Seed ${index} ${'x'.repeat(80)}` });
  }
  await manager.update(session.id, { autoCompaction: true });
  const events: Array<{ phase: string; cancelled?: boolean; error?: string }> = [];
  manager.on('compaction:start', () => { events.push({ phase: 'start' }); });
  manager.on('compaction:end', () => { events.push({ phase: 'end' }); });
  manager.on('compaction:error', event => { events.push({ phase: 'error', cancelled: event.cancelled, error: event.error }); });
  const bytes = () => readFile(path.join(root, `${session.id}.jsonl`));
  return { manager, store, session, events, bytes };
}

function holdSummary(manager: SessionManager) {
  const started = deferred();
  const finish = deferred();
  const summarize = vi.fn(async () => {
    started.resolve();
    await finish.promise; // Deliberately ignores AbortSignal.
    return 'Late summary';
  });
  manager.setAutoCompactionCallback(summarize);
  return { started, finish, summarize };
}

async function expectUnchanged(fixture: Awaited<ReturnType<typeof seed>>, before: Buffer) {
  expect(await fixture.bytes()).toEqual(before);
  const reloaded = await fixture.store.loadSession(fixture.session.id);
  expect(reloaded?.activeLeafId).toBe(fixture.manager.get(fixture.session.id)?.activeLeafId);
  expect(reloaded?.metadata?.compactionSummary).toBe(fixture.manager.get(fixture.session.id)?.metadata?.compactionSummary);
  expect(fixture.events.some(event => event.phase === 'end')).toBe(false);
}

describe('automatic compaction admission', () => {
  it('does not invoke inherited policy or summarization for a pre-aborted check', async () => {
    const fixture = await seed();
    const policy = vi.fn(async () => true);
    const summarize = vi.fn(async () => 'Unused');
    fixture.manager.setAutoCompactionPolicy(policy);
    fixture.manager.setAutoCompactionCallback(summarize);
    const controller = new AbortController();
    controller.abort();
    const before = await fixture.bytes();
    expect(await fixture.manager.checkAndTriggerCompaction(fixture.session.id, controller.signal)).toBe(false);
    expect(policy).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
    await expectUnchanged(fixture, before);
  });

  it.each(['abort', 'session-disabled', 'settings-disabled', 'branch', 'callback-replaced'] as const)(
    'revalidates %s after an asynchronous inherited-policy wait without starting a lifecycle', async change => {
      const fixture = await seed();
      const policyStarted = deferred();
      const finishPolicy = deferred();
      fixture.manager.setAutoCompactionPolicy(async () => {
        policyStarted.resolve();
        await finishPolicy.promise;
        return true;
      });
      const summarize = vi.fn(async () => 'Unused');
      fixture.manager.setAutoCompactionCallback(summarize);
      const replacement = vi.fn(async () => 'Replacement');
      const controller = new AbortController();
      const run = fixture.manager.checkAndTriggerCompaction(fixture.session.id, controller.signal);
      await policyStarted.promise;
      if (change === 'abort') controller.abort('private abort reason');
      if (change === 'session-disabled') await fixture.manager.update(fixture.session.id, { autoCompaction: false });
      if (change === 'settings-disabled') fixture.manager.setCompactionSettings({ enabled: false });
      if (change === 'branch') await fixture.manager.branchBeforeEntry(fixture.session.id, fixture.session.messages.at(-1)!.id);
      if (change === 'callback-replaced') fixture.manager.setAutoCompactionCallback(replacement);
      const before = await fixture.bytes();
      finishPolicy.resolve();
      expect(await run).toBe(false);
      expect(summarize).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      expect(fixture.events).toEqual([]);
      await expectUnchanged(fixture, before);
    },
  );

  it('rechecks cancellation after awaited start observers before calling the summarizer', async () => {
    const fixture = await seed();
    const controller = new AbortController();
    fixture.manager.on('compaction:start', async () => {
      await Promise.resolve();
      controller.abort('private abort reason');
    });
    const summarize = vi.fn(async () => 'Unused');
    fixture.manager.setAutoCompactionCallback(summarize);
    const before = await fixture.bytes();
    expect(await fixture.manager.checkAndTriggerCompaction(fixture.session.id, controller.signal)).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      { phase: 'start' }, { phase: 'error', cancelled: true, error: 'Compaction cancelled' },
    ]);
    await expectUnchanged(fixture, before);
  });

  it('rejects an abort-ignoring late summary without persisting it or reporting success', async () => {
    const fixture = await seed();
    const held = holdSummary(fixture.manager);
    const controller = new AbortController();
    const before = await fixture.bytes();
    const run = fixture.manager.checkAndTriggerCompaction(fixture.session.id, controller.signal);
    await held.started.promise;
    controller.abort('private abort reason');
    held.finish.resolve();
    expect(await run).toBe(false);
    expect(fixture.events).toEqual([
      { phase: 'start' }, { phase: 'error', cancelled: true, error: 'Compaction cancelled' },
    ]);
    await expectUnchanged(fixture, before);
    expect((await fixture.manager.getRawEntries(fixture.session.id)).some(entry => entry.type === 'compaction')).toBe(false);
  });

  it.each(['branch', 'manual-compaction', 'session-disabled', 'thresholds', 'replacement-session', 'callback-replaced'] as const)(
    'rejects stale output after %s while summarization was pending', async change => {
      const fixture = await seed();
      const held = holdSummary(fixture.manager);
      const run = fixture.manager.checkAndTriggerCompaction(fixture.session.id);
      await held.started.promise;
      if (change === 'branch') {
        // The first kept boundary still exists on this new active path: ID existence alone is insufficient.
        await fixture.manager.branchBeforeEntry(fixture.session.id, fixture.session.messages.at(-1)!.id);
      }
      if (change === 'manual-compaction') {
        await fixture.manager.applyCompaction(fixture.session.id, 'Independent summary', fixture.session.messages[4]!.id);
      }
      if (change === 'session-disabled') await fixture.manager.update(fixture.session.id, { autoCompaction: false });
      if (change === 'thresholds') fixture.manager.setCompactionSettings({ keepRecentTokens: 30 });
      if (change === 'replacement-session') {
        const messages = structuredClone(fixture.session.messages);
        const activeLeafId = fixture.session.activeLeafId;
        await fixture.manager.delete(fixture.session.id);
        await fixture.manager.create({ id: fixture.session.id, messages, activeLeafId, autoCompaction: true });
      }
      if (change === 'callback-replaced') fixture.manager.setAutoCompactionCallback(async () => 'Replacement summary');
      const before = await fixture.bytes();
      const contextBefore = fixture.manager.getEffectiveContext(fixture.session.id);
      const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      held.finish.resolve();
      expect(await run).toBe(false);
      expect(fixture.events).toEqual([
        { phase: 'start' }, { phase: 'error', cancelled: false, error: 'Compaction context or policy changed.' },
      ]);
      expect(errorOutput).toHaveBeenCalledWith('[SessionManager] Auto-compaction failed.');
      await expectUnchanged(fixture, before);
      expect(fixture.manager.getEffectiveContext(fixture.session.id)).toEqual(contextBefore);
    },
  );

  it.each(['abort', 'session-disabled', 'branch'] as const)(
    'checks %s again after waiting behind a durable manager mutation', async change => {
      const atPublicationQueue = deferred();
      const fixture = await seed(value => {
        if (value === 'Late summary') atPublicationQueue.resolve();
        return value;
      });
      const held = holdSummary(fixture.manager);
      const controller = new AbortController();
      const run = fixture.manager.checkAndTriggerCompaction(fixture.session.id, controller.signal);
      await held.started.promise;
      const storeStarted = deferred();
      const finishStore = deferred();
      const save = fixture.store.saveSession.bind(fixture.store);
      vi.spyOn(fixture.store, 'saveSession').mockImplementationOnce(async (...args) => {
        storeStarted.resolve();
        await finishStore.promise;
        return save(...args);
      });
      const mutation = fixture.manager.update(fixture.session.id, {
        title: 'Held metadata write',
        ...(change === 'session-disabled' ? { autoCompaction: false } : {}),
        ...(change === 'branch' ? { activeLeafId: fixture.session.messages[4]!.id } : {}),
      });
      await storeStarted.promise;
      held.finish.resolve();
      await atPublicationQueue.promise;
      if (change === 'abort') controller.abort();
      finishStore.resolve();
      await mutation;
      const before = await fixture.bytes();
      expect(await run).toBe(false);
      expect(fixture.events.at(-1)).toMatchObject({ phase: 'error', cancelled: change === 'abort' });
      await expectUnchanged(fixture, before);
    },
  );

  it('releases cancelled admission so a fresh check can commit exactly one new summary', async () => {
    const fixture = await seed();
    const held = holdSummary(fixture.manager);
    const controller = new AbortController();
    const run = fixture.manager.checkAndTriggerCompaction(fixture.session.id, controller.signal);
    await held.started.promise;
    controller.abort();
    held.finish.resolve();
    expect(await run).toBe(false);
    expect(await fixture.manager.checkAndTriggerCompaction(fixture.session.id)).toBe(true);
    expect(held.summarize).toHaveBeenCalledTimes(2);
    expect(fixture.events.map(event => event.phase)).toEqual(['start', 'error', 'start', 'end']);
    expect((await fixture.manager.getRawEntries(fixture.session.id)).filter(entry => entry.type === 'compaction')).toHaveLength(1);
  });

  it('does not pretend cancellation rolls back persistence that has already been admitted', async () => {
    const fixture = await seed();
    const storeStarted = deferred();
    const finishStore = deferred();
    const save = fixture.store.saveSession.bind(fixture.store);
    vi.spyOn(fixture.store, 'saveSession').mockImplementationOnce(async (...args) => {
      storeStarted.resolve();
      await finishStore.promise;
      return save(...args);
    });
    fixture.manager.setAutoCompactionCallback(async () => 'Admitted summary');
    const controller = new AbortController();
    const run = fixture.manager.checkAndTriggerCompaction(fixture.session.id, controller.signal);
    await storeStarted.promise;
    controller.abort();
    finishStore.resolve();
    expect(await run).toBe(true);
    expect(fixture.events.map(event => event.phase)).toEqual(['start', 'end']);
    expect((await fixture.store.loadSession(fixture.session.id))?.metadata?.compactionSummary).toBe('Admitted summary');
  });

  it('admits once before a start observer reenters and releases admission for a later check', async () => {
    const fixture = await seed();
    let joined: Promise<boolean> | undefined;
    fixture.manager.once('compaction:start', () => {
      joined = fixture.manager.checkAndTriggerCompaction(fixture.session.id);
    });
    const summarize = vi.fn(async () => 'One admitted summary');
    fixture.manager.setAutoCompactionCallback(summarize);
    const first = fixture.manager.checkAndTriggerCompaction(fixture.session.id);
    expect(await first).toBe(true);
    expect(await joined).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(fixture.events.map(event => event.phase)).toEqual(['start', 'end']);
    expect((await fixture.manager.getRawEntries(fixture.session.id)).filter(entry => entry.type === 'compaction')).toHaveLength(1);
    expect(await fixture.manager.checkAndTriggerCompaction(fixture.session.id)).toBe(false);
  });

  it('accepts unchanged context after metadata-only changes and equivalent settings refresh', async () => {
    const fixture = await seed();
    const held = holdSummary(fixture.manager);
    const run = fixture.manager.checkAndTriggerCompaction(fixture.session.id);
    await held.started.promise;
    await fixture.manager.update(fixture.session.id, { title: 'New title' });
    fixture.manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 60 });
    held.finish.resolve();
    expect(await run).toBe(true);
    expect(fixture.events.map(event => event.phase)).toEqual(['start', 'end']);
    const reloaded = await fixture.store.loadSession(fixture.session.id);
    expect(reloaded).toMatchObject({ title: 'New title', metadata: { compactionSummary: 'Late summary' } });
    expect(reloaded?.activeLeafId).toBe(fixture.manager.get(fixture.session.id)?.activeLeafId);
    expect((await fixture.manager.getRawEntries(fixture.session.id)).filter(entry => entry.type === 'compaction')).toHaveLength(1);
  });
});
