import { describe, expect, it, vi } from 'vitest';
import { PromptBoundaryRefresh } from './status-prompt-refresh.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function harness() {
  const refresh = new PromptBoundaryRefresh();
  const writes: string[] = [];
  const error = vi.fn();
  const state = { session: 'a', conversationRunning: false, isStreaming: false, shuttingDown: false };
  const current = (id: string) => id === state.session && !state.conversationRunning && !state.isStreaming && !state.shuttingDown;
  const start = (work: ReturnType<typeof deferred<string>>) => refresh.refresh(state.session,
    () => work.promise, current, value => { writes.push(`status:${value}`, `prompt:${state.session}`); }, error);
  return { refresh, writes, error, state, start, current };
}

describe('latest-only prompt-boundary refresh', () => {
  it('rejects older completion after the newer prompt already displayed', async () => {
    const h = harness();
    const old = deferred<string>();
    const latest = deferred<string>();
    const a = h.start(old);
    const b = h.start(latest);
    latest.resolve('new'); await b;
    old.resolve('old'); await a;
    expect(h.writes).toEqual(['status:new', 'prompt:a']);
  });

  it('rejects an older completion even while the newer refresh is still pending', async () => {
    const h = harness();
    const old = deferred<string>();
    const latest = deferred<string>();
    const a = h.start(old);
    const b = h.start(latest);
    old.resolve('old'); await a;
    expect(h.writes).toEqual([]);
    latest.resolve('new'); await b;
    expect(h.writes).toEqual(['status:new', 'prompt:a']);
  });

  it.each(['input', 'provider', 'shell'])('invalidates at %s start even if it finishes before the old snapshot', async () => {
    const h = harness();
    const old = deferred<string>();
    const pending = h.start(old);
    h.refresh.invalidate(); // FIRST action in processInput, before any await/branch.
    // Deliberately idle again: a live busy flag alone cannot detect this race.
    old.resolve('old'); await pending;
    expect(h.writes).toEqual([]);
    const next = deferred<string>();
    const ready = h.start(next);
    next.resolve('ready'); await ready;
    expect(h.writes).toEqual(['status:ready', 'prompt:a']);
  });

  it.each(['conversationRunning', 'isStreaming', 'shuttingDown'] as const)('rechecks live %s before display', async flag => {
    const h = harness();
    const work = deferred<string>();
    const pending = h.start(work);
    h.state[flag] = true;
    work.resolve('late'); await pending;
    expect(h.writes).toEqual([]);
  });

  it('rejects a snapshot prepared for a different current session', async () => {
    const h = harness();
    const work = deferred<string>();
    const pending = h.start(work);
    h.state.session = 'b';
    work.resolve('a'); await pending;
    expect(h.writes).toEqual([]);
  });

  it('close suppresses pending work and never prepares future work', async () => {
    const h = harness();
    const work = deferred<string>();
    const pending = h.start(work);
    h.refresh.close(); h.refresh.close(); h.refresh.invalidate();
    work.resolve('late'); await pending;
    const prepare = vi.fn(async () => 'future');
    await h.refresh.refresh('a', prepare, h.current, () => h.writes.push('bad'), h.error);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it('does not start a prompt snapshot while the boundary is busy', async () => {
    const h = harness();
    h.state.conversationRunning = true;
    const prepare = vi.fn(async () => 'bad');
    await h.refresh.refresh('a', prepare, h.current, () => h.writes.push('bad'), h.error);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it.each(['newer', 'invalidate', 'close', 'stream', 'session'])('suppresses stale errors after %s instead of printing in a new stream', async cause => {
    const h = harness();
    const old = deferred<string>();
    const pending = h.start(old);
    if (cause === 'newer') {
      const latest = deferred<string>();
      const next = h.start(latest); latest.resolve('new'); await next;
    } else if (cause === 'invalidate') h.refresh.invalidate();
    else if (cause === 'close') h.refresh.close();
    else if (cause === 'stream') h.state.isStreaming = true;
    else h.state.session = 'b';
    old.reject(new Error('stale')); await pending;
    expect(h.error).not.toHaveBeenCalled();
  });

  it('reports a current preparation error once without displaying or prompting', async () => {
    const h = harness();
    const work = deferred<string>();
    const pending = h.start(work);
    const error = new Error('current'); work.reject(error); await pending;
    expect(h.error).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.writes).toEqual([]);
  });
});
