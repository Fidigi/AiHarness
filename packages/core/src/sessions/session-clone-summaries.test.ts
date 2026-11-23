import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager, type BranchSummaryEntry } from './session-manager.js';
import type { Session } from '../types/index.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function seed(durable: boolean, running = false) {
  const root = durable ? await mkdtemp(path.join(os.tmpdir(), 'aih-clone-summaries-')) : undefined;
  if (root) roots.push(root);
  const store = root ? new JsonlSessionStore(root) : undefined;
  const manager = new SessionManager({ store });
  const session = await manager.create({ title: 'Source', autoCompaction: false,
    metadata: { custom: { value: 'source' } }, messages: [
      { id: 'question', role: 'user', content: 'Question', timestamp: new Date(1_000) },
    ] });
  await manager.addCommand(session.id, { id: 'before-summary', command: 'before', cwd: '/workspace',
    status: running ? 'running' : 'completed', timestamp: new Date(10_000_000_000_000), output: 'Before' });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000_000_000_010);
  const needed = (await manager.addBranchSummary(session.id, 'Required summary', 'Needed'))!;
  clock.mockRestore();
  await manager.addCommand(session.id, { id: 'after-summary', command: 'after', cwd: '/workspace',
    status: 'completed', timestamp: new Date(10_000_000_000_020), excludedFromContext: true, output: 'Excluded' });
  await manager.addMessage(session.id, { role: 'assistant', content: 'Answer' });
  const answer = session.messages.at(-1)!;
  await manager.addMessage(session.id, { role: 'user', content: 'Later message' });
  const backdated = vi.spyOn(Date, 'now').mockReturnValue(500);
  const later = (await manager.addBranchSummary(session.id, 'Later summary', 'Later'))!;
  backdated.mockRestore();
  await manager.update(session.id, { activeLeafId: 'question' });
  await manager.addBranchSummary(session.id, 'Abandoned summary', 'Abandoned');
  await manager.update(session.id, { activeLeafId: later.id });
  return { manager, store, root, session, answer, needed, later,
    bytes: () => root ? readFile(path.join(root, `${session.id}.jsonl`)) : undefined };
}

async function checkCopy(manager: SessionManager, copy: Session, full: boolean, sourceIds: Set<string>) {
  const raw = (await manager.getRawEntries(copy.id)).filter(entry => entry.type !== 'metadata');
  const summaries = raw.filter((entry): entry is BranchSummaryEntry => entry.type === 'branch_summary');
  expect(summaries.map(entry => entry.branchName).sort()).toEqual(full ? ['Later', 'Needed'] : ['Needed']);
  const needed = summaries.find(entry => entry.branchName === 'Needed')!;
  expect(needed).toMatchObject({ summary: 'Required summary', timestamp: 10_000_000_000_010,
    parentEntryId: copy.commands![0]!.id });
  expect(copy.commands![1]).toMatchObject({ parentEntryId: needed.id, excludedFromContext: true });
  expect(copy.messages[1]!.parentMessageId).toBe(copy.commands![1]!.id);
  expect(copy.messages.map(message => message.content)).toEqual(full
    ? ['Question', 'Answer', 'Later message'] : ['Question', 'Answer']);
  expect(copy.activeLeafId).toBe(full ? summaries.find(entry => entry.branchName === 'Later')!.id : copy.messages[1]!.id);
  const ids = new Set(raw.map(entry => entry.id));
  expect(raw.every(entry => !sourceIds.has(entry.id))).toBe(true);
  for (const entry of raw) {
    const parent = entry.type === 'message' ? entry.parentMessageId : entry.parentEntryId;
    if (parent) expect(ids.has(parent)).toBe(true);
  }
  const projected = await manager.getBranchSummaries(copy.id);
  expect(projected.map(entry => entry.id).sort()).toEqual(summaries.map(entry => entry.id).sort());
  expect(copy.metadata?.branchSummaries).toEqual(expect.arrayContaining(summaries));
  expect(copy.metadata?.branchSummaries).toHaveLength(summaries.length);
}

describe.each([false, true])('clone summary ancestry (durable=%s)', durable => {
  it.each(['full', 'index', 'id'] as const)('copies only required summaries and remaps every known parent (%s)', async mode => {
    const fixture = await seed(durable);
    const before = structuredClone(fixture.session);
    const bytes = await fixture.bytes();
    const sourceIds = new Set((await fixture.manager.getRawEntries(before.id)).map(entry => entry.id));
    const copy = (await fixture.manager.cloneSession(before.id, 'Copy', mode === 'full' ? undefined
      : mode === 'index' ? 1 : fixture.answer.id))!;
    expect(copy).not.toBeNull();
    await checkCopy(fixture.manager, copy, mode === 'full', sourceIds);
    expect(copy).toMatchObject({ parentId: undefined, branchId: undefined,
      metadata: { clonedFromSessionId: before.id, custom: { value: 'source' } } });
    expect(fixture.session).toEqual(before);
    expect(await fixture.bytes()).toEqual(bytes);
    if (fixture.store) {
      const reload = new SessionManager({ store: fixture.store });
      await reload.loadFromStore(copy.id);
      await checkCopy(reload, reload.get(copy.id)!, mode === 'full', sourceIds);
    }
    await fixture.manager.addMessage(copy.id, { role: 'user', content: 'Copy only' });
    (copy.metadata!.branchSummaries as BranchSummaryEntry[])[0]!.summary = 'Copy edit';
    expect(fixture.session).toEqual(before);
    expect(await fixture.bytes()).toEqual(bytes);
  });

  it('remaps a message parent directly targeting a summary', async () => {
    const fixture = await seed(durable);
    await fixture.manager.update(fixture.session.id, { activeLeafId: fixture.needed.id });
    await fixture.manager.addMessage(fixture.session.id, { role: 'user', content: 'Direct summary child' });
    const copy = (await fixture.manager.cloneSession(fixture.session.id))!;
    const summaries = await fixture.manager.getBranchSummaries(copy.id);
    const needed = summaries.find(entry => entry.branchName === 'Needed')!;
    expect(needed).toBeDefined();
    expect(needed.id).not.toBe(fixture.needed.id);
    expect(copy.messages.at(-1)!.parentMessageId).toBe(needed.id);
  });

  it('does not carry later summary metadata into a prefix ending before any summary', async () => {
    const fixture = await seed(durable);
    const copy = (await fixture.manager.cloneSession(fixture.session.id, undefined, 'question'))!;
    expect(copy.messages.map(message => message.content)).toEqual(['Question']);
    expect(copy.commands).toBeUndefined();
    expect(copy.metadata?.branchSummaries).toBeUndefined();
    expect(await fixture.manager.getBranchSummaries(copy.id)).toEqual([]);
    expect(copy.activeLeafId).toBe(copy.messages[0]!.id);
  });

  it('refuses a future-dated running ancestor behind a summary before creating any copy', async () => {
    const fixture = await seed(durable, true);
    const before = await fixture.bytes();
    const ids = fixture.manager.list().map(session => session.id);
    expect(fixture.needed.timestamp).toBeGreaterThan(fixture.answer.timestamp.getTime());
    expect(await fixture.manager.cloneSession(fixture.session.id, undefined, fixture.answer.id)).toBeNull();
    expect(fixture.manager.list().map(session => session.id)).toEqual(ids);
    expect(await fixture.bytes()).toEqual(before);
    if (fixture.store) expect(await fixture.store.listSessionIds()).toEqual(ids);
  });
});

it('persists summaries in the create-only write before publishing a clone and publishes nothing after a refused write', async () => {
  const fixture = await seed(true);
  const save = vi.spyOn(fixture.store!, 'saveSession');
  const observed: Array<Promise<BranchSummaryEntry[]>> = [];
  fixture.manager.setListener(id => { if (id !== fixture.session.id) observed.push(fixture.manager.getBranchSummaries(id)); });
  const copy = (await fixture.manager.cloneSession(fixture.session.id))!;
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]![0].id).toBe(copy.id);
  expect(save.mock.calls[0]![1]?.filter(entry => entry.type === 'branch_summary')).toHaveLength(2);
  expect(save.mock.calls[0]![2]).toEqual({ requireAbsent: true });
  expect(await observed[0]).toHaveLength(2);
  const before = await fixture.bytes();
  const ids = fixture.manager.list().map(session => session.id).sort();
  save.mockRejectedValueOnce(new Error('fixture private failure'));
  await expect(fixture.manager.cloneSession(fixture.session.id)).rejects.toThrow('Session persistence failed.');
  expect(fixture.manager.list().map(session => session.id).sort()).toEqual(ids);
  expect((await fixture.store!.listSessionIds()).sort()).toEqual(ids);
  expect(observed).toHaveLength(1);
  expect(await fixture.bytes()).toEqual(before);
});

it('refuses summary copies beyond the existing 1024 additional-entry bound before creation', async () => {
  const manager = new SessionManager();
  const session = await manager.create({ messages: [{ id: 'root', role: 'user', content: 'Root', timestamp: new Date(1) }] });
  const raw = await manager.getRawEntries(session.id);
  const summaries: BranchSummaryEntry[] = Array.from({ length: 1025 }, (_, i) => ({
    id: `summary-${i}`, type: 'branch_summary', timestamp: i + 2, branchName: 'Bounded', summary: 'Summary',
    parentEntryId: i === 0 ? 'root' : `summary-${i - 1}`,
  }));
  await manager.update(session.id, { activeLeafId: summaries.at(-1)!.id });
  vi.spyOn(manager, 'getRawEntries').mockResolvedValue([...raw, ...summaries]);
  const before = structuredClone(session);
  expect(await manager.cloneSession(session.id)).toBeNull();
  expect(manager.list()).toEqual([before]);
});
