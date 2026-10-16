import type { Message } from '../types/index.js';
import type { BranchSummaryAccounting } from './session-manager.js';
import type { BranchSummaryEvent, BranchSummaryOutput } from './branch-summarization.js';

/** Shared validation for manual, provider-generated and extension-overridden provenance. */
export function copyBranchSummaryAccounting(value: BranchSummaryAccounting): BranchSummaryAccounting {
  const fail = (): never => { throw new Error('Branch summary accounting is invalid.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result: BranchSummaryAccounting = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'provider' && key !== 'model' && key !== 'usage') return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return fail();
    const item: unknown = descriptor.value;
    if (item === undefined) continue;
    if (key !== 'usage') {
      if (typeof item !== 'string' || !item || item.length > 4_096 || Buffer.byteLength(item) > 4_096
        || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(item)) return fail();
      result[key] = item;
    } else {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return fail();
      const usage: NonNullable<Message['usage']> = {};
      for (const field of Reflect.ownKeys(item)) {
        if (field !== 'inputTokens' && field !== 'outputTokens' && field !== 'cacheReadTokens'
          && field !== 'cacheWriteTokens' && field !== 'totalTokens' && field !== 'costUsd') return fail();
        const property = Object.getOwnPropertyDescriptor(item, field);
        if (!property || !('value' in property)) return fail();
        const counter: unknown = property.value;
        if (counter === undefined) continue;
        if (typeof counter !== 'number' || !Number.isFinite(counter) || counter < 0) return fail();
        usage[field] = counter;
      }
      result.usage = usage;
    }
  }
  return result;
}

export function copyBranchSummaryOutput(value: unknown, maxBytes: number): BranchSummaryOutput {
  const fail = (): never => { throw new Error('Branch summary result is invalid.'); };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024
    || !value || typeof value !== 'object' || Array.isArray(value)) return fail();
  let summary: string | undefined;
  const accounting: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'summary' && key !== 'provider' && key !== 'model' && key !== 'usage') return fail();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property)) return fail();
    if (key === 'summary') {
      if (typeof property.value !== 'string' || property.value.length > maxBytes || Buffer.byteLength(property.value) > maxBytes || !property.value.trim()) return fail();
      summary = property.value;
    } else accounting[key] = property.value;
  }
  if (summary === undefined) return fail();
  // Preserve original whitespace until the manager redacts: credentials may contain it.
  return { summary, ...copyBranchSummaryAccounting(accounting) };
}

/** Primitive model-visible transcript only: no private journal data/details or rewrite capability. */
export function copyBranchSummaryEvent(value: BranchSummaryEvent): Readonly<BranchSummaryEvent> {
  const fail = (): never => { throw new Error('Branch summary event is invalid.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'sourceSessionId' && key !== 'fromEntryId' && key !== 'targetEntryId' && key !== 'transcript'
      && key !== 'signal' && key !== 'tokenBudget' && key !== 'maxOutputTokens' && key !== 'maxOutputBytes') return fail();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property)) return fail();
    const item: unknown = property.value;
    if (key === 'sourceSessionId' || key === 'fromEntryId' || key === 'targetEntryId') {
      if (typeof item !== 'string' || !item || item.length > 256 || Buffer.byteLength(item) > 256 || item.includes('\0')) return fail();
    } else if (key === 'transcript') {
      if (typeof item !== 'string' || item.length > 2_000_000 || Buffer.byteLength(item) > 2_000_000) return fail();
    } else if (key === 'signal') {
      if (!(item instanceof AbortSignal)) return fail();
    } else if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1
      || item > (key === 'tokenBudget' ? 2_000_000 : key === 'maxOutputTokens' ? 4_096 : 16_384)) return fail();
    result[key] = item;
  }
  if (Reflect.ownKeys(result).length !== 8 || (result.maxOutputBytes as number) > (result.maxOutputTokens as number) * 4) return fail();
  return Object.freeze(result) as unknown as Readonly<BranchSummaryEvent>;
}
