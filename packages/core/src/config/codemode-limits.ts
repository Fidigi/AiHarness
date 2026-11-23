/** Native production defaults are also absolute ceilings. Guests have no configuration channel. */
export const CODEMODE_LIMITS = Object.freeze({
  timeoutMs: 10_000, memoryBytes: 32 * 1024 * 1024, stackBytes: 256 * 1024,
  interrupts: 10_000, calls: 64, concurrency: 4, inputBytes: 64 * 1024,
  outputBytes: 64 * 1024, resultBytes: 256 * 1024, sourceBytes: 64 * 1024,
});
export type CodemodeLimits = { -readonly [Key in keyof typeof CODEMODE_LIMITS]: number };
export type ConfiguredCodemodeLimits = Partial<Pick<CodemodeLimits, 'timeoutMs' | 'memoryBytes' | 'calls' | 'outputBytes'>>;
export const CONFIGURABLE_CODEMODE_LIMITS = Object.freeze({
  timeoutMs: CODEMODE_LIMITS.timeoutMs, memoryBytes: CODEMODE_LIMITS.memoryBytes,
  calls: CODEMODE_LIMITS.calls, outputBytes: CODEMODE_LIMITS.outputBytes,
});

/** Validate and copy trusted configuration; unlike the low-level runner, never silently repair it. */
export function validateCodemodeLimits(value: unknown): ConfiguredCodemodeLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid codemode limits.');
  const result: ConfiguredCodemodeLimits = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !Object.hasOwn(CONFIGURABLE_CODEMODE_LIMITS, key)
      || !descriptor || !('value' in descriptor)) throw new Error('Invalid codemode limits.');
    const name = key as keyof ConfiguredCodemodeLimits;
    const amount: unknown = descriptor.value;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1
      || amount > CONFIGURABLE_CODEMODE_LIMITS[name]) throw new Error('Invalid codemode limits.');
    result[name] = amount;
  }
  return result;
}

export function resolveCodemodeLimits(value?: ConfiguredCodemodeLimits): CodemodeLimits {
  return { ...CODEMODE_LIMITS, ...(value === undefined ? {} : validateCodemodeLimits(value)) };
}
