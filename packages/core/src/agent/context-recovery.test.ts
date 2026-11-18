import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../sessions/session-manager.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { runToolLoop } from './tool-loop.js';
import { ProviderRequestContextError } from './provider-request-estimate.js';
import { getSessionAccounting } from '../sessions/session-accounting.js';

async function fixture(enabled = true) {
  const manager = new SessionManager();
  manager.setCompactionSettings({ enabled, keepRecentTokens: 20 });
  const session = await manager.create({ title: 'Recovery' });
  for (let i = 0; i < 3; i++) {
    await manager.addMessage(session.id, { role: 'user', content: `old ${i}: ${'x'.repeat(2000)}` });
    await manager.addMessage(session.id, { role: 'assistant', content: 'old answer' });
  }
  await manager.addMessage(session.id, { role: 'user', content: 'current request' });
  const summary = vi.fn(async () => ({ summary: 'Earlier facts', usage: { totalTokens: 3 } }));
  manager.setAutoCompactionCallback(summary);
  const registry = new ExtensionRegistry();
  const run = (streamTurn: Parameters<typeof runToolLoop>[0]['streamTurn'], signal?: AbortSignal) => runToolLoop({
    sessionManager: manager, sessionId: session.id, extensionRegistry: registry,
    toolContext: { sessionManager: manager, currentSessionId: session.id, notify() {} }, streamTurn, signal,
  });
  return { manager, session, summary, run };
}

describe('bounded native context recovery', () => {
  it('repairs a local overflow once without deleting transcript or dequeuing a continuation', async () => {
    const f = await fixture();
    const turn = vi.fn().mockRejectedValueOnce(new ProviderRequestContextError('overflow')).mockResolvedValueOnce({ content: 'recovered' });
    expect(await f.run(turn)).toBe('recovered');
    expect(f.summary).toHaveBeenCalledOnce();
    expect(turn).toHaveBeenCalledTimes(2);
    expect(turn.mock.calls[1][0][0].content).toContain('[Context Summary]');
    expect(turn.mock.calls[1][3]).toBe('overflow');
    const raw = await f.manager.getRawEntries(f.session.id);
    expect(raw.filter(entry => entry.type === 'message' && entry.content.includes('old 0:'))).toHaveLength(1);
  });

  it('retains a length-exhausted response and its usage while omitting it only from future model input', async () => {
    const f = await fixture();
    const turn = vi.fn().mockResolvedValueOnce({ content: 'unfinished answer', stopReason: 'length', usage: { totalTokens: 7 } })
      .mockResolvedValueOnce({ content: 'complete answer', usage: { totalTokens: 4 } });
    expect(await f.run(turn)).toBe('complete answer');
    expect(turn.mock.calls[1][0].some((message: { content: string }) => message.content === 'unfinished answer')).toBe(false);
    const raw = await f.manager.getRawEntries(f.session.id);
    expect(raw.filter(entry => entry.type === 'message' && entry.content === 'unfinished answer')).toHaveLength(1);
    expect(raw.some(entry => entry.type === 'context_edit')).toBe(true);
    expect(getSessionAccounting(raw, f.manager.get(f.session.id)!.activeLeafId).active.usage.totalTokens).toBe(14);
  });

  it.each(['disabled', 'session-disabled', 'ineffective', 'repeated', 'invalid'])('does not loop or bypass %s policy', async mode => {
    const f = await fixture(mode !== 'disabled');
    if (mode === 'session-disabled') await f.manager.update(f.session.id, { autoCompaction: false });
    if (mode === 'ineffective') f.summary.mockImplementation(async () => ({ summary: 'x'.repeat(15000), usage: { totalTokens: 3 } }));
    const error = new ProviderRequestContextError(mode === 'invalid' ? 'invalid' : 'overflow');
    const turn = vi.fn().mockRejectedValue(error);
    await expect(f.run(turn)).rejects.toThrow(error.message);
    expect(turn).toHaveBeenCalledTimes(mode === 'repeated' ? 2 : 1);
    expect(f.summary).toHaveBeenCalledTimes(['disabled', 'session-disabled', 'invalid'].includes(mode) ? 0 : 1);
  });

  it('does not retry or publish a late summary after cancellation', async () => {
    const f = await fixture(); const controller = new AbortController();
    f.summary.mockImplementation(async () => { controller.abort(); return { summary: 'late', usage: { totalTokens: 3 } }; });
    const turn = vi.fn().mockRejectedValue(new ProviderRequestContextError('overflow'));
    await expect(f.run(turn, controller.signal)).rejects.toThrow();
    expect(turn).toHaveBeenCalledOnce();
    expect((await f.manager.getRawEntries(f.session.id)).some(entry => entry.type === 'compaction')).toBe(false);
  });
});
