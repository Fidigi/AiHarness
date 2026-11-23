import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { JsonlSessionStore, SessionManager, TokenEstimator, prepareCompactionContext } from '../index.js';
import type { CompactionEntry, SessionEntry } from './session-manager.js';
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const modes = ['memory','native','structural'] as const;
const kinds = ['valid','exact-output-bound','over-output-bound','over-input-bound','summary-accessor','usage-accessor','kept-id-mutation','kept-content-accessor','ignored-unknown-accessor','signal-shadow','journal-aba','source-id-accessor'] as const;
describe.each(modes)('automatic generated compaction authority (%s)', mode => {
 it.each(kinds)('%s', async kind => {
  const root = await mkdtemp(path.join(tmpdir(), 'auto-compaction-generation-test-')); let passed = false;
  try {
  const disk = new JsonlSessionStore(path.join(root, mode, kind));
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
  const manager = new SessionManager({ store }), session = await manager.create({ autoCompaction: false }), sourceId = session.id;
  manager.setCompactionSettings({ enabled: true, reserveTokens: 100, keepRecentTokens: 2000 }); manager.setCompactionContextWindow(10000);
  for (let index = 0; index < (kind === 'over-input-bound' ? 50 : 6); index++) await manager.addMessage(sourceId, {
   role: index % 2 ? 'assistant' : 'user', content: kind === 'over-input-bound' ? 'INPUT_BOUND '.repeat(4200) : `Seed ${index} ${'x'.repeat(10000)}`,
  }, { skipAutoCompaction: true });
  await manager.update(sourceId, { autoCompaction: true });
  const sibling = await manager.create({ title: 'Sibling', autoCompaction: false }), siblingId = sibling.id;
  await manager.addMessage(siblingId, { role: 'user', content: 'SIBLING_MUST_SURVIVE' }, { skipAutoCompaction: true });
  const target = manager.requestCompaction(sourceId); assert.ok(target); const expectedBoundary = target.keptEntries.find(entry => entry.type === 'message')!.id;
  const sourcePrefixBytes = Buffer.byteLength(JSON.stringify(target.toCompact)); if (kind === 'over-input-bound') assert.ok(sourcePrefixBytes > 2000000);
  const summary = kind === 'exact-output-bound' ? 'x'.repeat(16384) : kind === 'over-output-bound' ? 'x'.repeat(16385) : 'GENERATION_BOUND_SUMMARY';
  const prepared = prepareCompactionContext(manager, sourceId, 'threshold'); assert.ok(prepared); assert.equal(prepared.firstKeptEntryId, expectedBoundary);
  const expectedTokensAfter = TokenEstimator.estimateTokens(summary) + prepared.keptTokens;
  const before = await manager.getRawEntries(sourceId), beforeSibling = await manager.getRawEntries(siblingId), leaf = session.activeLeafId;
  const nativeFile = (id: string): string => { const file = disk.getSessionFilePath(id); assert.ok(file); return file; };
  const sourceBytes = store ? await readFile(nativeFile(sourceId)) : undefined;
  const siblingBytes = store ? await readFile(nativeFile(siblingId)) : undefined;
  const controller = new AbortController(), events: Array<{ phase: string; [key: string]: unknown }> = []; let calls = 0, getterReads = 0, ignoredReads = 0, mutableArrays = true, signalIdentity = true;
  for (const phase of ['start','end','error'] as const) manager.on(`compaction:${phase}`, event => { events.push({ phase, ...event }); });
  manager.setAutoCompactionCallback(async (_id, toCompact, kept, signal) => {
   assert.ok(signal); calls++; mutableArrays = Array.isArray(toCompact) && Array.isArray(kept) && !Object.isFrozen(toCompact) && !Object.isFrozen(kept); signalIdentity = signal === controller.signal;
   if (kind === 'kept-id-mutation') kept.find(entry => entry.type === 'message')!.id = toCompact.find(entry => entry.type === 'message')!.id;
   if (kind === 'kept-content-accessor') Object.defineProperty(kept.find(entry => entry.type === 'message')!, 'content', { enumerable: true, configurable: true, get() { getterReads++; return 'UNAUTHORIZED_REPLACEMENT_ESTIMATE'; } });
   if (kind === 'signal-shadow') { Object.defineProperty(signal, 'aborted', { configurable: true, get() { getterReads++; return false; } }); controller.abort('PRIVATE_ABORT_REASON'); }
   if (kind === 'source-id-accessor') Object.defineProperty(session, 'id', { enumerable: true, configurable: true, get() { getterReads++; return siblingId; }, set() { return; } });
   if (kind === 'journal-aba') { await manager.appendCustomEntry(sourceId, 'fixture:private', { privateState: 'PRIVATE_JOURNAL_MUTATION' }); await manager.update(sourceId, { activeLeafId: leaf }); }
   const result = { summary, provider: 'mock', model: 'mock-model', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 } };
   if (kind === 'summary-accessor') Object.defineProperty(result, 'summary', { enumerable: true, get() { getterReads++; return summary; } });
   if (kind === 'usage-accessor') Object.defineProperty(result, 'usage', { enumerable: true, get() { getterReads++; return { inputTokens: 2, outputTokens: 1, totalTokens: 3 }; } });
   if (kind === 'ignored-unknown-accessor') { Object.defineProperty(result, 'legacy', { enumerable: true, get() { ignoredReads++; return 'UNAUTHORIZED_LEGACY_VALUE'; } }); Object.defineProperty(result, 'toJSON', { enumerable: true, value: () => { ignoredReads++; return result; } }); }
   return result;
  });
  let applied: boolean | undefined, thrown: string | undefined; try { applied = await manager.checkAndTriggerCompaction(sourceId, controller.signal); } catch (error) { thrown = String(error); }
  const readsDuringOperation = getterReads;
  if (kind === 'source-id-accessor') Object.defineProperty(session, 'id', { enumerable: true, configurable: true, writable: true, value: sourceId });
  if (kind === 'signal-shadow') Reflect.deleteProperty(controller.signal, 'aborted');
  let readRefused = false;
  const readEntries = (id: string): Promise<SessionEntry[]> => manager.getRawEntries(id).catch((): SessionEntry[] => { readRefused = true; return []; });
  const after = await readEntries(sourceId), afterSibling = await readEntries(siblingId), compactions: CompactionEntry[] = after.filter((entry): entry is CompactionEntry => entry.type === 'compaction');
  const valid = ['valid','exact-output-bound','kept-id-mutation','kept-content-accessor','ignored-unknown-accessor'].includes(kind);
  const record = { node: process.versions.node, mode, kind, sourcePrefixBytes, outputBytes: Buffer.byteLength(summary), calls, applied, thrown,
   getterReads: readsDuringOperation, ignoredReads, readRefused, mutableArrays, signalIdentity, signalAborted: nativeAborted.call(controller.signal) as boolean,
   published: compactions.length, completed: events.filter(event => event.phase === 'end').length, expectedBoundary, actualBoundary: compactions[0]?.firstKeptEntryId,
   expectedTokensAfter, actualTokensAfter: compactions[0]?.tokensAfter,
   rawConserved: before.every(entry => JSON.stringify(after.find(next => next.id === entry.id)) === JSON.stringify(entry)),
   sourceUnchanged: JSON.stringify(before) === JSON.stringify(after) && (!store || sourceBytes!.equals(await readFile(nativeFile(sourceId)))),
   siblingUnchanged: JSON.stringify(beforeSibling) === JSON.stringify(afterSibling) && (!store || siblingBytes!.equals(await readFile(nativeFile(siblingId)))),
   ok: false,
  };
  record.ok = !thrown && !readRefused && record.rawConserved && record.siblingUnchanged && record.getterReads === 0 && record.ignoredReads === 0 && record.mutableArrays && record.signalIdentity &&
   (valid ? record.calls === 1 && applied === true && record.published === 1 && record.completed === 1 && record.actualBoundary === expectedBoundary && record.actualTokensAfter === expectedTokensAfter :
    applied === false && record.published === 0 && record.completed === 0 && (kind === 'journal-aba' || record.sourceUnchanged) && record.calls === (kind === 'over-input-bound' ? 0 : 1));
  await writeFile(path.join(root, 'observations.json'), JSON.stringify({ record, before, after, beforeSibling, afterSibling, events }, null, 2));
  assert.equal(record.ok, true, JSON.stringify(record)); passed = true;
  } finally { if (passed) await rm(root, { recursive: true, force: true }); else console.error('RETAINED_COMPACTION_GENERATION_ROOT', root); }
 });
});
