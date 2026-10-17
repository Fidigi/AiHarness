import type { BeforeProviderData } from '../extensions/extension-registry.js';
import type { Message } from '../types/index.js';
import { captureProviderOptionSlots, ProviderRequestOptionsError } from './provider-request-options.js';

const DateConstructor = Date;
const dateTime = Date.prototype.getTime;
const dateIso = Date.prototype.toISOString;
const stringify = JSON.stringify;
const OMIT = Symbol('unsupported legacy data');
const MODEL = new Set(['role', 'content', 'blocks', 'toolCalls', 'toolCallId', 'name']);
const IDENTITY = new Set(['id', 'parentMessageId', 'agentId', 'timestamp']);
const fail = (): never => { throw new ProviderRequestOptionsError(); };
const put = (target: object, key: PropertyKey, value: unknown): void => {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
};
function record(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value;
}
function own(value: object, key: string, required = false): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property) { if (required || key in value) return fail(); return undefined; }
  if (!('value' in property)) return fail();
  return property.value;
}
function labels(value: object): Pick<BeforeProviderData, 'provider' | 'model'> {
  const provider = own(value, 'provider', true), model = own(value, 'model');
  if (typeof provider !== 'string' || (model !== undefined && typeof model !== 'string')) return fail();
  return { provider, ...(model !== undefined ? { model } : {}) };
}

/** Passive display labels only; never a provider/model/source admission capability. */
export function captureProviderCallLabels(value: unknown): Pick<BeforeProviderData, 'provider' | 'model'> {
  try { return labels(record(value)); } catch { return fail(); }
}

/**
 * Snapshot before extensible JSON redaction, then snapshot its result again.
 * Call only after the awaited mutable before/start observers have settled.
 * Getters and executable serializers never enter the redactor's model input.
 * Do not freeze callbacks' arrays or mutate their original payload/objects.
 *
 * The caller separately owns signal lifetime/brand before exposing callbacks.
 * The borrowed numeric-thinking map is deliberately not serialized by a JSON
 * redactor: unused legacy fields must not gain serialization authority. Native
 * numeric consumers still validate their own used fields. This helper does not
 * certify native defaults/thinking expansion, media cost or dispatch authority.
 */
export function redactProviderPayload(
  value: unknown,
  redact: <T>(input: T) => T,
  signal?: AbortSignal,
): BeforeProviderData {
  return prepareProviderPayload(value, redact, signal).data;
}

/** Numeric evidence is separate from redactor-editable input, not a dispatch lease. */
export interface PreparedProviderPayload {
  readonly data: BeforeProviderData;
  readonly requestedMaxTokens?: number;
}

export function prepareProviderPayload(
  value: unknown,
  redact: <T>(input: T) => T,
  signal?: AbortSignal,
): Readonly<PreparedProviderPayload> {
  try {
    const first = snapshot(value, signal), hasBudgets = Object.hasOwn(first.options, 'thinkingBudgets');
    const budgets = first.options.thinkingBudgets, requestedMaxTokens = first.options.maxTokens;
    delete first.options.signal;
    delete first.options.thinkingBudgets;
    const input = copier().value(first, false) as BeforeProviderData;
    const result = snapshot(redact(input), signal);
    delete result.options.signal;
    delete result.options.thinkingBudgets;
    const final = copier().value(result, false) as BeforeProviderData;
    put(final.options, 'signal', signal);
    // A JSON redactor does not own operational signal or opaque budget bindings.
    if (hasBudgets) put(final.options, 'thinkingBudgets', budgets);
    return Object.freeze({ data: final, ...(requestedMaxTokens !== undefined ? { requestedMaxTokens } : {}) });
  } catch { return fail(); }
}

/** Prepare owned callback input without redaction; no publication/dispatch authority. */
export function captureProviderMessages(value: unknown): Message[] {
  try { return copier().value(copier().messages(value), false) as Message[]; } catch { return fail(); }
}

function snapshot(value: unknown, signal?: AbortSignal): BeforeProviderData {
  const source = record(value), metadata = labels(source), copy = copier();
  const slots = captureProviderOptionSlots(own(source, 'options', true), signal);
  const options = {} as BeforeProviderData['options'];
  for (const key of Reflect.ownKeys(slots)) {
    if (key === 'signal' || key === 'thinkingBudgets') { put(options, key, Object.getOwnPropertyDescriptor(slots, key)!.value); continue; }
    const property = Object.getOwnPropertyDescriptor(slots, key)!;
    const item = copy.value(property.value, key === 'tools');
    if (item !== OMIT) put(options, key, item);
  }
  return { ...metadata, messages: copy.messages(own(source, 'messages', true)), options };
}

function copier(): { value: (value: unknown, strict: boolean) => unknown; messages: (value: unknown) => Message[] } {
  let nodes = 0, bytes = 0;
  const visiting = new Set<object>();
  const add = (count: number): void => { bytes += count; if (bytes > 64 * 1024 * 1024) fail(); };
  const text = (value: string): void => {
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024 * 1024 - bytes) fail();
    add(Buffer.byteLength(stringify(value), 'utf8'));
  };
  const clone = (value: unknown, strict: boolean, depth: number): unknown => {
    if (++nodes > 65_536 || depth > 32) return fail();
    if (value === undefined) return undefined;
    if (value === null || typeof value === 'boolean') { add(value === null ? 4 : value ? 4 : 5); return value; }
    if (typeof value === 'string') { text(value); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return strict ? fail() : OMIT;
      add(String(value).length); return value;
    }
    if (typeof value === 'function') return strict ? fail() : value;
    if (typeof value !== 'object' || !value) return strict ? fail() : OMIT;
    if (visiting.has(value)) return strict ? fail() : OMIT;
    if (value instanceof DateConstructor) {
      if (Object.getPrototypeOf(value) !== DateConstructor.prototype || Reflect.ownKeys(value).length) return strict ? fail() : OMIT;
      const time = dateTime.call(value);
      if (!Number.isFinite(time)) return strict ? fail() : OMIT;
      text(dateIso.call(value)); return new DateConstructor(time);
    }
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype && prototype !== null : prototype !== Object.prototype && prototype !== null) return strict ? fail() : OMIT;
    const serializer = Object.getOwnPropertyDescriptor(value, 'toJSON');
    if (strict && (serializer ? !('value' in serializer) || typeof serializer.value === 'function' : 'toJSON' in value)) return fail();
    visiting.add(value);
    try {
      add(2);
      if (array) {
        const length = own(value, 'length', true);
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 65_536) return fail();
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const item = clone(own(value, String(index), true), strict, depth + 1);
          if (index) add(1);
          if (item === OMIT || item === undefined || typeof item === 'function') add(4);
          result.push(item === OMIT ? undefined : item);
        }
        return result;
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length > 65_536) return fail();
      const result: Record<string, unknown> = {}; let count = 0;
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !property?.enumerable) continue;
        if (!('value' in property)) { if (strict) return fail(); continue; }
        if (key === 'toJSON' && typeof property.value === 'function') continue;
        const item = clone(property.value, strict, depth + 1);
        if (item === OMIT) continue;
        if (item !== undefined && typeof item !== 'function') { if (count++) add(1); text(key); add(1); }
        put(result, key, item);
      }
      return result;
    } finally { visiting.delete(value); }
  };
  const message = (value: unknown): Message => {
    const source = record(value), role = own(source, 'role', true), content = own(source, 'content', true);
    if (typeof role !== 'string' || !['system', 'user', 'assistant', 'tool'].includes(role) || typeof content !== 'string') return fail();
    const result: Record<string, unknown> = {};
    // Inherited recognized presence must not silently disappear during enumeration.
    for (const key of [...MODEL, ...IDENTITY]) own(source, key, key === 'role' || key === 'content');
    const keys = Reflect.ownKeys(source); if (keys.length > 65_536) return fail();
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const property = Object.getOwnPropertyDescriptor(source, key);
      if (!property || !('value' in property) || (!property.enumerable && !MODEL.has(key) && !IDENTITY.has(key))) continue;
      if (key === 'toJSON' && typeof property.value === 'function') continue;
      const item = clone(property.value, MODEL.has(key) || IDENTITY.has(key), 0);
      if (item !== OMIT) put(result, key, item);
    }
    return result as unknown as Message;
  };
  const messages = (value: unknown): Message[] => {
    if (!Array.isArray(value)) return fail();
    const length = own(value, 'length', true);
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 65_536) return fail();
    const result: Message[] = [];
    for (let index = 0; index < length; index++) {
      if (++nodes > 65_536) return fail();
      result.push(message(own(value, String(index), true)));
    }
    return result;
  };
  return { value: (value, strict) => clone(value, strict, 0), messages };
}
