import type { ChatOptions } from '../providers/index.js';
import type { Message } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';

const dateValue = Date.prototype.getTime;
const dateString = Date.prototype.toISOString;

/** An explicit canonical request policy, not a vendor tokenizer or transport certificate. */
export interface CanonicalProviderRequestEstimate {
  readonly policy: 'canonical-json-utf8/4-v1';
  readonly bytes: number;
  readonly estimatedTokens: number;
  /** Encoded media does not establish its model token cost. */
  readonly unknownMedia: boolean;
}

/**
 * Estimate the owned, model-bearing canonical representation only. History IDs,
 * billed usage, private metadata and response options are not model input.
 * This pure helper supplies neither publication nor provider-dispatch authority.
 * Dialect body projection and unknown-media policy still belong to the owner.
 */
export function estimateCanonicalProviderRequest(
  messages: readonly Message[],
  options: Pick<ChatOptions, 'systemPrompt' | 'tools'> = {},
): CanonicalProviderRequestEstimate {
  const fail = (): never => { throw new Error('Provider request cannot be measured by the canonical JSON policy.'); };
  const own = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property) {
      if (key in value) return fail();
      return undefined;
    }
    if (!('value' in property)) return fail();
    return property.value;
  };
  const array = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) return fail();
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value)
      || length.value < 0 || length.value > 65_536) return fail();
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item || !('value' in item)) return fail();
      result.push(item.value);
    }
    return result;
  };
  let unknownMedia = false;
  const projected = array(messages).map(message => {
    const role = own(message, 'role'), content = own(message, 'content');
    if (typeof role !== 'string' || !['user', 'assistant', 'system', 'tool'].includes(role) || typeof content !== 'string') return fail();
    const result: Record<string, unknown> = { role, content };
    for (const key of ['blocks', 'toolCalls', 'toolCallId', 'name'] as const) {
      const item = own(message, key);
      if (item === undefined) continue;
      if (key === 'blocks') {
        for (const block of array(item)) if (own(block, 'type') === 'image') unknownMedia = true;
      }
      if (key === 'toolCalls') array(item);
      if ((key === 'name' || key === 'toolCallId') && typeof item !== 'string') return fail();
      result[key] = item;
    }
    return result;
  });
  const system = own(options, 'systemPrompt');
  if (system !== undefined && typeof system !== 'string') return fail();
  const rawTools = own(options, 'tools');
  const tools = rawTools === undefined ? [] : array(rawTools).map(tool => {
    const name = own(tool, 'name'), description = own(tool, 'description'), parameters = own(tool, 'parameters');
    if (typeof name !== 'string' || typeof description !== 'string'
      || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return fail();
    return { name, description, parameters };
  });
  const wire = { messages: projected, systemPrompt: system ?? '', tools };
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const add = (value: number): void => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 64 * 1024 * 1024 - bytes) return fail();
    bytes += value;
  };
  const text = (value: string): void => {
    if (Buffer.byteLength(value) > 64 * 1024 * 1024 - bytes) return fail();
    add(Buffer.byteLength(JSON.stringify(value)));
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 65_536 || depth > 32) return fail();
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { text(value); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(Buffer.byteLength(JSON.stringify(value))); return; }
    if (!value || typeof value !== 'object' || active.has(value)) return fail();
    if (value instanceof Date) {
      if (Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length) return fail();
      const timestamp = dateValue.call(value);
      if (!Number.isFinite(timestamp)) return fail();
      text(dateString.call(new Date(timestamp))); return;
    }
    const serializer = Object.getOwnPropertyDescriptor(value, 'toJSON');
    if (serializer ? !('value' in serializer) || typeof serializer.value === 'function' : 'toJSON' in value) return fail();
    active.add(value);
    try {
      if (Array.isArray(value)) {
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Array.prototype && prototype !== null) return fail();
        const items = array(value);
        add(2 + Math.max(0, items.length - 1));
        for (const item of items) { if (item === undefined) add(4); else visit(item, depth + 1); }
      } else {
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return fail();
        add(2); let count = 0;
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== 'string') return fail();
          const item = Object.getOwnPropertyDescriptor(value, key);
          if (!item || !('value' in item)) return fail();
          if (!item.enumerable || item.value === undefined) continue;
          if (count++) add(1);
          text(key); add(1); visit(item.value, depth + 1);
        }
      }
    } finally { active.delete(value); }
  };
  visit(wire, 0);
  return { policy: 'canonical-json-utf8/4-v1', bytes, estimatedTokens: Math.ceil(bytes / 4), unknownMedia };
}

export interface ProviderRequestBudget {
  readonly contextWindow: number;
  readonly reserveTokens: number;
}

/** A local admission refusal is not a failed provider attempt and must not be retried unchanged. */
export class ProviderRequestContextError extends Error {
  constructor(readonly kind: 'invalid' | 'overflow' | 'unmeasurable' | 'stale') {
    super(kind === 'invalid' ? 'Provider request context budget is invalid.'
      : kind === 'overflow' ? 'Provider request exceeds the owned context budget.'
      : kind === 'stale' ? 'Provider request context budget changed.'
      : 'Provider request cannot be measured by the canonical JSON policy.');
    this.name = 'ProviderRequestContextError';
  }
}

// Internal owner authority is not serialized or supplied by a caller's plain policy.
const budgetChecks = new WeakMap<object, () => void>();

/** Capture existing manager policy without adding a capability to borrowed stores/providers. */
export function captureManagerProviderBudget(manager: Pick<SessionManager,
  'getCompactionContextWindow' | 'getCompactionSettings'>): Readonly<ProviderRequestBudget> | undefined {
  const getWindow = manager.getCompactionContextWindow.bind(manager);
  const contextWindow = getWindow();
  if (contextWindow === undefined) return undefined;
  const getSettings = manager.getCompactionSettings.bind(manager);
  const reserve = (): unknown => {
    const settings: unknown = getSettings();
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new ProviderRequestContextError('invalid');
    const property = Object.getOwnPropertyDescriptor(settings, 'reserveTokens');
    if (!property || !('value' in property)) throw new ProviderRequestContextError('invalid');
    return property.value;
  };
  const budget = captureProviderRequestBudget({ contextBudget: { contextWindow, reserveTokens: reserve() } });
  if (!budget) throw new ProviderRequestContextError('invalid');
  budgetChecks.set(budget, () => {
    if (getWindow() !== budget.contextWindow) throw new ProviderRequestContextError('stale');
    if (reserve() !== budget.reserveTokens) throw new ProviderRequestContextError('stale');
  });
  return budget;
}

/** Capture new optional policy before extensible observers; never read recognized accessors. */
export function captureProviderRequestBudget(options: object): Readonly<ProviderRequestBudget> | undefined {
  const fail = (): never => { throw new ProviderRequestContextError('invalid'); };
  const own = (record: object, key: string): unknown => {
    const property = Object.getOwnPropertyDescriptor(record, key);
    if (!property) { if (key in record) return fail(); return undefined; }
    if (!('value' in property)) return fail();
    return property.value;
  };
  const source = own(options, 'contextBudget');
  if (source === undefined) return undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return fail();
  const contextWindow = own(source, 'contextWindow'), reserveTokens = own(source, 'reserveTokens');
  if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow < 1
    || typeof reserveTokens !== 'number' || !Number.isSafeInteger(reserveTokens) || reserveTokens < 0) return fail();
  const budget = Object.freeze({ contextWindow, reserveTokens });
  const check = budgetChecks.get(source);
  if (check) budgetChecks.set(budget, check);
  return budget;
}

/**
 * Prototype canonical-policy guard. Unknown media remains unmeasured rather than
 * silently becoming zero-cost; only independently known non-message overhead can
 * authorize refusal in that case. This is NOT complete dialect/media admission.
 */
export function assertProviderRequestBudget(messages: readonly Message[],
  options: Pick<ChatOptions, 'systemPrompt' | 'tools' | 'maxTokens'>, budget: Readonly<ProviderRequestBudget>,
  minimumOutputTokens = 0): void {
  const owned = captureProviderRequestBudget({ contextBudget: budget });
  if (!owned) throw new ProviderRequestContextError('invalid');
  const check = budgetChecks.get(owned);
  check?.();
  let reserve: number;
  try {
    if (!Number.isSafeInteger(minimumOutputTokens) || minimumOutputTokens < 0) throw new Error();
    const property = Object.getOwnPropertyDescriptor(options, 'maxTokens');
    if (property ? !('value' in property) : 'maxTokens' in options) throw new Error();
    const requested: unknown = property?.value;
    if (requested !== undefined && (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1)) throw new Error();
    reserve = Math.max(owned.reserveTokens, minimumOutputTokens, requested === undefined ? 0 : requested as number);
  } catch { throw new ProviderRequestContextError('invalid'); }
  // Removing input cannot make an impossible requested output ceiling fit.
  if (reserve > owned.contextWindow) throw new ProviderRequestContextError('overflow');
  let estimate: CanonicalProviderRequestEstimate;
  try {
    estimate = estimateCanonicalProviderRequest(messages, options);
    if (estimate.unknownMedia) estimate = estimateCanonicalProviderRequest([], options);
  } catch { throw new ProviderRequestContextError('unmeasurable'); }
  if (estimate.estimatedTokens > owned.contextWindow - reserve) {
    throw new ProviderRequestContextError('overflow');
  }
  check?.();
}
