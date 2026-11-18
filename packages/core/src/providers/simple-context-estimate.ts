import { isProxy } from 'node:util/types';
import type { ChatOptions } from './index.js';
import type { Message } from '../types/index.js';
import { ProviderOutputBudgetError } from './provider-output-budget.js';

const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function contextJson(value: unknown): string {
  try { return JSON.stringify(value) ?? 'undefined'; } catch { return '[unserializable]'; }
}

/** Consume only inert own data; unrelated usage/metadata fields stay opaque. */
function contextSlot(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (key in value) throw new ProviderOutputBudgetError();
    return undefined;
  }
  if (!('value' in descriptor)) throw new ProviderOutputBudgetError();
  return descriptor.value;
}
function contextCarrier(value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || isProxy(value) || Array.isArray(value)) throw new ProviderOutputBudgetError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ProviderOutputBudgetError();
  return value;
}
function contextScalar(value: object, key: string): unknown {
  const field = contextSlot(value, key);
  if ((typeof field === 'object' && field !== null) || typeof field === 'function') throw new ProviderOutputBudgetError();
  return field;
}

/** Approximate transcript estimate, not vendor tokenization or observed billing. */
export function simpleContextTokens(messages: readonly Message[], options: ChatOptions | undefined): number {
  const initialSystem = Boolean(options?.systemPrompt || options?.tools?.length);
  let tokens = initialSystem ? Math.ceil((options?.systemPrompt?.length ?? 0) / 3.5)
    + (options?.tools?.length ? Math.ceil(contextJson(options.tools).length / 3.5) : 0) : 0;
  let latestPrefix = initialSystem ? 0 : Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const time = message.timestamp.getTime();
    let used: unknown = 0, stopped = false;
    if (message.role === 'assistant' && time >= latestPrefix) {
      const usage = contextCarrier(contextSlot(message, 'usage'));
      if (usage) {
        used = contextScalar(usage, 'totalTokens');
        if (!used) {
          const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => contextScalar(usage, key));
          // Missing counters remain unknown; only a complete sum can replace an absent/zero total.
          used = fields.every(counter) ? fields.reduce<number>((sum, value) => sum + Number(value), 0) : 0;
        }
        if (counter(used) && used > 0) {
          const metadata = contextCarrier(contextSlot(message, 'metadata'));
          const stop = metadata ? contextScalar(metadata, 'stopReason') : undefined;
          stopped = stop === 'error' || stop === 'aborted';
        }
      }
    }
    if (counter(used) && used > 0 && !stopped) tokens = used;
    else {
      let chars = message.content.length;
      for (const block of message.blocks ?? []) {
        if (block.type === 'image' && message.role !== 'assistant') chars += 4800;
        if (block.type === 'reasoning' && message.role === 'assistant') chars += block.text.length;
      }
      if (message.role === 'assistant') for (const call of message.toolCalls ?? []) chars += call.name.length + contextJson(call.input).length;
      tokens += Math.ceil(chars / 3.5);
    }
    latestPrefix = Math.max(latestPrefix, time);
  }
  return tokens;
}
