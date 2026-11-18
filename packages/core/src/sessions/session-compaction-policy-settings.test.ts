import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore, SessionManager } from './session-manager.js';
import type { CompactionSettings } from './session-manager.js';

const cases = ['initial-enabled', 'initial-reserveTokens', 'initial-keepRecentTokens',
  'policy-enabled', 'policy-reserveTokens', 'policy-keepRecentTokens',
  'initial-legacy', 'policy-legacy', 'same-values-title'] as const;

describe.each(['memory', 'native', 'structural'] as const)('owned automatic policy settings (%s)', mode => {
  it.each(cases)('%s', async kind => {
    const root = await mkdtemp(path.join(tmpdir(), 'compaction-policy-settings-')); let passed = false;
    try {
      const disk = new JsonlSessionStore(root);
      class BorrowedStore extends JsonlSessionStore {
        constructor() { super(undefined, false); }
        setRedaction(...args: Parameters<JsonlSessionStore['setRedaction']>) { disk.setRedaction(...args); }
        listSessionIds() { return disk.listSessionIds(); }
        loadSession(id: string) { return disk.loadSession(id); }
        saveSession(...args: Parameters<JsonlSessionStore['saveSession']>) { return disk.saveSession(...args); }
        getRawEntries(id: string) { return disk.getRawEntries(id); }
        deleteSession(id: string) { return disk.deleteSession(id); }
      }
      const store = mode === 'memory' ? undefined : mode === 'native' ? disk : new BorrowedStore();
      const manager = new SessionManager({ store });
      manager.setCompactionSettings({ enabled: false, reserveTokens: 200, keepRecentTokens: 1 });
      manager.setCompactionContextWindow(256);
      const session = await manager.create({ autoCompaction: true, activeLeafId: 'initial-3',
        messages: (['user', 'assistant', 'user', 'assistant'] as const).map((role, index) => ({
          id: `initial-${index}`, role, content: 'x'.repeat(100), timestamp: new Date(index),
          ...(index ? { parentMessageId: `initial-${index - 1}` } : {}),
        })),
      });
      manager.setCompactionSettings({ enabled: true });
      const summarize = vi.fn(async () => 'TINY'), getter = vi.fn();
      const started = vi.fn(), completed = vi.fn(), failed = vi.fn();
      manager.setAutoCompactionCallback(summarize);
      manager.on('compaction:start', started); manager.on('compaction:end', completed); manager.on('compaction:error', failed);
      const before = await manager.getRawEntries(session.id), file = store ? disk.getSessionFilePath(session.id) : undefined;
      const bytes = file ? await readFile(file) : undefined;
      const alter = (): void => {
        if (kind === 'same-values-title') { manager.setCompactionSettings({ enabled: true, reserveTokens: 200, keepRecentTokens: 1 }); return; }
        const key = kind.slice(kind.indexOf('-') + 1);
        const settings = manager.getCompactionSettings(), value = key === 'legacy' ? 'IGNORED' : settings[key as keyof CompactionSettings];
        Object.defineProperty(settings, key, { configurable: true, enumerable: true, get: () => { getter(); return value; } });
      };
      if (kind.startsWith('initial-')) alter();
      else manager.setAutoCompactionPolicy(async () => {
        alter();
        if (kind === 'same-values-title') await manager.update(session.id, { title: 'CURRENT_TITLE' });
        return true;
      });
      const applied = await manager.checkAndTriggerCompaction(session.id), after = await manager.getRawEntries(session.id);
      const valid = kind.endsWith('legacy') || kind === 'same-values-title';
      await writeFile(path.join(root, 'observations.json'), JSON.stringify({ mode, kind, applied, getterReads: getter.mock.calls.length,
        summaries: summarize.mock.calls.length, started: started.mock.calls.length, completed: completed.mock.calls.length,
        failed: failed.mock.calls.length, before, after }, null, 2));
      expect(getter).not.toHaveBeenCalled(); expect(applied).toBe(valid); expect(failed).not.toHaveBeenCalled();
      expect(summarize).toHaveBeenCalledTimes(valid ? 1 : 0); expect(started).toHaveBeenCalledTimes(valid ? 1 : 0); expect(completed).toHaveBeenCalledTimes(valid ? 1 : 0);
      expect(before.every(entry => JSON.stringify(after.find(next => next.id === entry.id)) === JSON.stringify(entry))).toBe(true);
      expect(after.filter(entry => entry.type === 'compaction')).toHaveLength(valid ? 1 : 0);
      if (!valid) { expect(after).toEqual(before); if (file && bytes) expect(await readFile(file)).toEqual(bytes); }
      if (kind === 'same-values-title') expect(manager.get(session.id)?.title).toBe('CURRENT_TITLE');
      passed = true;
    } finally { if (passed) await rm(root, { recursive: true, force: true }); }
  });
});
