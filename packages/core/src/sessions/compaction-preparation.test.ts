import { describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager.js';
import { prepareCompactionContext } from './compaction-preparation.js';

async function fixture(count = 4) {
  const manager = new SessionManager(); manager.setCompactionSettings({ enabled: false });
  const session = await manager.create(), id = session.id;
  for (let index = 0; index < count; index++) await manager.addMessage(id,
    { role: index % 2 ? 'assistant' : 'user', content: `ordinary-${index}` }, { skipAutoCompaction: true });
  return { manager, id };
}
async function appendTools(manager: SessionManager, id: string) {
  await manager.addMessage(id, { role: 'assistant', content: 'declaration', toolCalls: [
    { id: 'a', name: 'alpha', input: { nested: { value: 'ORIGINAL' } } },
    { id: 'b', name: 'beta', input: {} },
  ] }, { skipAutoCompaction: true });
  for (const call of ['a', 'b']) await manager.addMessage(id,
    { role: 'tool', toolCallId: call, content: `result-${call}` }, { skipAutoCompaction: true });
}

describe('owned shared compaction preparation', () => {
  it('retains explicit manual meaning with automatic generation disabled and performs no work implicitly', async () => {
    const { manager, id } = await fixture(3); let generations = 0, starts = 0;
    manager.setAutoCompactionCallback(async () => { generations++; return 'UNEXPECTED'; });
    manager.on('compaction:start', () => { starts++; });
    const before = await manager.getRawEntries(id), source = manager.captureCompactionSource(id);
    const prepared = prepareCompactionContext(manager, id)!;
    expect(prepared.toCompact.map(message => message.content)).toEqual(['ordinary-0']);
    expect(prepared.keptMessages.map(message => message.content)).toEqual(['ordinary-1', 'ordinary-2']);
    expect(generations).toBe(0); expect(starts).toBe(0); expect(await manager.getRawEntries(id)).toEqual(before);
    if (!source) throw new Error('Fixture source missing.');
    await manager.applyCompaction(id, 'EXPLICIT_SUMMARY', prepared.firstKeptEntryId, {}, { source });
    expect(manager.getEffectiveContext(id).map(entry => entry.type === 'message' ? entry.content : '')[0]).toContain('EXPLICIT_SUMMARY');
  });

  it('includes prior background and public custom content in the prefix exactly once, without private state/details', async () => {
    const { manager, id } = await fixture();
    await manager.applyCompaction(id, 'PRIOR_BACKGROUND', manager.get(id)!.messages.at(-2)!.id);
    await manager.appendCustomEntry(id, 'state', { secret: 'PRIVATE_STATE' });
    await manager.appendCustomMessage(id, 'public', 'PUBLIC_CUSTOM', { display: false, details: { secret: 'PRIVATE_DETAILS' } });
    for (let index = 0; index < 4; index++) await manager.addMessage(id,
      { role: 'user', content: `new-${index}` }, { skipAutoCompaction: true });
    const prepared = prepareCompactionContext(manager, id)!;
    expect(prepared.toCompact.filter(message => message.content.includes('PRIOR_BACKGROUND'))).toHaveLength(1);
    expect(prepared.toCompact.filter(message => message.content.includes('PUBLIC_CUSTOM'))).toHaveLength(1);
    expect(prepared.keptMessages.map(message => message.content)).toEqual(['new-2', 'new-3']);
    expect(JSON.stringify(prepared)).not.toMatch(/PRIVATE_STATE|PRIVATE_DETAILS/);
    expect([...prepared.toCompact, ...prepared.keptMessages].map(message => message.id)).toEqual(prepared.messages.map(message => message.id));
  });

  it('retains the entire final assistant/multi-tool unit beyond a soft keep target', async () => {
    const { manager, id } = await fixture(3); await appendTools(manager, id);
    manager.setCompactionSettings({ keepRecentTokens: 1 });
    const prepared = prepareCompactionContext(manager, id)!;
    expect(prepared.toCompact).toHaveLength(3);
    expect(prepared.keptMessages.map(message => message.content)).toEqual(['declaration', 'result-a', 'result-b']);
    expect(prepared.keptMessages[0].toolCalls?.map(call => call.id)).toEqual(['a', 'b']);
    expect(prepared.firstKeptEntryId).toBe(prepared.keptMessages[0].id);
    expect(prepared.keptTokens).toBeGreaterThan(1);
  });

  it('can summarize a completed entire tool unit rather than keep an orphan result', async () => {
    const { manager, id } = await fixture(3); await appendTools(manager, id);
    await manager.addMessage(id, { role: 'user', content: 'NEXT_USER' }, { skipAutoCompaction: true });
    manager.setCompactionSettings({ keepRecentTokens: 1 });
    const prepared = prepareCompactionContext(manager, id)!;
    expect(prepared.toCompact.slice(-3).map(message => message.content)).toEqual(['declaration', 'result-a', 'result-b']);
    expect(prepared.keptMessages.map(message => message.content)).toEqual(['NEXT_USER']);
  });

  it('does not manufacture a useful cut by splitting the only atomic unit', async () => {
    const { manager, id } = await fixture(0); await appendTools(manager, id);
    manager.setCompactionSettings({ keepRecentTokens: 1 });
    expect(prepareCompactionContext(manager, id)).toBeNull();
  });

  it('does not force a threshold target when the entire context fits the keep target', async () => {
    const { manager, id } = await fixture();
    expect(prepareCompactionContext(manager, id, 'threshold')).toBeNull();
    expect(prepareCompactionContext(manager, id, 'manual')).not.toBeNull();
  });

  it('conserves legacy zero keep as final-unit retention without changing pure-cut validation', async () => {
    const { manager, id } = await fixture(); manager.setCompactionSettings({ enabled: true, keepRecentTokens: 0 });
    expect(prepareCompactionContext(manager, id, 'threshold')?.keptMessages.map(message => message.content)).toEqual(['ordinary-3']);
    expect(manager.requestCompaction(id)?.keptEntries.map(entry => entry.type === 'message' ? entry.content : '')).toEqual(['ordinary-3']);
  });

  it('preserves legacy invalid-boundary no-ops but refuses a false captured publication without consuming its source', async () => {
    const { manager, id } = await fixture(), source = manager.captureCompactionSource(id);
    const prepared = prepareCompactionContext(manager, id)!;
    if (!source) throw new Error('Fixture source missing.');
    const before = await manager.getRawEntries(id);
    await expect(manager.applyCompaction(id, 'Legacy no-op', 'missing')).resolves.toBeUndefined();
    await expect(manager.applyCompaction(id, 'Never completed', 'missing', {}, { source }))
      .rejects.toThrow('Compaction boundary is not an active model entry.');
    expect(await manager.getRawEntries(id)).toEqual(before);
    await manager.applyCompaction(id, 'Valid later publication', prepared.firstKeptEntryId, {}, { source });
    expect((await manager.getRawEntries(id)).filter(entry => entry.type === 'compaction')).toHaveLength(1);
  });

  it('never evaluates a substituted keep-setting accessor', async () => {
    const { manager, id } = await fixture(); let reads = 0;
    Object.defineProperty(manager.getCompactionSettings(), 'keepRecentTokens', { get() { reads++; return 1; } });
    expect(() => prepareCompactionContext(manager, id)).toThrow('Compaction cut policy is invalid.'); expect(reads).toBe(0);
  });

  it('returns independently mutable legacy arrays without nested aliases into the journal', async () => {
    const { manager, id } = await fixture(3); await appendTools(manager, id);
    manager.setCompactionSettings({ keepRecentTokens: 1 });
    const before = JSON.stringify(manager.getEffectiveContext(id)), prepared = prepareCompactionContext(manager, id)!;
    prepared.toCompact[0].content = 'MUTATED';
    const input = prepared.keptMessages[0].toolCalls![0].input as { nested: { value: string } }; input.nested.value = 'MUTATED';
    prepared.toCompact.push(prepared.keptMessages[0]);
    expect(JSON.stringify(manager.getEffectiveContext(id))).toBe(before);
    expect(JSON.stringify(prepareCompactionContext(manager, id))).not.toContain('MUTATED');
  });

  it('does not create context or generation authority for a missing session', () => {
    expect(prepareCompactionContext(new SessionManager(), 'missing')).toBeNull();
  });

  it('cannot renew an earlier source lease after private ancestry changes', async () => {
    const { manager, id } = await fixture(); const source = manager.captureCompactionSource(id);
    const prepared = prepareCompactionContext(manager, id)!;
    await manager.appendCustomEntry(id, 'private', { changed: true });
    if (!source) throw new Error('Fixture source missing.');
    await expect(manager.applyCompaction(id, 'LATE_SUMMARY', prepared.firstKeptEntryId, {}, { source })).rejects.toThrow('Compaction context or policy changed.');
    expect((await manager.getRawEntries(id)).filter(entry => entry.type === 'compaction')).toHaveLength(0);
  });

  it('does not borrow an orphan result when preparing the retained model suffix', async () => {
    const { manager, id } = await fixture();
    await manager.addMessage(id, { role: 'tool', toolCallId: 'missing', content: 'ORPHAN' }, { skipAutoCompaction: true });
    const prepared = prepareCompactionContext(manager, id)!;
    expect(prepared.messages.map(message => message.content)).toEqual(['ordinary-0', 'ordinary-1', 'ordinary-2', 'ordinary-3']);
    expect(prepared.keptMessages.map(message => message.content)).toEqual(['ordinary-2', 'ordinary-3']);
  });
});
