import { describe, expect, it } from 'vitest';
import { rememberRetirement, remembersRetirement, mergeRetirements, type RetirementFilter } from './run-retirement-filter.js';

describe('fixed-size conservative retirement memory', () => {
  it('keeps every retired key after churn with exactly thirty-two immutable words', () => {
    let filter: RetirementFilter | undefined;
    const keys = Array.from({ length: 10_000 }, (_, i) => JSON.stringify(['session', 'retired-' + i]));
    for (const key of keys) filter = rememberRetirement(filter, key);
    expect(filter).toHaveLength(32);
    expect(Object.isFrozen(filter)).toBe(true);
    for (const key of keys) expect(remembersRetirement(filter, key)).toBe(true);
  });
  it('never mutates an old guard-owned filter while adding or merging', () => {
    const first = rememberRetirement(undefined, 'first');
    const original = [...first];
    const second = rememberRetirement(first, 'second');
    const merged = mergeRetirements(first, second);
    expect(first).toEqual(original);
    expect(remembersRetirement(merged, 'first')).toBe(true);
    expect(remembersRetirement(merged, 'second')).toBe(true);
    expect(merged).toHaveLength(32);
    expect(Object.isFrozen(merged)).toBe(true);
  });
  it('keeps tuple boundaries while accepting prototype-like literal IDs', () => {
    for (const id of ['__proto__', 'constructor', 'toString']) {
      const filter = rememberRetirement(undefined, JSON.stringify([id, 'run']));
      expect(remembersRetirement(filter, JSON.stringify([id, 'run']))).toBe(true);
    }
    expect(JSON.stringify(['a:b', 'c'])).not.toBe(JSON.stringify(['a', 'b:c']));
  });
  it('has no authority when absent and admits conservative saturation as a recovery signal', () => {
    expect(remembersRetirement(undefined, 'unknown')).toBe(false);
    const saturated = Object.freeze(Array<number>(32).fill(0xffffffff));
    expect(remembersRetirement(saturated, 'new-key')).toBe(true);
  });
});
