import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from './session-manager.js';

function latch() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
const roots: string[] = [];
afterEach(async context => {
  vi.restoreAllMocks();
  const completedRoots = roots.splice(0);
  if (context.task.result?.state === 'fail') console.error('Retained compaction roots:', completedRoots);
  else await Promise.all(completedRoots.map(root => rm(root, { recursive: true, force: true })));
});

type Stage = 'policy' | 'summary' | 'prepare' | 'save';
type Action = 'abort' | 'replace' | 'replace-restore' | 'same-store' | 'settings' | 'window' | 'callback';
const common: ReadonlyArray<readonly [Stage, Action]> = [
  ['policy', 'replace'], ['summary', 'replace'], ['summary', 'replace-restore'],
  ['policy', 'same-store'], ['summary', 'same-store'], ['save', 'abort'], ['save', 'replace'],
];
const preparation: ReadonlyArray<readonly [Stage, Action]> = [
  ['prepare', 'abort'], ['prepare', 'replace'], ['prepare', 'replace-restore'],
  ['prepare', 'settings'], ['prepare', 'window'], ['prepare', 'callback'], ['prepare', 'same-store'],
];

for (const mode of ['native', 'structural'] as const) describe(`automatic compaction captured ${mode} store`, () => {
  it.each([...common, ...(mode === 'structural' ? preparation : [])])(
    'revalidates %s / %s before save without rolling back an admitted write', async (stage, action) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-compaction-store-')); roots.push(root);
      const disk = new JsonlSessionStore(path.join(root, 'source')), replacement = new JsonlSessionStore(path.join(root, 'replacement'));
      const entered = latch(), finish = latch(); let armed = false;
      const save = disk.saveSession.bind(disk), writes = vi.fn(async (...args: Parameters<typeof save>) => {
        if (armed && stage === 'save') { entered.release(); await finish.promise; }
        await save(...args);
      });
      disk.saveSession = writes;
      // Delegate the existing public store contract; no additional adapter capability is required.
      class BorrowedStore extends JsonlSessionStore {
        constructor() { super(undefined, false); }
        override setRedaction(...args: Parameters<JsonlSessionStore['setRedaction']>): void { disk.setRedaction(...args); }
        override listSessionIds() { return disk.listSessionIds(); }
        override loadSession(id: string) { return disk.loadSession(id); }
        override saveSession(...args: Parameters<JsonlSessionStore['saveSession']>) { return disk.saveSession(...args); }
        override async getRawEntries(id: string) {
          if (armed && stage === 'prepare') { entered.release(); await finish.promise; }
          return disk.getRawEntries(id);
        }
        override deleteSession(id: string) { return disk.deleteSession(id); }
      }
      const store = mode === 'native' ? disk : new BorrowedStore(), manager = new SessionManager({ store });
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 60 });
      const session = await manager.create({ autoCompaction: false });
      for (let index = 0; index < 6; index++) await manager.addMessage(session.id, { role: 'user', content: `Seed ${index} ${'x'.repeat(80)}` });
      await manager.update(session.id, { autoCompaction: true });
      const before = await readFile(disk.getSessionFilePath(session.id)!), snapshot = structuredClone(session), raw = await disk.getRawEntries(session.id);
      const events: Array<{ phase: string; cancelled?: boolean; error?: string }> = [];
      manager.on('compaction:start', () => { events.push({ phase: 'start' }); });
      manager.on('compaction:end', () => { events.push({ phase: 'end' }); });
      manager.on('compaction:error', event => { events.push({ phase: 'error', cancelled: event.cancelled, error: event.error }); });
      const summarize = vi.fn(async () => {
        if (stage === 'summary') { entered.release(); await finish.promise; }
        return { summary: 'Captured summary', provider: 'mock', model: 'summary-model', usage: { totalTokens: 3 } };
      });
      manager.setAutoCompactionCallback(summarize);
      if (stage === 'policy') manager.setAutoCompactionPolicy(async () => { entered.release(); await finish.promise; return true; });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      writes.mockClear(); armed = true;
      const controller = new AbortController(), pending = manager.checkAndTriggerCompaction(session.id, controller.signal);
      try {
        await entered.promise;
        if (action === 'abort') controller.abort('private abort reason');
        if (action === 'replace' || action === 'replace-restore') {
          manager.setStore(replacement);
          if (action === 'replace-restore') manager.setStore(store);
        }
        if (action === 'same-store') manager.setStore(store);
        if (action === 'settings') manager.setCompactionSettings({ enabled: false });
        if (action === 'window') manager.setCompactionContextWindow(128_000);
        if (action === 'callback') manager.setAutoCompactionCallback(async () => 'Never admitted');
        finish.release();
        const admitted = stage === 'save' || action === 'same-store';
        expect(await pending).toBe(admitted);
        expect(await replacement.listSessionIds()).toEqual([]);
        expect(writes).toHaveBeenCalledTimes(admitted ? 1 : 0);
        expect(events.filter(event => event.phase === 'end')).toHaveLength(admitted ? 1 : 0);
        if (admitted) {
          const entries = await disk.getRawEntries(session.id), compactions = entries.filter(entry => entry.type === 'compaction');
          expect(compactions).toHaveLength(1);
          expect(compactions[0]).toMatchObject({ summary: 'Captured summary', provider: 'mock', model: 'summary-model', usage: { totalTokens: 3 } });
          expect(entries.filter(entry => entry.type === 'message')).toHaveLength(6);
          expect((await disk.loadSession(session.id))?.activeLeafId).toBe(session.activeLeafId);
          expect(session.activeLeafId).not.toBe(snapshot.activeLeafId);
          expect(manager.getEffectiveContext(session.id).some(entry => 'content' in entry && entry.content.includes('Captured summary'))).toBe(true);
          expect(errors).not.toHaveBeenCalled();
        } else {
          expect(session).toEqual(snapshot);
          expect(await readFile(disk.getSessionFilePath(session.id)!)).toEqual(before);
          expect(await disk.getRawEntries(session.id)).toEqual(raw);
          if (stage === 'policy') { expect(events).toEqual([]); expect(summarize).not.toHaveBeenCalled(); }
          else expect(events).toEqual([{ phase: 'start' }, { phase: 'error', cancelled: action === 'abort',
            error: action === 'abort' ? 'Compaction cancelled' : 'Compaction context or policy changed.' }]);
        }
      } finally { finish.release(); await pending; }
    },
  );
});
