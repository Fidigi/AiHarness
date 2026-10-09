import { describe, expect, it, vi } from 'vitest';
import { CredentialRedactor } from '../providers/credentials.js';
import { ToolProgressChannel, TOOL_PROGRESS_LIMITS, type ToolProgressInput, type ToolProgressSnapshot } from './tool-progress.js';

const call = { id: 'outer', name: 'arbitrary', input: {} };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('bounded arbitrary progress channel', () => {
  it('captures immutable correlation rather than retaining a caller-owned tool call', async () => {
    const mutable = { id: 'real-id', name: 'real-name', input: {} };
    const sink = vi.fn();
    const channel = new ToolProgressChannel(mutable, sink);
    mutable.id = 'spoof'; mutable.name = 'spoof';
    await channel.report({ version: 1, content: 'update' });
    expect(sink.mock.calls[0]![0]).toMatchObject({ toolCallId: 'real-id', toolName: 'real-name' });
    expect(await channel.finish('completed')).toMatchObject({ toolCallId: 'real-id', toolName: 'real-name' });
  });
  it('awaits sequential sinks and retains snapshots without producer/sink aliases', async () => {
    const blocked = gate();
    const seen: ToolProgressSnapshot[] = [];
    const sink = vi.fn(async (snapshot: ToolProgressSnapshot) => {
      seen.push(structuredClone(snapshot));
      snapshot.content = 'sink mutation';
      if (seen.length === 1) await blocked.promise;
    });
    const channel = new ToolProgressChannel(call, sink);
    const input: ToolProgressInput = { version: 1, content: 'one', details: { step: 1 } };
    let returned = false;
    const pending = channel.report(input).then(() => { returned = true; });
    input.content = 'producer mutation';
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
    blocked.release(); await pending;
    await channel.report({ version: 1, details: { step: 2 } });
    expect(seen.map(snapshot => [snapshot.content, snapshot.details, snapshot.sequence])).toEqual([
      ['one', { step: 1 }, 1], ['one', { step: 2 }, 2],
    ]);
    const terminal = await channel.finish('completed');
    expect(terminal).toMatchObject({ version: 1, toolCallId: 'outer', toolName: 'arbitrary',
      sequence: 3, content: 'one', details: { step: 2 }, status: 'completed', omittedUpdates: 0 });
    expect(Number.isSafeInteger(terminal!.durationMs)).toBe(true);
    expect(terminal!.durationMs).toBeGreaterThanOrEqual(seen[1]!.durationMs);
    terminal!.content = 'terminal mutation';
    expect(await channel.finish('failed')).toMatchObject({ sequence: 3, status: 'completed', content: 'one' });
    await channel.report({ version: 1, content: 'late' });
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('coalesces ignored-Promise flooding into one pending item and caps submissions/deliveries', async () => {
    const blocked = gate();
    const seen: ToolProgressSnapshot[] = [];
    const channel = new ToolProgressChannel(call, async snapshot => {
      seen.push(snapshot);
      if (seen.length === 1) await blocked.promise;
    });
    for (let i = 0; i < 10_000; i++) void channel.report({ version: 1, content: String(i) });
    expect(seen).toHaveLength(1);
    blocked.release();
    const terminal = await channel.finish('completed');
    expect(seen.map(snapshot => snapshot.content)).toEqual(['0', '4095']);
    expect(terminal).toMatchObject({ content: '4095', sequence: 4097, omittedUpdates: 9998 });
    const sink = vi.fn();
    const capped = new ToolProgressChannel(call, sink);
    for (let i = 0; i < 300; i++) await capped.report({ version: 1, content: String(i) });
    expect(sink).toHaveBeenCalledTimes(TOOL_PROGRESS_LIMITS.deliveries);
    expect(await capped.finish('completed')).toMatchObject({ content: '299', omittedUpdates: 44 });
  });

  it('bounds UTF-8, depth, node count and serialized details without invoking accessors/toJSON', async () => {
    const getter = vi.fn(() => 'secret');
    const details = { many: Array.from({ length: 1000 }, (_, i) => ({ i })),
      deep: { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } },
      cycle: {} };
    details.cycle = details;
    const channel = new ToolProgressChannel(call, undefined, undefined, value => value.replaceAll('secret', '[redacted]'));
    const hostile = { secret: 'secret', unicode: '😀'.repeat(10_000), deep: details.deep,
      toJSON: getter, get accessor() { return getter(); }, many: details.many, cycle: details.cycle };
    await channel.report({ version: 1, content: 'secret' + '😀'.repeat(100_000), details: hostile as unknown as ToolProgressInput['details'] });
    const terminal = await channel.finish('completed');
    expect(getter).not.toHaveBeenCalled();
    expect(terminal!.truncated).toBe(true);
    expect(Buffer.byteLength(terminal!.content!)).toBeLessThanOrEqual(TOOL_PROGRESS_LIMITS.contentBytes);
    expect(Buffer.byteLength(JSON.stringify(terminal!.details))).toBeLessThanOrEqual(TOOL_PROGRESS_LIMITS.detailsBytes);
    expect(JSON.stringify(terminal)).not.toContain('secret"');
    expect(terminal!.content).not.toContain('\uFFFD');
    expect(JSON.stringify(terminal!.details)).not.toContain('too deep');
    expect(terminal!.content).toMatch(/^\[redacted\]/);
    // Independently exhaust the node budget (not just the string budget).
    const nodes = new ToolProgressChannel(call);
    await nodes.report({ version: 1, details: Array(1000).fill(true) });
    expect((await nodes.finish('completed'))!.details).toHaveLength(TOOL_PROGRESS_LIMITS.nodes - 1);
    const depth = new ToolProgressChannel(call);
    await depth.report({ version: 1, details: details.deep });
    expect((await depth.finish('completed'))!.details).toEqual({ a: { b: { c: { d: { e: { f: { g: null } } } } } } });
    // Skipped accessors also consume the scan budget; a useful property after
    // 256 hostile entries cannot trigger an unbounded descriptor traversal.
    const accessorFlood: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) Object.defineProperty(accessorFlood, `g${i}`, { enumerable: true, get: getter });
    accessorFlood.afterBudget = 'must not scan';
    const scan = new ToolProgressChannel(call);
    await scan.report({ version: 1, details: accessorFlood as ToolProgressInput['details'] });
    expect((await scan.finish('completed'))!.details).toEqual({});
    expect(getter).not.toHaveBeenCalled();
  });

  it('preserves sparse array indices, trailing holes and non-enumerable indices, ignoring named properties', async () => {
    // Exact review example: previously ['second', 'named'] with no truncation.
    const example = Array(2);
    example[1] = 'second';
    Object.defineProperty(example, 'foo', { value: 'named', enumerable: true });
    const simple = new ToolProgressChannel(call);
    await simple.report({ version: 1, details: example });
    expect(await simple.finish('completed')).toMatchObject({ details: [null, 'second'], truncated: false });
    const getter = vi.fn(() => 'must not read');
    const sparse: unknown[] = Array(4);
    sparse[1] = 'second';
    Object.defineProperty(sparse, '2', { value: 'third', enumerable: false });
    Object.defineProperty(sparse, 'foo', { value: 'named', enumerable: true });
    Object.defineProperty(sparse, 'namedAccessor', { get: getter, enumerable: true });
    const channel = new ToolProgressChannel(call);
    await channel.report({ version: 1, details: sparse as ToolProgressInput['details'] });
    expect(await channel.finish('completed')).toMatchObject({
      details: [null, 'second', 'third', null], truncated: false,
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not read inherited array indices, and treats unsupported entries as explicit null rejections', async () => {
    const getter = vi.fn(() => 'inherited secret');
    const prototype = Object.create(Array.prototype) as object;
    Object.defineProperty(prototype, '0', { get: getter });
    const array: unknown[] = Array(4);
    array[1] = undefined;
    array[2] = () => 'not JSON';
    array[3] = Symbol('not JSON');
    Object.setPrototypeOf(array, prototype);
    const channel = new ToolProgressChannel(call);
    await channel.report({ version: 1, details: array as ToolProgressInput['details'] });
    expect(await channel.finish('completed')).toMatchObject({ details: [null, null, null, null], truncated: true });
    expect(getter).not.toHaveBeenCalled();
    const holes = new ToolProgressChannel(call);
    await holes.report({ version: 1, details: Array(TOOL_PROGRESS_LIMITS.nodes - 1) });
    expect(await holes.finish('completed')).toMatchObject({
      details: Array(TOOL_PROGRESS_LIMITS.nodes - 1).fill(null), truncated: false,
    });
  });

  it('replaces rejected array accessors with null without shifting later indices', async () => {
    const getter = vi.fn(() => 'must not read');
    const array: unknown[] = ['first', null, 'third'];
    Object.defineProperty(array, '1', { get: getter, enumerable: true });
    const channel = new ToolProgressChannel(call);
    await channel.report({ version: 1, details: array as ToolProgressInput['details'] });
    expect(await channel.finish('completed')).toMatchObject({ details: ['first', null, 'third'], truncated: true });
    expect(getter).not.toHaveBeenCalled();
    // Rejected entries still consume traversal budget, including non-enumerable ones.
    const flood = Array(1000);
    for (let i = 0; i < flood.length; i++) Object.defineProperty(flood, String(i), { get: getter });
    const bounded = new ToolProgressChannel(call);
    await bounded.report({ version: 1, details: flood });
    expect(await bounded.finish('completed')).toMatchObject({
      details: Array(TOOL_PROGRESS_LIMITS.nodes - 1).fill(null), truncated: true,
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds sparse array length traversal using only own descriptors, never enumeration or property reads', async () => {
    const array: unknown[] = [];
    array.length = 0xffff_ffff;
    const get = vi.fn(() => { throw new Error('property read'); });
    const ownKeys = vi.fn(() => { throw new Error('enumeration'); });
    const descriptor = vi.fn((target: unknown[], key: string | symbol) => Reflect.getOwnPropertyDescriptor(target, key));
    const proxy = new Proxy(array, { get, ownKeys, getOwnPropertyDescriptor: descriptor });
    const channel = new ToolProgressChannel(call);
    await channel.report({ version: 1, details: proxy as ToolProgressInput['details'] });
    const terminal = await channel.finish('completed');
    expect(terminal!.details).toEqual(Array(TOOL_PROGRESS_LIMITS.nodes - 1).fill(null));
    expect(terminal!.truncated).toBe(true);
    expect(descriptor.mock.calls.map(([, key]) => key)).toEqual([
      'length', ...Array.from({ length: TOOL_PROGRESS_LIMITS.nodes - 1 }, (_, i) => String(i)),
    ]);
    expect(get).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it('explicitly truncates on rejected array length/descriptors and exhausted byte budgets', async () => {
    for (const rejectedKey of ['length', '1']) {
      const proxy = new Proxy(['first', 'second', 'third'], {
        getOwnPropertyDescriptor(target, key) {
          if (key === rejectedKey) throw new Error('descriptor rejected');
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const channel = new ToolProgressChannel(call);
      await channel.report({ version: 1, details: proxy });
      expect(await channel.finish('completed')).toMatchObject({
        details: rejectedKey === 'length' ? [] : ['first'], truncated: true,
      });
    }
    const channel = new ToolProgressChannel(call);
    await channel.report({ version: 1, details: Array(1000).fill('"'.repeat(1000)) });
    const terminal = await channel.finish('completed');
    expect(terminal!.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(terminal!.details))).toBeLessThanOrEqual(TOOL_PROGRESS_LIMITS.detailsBytes);
  });

  it('fails closed rather than leaking credential prefixes at ASCII and UTF-8 clipping boundaries', async () => {
    const credential = 'disposable-boundary-credential';
    const redactor = new CredentialRedactor([credential]);
    for (const unicode of [false, true]) {
      const contentPrefix = unicode
        ? '😀'.repeat((TOOL_PROGRESS_LIMITS.contentBytes - 4) / 4)
        : 'x'.repeat(TOOL_PROGRESS_LIMITS.contentBytes - 4);
      // Root values and object keys each start with eight bytes of bookkeeping.
      const detailsBudget = TOOL_PROGRESS_LIMITS.detailsBytes - 8;
      const detailsPrefix = unicode ? '😀'.repeat((detailsBudget - 4) / 4) : 'x'.repeat(detailsBudget - 4);
      for (const details of [detailsPrefix + credential, { [detailsPrefix + credential]: true }]) {
        const redact = vi.fn((value: string) => redactor.redact(value));
        const channel = new ToolProgressChannel(call, undefined, undefined, redact);
        await channel.report({ version: 1, content: contentPrefix + credential, details });
        const terminal = await channel.finish('completed');
        expect(terminal!.content).toBe('[redacted]');
        expect(terminal!.details).toEqual(typeof details === 'string' ? '[redacted]' : { '[redacted]': true });
        expect(terminal!.truncated).toBe(true);
        // No clipped producer fragment, nor an unbounded original, reaches the scrubber.
        expect(redact).not.toHaveBeenCalled();
        expect(JSON.stringify(terminal)).not.toContain('disp');
      }
    }
  });

  it('redacts complete fitting strings before clipping bounded redactor output', async () => {
    const credential = 'disposable-fitting-credential';
    const redactor = new CredentialRedactor([credential]);
    const redact = vi.fn((value: string) => redactor.redact(value));
    const channel = new ToolProgressChannel(call, undefined, undefined, redact);
    await channel.report({ version: 1, content: credential, details: { [credential]: credential } });
    expect(await channel.finish('completed')).toMatchObject({
      content: '[REDACTED]', details: { '[REDACTED]': '[REDACTED]' },
    });
    expect(redact.mock.calls.map(([value]) => value)).toEqual([credential, credential, credential]);
    const expanded = new ToolProgressChannel(call, undefined, undefined, () => '😀'.repeat(100_000));
    await expanded.report({ version: 1, content: 'safe' });
    const terminal = await expanded.finish('completed');
    expect(Buffer.byteLength(terminal!.content!)).toBe(TOOL_PROGRESS_LIMITS.contentBytes);
    expect(terminal!.content).not.toContain('\uFFFD');
    expect(terminal!.truncated).toBe(true);
  });

  it('ignores invalid versions/accessor fields and suppresses queued/late output on abort', async () => {
    const controller = new AbortController();
    const blocked = gate();
    const sink = vi.fn(async () => { await blocked.promise; });
    const channel = new ToolProgressChannel(call, sink, controller.signal);
    const getter = vi.fn(() => 1);
    await channel.report({ version: 2, content: 'invalid' } as unknown as ToolProgressInput);
    await channel.report({ get version() { return getter(); } } as ToolProgressInput);
    expect(getter).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled();
    void channel.report({ version: 1, content: 'visible' });
    void channel.report({ version: 1, content: 'queued' });
    controller.abort();
    void channel.report({ version: 1, content: 'late' });
    blocked.release();
    const terminal = await channel.finish('cancelled');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(terminal).toMatchObject({ status: 'cancelled', content: 'queued', omittedUpdates: 3 });
    expect(await channel.finish('completed')).toEqual(terminal);
  });

  it('serializes synchronous reentrant producers and observes abort during terminal drain', async () => {
    const controller = new AbortController();
    const blocked = gate();
    const seen: number[] = [];
    let active = 0;
    let maxActive = 0;
    const channel = new ToolProgressChannel(call, async snapshot => {
      active++; maxActive = Math.max(maxActive, active);
      seen.push(snapshot.sequence);
      if (snapshot.sequence === 1) {
        void channel.report({ version: 1, content: 'reentrant' });
        await blocked.promise;
      }
      active--;
    }, controller.signal);
    void channel.report({ version: 1, content: 'first' });
    expect(seen).toEqual([1]);
    const terminal = channel.finish('completed');
    controller.abort(); blocked.release();
    expect(await terminal).toMatchObject({ status: 'cancelled', content: 'reentrant', sequence: 3 });
    expect(seen).toEqual([1]); expect(maxActive).toBe(1);
  });

  it('contains sink rejection even if producers ignore Promises, exposing failure for durable settlement', async () => {
    const error = new Error('sink failed');
    const sink = vi.fn(async () => { throw error; });
    const channel = new ToolProgressChannel(call, sink);
    void channel.report({ version: 1, content: 'first' });
    await channel.finish('failed');
    await channel.report({ version: 1, content: 'late' });
    expect(channel.failure).toBe(error);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
