import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '../providers/index.js';
import type { Message } from '../types/index.js';
import { assertCompactionTranscript, readCompactionSummary } from './compaction-generation.js';

const messages = (content = ''): Message[] => [{ id: 'm', role: 'user', content, timestamp: new Date(0) }];
const transcript = (value: unknown): void => assertCompactionTranscript(value as Message[]);
const summary = (value: unknown): string => readCompactionSummary(value as ChatResponse);
const inputError = 'Compaction transcript is invalid or exceeds 2000000 bytes.';
const outputError = 'Compaction did not produce a complete bounded text summary.';

describe('compaction generation transcript bounds', () => {
  it('accepts the exact serialized UTF-8 boundary and refuses the next byte', () => {
    const allowance = 2_000_000 - Buffer.byteLength(JSON.stringify(messages()));
    const exact = messages('a'.repeat(allowance));
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(2_000_000);
    expect(() => assertCompactionTranscript(exact)).not.toThrow();
    exact[0].content += 'a'; expect(() => assertCompactionTranscript(exact)).toThrow(inputError);
  });
  it('counts UTF-8 and JSON escapes rather than UTF-16/4', () => {
    const input = messages('😀'.repeat(500_000));
    expect(input[0].content.length).toBe(1_000_000);
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
    expect(() => assertCompactionTranscript(messages('\0'.repeat(333_334)))).toThrow(inputError);
  });
  it('preserves all individually redactor-safe entries in an oversized canonical prefix', () => {
    const input = Array.from({ length: 50 }, (_, index) => ({ ...messages()[0], id: `entry-${index}`, content: 'a'.repeat(50_400) }));
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(2_000_000);
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
  });
  it('counts public nested tool and block fields, without executing toJSON', () => {
    let calls = 0;
    const input = messages('public'); input[0].toolCalls = [{ id: 'call', name: 'read', input: { toJSON() { calls++; return 'small'; }, large: 'a'.repeat(2_000_001) } }];
    expect(() => assertCompactionTranscript(input)).toThrow(inputError); expect(calls).toBe(0);
  });
  it('accepts null-prototype JSON, authentic Dates and omitted undefined record fields', () => {
    const input = messages('public'); input[0].metadata = Object.assign(Object.create(null), { nested: [null, true, 1, undefined], omitted: undefined });
    expect(() => assertCompactionTranscript(input)).not.toThrow();
  });
  it('does not invoke a replacement content accessor', () => {
    let calls = 0; const input = messages(); Object.defineProperty(input[0], 'content', { enumerable: true, get() { calls++; return 'small'; } });
    expect(() => assertCompactionTranscript(input)).toThrow(inputError); expect(calls).toBe(0);
  });
  it('does not invoke replacement array toJSON or Date coercion', () => {
    let calls = 0; const input = messages();
    Object.defineProperty(input, 'toJSON', { get() { calls++; return () => []; } });
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
    const dated = messages(); Object.defineProperty(dated[0].timestamp, 'valueOf', { get() { calls++; return () => 0; } });
    expect(() => assertCompactionTranscript(dated)).toThrow(inputError); expect(calls).toBe(0);
  });
  it.each([NaN, Infinity, 1n, () => 'not data', Symbol('private')])('refuses unsupported nested data %s', value => {
    const input = messages(); input[0].metadata = { value };
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
  });
  it('refuses cycles while allowing repeated independent references', () => {
    const shared = { public: 'value' }, input = messages(); input[0].metadata = { a: shared, b: shared };
    expect(() => assertCompactionTranscript(input)).not.toThrow(); shared.public = shared as unknown as string;
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
  });
  it('refuses sparse/inherited indices, invalid Dates and foreign objects', () => {
    expect(() => transcript(new Array(1))).toThrow(inputError);
    const input = messages(); input[0].timestamp = new Date(NaN);
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
    input[0].metadata = { foreign: new Map() }; input[0].timestamp = new Date(0);
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
  });
  it('bounds depth and total node work', () => {
    let nested: unknown = 'public'; for (let i = 0; i < 40; i++) nested = { nested };
    const input = messages(); input[0].metadata = { nested };
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
    input[0].metadata = { values: Array.from({ length: 65_536 }, () => null) };
    expect(() => assertCompactionTranscript(input)).toThrow(inputError);
  });
  it('does not mutate caller arrays, nested fields or Date values', () => {
    const input = messages('public'); input[0].toolCalls = [{ id: 'c', name: 'tool', input: { public: 'value' } }];
    const before = structuredClone(input); assertCompactionTranscript(input); expect(input).toEqual(before);
  });
});

describe('compaction generation completion bounds', () => {
  it('accepts complete text and exact byte-bound ASCII/Unicode output', () => {
    for (const content of ['complete', 'a'.repeat(16_384), '😀'.repeat(4_096)]) expect(summary({ content, toolCalls: [] })).toBe(content);
  });
  it('preserves original whitespace until redaction', () => { expect(summary({ content: ' secret ' })).toBe(' secret '); });
  it.each(['a'.repeat(16_385), '😀'.repeat(4_097), '', ' \n '])('refuses over-bound or empty text', content => {
    expect(() => summary({ content })).toThrow(outputError);
  });
  it('refuses explicit length exhaustion despite nonempty useful text', () => {
    expect(() => summary({ content: 'useful but incomplete', stopReason: 'length' })).toThrow(outputError);
  });
  it('refuses any tool-producing response without reading tool payloads', () => {
    let calls = 0; const tools = [{}]; Object.defineProperty(tools, '0', { get() { calls++; return {}; } });
    expect(() => summary({ content: 'tool prose', toolCalls: tools })).toThrow(outputError); expect(calls).toBe(0);
  });
  it.each(['content', 'stopReason', 'toolCalls'])('refuses a replacement %s getter without calling it', key => {
    let calls = 0; const value = { content: 'complete' }; Object.defineProperty(value, key, { get() { calls++; return undefined; } });
    expect(() => summary(value)).toThrow(outputError); expect(calls).toBe(0);
  });
  it('ignores unknown fields without granting serialization authority', () => {
    let calls = 0; const value = { content: 'complete', toJSON() { calls++; throw Error('private'); } };
    Object.defineProperty(value, 'legacy', { get() { calls++; throw Error('private'); } });
    expect(summary(value)).toBe('complete'); expect(calls).toBe(0);
  });
});
