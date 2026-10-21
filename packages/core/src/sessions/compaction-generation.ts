import type { ChatResponse } from '../providers/index.js';
import type { Message } from '../types/index.js';
import type { AutoCompactionResult, SessionEntry } from './session-manager.js';
import { copyBranchSummaryOutput } from './session-branch-summary.js';

const MAX_TRANSCRIPT_BYTES = 2_000_000;
const MAX_SUMMARY_BYTES = 16_384;
const MAX_TRANSCRIPT_NODES = 65_536;
const MAX_TRANSCRIPT_DEPTH = 32;
const dateValue = Date.prototype.getTime;
const dateString = Date.prototype.toISOString;

/** Copy only complete, own-data provider fields before an owning redactor can serialize them. */
export function copyCompactionResponse(response: ChatResponse): ChatResponse {
  const fail = (): never => { throw new Error('Compaction did not produce a complete bounded text summary.'); };
  const content = readCompactionSummary(response);
  const own = (record: object, key: string): unknown => {
    const property = Object.getOwnPropertyDescriptor(record, key);
    if (!property) {
      if (key in record) return fail();
      return undefined;
    }
    if (!('value' in property)) return fail();
    return property.value;
  };
  const model = own(response, 'model'), provider = own(response, 'provider'), rawUsage = own(response, 'usage');
  if (provider !== undefined && (typeof provider !== 'string' || !provider.trim() || Buffer.byteLength(provider) > 128)) return fail();
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || Buffer.byteLength(model) > 4096)) return fail();
  let usage: ChatResponse['usage'];
  if (rawUsage !== undefined) {
    if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) return fail();
    usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (const key of ['promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'] as const) {
      const item = own(rawUsage, key);
      if (item !== undefined) {
        if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) return fail();
        usage[key] = item;
      }
    }
  }
  return { content, ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}), ...(usage ? { usage } : {}) };
}

/** Internal legacy result adapter: ignored fields never gain serialization authority. */
export function copyAutomaticCompactionResult(value: unknown): AutoCompactionResult {
  const fail = (): never => { throw new Error('Compaction did not produce a complete bounded text summary.'); };
  const source: unknown = typeof value === 'string' ? { summary: value } : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return fail();
  const own = (record: object, key: string): unknown => {
    const property = Object.getOwnPropertyDescriptor(record, key);
    if (!property) {
      if (key in record) return fail();
      return undefined;
    }
    if (!('value' in property)) return fail();
    return property.value;
  };
  const result: Record<string, unknown> = {};
  for (const key of ['summary', 'provider', 'model', 'usage']) {
    const item = own(source, key);
    if (item !== undefined) result[key] = item;
  }
  if (result.usage !== undefined) {
    if (!result.usage || typeof result.usage !== 'object' || Array.isArray(result.usage)) return fail();
    const usage: Record<string, unknown> = {};
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd']) {
      const item = own(result.usage, key);
      if (item !== undefined) usage[key] = item;
    }
    result.usage = usage;
  }
  try { return copyBranchSummaryOutput(result, MAX_SUMMARY_BYTES); }
  catch { return fail(); }
}

/** Validate an owned canonical prefix before redaction or provider work. This is not a wire/token estimate. */
export function assertCompactionTranscript(messages: readonly (Message | SessionEntry)[]): void {
  const fail = (): never => { throw new Error('Compaction transcript is invalid or exceeds 2000000 bytes.'); };
  if (!Array.isArray(messages)) return fail();
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const add = (count: number): void => { bytes += count; if (bytes > MAX_TRANSCRIPT_BYTES) fail(); };
  const text = (value: string): void => {
    if (Buffer.byteLength(value) > MAX_TRANSCRIPT_BYTES - bytes) fail();
    add(Buffer.byteLength(JSON.stringify(value)));
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > MAX_TRANSCRIPT_NODES || depth > MAX_TRANSCRIPT_DEPTH) fail();
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { text(value); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(Buffer.byteLength(JSON.stringify(value))); return; }
    if (typeof value !== 'object' || !value || active.has(value)) return fail();
    if (value instanceof Date) {
      if (Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length) return fail();
      const timestamp = dateValue.call(value);
      if (!Number.isFinite(timestamp)) return fail();
      text(dateString.call(new Date(timestamp))); return;
    }
    // Non-callable data named toJSON is ordinary JSON, not serialization authority.
    const serializer = Object.getOwnPropertyDescriptor(value, 'toJSON');
    if (serializer && (!('value' in serializer) || typeof serializer.value === 'function')) return fail();
    active.add(value);
    try {
      if (Array.isArray(value)) {
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== null && prototype !== Array.prototype) return fail();
        const length = Object.getOwnPropertyDescriptor(value, 'length');
        if (!length || !('value' in length) || !Number.isSafeInteger(length.value)
          || length.value < 0 || length.value > MAX_TRANSCRIPT_NODES) return fail();
        add(2 + Math.max(0, length.value - 1));
        for (let index = 0; index < length.value; index++) {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          if (!property || !('value' in property)) return fail();
          if (property.value === undefined) add(4);
          else visit(property.value, depth + 1);
        }
      } else {
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== null && prototype !== Object.prototype) return fail();
        add(2); let count = 0;
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== 'string') return fail();
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (!property || !('value' in property)) return fail();
          if (!property.enumerable || property.value === undefined) continue;
          if (count++) add(1);
          text(key); add(1); visit(property.value, depth + 1);
        }
      }
    } finally { active.delete(value); }
  };
  visit(messages, 0);
}

/** Read only own-data completion fields; never call provider accessors or toJSON. */
export function readCompactionSummary(response: Pick<ChatResponse, 'content' | 'stopReason' | 'toolCalls'>): string {
  const fail = (): never => { throw new Error('Compaction did not produce a complete bounded text summary.'); };
  if (!response || typeof response !== 'object' || Array.isArray(response)) return fail();
  const read = (key: string): unknown => {
    const property = Object.getOwnPropertyDescriptor(response, key);
    if (!property) {
      if (key in response) return fail();
      return undefined;
    }
    if (!('value' in property)) return fail();
    return property.value;
  };
  const content = read('content'), stopReason = read('stopReason'), tools = read('toolCalls');
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_SUMMARY_BYTES
    || stopReason !== undefined) return fail();
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return fail();
    const length = Object.getOwnPropertyDescriptor(tools, 'length');
    if (!length || !('value' in length) || length.value !== 0) return fail();
  }
  // Keep whitespace until the owning redactor has seen the entire original secret.
  return content;
}
