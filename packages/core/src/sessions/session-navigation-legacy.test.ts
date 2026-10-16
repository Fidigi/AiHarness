import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const context = (manager: SessionManager, id: string) => manager.getEffectiveContext(id).map(entry => entry.type === 'message' ? entry.content : '');
async function fixture(durable: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-legacy-navigation-')); roots.push(root);
  const manager = new SessionManager(durable ? { store: new JsonlSessionStore(root) } : {});
  const session = await manager.create({ metadata: { compactionSummary: 'Legacy retained background',
    lastCompacted: '2026-01-01T00:00:00.000Z' } });
  await manager.addMessage(session.id, { role: 'user', content: 'Retained root' });
  const target = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned' });
  return { manager, session, target, root };
}
const expected = ['[Context Summary] Legacy retained background', 'Retained root'];

for (const durable of [false, true]) {
  it(`retains a metadata-only legacy compaction prefix during navigation/reload (${durable})`, async () => {
    const f = await fixture(durable);
    expect(context(f.manager, f.session.id)).toEqual([...expected, 'Abandoned']);
    await f.manager.navigateTree(f.session.id, f.target);
    expect(context(f.manager, f.session.id)).toEqual(expected);
    if (durable) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(f.root) });
      await reloaded.loadFromStore(f.session.id);
      expect(context(reloaded, f.session.id)).toEqual(expected);
    }
  });

  for (const navigateFirst of [false, true]) it(`does not substitute a later compaction for a legacy prefix (${durable}/${navigateFirst})`, async () => {
    const f = await fixture(durable);
    if (navigateFirst) await f.manager.navigateTree(f.session.id, f.target);
    await f.manager.applyCompaction(f.session.id, 'Later replacement', f.target);
    expect(context(f.manager, f.session.id)[0]).toBe('[Context Summary] Later replacement');
    await f.manager.navigateTree(f.session.id, f.target);
    expect(context(f.manager, f.session.id)).toEqual(expected);
    if (durable) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(f.root) }); await reloaded.loadFromStore(f.session.id);
      expect(context(reloaded, f.session.id)).toEqual(expected);
    }
  });

  it(`scopes a retained legacy prefix to its ancestry, never a later independent root (${durable})`, async () => {
    const f = await fixture(durable);
    await f.manager.navigateTree(f.session.id, f.target);
    await f.manager.branchBeforeEntry(f.session.id, f.target);
    await f.manager.addMessage(f.session.id, { role: 'user', content: 'Independent root' });
    const independent = f.session.activeLeafId!;
    expect(context(f.manager, f.session.id)).toEqual(['Independent root']);
    await f.manager.navigateTree(f.session.id, f.target);
    expect(context(f.manager, f.session.id)).toEqual(expected);
    await f.manager.navigateTree(f.session.id, independent);
    expect(context(f.manager, f.session.id)).toEqual(['Independent root']);
  });

  it(`remaps the legacy prefix anchor when cloning current custom context (${durable})`, async () => {
    const f = await fixture(durable);
    await f.manager.navigateTree(f.session.id, f.target);
    await f.manager.appendCustomMessage(f.session.id, 'notice', 'Useful custom content', { display: false });
    const clone = await f.manager.cloneSession(f.session.id);
    expect(clone).not.toBeNull();
    expect(context(f.manager, clone!.id)).toEqual([...expected, '[Custom Message: notice]\nUseful custom content']);
    if (durable) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(f.root) }); await reloaded.loadFromStore(clone!.id);
      expect(context(reloaded, clone!.id)).toEqual([...expected, '[Custom Message: notice]\nUseful custom content']);
    }
  });
}

it('never makes a clock-reordered custom descendant the parent of its cloned root', async () => {
  const manager = new SessionManager();
  const session = await manager.create({ messages: [{ id: 'future-root', role: 'user', content: 'Root',
    timestamp: new Date(Date.now() + 3_600_000) }] });
  await manager.appendCustomMessage(session.id, 'notice', 'Earlier-clock context', { display: false });
  await manager.navigateTree(session.id, 'future-root');
  await manager.appendCustomMessage(session.id, 'notice', 'Current custom context', { display: false });
  const clone = await manager.cloneSession(session.id);
  expect(clone).not.toBeNull();
  expect(context(manager, clone!.id)).toEqual(['Root', '[Custom Message: notice]\nCurrent custom context']);
});

it('rejects accessors on newly retained legacy prefix data without reading them', async () => {
  const f = await fixture(false);
  let reads = 0;
  Object.defineProperty(f.session.metadata!, 'aiHarnessLegacyCompactionPrefix', { enumerable: true,
    get: () => { reads++; return { anchorEntryId: f.target, summary: 'Wrong', timestamp: 1 }; } });
  await expect(f.manager.navigateTree(f.session.id, f.target)).rejects.toThrow('Legacy compaction context is invalid.');
  expect(reads).toBe(0);
});
