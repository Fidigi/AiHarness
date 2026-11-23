import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '../providers/index.js';
import { copyAutomaticCompactionResult, copyCompactionResponse, readCompactionSummary } from './compaction-generation.js';

function inherit(record: object, key: string, value: unknown, accessor: boolean, read: () => void): void {
  Reflect.deleteProperty(record, key);
  const prototype = {};
  Object.defineProperty(prototype, key, accessor
    ? { enumerable: true, get: () => { read(); return value; } }
    : { enumerable: true, value });
  Object.setPrototypeOf(record, prototype);
}

describe('inherited recognized generation fields confer no publication authority', () => {
  it.each(['stopReason', 'toolCalls'].flatMap(field => [false, true].map(accessor => ({ field, accessor }))))(
    'refuses inherited $field (accessor=$accessor) without discarding completion evidence', ({ field, accessor }) => {
      const response: ChatResponse = { content: 'summary' }; let reads = 0;
      inherit(response, field, field === 'stopReason' ? 'length' : [{ id: 'pending', name: 'must_not_run', input: {} }], accessor, () => { reads++; });
      expect(() => readCompactionSummary(response)).toThrow('complete bounded text summary');
      expect(reads).toBe(0);
    });
  it.each(['model', 'usage', 'nested-usage'].flatMap(field => [false, true].map(accessor => ({ field, accessor }))))(
    'refuses inherited provider $field (accessor=$accessor) rather than normalizing it away', ({ field, accessor }) => {
      const response: ChatResponse = { content: 'summary', model: 'mock-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }; let reads = 0;
      const target = field === 'nested-usage' ? response.usage! : response;
      inherit(target, field === 'nested-usage' ? 'promptTokens' : field,
        field === 'nested-usage' ? 2 : field === 'model' ? 'mock-model' : response.usage, accessor, () => { reads++; });
      expect(() => copyCompactionResponse(response)).toThrow('complete bounded text summary');
      expect(reads).toBe(0);
    });
  it.each(['provider', 'model', 'usage', 'nested-usage'].flatMap(field => [false, true].map(accessor => ({ field, accessor }))))(
    'refuses inherited automatic $field (accessor=$accessor) without inventing empty accounting', ({ field, accessor }) => {
      const result = { summary: 'summary', provider: 'mock', model: 'mock-model', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }; let reads = 0;
      const target = field === 'nested-usage' ? result.usage : result;
      inherit(target, field === 'nested-usage' ? 'inputTokens' : field,
        field === 'nested-usage' ? 2 : field === 'provider' ? 'mock' : field === 'model' ? 'mock-model' : result.usage, accessor, () => { reads++; });
      expect(() => copyAutomaticCompactionResult(result)).toThrow('complete bounded text summary');
      expect(reads).toBe(0);
    });
  it.each(['legacy', 'toJSON'].flatMap(field => ['provider', 'automatic'].map(adapter => ({ field, adapter }))))(
    'ignores unrelated inherited $field on $adapter output without execution', ({ field, adapter }) => {
      const response: ChatResponse = { content: 'summary' }, result = { summary: 'summary' }; let reads = 0;
      inherit(adapter === 'provider' ? response : result, field, () => ({ content: 'FORGED' }), true, () => { reads++; });
      expect(adapter === 'provider' ? copyCompactionResponse(response) : copyAutomaticCompactionResult(result))
        .toEqual(adapter === 'provider' ? { content: 'summary' } : { summary: 'summary' });
      expect(reads).toBe(0);
    });
});
