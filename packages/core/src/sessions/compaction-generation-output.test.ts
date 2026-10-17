import { describe, expect, it } from 'vitest';
import { copyAutomaticCompactionResult } from './compaction-generation.js';

describe('owned legacy automatic compaction output', () => {
  it('accepts a complete exact-bound string', () => {
    const summary = 'x'.repeat(16_384);
    expect(copyAutomaticCompactionResult(summary)).toEqual({ summary });
  });
  it('copies null-prototype output and conserved zero counters', () => {
    const usage = Object.assign(Object.create(null) as Record<string, unknown>, { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const input = Object.assign(Object.create(null) as Record<string, unknown>, { summary: 'summary', provider: 'mock', model: 'mock-model', usage });
    expect(copyAutomaticCompactionResult(input)).toEqual({ summary: 'summary', provider: 'mock', model: 'mock-model', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  });
  it('preserves original whitespace for the owning redactor', () => {
    expect(copyAutomaticCompactionResult(' secret with whitespace ').summary).toBe(' secret with whitespace ');
  });
  it('refuses one byte over the output boundary', () => {
    expect(() => copyAutomaticCompactionResult('x'.repeat(16_385))).toThrow('complete bounded text summary');
  });
  it.each(['summary', 'provider', 'model', 'usage'])('does not evaluate the recognized %s accessor', key => {
    const input = { summary: 'summary' }; let reads = 0;
    Object.defineProperty(input, key, { enumerable: true, get: () => { reads++; return 'unauthorized'; } });
    expect(() => copyAutomaticCompactionResult(input)).toThrow('complete bounded text summary');
    expect(reads).toBe(0);
  });
  it.each(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'])('does not evaluate a recognized usage.%s accessor', key => {
    const usage = {}; let reads = 0;
    Object.defineProperty(usage, key, { enumerable: true, get: () => { reads++; return 1; } });
    expect(() => copyAutomaticCompactionResult({ summary: 'summary', usage })).toThrow('complete bounded text summary');
    expect(reads).toBe(0);
  });
  it('ignores unknown top-level and usage getters and toJSON without granting serialization authority', () => {
    let reads = 0; const usage = { inputTokens: 2, outputTokens: 1 };
    const input = { summary: 'summary', usage };
    for (const object of [input, usage]) for (const key of ['legacy', 'toJSON']) Object.defineProperty(object, key, { enumerable: true, get: () => { reads++; throw new Error('must not execute'); } });
    expect(copyAutomaticCompactionResult(input)).toEqual({ summary: 'summary', usage: { inputTokens: 2, outputTokens: 1 } });
    expect(reads).toBe(0);
  });
  it.each([NaN, Infinity, -1])('refuses invalid usage counter %s', inputTokens => {
    expect(() => copyAutomaticCompactionResult({ summary: 'summary', usage: { inputTokens } })).toThrow('complete bounded text summary');
  });
  it('leaves valid fractional accounting for the existing persistence normalizer', () => {
    expect(copyAutomaticCompactionResult({ summary: 'summary', usage: { inputTokens: 2.5, costUsd: 0.125 } })).toEqual({ summary: 'summary', usage: { inputTokens: 2.5, costUsd: 0.125 } });
  });
});
