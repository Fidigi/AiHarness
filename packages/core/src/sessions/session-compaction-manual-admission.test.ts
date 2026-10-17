import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager, type SessionCompactionOptions } from './session-manager.js';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const roots: string[] = [];
afterEach(async context => {
  vi.restoreAllMocks(); const completed = roots.splice(0);
  if (context.task.result?.state === 'fail') console.error('Retained manual compaction roots:', completed);
  else await Promise.all(completed.map(root => rm(root, { recursive: true, force: true })));
});
type Mode = 'memory' | 'native' | 'structural';
async function fixture(mode: Mode, stage: 'prepare' | 'save' = 'save') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-manual-compaction-admission-')); roots.push(root);
  const disk = new JsonlSessionStore(path.join(root, 'source')), replacement = new JsonlSessionStore(path.join(root, 'replacement'));
  const entered = latch(), finish = latch(); let armed = false;
  const writes: Buffer[] = [], save = disk.saveSession.bind(disk);
  disk.saveSession = async (...args) => {
    if (armed && stage === 'save') { armed = false; entered.release(); await finish.promise; }
    await save(...args); writes.push(await readFile(disk.getSessionFilePath(args[0].id)!));
  };
  class BorrowedStore extends JsonlSessionStore {
    constructor() { super(undefined, false); }
    override setRedaction(...args: Parameters<JsonlSessionStore['setRedaction']>): void { disk.setRedaction(...args); }
    override listSessionIds() { return disk.listSessionIds(); }
    override loadSession(id: string) { return disk.loadSession(id); }
    override saveSession(...args: Parameters<JsonlSessionStore['saveSession']>) { return disk.saveSession(...args); }
    override async getRawEntries(id: string) {
      if (armed && stage === 'prepare') { armed = false; entered.release(); await finish.promise; }
      return disk.getRawEntries(id);
    }
    override deleteSession(id: string) { return disk.deleteSession(id); }
  }
  const store = mode === 'native' ? disk : new BorrowedStore(), manager = new SessionManager(mode === 'memory' ? {} : { store });
  const session = await manager.create({ autoCompaction: false });
  for (let index = 0; index < 6; index++) await manager.addMessage(session.id, { role: index % 2 ? 'assistant' : 'user', content: `Seed ${index}` });
  writes.length = 0;
  const publish = (options: SessionCompactionOptions = {}) => manager.applyCompaction(session.id, 'Owned manual summary', session.messages[4]!.id,
    { provider: 'mock', model: 'summary-model', usage: { totalTokens: 3 } }, options);
  const bytes = () => readFile(disk.getSessionFilePath(session.id)!);
  return { manager, session, store, disk, replacement, publish, bytes, writes, entered, finish, arm: () => { armed = true; } };
}
const observe = (run: Promise<void>) => run.then(() => ({ success: true, error: undefined as unknown }), error => ({ success: false, error: error as unknown }));
async function expectApplied(f: Awaited<ReturnType<typeof fixture>>, mode: Mode) {
  const raw = await f.manager.getRawEntries(f.session.id), compactions = raw.filter(entry => entry.type === 'compaction');
  expect(compactions).toHaveLength(1); expect(compactions[0]).toMatchObject({ summary: 'Owned manual summary', provider: 'mock', model: 'summary-model', usage: { totalTokens: 3 } });
  expect(raw.filter(entry => entry.type === 'message')).toHaveLength(6);
  expect(f.session.messages).toHaveLength(2); expect(f.manager.getEffectiveContext(f.session.id).map(entry => 'content' in entry ? entry.content : '')).toContain('[Context Summary] Owned manual summary');
  if (mode !== 'memory') expect((await f.disk.loadSession(f.session.id))?.activeLeafId).toBe(f.session.activeLeafId);
  expect(await f.replacement.listSessionIds()).toEqual([]);
}

for (const mode of ['memory', 'native', 'structural'] as const) describe(`explicit compaction lifetime (${mode})`, () => {
  it('withdraws a pre-aborted publication without leaking its reason or touching context/history', async () => {
    const f = await fixture(mode), controller = new AbortController(), snapshot = structuredClone(f.session), raw = await f.manager.getRawEntries(f.session.id);
    const before = mode === 'memory' ? undefined : await f.bytes(); controller.abort('PRIVATE_ABORT_REASON');
    await expect(f.publish({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: 'Compaction cancelled' });
    expect(f.session).toEqual(snapshot); expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw); expect(f.writes).toHaveLength(0);
    if (before) expect(await f.bytes()).toEqual(before);
  });
  for (const captured of [false, true]) it.each(['id-value', 'id-getter-same', 'id-getter-sibling'] as const)(
    `withdraws canonical identity substitution %s before queue admission (captured=${captured})`, async action => {
      const f = await fixture(mode), id = f.session.id, boundary = f.session.messages[4]!.id, leaf = f.session.activeLeafId;
      const sibling = await f.manager.create({ title: 'Sibling stays owned', autoCompaction: false });
      await f.manager.addMessage(sibling.id, { role: 'user', content: 'SIBLING_STAYS_OWNED' });
      const before = await f.manager.getRawEntries(id), siblingBefore = await f.manager.getRawEntries(sibling.id), messages = structuredClone(f.session.messages);
      const bytes = mode === 'memory' ? undefined : await readFile(f.disk.getSessionFilePath(id)!);
      const siblingBytes = mode === 'memory' ? undefined : await readFile(f.disk.getSessionFilePath(sibling.id)!);
      const source = captured ? f.manager.captureCompactionSource(id)! : undefined, getter = vi.fn(() => action === 'id-getter-same' ? id : sibling.id);
      f.writes.length = 0;
      const pending = f.manager.applyCompaction(id, 'Never redirected', boundary, {}, { source });
      if (action === 'id-value') f.session.id = sibling.id;
      else Object.defineProperty(f.session, 'id', { configurable: true, enumerable: true, get: getter });
      await expect(pending).rejects.toThrow('Compaction context or policy changed.');
      expect(getter).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
      expect(f.session.messages).toEqual(messages); expect(f.session.activeLeafId).toBe(leaf); expect(f.session.metadata?.compactionSummary).toBeUndefined();
      expect(await f.manager.getRawEntries(id)).toEqual(before); expect(await f.manager.getRawEntries(sibling.id)).toEqual(siblingBefore);
      if (bytes) expect(await readFile(f.disk.getSessionFilePath(id)!)).toEqual(bytes);
      if (siblingBytes) expect(await readFile(f.disk.getSessionFilePath(sibling.id)!)).toEqual(siblingBytes);
      expect(() => f.manager.captureCompactionSource(id)).toThrow('Compaction context or policy changed.');
      expect(getter).not.toHaveBeenCalled(); expect(await f.replacement.listSessionIds()).toEqual([]);
    });
  for (const kind of ['custom', 'custom-message'] as const) it.each([false, true])(`conserves valid private ${kind} JSON with captured source=%s`, async captured => {
    const f = await fixture(mode), data = { nested: [{ value: 'PRIVATE_STATE_JSON' }] };
    if (kind === 'custom') await f.manager.appendCustomEntry(f.session.id, 'fixture:private-json', data);
    else await f.manager.appendCustomMessage(f.session.id, 'fixture:private-json', 'Visible custom content', { display: false, details: data });
    const raw = await f.manager.getRawEntries(f.session.id), source = captured ? f.manager.captureCompactionSource(f.session.id)! : undefined;
    await f.publish({ source }); await expectApplied(f, mode);
    const privateEntries = (entries: typeof raw) => entries.filter(entry => entry.type === 'custom' || entry.type === 'custom_message');
    expect(privateEntries(await f.manager.getRawEntries(f.session.id))).toEqual(privateEntries(raw));
    expect(JSON.stringify(f.manager.getEffectiveContext(f.session.id))).not.toContain('PRIVATE_STATE_JSON');
  });
  it('reads the native live abort state without evaluating an own aborted accessor', async () => {
    const f = await fixture(mode), controller = new AbortController(), accessor = vi.fn(() => { throw new Error('PRIVATE_ACCESSOR'); });
    Object.defineProperty(controller.signal, 'aborted', { get: accessor }); controller.abort('PRIVATE_REASON');
    await expect(f.publish({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: 'Compaction cancelled' });
    expect(accessor).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
  });
  it('preserves explicit caller-summary behavior and durable provenance without automatic authority', async () => {
    const f = await fixture(mode); f.manager.setCompactionSettings({ enabled: false });
    const callback = vi.fn(async () => 'No implicit generation'); f.manager.setAutoCompactionCallback(callback);
    await f.publish({ signal: new AbortController().signal }); expect(callback).not.toHaveBeenCalled(); await expectApplied(f, mode);
  });
});

for (const mode of ['native', 'structural'] as const) describe(`explicit compaction queued ${mode} store`, () => {
  it.each(['abort', 'replace', 'replace-restore', 'branch', 'title', 'same-store', 'settings', 'captured-options'] as const)(
    'rechecks %s after an earlier admitted metadata write', async action => {
      const f = await fixture(mode), controller = new AbortController(), other = new AbortController();
      f.arm(); const mutation = f.manager.update(f.session.id, { title: 'Metadata admitted first', ...(action === 'branch' ? { activeLeafId: f.session.messages[3]!.id } : {}) });
      await f.entered.promise;
      const options = { signal: controller.signal }, pending = observe(f.publish(options));
      if (action === 'abort') controller.abort('PRIVATE_REASON');
      if (action === 'replace' || action === 'replace-restore') f.manager.setStore(f.replacement);
      if (action === 'replace-restore' || action === 'same-store') f.manager.setStore(f.store);
      if (action === 'settings') f.manager.setCompactionSettings({ enabled: false });
      if (action === 'captured-options') { options.signal = other.signal; other.abort('NOT_ADMITTED'); }
      f.finish.release(); await mutation; const result = await pending;
      const rejected = ['abort', 'replace', 'replace-restore', 'branch'].includes(action);
      expect(result.success).toBe(!rejected);
      if (rejected) {
        expect(result.error).toMatchObject({ message: action === 'abort' ? 'Compaction cancelled' : 'Compaction context or policy changed.' });
        expect(f.writes).toHaveLength(1); expect(await f.bytes()).toEqual(f.writes[0]);
        expect((await f.disk.getRawEntries(f.session.id)).filter(entry => entry.type === 'compaction')).toEqual([]);
        expect(f.session.metadata?.compactionSummary).toBeUndefined(); expect(f.session.title).toBe('Metadata admitted first');
        expect(await f.replacement.listSessionIds()).toEqual([]);
      } else { expect(f.writes).toHaveLength(2); await expectApplied(f, mode); }
    });
  it.each(['abort', 'replace', 'identity'] as const)('allows an already-started save to finish after %s', async action => {
    const f = await fixture(mode), controller = new AbortController(), id = f.session.id;
    const sibling = action === 'identity' ? await f.manager.create({ title: 'Admitted sibling stays owned' }) : undefined;
    const siblingBytes = sibling ? await readFile(f.disk.getSessionFilePath(sibling.id)!) : undefined;
    f.writes.length = 0; f.arm(); const pending = observe(f.publish({ signal: controller.signal }));
    await f.entered.promise;
    if (action === 'abort') controller.abort(); else if (action === 'replace') f.manager.setStore(f.replacement); else f.session.id = sibling!.id;
    f.finish.release(); expect((await pending).success).toBe(true); expect(f.writes).toHaveLength(1); expect(f.session.id).toBe(id);
    const reloaded = await f.disk.loadSession(id); expect(reloaded?.metadata?.compactionSummary).toBe('Owned manual summary');
    expect(reloaded?.activeLeafId).toBe(f.session.activeLeafId); expect(await f.replacement.listSessionIds()).toEqual([]);
    if (sibling) expect(await readFile(f.disk.getSessionFilePath(sibling.id)!)).toEqual(siblingBytes);
  });
});

describe('explicit compaction structural preparation', () => {
  it.each(['abort', 'replace', 'replace-restore', 'same-store'] as const)('checks %s immediately before the captured save', async action => {
    const f = await fixture('structural', 'prepare'), controller = new AbortController(), before = await f.bytes(), raw = await f.manager.getRawEntries(f.session.id), snapshot = structuredClone(f.session);
    f.arm(); const pending = observe(f.publish({ signal: controller.signal })); await f.entered.promise;
    if (action === 'abort') controller.abort('PRIVATE_REASON');
    if (action === 'replace' || action === 'replace-restore') f.manager.setStore(f.replacement);
    if (action === 'replace-restore' || action === 'same-store') f.manager.setStore(f.store);
    f.finish.release(); const result = await pending; expect(result.success).toBe(action === 'same-store');
    if (action === 'same-store') await expectApplied(f, 'structural');
    else { expect(await f.bytes()).toEqual(before); expect(await f.disk.getRawEntries(f.session.id)).toEqual(raw); expect(f.session).toEqual(snapshot); expect(f.writes).toHaveLength(0); expect(await f.replacement.listSessionIds()).toEqual([]); }
  });
});

for (const mode of ['memory', 'native', 'structural'] as const) describe(`captured compaction source (${mode})`, () => {
  it('keeps only frozen host identities public, rejects copies and admits a source only once', async () => {
    const f = await fixture(mode), boundary = f.session.messages[4]!.id, source = f.manager.captureCompactionSource(f.session.id)!;
    expect(Object.isFrozen(source)).toBe(true); expect(Object.keys(source).sort()).toEqual(['entryId', 'sourceSessionId']);
    expect(source).toEqual({ sourceSessionId: f.session.id, entryId: f.session.activeLeafId });
    expect(f.manager.captureCompactionSource('missing')).toBeNull();
    await expect(f.manager.applyCompaction('missing', 'Legacy missing-session no-op', boundary)).resolves.toBeUndefined();
    await expect(f.publish({ source: structuredClone(source) })).rejects.toThrow('Compaction source is invalid.');
    await f.publish({ source }); await expectApplied(f, mode);
    await expect(f.manager.applyCompaction(f.session.id, 'Never reused', boundary, {}, { source })).rejects.toThrow('Compaction context or policy changed.');
    expect((await f.manager.getRawEntries(f.session.id)).filter(entry => entry.type === 'compaction')).toHaveLength(1);
  });
  it.each(['journal', 'legacy'] as const)('refuses a changed %s even when its selected leaf is restored', async action => {
    const f = await fixture(mode), boundary = f.session.messages[4]!.id, leaf = f.session.activeLeafId, source = f.manager.captureCompactionSource(f.session.id)!;
    if (action === 'journal') {
      await f.manager.appendCustomEntry(f.session.id, 'fixture:private', { secret: 'PRIVATE_STATE' });
      await f.manager.update(f.session.id, { activeLeafId: leaf });
    } else await f.manager.update(f.session.id, { metadata: { ...f.session.metadata, compactionSummary: 'Changed legacy context' } });
    expect(f.session.activeLeafId).toBe(leaf);
    const before = mode === 'memory' ? undefined : await f.bytes(), raw = await f.manager.getRawEntries(f.session.id), snapshot = structuredClone(f.session);
    await expect(f.manager.applyCompaction(f.session.id, 'Stale source', boundary, {}, { source })).rejects.toThrow('Compaction context or policy changed.');
    expect(f.session).toEqual(snapshot); expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw);
    if (before) expect(await f.bytes()).toEqual(before);
  });
  it.each(['capture', 'publish', 'captured'] as const)('rejects a malformed legacy prefix during %s without evaluating nested accessors', async action => {
    const f = await fixture(mode), getter = vi.fn(() => 'PRIVATE_LEGACY_DATA'), raw = await f.manager.getRawEntries(f.session.id), before = mode === 'memory' ? undefined : await f.bytes();
    const source = action === 'captured' ? f.manager.captureCompactionSource(f.session.id)! : undefined;
    const prefix = Object.defineProperty({ anchorEntryId: f.session.messages[0]!.id, timestamp: 0 }, 'summary', { get: getter, enumerable: true });
    f.session.metadata = { ...f.session.metadata, aiHarnessLegacyCompactionPrefix: prefix };
    if (action === 'capture') expect(() => f.manager.captureCompactionSource(f.session.id)).toThrow('Legacy compaction context is invalid.');
    else await expect(f.publish({ source })).rejects.toThrow('Legacy compaction context is invalid.');
    expect(getter).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0); expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw);
    if (before) expect(await f.bytes()).toEqual(before);
  });
  it.each((['compactionSummary', 'lastCompacted', 'compactionEntryId'] as const).flatMap(key =>
    (['before-capture', 'after-capture'] as const).map(phase => [key, phase] as const)))('does not evaluate ignored nonstring %s (%s)', async (key, phase) => {
    const f = await fixture(mode), toJSON = vi.fn(() => 'PRIVATE_LEGACY_DATA');
    const captured = phase === 'after-capture' ? f.manager.captureCompactionSource(f.session.id)! : undefined;
    f.session.metadata = { ...f.session.metadata, [key]: { toJSON } };
    const source = captured ?? f.manager.captureCompactionSource(f.session.id)!;
    await f.publish({ source }); expect(toJSON).not.toHaveBeenCalled(); await expectApplied(f, mode);
  });
  it('accepts a title-only publication after capturing generation inputs', async () => {
    const f = await fixture(mode), source = f.manager.captureCompactionSource(f.session.id)!;
    await f.manager.update(f.session.id, { title: 'New title' }); await f.publish({ source });
    expect(f.session.title).toBe('New title'); await expectApplied(f, mode);
  });
});
for (const mode of ['native', 'structural'] as const) describe(`captured ${mode} compaction store generation`, () => {
  it.each(['replace', 'replace-restore', 'same-store'] as const)('revalidates %s from before summary generation', async action => {
    const f = await fixture(mode), source = f.manager.captureCompactionSource(f.session.id)!, before = await f.bytes(), snapshot = structuredClone(f.session), raw = await f.disk.getRawEntries(f.session.id);
    if (action !== 'same-store') f.manager.setStore(f.replacement);
    if (action !== 'replace') f.manager.setStore(f.store);
    const result = await observe(f.publish({ source })); expect(result.success).toBe(action === 'same-store');
    if (action === 'same-store') await expectApplied(f, mode);
    else { expect(result.error).toMatchObject({ message: 'Compaction context or policy changed.' }); expect(await f.bytes()).toEqual(before); expect(await f.disk.getRawEntries(f.session.id)).toEqual(raw); expect(f.session).toEqual(snapshot); expect(await f.replacement.listSessionIds()).toEqual([]); }
  });
});
describe('captured compaction source ownership', () => {
  it('withdraws a genuinely memory-only source on store replacement', async () => {
    const f = await fixture('memory'), source = f.manager.captureCompactionSource(f.session.id)!, snapshot = structuredClone(f.session);
    f.manager.setStore(f.replacement);
    await expect(f.publish({ source })).rejects.toThrow('Compaction context or policy changed.');
    expect(f.session).toEqual(snapshot); expect(await f.replacement.listSessionIds()).toEqual([]);
  });
  it('does not borrow another manager lease or evaluate a fabricated source accessor', async () => {
    const f = await fixture('memory'), source = f.manager.captureCompactionSource(f.session.id)!, other = new SessionManager();
    await other.create({ id: f.session.id });
    await expect(other.applyCompaction(f.session.id, 'Wrong owner', f.session.messages[4]!.id, {}, { source })).rejects.toThrow('Compaction source is invalid.');
    const accessor = vi.fn(() => f.session.id), fabricated = Object.defineProperty({}, 'sourceSessionId', { get: accessor });
    await expect(f.publish({ source: fabricated as typeof source })).rejects.toThrow('Compaction source is invalid.'); expect(accessor).not.toHaveBeenCalled();
    expect(f.session.metadata?.compactionSummary).toBeUndefined();
  });
});

describe('explicit compaction own options', () => {
  it.each([null, [], { unknown: true }, { signal: null }, { signal: {} }, { signal: Object.create(AbortSignal.prototype) }, { [Symbol('extra')]: true }].map(options => ({ options })))(
    'rejects invalid options before persistence', async ({ options }) => {
      const f = await fixture('memory'), snapshot = structuredClone(f.session), raw = await f.manager.getRawEntries(f.session.id);
      await expect(f.publish(options as SessionCompactionOptions)).rejects.toThrow('Compaction options are invalid.');
      expect(f.session).toEqual(snapshot); expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw);
    });
  it('does not evaluate a signal accessor', async () => {
    const f = await fixture('memory'), accessor = vi.fn(() => new AbortController().signal);
    await expect(f.publish(Object.defineProperty({}, 'signal', { get: accessor }))).rejects.toThrow('Compaction options are invalid.');
    expect(accessor).not.toHaveBeenCalled(); expect(f.session.metadata?.compactionSummary).toBeUndefined();
  });
});
