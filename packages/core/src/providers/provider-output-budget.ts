import type { ChatOptions } from './index.js';
import type { Message } from '../types/index.js';

/** Internal preparation only. No new required provider/store method or public DTO field. */
export interface PreparedNativeOutputBudget {
  readonly options: ChatOptions;
  readonly maxTokens: number;
}
export type NativeOutputBudgetPolicy = (ownedOptions: ChatOptions, messages?: readonly Message[]) => Readonly<PreparedNativeOutputBudget>;
const policies = new WeakMap<object, () => NativeOutputBudgetPolicy>();

export class ProviderOutputBudgetError extends Error {
  constructor(kind?: 'thinking') {
    super(kind === 'thinking'
      ? 'Thinking budgets must contain only safe nonnegative integer minimal/low/medium/high values.'
      : 'Provider native output policy is invalid.');
    this.name = 'ProviderOutputBudgetError';
  }
}

/** First-party registration; structural/extension providers remain unchanged. */
export function registerNativeOutputBudget(provider: object, capture: () => NativeOutputBudgetPolicy): void {
  policies.set(provider, capture);
}

/** Capture the registered source before extensible callbacks; no property lookup on opaque providers. */
export function captureNativeOutputBudget(provider: object): NativeOutputBudgetPolicy | undefined {
  return policies.get(provider)?.();
}

/** Preserve native fallback semantics without configuration getters or unrelated legacy reads. */
export function captureNativeConfiguredModel(config: object, fallback: string): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(config, 'model');
    if (!descriptor) {
      if ('model' in config) throw new ProviderOutputBudgetError();
      return fallback;
    }
    if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string')) throw new ProviderOutputBudgetError();
    return descriptor.value || fallback;
  } catch { throw new ProviderOutputBudgetError(); }
}
