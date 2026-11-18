import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '../providers/index.js';
import { copyCompactionResponse } from './compaction-generation.js';

describe('owned complete compaction provider response', () => {
  it('copies recognized fields and zero accounting without aliases or unrelated output', () => {
    const response: ChatResponse = { content: 'summary', model: 'mock-model', reasoning: 'not a summary', toolCalls: [], usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const copy = copyCompactionResponse(response);
    expect(copy).toEqual({ content: 'summary', model: 'mock-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(copy).not.toBe(response); expect(copy.usage).not.toBe(response.usage);
    response.usage!.promptTokens = 99; expect(copy.usage?.promptTokens).toBe(2);
  });
  it('accepts null-prototype response and usage records', () => {
    const usage = Object.assign(Object.create(null) as NonNullable<ChatResponse['usage']>, { promptTokens: 2, completionTokens: 1, totalTokens: 3 });
    const response = Object.assign(Object.create(null) as ChatResponse, { content: 'summary', usage });
    expect(copyCompactionResponse(response)).toEqual({ content: 'summary', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
  });
  it('preserves original whitespace for the owner', () => {
    expect(copyCompactionResponse({ content: ' original secret ' }).content).toBe(' original secret ');
  });
  it('does not invent accounting when usage is absent', () => {
    expect(copyCompactionResponse({ content: 'summary' })).toEqual({ content: 'summary' });
  });
  it('accepts an exact 4096-byte response model', () => {
    expect(copyCompactionResponse({ content: 'summary', model: 'x'.repeat(4096) }).model).toHaveLength(4096);
  });
  it.each(['model', 'usage'])('refuses recognized %s accessors without invoking them', key => {
    const response: ChatResponse = { content: 'summary' }; let reads = 0;
    Object.defineProperty(response, key, { enumerable: true, get: () => { reads++; return 'replacement'; } });
    expect(() => copyCompactionResponse(response)).toThrow('complete bounded text summary'); expect(reads).toBe(0);
  });
  it.each(['promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'])('refuses recognized usage.%s accessors without invoking them', key => {
    const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 }; let reads = 0;
    Object.defineProperty(usage, key, { enumerable: true, get: () => { reads++; return 1; } });
    expect(() => copyCompactionResponse({ content: 'summary', usage })).toThrow('complete bounded text summary'); expect(reads).toBe(0);
  });
  it('never grants unknown getters, reasoning or toJSON serialization authority', () => {
    let reads = 0; const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 }, response: ChatResponse = { content: 'summary', usage };
    for (const object of [response, usage]) for (const key of ['legacy', 'reasoning', 'toJSON']) Object.defineProperty(object, key, { enumerable: true, get: () => { reads++; throw new Error('unvalidated code'); } });
    expect(JSON.stringify(copyCompactionResponse(response))).toBe('{"content":"summary","usage":{"promptTokens":2,"completionTokens":1,"totalTokens":3}}'); expect(reads).toBe(0);
  });
  it.each(['', ' ', 'x'.repeat(4097)])('refuses an invalid model (case %#)', model => {
    expect(() => copyCompactionResponse({ content: 'summary', model })).toThrow('complete bounded text summary');
  });
  it.each([-1, NaN, Infinity])('refuses invalid recognized usage %s', promptTokens => {
    expect(() => copyCompactionResponse({ content: 'summary', usage: { promptTokens, completionTokens: 1, totalTokens: 3 } })).toThrow('complete bounded text summary');
  });
  it.each([null, []])('refuses a nonrecord usage value (case %#)', value => {
    const response: ChatResponse = { content: 'summary' }; Object.defineProperty(response, 'usage', { enumerable: true, value });
    expect(() => copyCompactionResponse(response)).toThrow('complete bounded text summary');
  });
});
