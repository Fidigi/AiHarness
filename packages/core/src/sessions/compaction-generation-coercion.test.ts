import { describe, expect, it } from 'vitest';
import { assertCompactionTranscript } from './compaction-generation.js';

describe('transcript serialization authority', () => {
  it('refuses a nonenumerable own toJSON replacement without evaluating it', () => {
    let calls = 0; const message = { id: 'public', role: 'user' as const, content: 'small permitted input', timestamp: new Date(0) };
    Object.defineProperty(message, 'toJSON', { value: () => { calls++; return { content: 'x'.repeat(2_000_001) }; } });
    // Genuine controlled serialization demonstrates why ignoring this property is unsafe.
    expect(Buffer.byteLength(JSON.stringify([message]))).toBeGreaterThan(2_000_000); expect(calls).toBe(1); calls = 0;
    expect(() => assertCompactionTranscript([message])).toThrow('transcript is invalid'); expect(calls).toBe(0);
  });
  it('accepts non-callable own toJSON data without granting serialization authority', () => {
    for (const value of [undefined, null, false, 0, 'PUBLIC_DATA_KEY', { nested: ['public'] }]) {
      for (const container of [{}, [], Object.create(null) as Record<string, unknown>]) {
        for (const enumerable of [true, false]) {
          const data = Array.isArray(container) ? [] : Object.create(Object.getPrototypeOf(container)) as Record<string, unknown>;
          Object.defineProperty(data, 'toJSON', { value, enumerable });
          const message = { id: 'public', role: 'user' as const, content: 'permitted input', timestamp: new Date(0), metadata: { data } };
          expect(() => JSON.stringify([message])).not.toThrow();
          expect(() => assertCompactionTranscript([message])).not.toThrow();
        }
      }
    }
  });

  it('keeps an unrelated nonenumerable local function outside JSON authority', () => {
    let calls = 0; const message = { id: 'public', role: 'user' as const, content: 'small permitted input', timestamp: new Date(0) };
    Object.defineProperty(message, 'localOnly', { value: () => { calls++; return 'ignored'; } });
    expect(() => assertCompactionTranscript([message])).not.toThrow(); expect(calls).toBe(0);
  });
});
