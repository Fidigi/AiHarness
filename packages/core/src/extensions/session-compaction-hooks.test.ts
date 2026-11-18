import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, SessionManager } from '@ai-harness/core';

async function fixture() {
  const manager = new SessionManager(), session = await manager.create();
  for (const content of ['Old user', 'Old reply', 'Kept user', 'Kept reply']) {
    await manager.addMessage(session.id, { role: content.includes('user') ? 'user' : 'assistant', content });
  }
  const registry = new ExtensionRegistry(); registry.attachSessionManager(manager);
  return { manager, session, registry, boundary: session.messages[2].id };
}

it('orders output-only overrides and preserves raw history, source/cut, accounting and private checkpoints', async () => {
  const f = await fixture(), calls: string[] = [], output = { summary: 'Owned override' };
  await f.registry.load('first', api => { api.before('before:session:compaction', event => {
    expect(Object.isFrozen(event)).toBe(true); expect(event).toMatchObject({ sessionId: f.session.id, firstKeptEntryId: f.boundary });
    expect(Object.keys(event)).not.toContain('loadout'); calls.push('first'); return output;
  }); });
  await f.registry.load('second', api => { api.before('before:session:compaction', () => { calls.push('second'); output.summary = 'Late mutation'; }); });
  const source = f.manager.captureCompactionSource(f.session.id)!;
  await f.manager.applyCompaction(f.session.id, 'Generated', f.boundary, { usage: { costUsd: 0.03 } }, { source });
  const compact = (await f.manager.getRawEntries(f.session.id)).findLast(entry => entry.type === 'compaction');
  expect(compact).toMatchObject({ summary: 'Owned override', firstKeptEntryId: f.boundary, usage: { costUsd: 0.03 } });
  expect(calls).toEqual(['first', 'second']); await f.registry.shutdown();
});

describe('compaction override refusal', () => {
  it.each([false, { cancel: true }, { summary: 'ok', firstKeptEntryId: 'foreign' }, { summary: ' ' }, { summary: 'ok', usage: { costUsd: 0 } }])('never publishes for %j', async result => {
    const f = await fixture(), before = await f.manager.getRawEntries(f.session.id);
    await f.registry.load('refusal', api => { api.before('before:session:compaction', () => result as never); });
    await expect(f.manager.applyCompaction(f.session.id, 'Original', f.boundary)).rejects.toThrow();
    expect(await f.manager.getRawEntries(f.session.id)).toEqual(before); await f.registry.shutdown();
  });

  it.each(['abort', 'source', 'unload'] as const)('withdraws a held override on %s', async action => {
    const f = await fixture(), controller = new AbortController();
    let release!: () => void, enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    await f.registry.load('held', api => { api.before('before:session:compaction', async () => { enter(); await gate; return { summary: 'Late' }; }); });
    const pending = f.manager.applyCompaction(f.session.id, 'Original', f.boundary, {}, { signal: controller.signal });
    await entered;
    if (action === 'abort') controller.abort();
    else if (action === 'source') await f.manager.addMessage(f.session.id, { role: 'user', content: 'New source' });
    else await f.registry.unload('held');
    release(); await expect(pending).rejects.toThrow();
    expect((await f.manager.getRawEntries(f.session.id)).some(entry => entry.type === 'compaction')).toBe(false);
    await f.registry.shutdown();
  });

  it('does not evaluate output accessors', async () => {
    const f = await fixture(), getter = vi.fn(() => 'Injected');
    await f.registry.load('getter', api => { api.before('before:session:compaction', () => Object.defineProperty({}, 'summary', { get: getter }) as never); });
    await expect(f.manager.applyCompaction(f.session.id, 'Original', f.boundary)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); await f.registry.shutdown();
  });
});
