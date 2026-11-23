import { describe, expect, it, vi } from 'vitest';
import {
  copySessionBranchEvent, copySessionBranchOptions, SessionBranchAdmissions, SessionBranchCancelledError,
  type SessionBranchEvent, type SessionBranchHook,
} from './session-branch-admission.js';

const selection = { operation: 'clone' as const, entryId: 'selected-private', position: 'at' as const, externalSource: false };
function latch() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

describe('neutral branch admission', () => {
  it('awaits hooks in order before admitting publication', async () => {
    const admissions = new SessionBranchAdmissions(), gate = latch(), entered = latch(), calls: number[] = [];
    admissions.onBefore(async () => { calls.push(1); entered.release(); await gate.promise; calls.push(2); });
    admissions.onBefore(() => { calls.push(3); });
    const ticket = admissions.begin('source'), pending = admissions.run(ticket, selection);
    await entered.promise; expect(calls).toEqual([1]);
    gate.release(); await pending; expect(calls).toEqual([1, 2, 3]);
    ticket.admit(); ticket.finish();
  });

  it('owns frozen primitive identities before its first wait', async () => {
    const admissions = new SessionBranchAdmissions(), input = { ...selection };
    const seen: Readonly<SessionBranchEvent>[] = [];
    admissions.onBefore(event => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(Reflect.set(event, 'entryId', 'rewritten')).toBe(false);
      seen.push(event);
    });
    const ticket = admissions.begin('captured-source'), pending = admissions.run(ticket, input);
    input.entryId = 'later-selection'; await pending;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sourceSessionId: 'captured-source', entryId: 'selected-private' });
    expect(seen[0].signal).toBe(ticket.signal); ticket.finish();
  });

  it('stops on a veto without invoking later hooks or admitting publication', async () => {
    const admissions = new SessionBranchAdmissions(), later = vi.fn();
    admissions.onBefore(() => false); admissions.onBefore(later);
    const ticket = admissions.begin('source');
    await expect(admissions.run(ticket, selection)).rejects.toBeInstanceOf(SessionBranchCancelledError);
    expect(later).not.toHaveBeenCalled(); expect(ticket.signal.aborted).toBe(true);
    expect(() => ticket.admit()).toThrow(SessionBranchCancelledError); ticket.finish();
  });

  it('fails closed without leaking privileged callback errors', async () => {
    const admissions = new SessionBranchAdmissions(), later = vi.fn();
    admissions.onBefore(() => { throw new Error('PRIVATE_CALLBACK_ERROR'); }); admissions.onBefore(later);
    const ticket = admissions.begin('source');
    await expect(admissions.run(ticket, selection)).rejects.toThrow(/^Session branch hook failed\.$/);
    expect(later).not.toHaveBeenCalled(); expect(() => ticket.admit()).toThrow(SessionBranchCancelledError); ticket.finish();
  });

  it('rejects an invalid callback result without evaluating its accessors', async () => {
    const admissions = new SessionBranchAdmissions(), getter = vi.fn(() => true);
    admissions.onBefore((() => Object.defineProperty({}, 'cancel', { get: getter })) as unknown as SessionBranchHook);
    const ticket = admissions.begin('source');
    await expect(admissions.run(ticket, selection)).rejects.toThrow('Session branch hook result is invalid.');
    expect(getter).not.toHaveBeenCalled(); expect(() => ticket.admit()).toThrow(SessionBranchCancelledError); ticket.finish();
  });

  it('settles cancellation even when a callback ignores its signal and later succeeds', async () => {
    const admissions = new SessionBranchAdmissions(), caller = new AbortController(), gate = latch(), entered = latch(), later = vi.fn();
    admissions.onBefore(async () => { entered.release(); await gate.promise; }); admissions.onBefore(later);
    const ticket = admissions.begin('source', caller.signal), pending = admissions.run(ticket, selection);
    await entered.promise; caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'SESSION_BRANCH_CANCELLED' });
    gate.release(); await Promise.resolve();
    expect(later).not.toHaveBeenCalled(); expect(() => ticket.admit()).toThrow(SessionBranchCancelledError); ticket.finish();
  });

  it.each(['registration', 'unsubscribe', 'retire'] as const)('withdraws a pending callback on %s', async action => {
    const admissions = new SessionBranchAdmissions(), gate = latch(), entered = latch();
    const remove = admissions.onBefore(async () => { entered.release(); await gate.promise; });
    const ticket = admissions.begin('source'), pending = admissions.run(ticket, selection);
    await entered.promise;
    if (action === 'registration') admissions.onBefore(() => undefined);
    else if (action === 'unsubscribe') remove();
    else admissions.retire();
    await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError);
    gate.release(); ticket.finish();
  });

  it('retires only the named source when source authority is withdrawn', async () => {
    const admissions = new SessionBranchAdmissions(), first = admissions.begin('first'), second = admissions.begin('second');
    admissions.retire('first');
    expect(() => first.admit()).toThrow(SessionBranchCancelledError);
    expect(() => second.check()).not.toThrow(); second.admit(); first.finish(); second.finish();
  });

  it('makes an owned unsubscribe idempotent without revoking later work', async () => {
    const admissions = new SessionBranchAdmissions(), hook = vi.fn(), remove = admissions.onBefore(hook);
    remove(); const ticket = admissions.begin('source'); remove();
    await admissions.run(ticket, selection); expect(hook).not.toHaveBeenCalled(); ticket.admit(); ticket.finish();
  });

  it('preserves already-admitted work through abort, registration and authority retirement', async () => {
    const admissions = new SessionBranchAdmissions(), caller = new AbortController(), ticket = admissions.begin('source', caller.signal);
    await admissions.run(ticket, selection); ticket.admit();
    admissions.onBefore(() => false); admissions.retire(); caller.abort();
    expect(ticket.signal.aborted).toBe(false); expect(() => ticket.check()).not.toThrow();
    await expect(ticket.waitFor(Promise.resolve('durable-result'))).resolves.toBe('durable-result');
    ticket.finish(); expect(ticket.signal.aborted).toBe(false);
  });

  it('refuses an already-aborted lifetime before hook invocation', async () => {
    const admissions = new SessionBranchAdmissions(), caller = new AbortController(), hook = vi.fn();
    admissions.onBefore(hook); caller.abort();
    expect(() => admissions.begin('source', caller.signal)).toThrow(SessionBranchCancelledError);
    expect(hook).not.toHaveBeenCalled();
  });

  it('finishes pending leases idempotently and cannot resurrect them', async () => {
    const admissions = new SessionBranchAdmissions(), ticket = admissions.begin('source');
    ticket.finish(); ticket.finish();
    expect(ticket.signal.aborted).toBe(true); expect(() => ticket.admit()).toThrow(SessionBranchCancelledError);
    await expect(admissions.run(ticket, selection)).rejects.toBeInstanceOf(SessionBranchCancelledError);
  });

  it('observes a late rejected operation even when its lease is already cancelled', async () => {
    const admissions = new SessionBranchAdmissions(), ticket = admissions.begin('source');
    ticket.cancel();
    await expect(ticket.waitFor(Promise.reject(new Error('LATE_REJECTION')))).rejects.toBeInstanceOf(SessionBranchCancelledError);
    ticket.finish();
  });

  it('bounds registered callbacks without revoking work for a refused registration', () => {
    const admissions = new SessionBranchAdmissions();
    for (let index = 0; index < 128; index++) admissions.onBefore(() => undefined);
    const ticket = admissions.begin('source');
    expect(() => admissions.onBefore(() => undefined)).toThrow('Session branch hook limit reached.');
    expect(ticket.signal.aborted).toBe(false); ticket.finish();
  });

  it('rechecks callback capacity after a synchronous abort listener registers another generation', async () => {
    const admissions = new SessionBranchAdmissions(), inner = vi.fn(), outer = vi.fn();
    for (let index = 0; index < 127; index++) admissions.onBefore(() => undefined);
    const ticket = admissions.begin('source');
    ticket.signal.addEventListener('abort', () => { admissions.onBefore(inner); }, { once: true });
    expect(() => admissions.onBefore(outer)).toThrow('Session branch hook limit reached.'); ticket.finish();
    expect(() => admissions.onBefore(outer)).toThrow('Session branch hook limit reached.');
    const next = admissions.begin('source'); await admissions.run(next, selection); next.admit(); next.finish();
    expect(inner).toHaveBeenCalledTimes(1); expect(outer).not.toHaveBeenCalled();
  });

  it('bounds unpublished leases and releases capacity after completion', () => {
    const admissions = new SessionBranchAdmissions();
    const tickets = Array.from({ length: 256 }, () => admissions.begin('source'));
    expect(() => admissions.begin('source')).toThrow('Session branch admission limit reached.');
    tickets[0].finish(); const next = admissions.begin('source');
    for (const ticket of tickets) ticket.finish(); next.finish();
  });
});

describe('branch lifetime option capture', () => {
  it('captures the exact signal and ignores inherited options', () => {
    const signal = new AbortController().signal, input = { signal };
    expect(copySessionBranchOptions(input)).toEqual({ signal }); input.signal = new AbortController().signal;
    expect(copySessionBranchOptions(Object.create({ signal }))).toEqual({ signal: undefined });
  });

  it.each([null, [], { extra: true }, { signal: {} }, { signal: false }])('refuses malformed own options %j', value => {
    expect(() => copySessionBranchOptions(value as never)).toThrow('Session branch options are invalid.');
  });

  it('refuses a signal accessor without evaluating it', () => {
    const getter = vi.fn(() => new AbortController().signal), input = Object.defineProperty({}, 'signal', { get: getter });
    expect(() => copySessionBranchOptions(input)).toThrow('Session branch options are invalid.');
    expect(getter).not.toHaveBeenCalled();
  });

  it('refuses unknown symbol options without evaluating them', () => {
    const getter = vi.fn(), input = Object.defineProperty({}, Symbol('unknown'), { get: getter });
    expect(() => copySessionBranchOptions(input)).toThrow('Session branch options are invalid.'); expect(getter).not.toHaveBeenCalled();
  });
});

describe('branch event capture', () => {
  const event = (): SessionBranchEvent => ({ ...selection, sourceSessionId: 'source', signal: new AbortController().signal });
  it('returns owned frozen metadata with the exact signal capability', () => {
    const original = event(), captured = copySessionBranchEvent(original);
    expect(captured).toEqual(original); expect(captured).not.toBe(original); expect(Object.isFrozen(captured)).toBe(true);
    expect(captured.signal).toBe(original.signal);
  });
  it.each([{ sourceSessionId: '' }, { entryId: 'x'.repeat(257) }, { operation: 'switch' }, { position: 'after' },
    { externalSource: 1 }, { signal: {} }, { unknown: true }])('refuses invalid metadata %j', fields => {
    expect(() => copySessionBranchEvent({ ...event(), ...fields } as never)).toThrow('Session branch event is invalid.');
  });
  it('rejects an own identity accessor without evaluating it', () => {
    const getter = vi.fn(() => 'changed'), input = Object.defineProperty(event(), 'sourceSessionId', { get: getter });
    expect(() => copySessionBranchEvent(input)).toThrow('Session branch event is invalid.'); expect(getter).not.toHaveBeenCalled();
  });
  it('rejects missing required metadata instead of reading inherited identities', () => {
    expect(() => copySessionBranchEvent(Object.create(event()))).toThrow('Session branch event is invalid.');
  });
});
