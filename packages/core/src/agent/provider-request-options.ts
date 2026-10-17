import type { ChatOptions } from '../providers/index.js';
import { ProviderRequestContextError } from './provider-request-estimate.js';

/** Local shape refusal is not a failed provider attempt or a reason to retry unchanged. */
export class ProviderRequestOptionsError extends ProviderRequestContextError {
  constructor() {
    super('invalid');
    this.name = 'ProviderRequestOptionsError';
    this.message = 'Provider request options are invalid.';
  }
}

const names = ['model', 'temperature', 'maxTokens', 'systemPrompt', 'tools', 'maxRetries',
  'thinking', 'thinkingBudgets', 'sessionId'] as const;
const known = new Set<PropertyKey>([...names, 'signal']);
const fail = (): never => { throw new ProviderRequestOptionsError(); };

/**
 * Capture top-level option slots without granting getters/serializers read authority.
 * This is preparation only, not recursive JSON validation or dispatch authority.
 * Mutable arrays/budget maps and legacy own-data values remain mutable; the caller
 * must independently own nested model input before extensible JSON redaction and
 * revalidate its actual post-callback request, owner budget and lifetime at dispatch.
 * The authentic signal's capture/subscription/brand belongs to that caller, not hooks.
 */
export function captureProviderOptionSlots(value: unknown, signal?: AbortSignal): ChatOptions {
  try { return captureSlots(value, signal); } catch { return fail(); }
}

function captureSlots(value: unknown, signal?: AbortSignal): ChatOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result: Record<PropertyKey, unknown> = {};
  const put = (key: PropertyKey, item: unknown): void => {
    Object.defineProperty(result, key, { value: item, enumerable: true, configurable: true, writable: true });
  };
  for (const key of names) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property) { if (key in value) return fail(); continue; }
    if (!('value' in property)) return fail();
    const item: unknown = property.value;
    if (item !== undefined) {
      if ((key === 'model' || key === 'systemPrompt' || key === 'sessionId') && typeof item !== 'string') return fail();
      if (key === 'maxTokens' && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)) return fail();
      if (key === 'maxRetries' && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return fail();
      if (key === 'temperature' && (typeof item !== 'number' || !Number.isFinite(item))) return fail();
      if (key === 'tools' && !Array.isArray(item)) return fail();
      if (key === 'thinking' && (typeof item !== 'string'
        || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(item))) return fail();
      // Numeric dialects validate recognized nested budgets when actually used;
      // effort-only/off modes must not accidentally evaluate unused legacy fields.
      if (key === 'thinkingBudgets' && (!item || typeof item !== 'object' || Array.isArray(item))) return fail();
    }
    put(key, item);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (known.has(key)) continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property) || !property.enumerable) continue;
    // Unknown serializers cannot acquire authority merely by reaching a redactor.
    if (key === 'toJSON' && typeof property.value === 'function') continue;
    put(key, property.value);
  }
  put('signal', signal);
  return result as ChatOptions;
}

/** Read only an explicit own-data output ceiling; provider-native defaults are not inferred. */
export function requestedProviderOutputTokens(value: unknown): number | undefined {
  try { return requestedOutput(value); } catch { return fail(); }
}

function requestedOutput(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const property = Object.getOwnPropertyDescriptor(value, 'maxTokens');
  if (!property) { if ('maxTokens' in value) return fail(); return undefined; }
  if (!('value' in property)) return fail();
  const item: unknown = property.value;
  if (item === undefined) return undefined;
  if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) return fail();
  return item;
}
