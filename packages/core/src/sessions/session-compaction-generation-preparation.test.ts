import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'vitest';
import { JsonlSessionStore, SessionManager, TokenEstimator, prepareCompactionContext } from '../index.js';
import type { CompactionEntry } from './session-manager.js';

describe.each(['memory', 'native', 'structural'] as const)('automatic preparation failure boundary (%s)', mode => {
  it.each(['initial-source-accessor', 'policy-source-accessor', 'data-toJSON-prefix', 'owned-summary-redaction'] as const)('%s', async kind => {
    const root = await mkdtemp(path.join(tmpdir(), 'automatic-preparation-test-')); let passed = false;
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
      let calls = 0, getterReads = 0, summaryRedactions = 0, completed = 0, started = 0, failedEvents = 0;
      const rawSummary = '   RAW_GENERATED_SUMMARY   ';
      const redactText = (text: string): string => {
        if (text === rawSummary) { summaryRedactions++; return ' first '; }
        if (text.trim() === 'first') { summaryRedactions++; return 'SECOND_REDACTION_MUST_NOT_REPLACE_THE_OWNED_SUMMARY'; }
        return text;
      };
      const manager = new SessionManager({ store, redactText, redactJson: value => value }), session = await manager.create({ autoCompaction: false }), id = session.id;
      manager.setCompactionSettings({ enabled: true, reserveTokens: 100, keepRecentTokens: 2000 }); manager.setCompactionContextWindow(10000);
      for (let i = 0; i < 6; i++) await manager.addMessage(id, { role: i % 2 ? 'assistant' : 'user', content: `Seed ${i} ${'x'.repeat(10000)}`, metadata: kind === 'data-toJSON-prefix' && i === 0 ? { toJSON: 'PUBLIC_DATA_KEY' } : undefined }, { skipAutoCompaction: true });
      await manager.update(id, { autoCompaction: true });
      if (kind === 'policy-source-accessor') await manager.update(id, { metadata: {
        ...session.metadata, compactionSummary: 'PUBLIC_PRIOR_CONTEXT', lastCompacted: new Date(0).toISOString(),
      } });
      const sibling = await manager.create({ autoCompaction: false }), siblingId = sibling.id;
      await manager.addMessage(siblingId, { role: 'user', content: 'SIBLING_HISTORY' }, { skipAutoCompaction: true });
      const before = await manager.getRawEntries(id), siblingBefore = await manager.getRawEntries(siblingId);
      const nativeFile = (sourceId: string): string => { const file = disk.getSessionFilePath(sourceId); assert.ok(file); return file; };
      const sourceBytes = store ? await readFile(nativeFile(id)) : undefined, siblingBytes = store ? await readFile(nativeFile(siblingId)) : undefined;
      manager.on('compaction:end', () => { completed++; });
      manager.on('compaction:start', () => { started++; });
      manager.on('compaction:error', () => { failedEvents++; });
      manager.setAutoCompactionCallback(async () => { calls++; return rawSummary; });
      const prepared = prepareCompactionContext(manager, id, 'threshold'); assert.ok(prepared);
      if (kind === 'data-toJSON-prefix') assert.ok(JSON.stringify(prepared.toCompact).includes('"toJSON":"PUBLIC_DATA_KEY"'));
      await writeFile(path.join(root, 'before.json'), JSON.stringify({ mode, kind, before, siblingBefore, firstKeptEntryId: prepared.firstKeptEntryId, keptTokens: prepared.keptTokens }, null, 2));
      const substituteIdentity = (): void => { Object.defineProperty(session, 'id', { configurable: true, enumerable: true, get: () => { getterReads++; return siblingId; } }); };
      if (kind === 'initial-source-accessor') substituteIdentity();
      if (kind === 'policy-source-accessor') manager.setAutoCompactionPolicy(async () => { substituteIdentity(); return true; });
      let applied: boolean;
      try { applied = await manager.checkAndTriggerCompaction(id); }
      finally { if (kind.endsWith('source-accessor')) Object.defineProperty(session, 'id', { configurable: true, enumerable: true, writable: true, value: id }); }
      const after = await manager.getRawEntries(id), siblingAfter = await manager.getRawEntries(siblingId);
      const entries: CompactionEntry[] = after.filter((entry): entry is CompactionEntry => entry.type === 'compaction');
      await writeFile(path.join(root, 'observations.json'), JSON.stringify({ mode, kind, applied, calls, getterReads, summaryRedactions, completed, started, failedEvents, before, after, siblingBefore, siblingAfter }, null, 2));
      assert.equal(getterReads, 0); assert.deepEqual(siblingAfter, siblingBefore);
      if (store) assert.ok(siblingBytes!.equals(await readFile(nativeFile(siblingId))));
      assert.ok(before.every(entry => JSON.stringify(after.find(next => next.id === entry.id)) === JSON.stringify(entry)));
      if (kind.endsWith('source-accessor')) {
        assert.equal(applied, false); assert.equal(calls, 0); assert.equal(completed, 0); assert.deepEqual(after, before);
        assert.equal(started, 0); assert.equal(failedEvents, 0);
        if (store) assert.ok(sourceBytes!.equals(await readFile(nativeFile(id))));
      } else {
        assert.equal(applied, true); assert.equal(calls, 1); assert.equal(completed, 1); assert.equal(summaryRedactions, 1); assert.equal(started, 1); assert.equal(failedEvents, 0);
        assert.equal(entries.length, 1); assert.equal(entries[0].summary, 'first');
        assert.equal(entries[0].tokensAfter, TokenEstimator.estimateTokens('first') + prepared.keptTokens);
      }
      passed = true;
    } finally { if (passed) await rm(root, { recursive: true, force: true }); else console.error('RETAINED_AUTOMATIC_PREPARATION_ROOT', root); }
  });
});
