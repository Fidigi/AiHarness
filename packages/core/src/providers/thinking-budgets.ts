import type { ThinkingLevel } from './index.js';

/** Overrides for numeric reasoning dialects; effort-only dialects do not consume them. */
export type ThinkingBudgets = Readonly<Partial<Record<'minimal' | 'low' | 'medium' | 'high', number>>>;
const LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

/** Copy only inert, own, safe nonnegative integer fields. Never invoke getters. */
export function copyThinkingBudgets(value: unknown): ThinkingBudgets | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const names = Reflect.ownKeys(value);
    if (names.length > 4) throw new Error();
    const copy: Partial<Record<keyof ThinkingBudgets, number>> = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (typeof name !== 'string' || !LEVELS.has(name) || !descriptor || !('value' in descriptor)) throw new Error();
      const budget: unknown = descriptor.value;
      if (budget === undefined) continue;
      if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 0) throw new Error();
      copy[name as keyof ThinkingBudgets] = budget;
    }
    return copy;
  } catch { throw new Error('Thinking budgets must contain only safe nonnegative integer minimal/low/medium/high values.'); }
}

/** Provider-local bounds are conservative admission limits, not model capability discovery. */
export function resolveThinkingBudget(
  level: Exclude<ThinkingLevel, 'off'>,
  overrides: ThinkingBudgets | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const budgets = copyThinkingBudgets(overrides);
  const configured = level === 'xhigh' || level === 'max' ? undefined : budgets?.[level];
  return Math.max(minimum, Math.min(maximum, configured ?? fallback));
}
