import { describe, expect, it, vi } from 'vitest';
import { parseProviderToolArguments, ProviderToolArgumentsError } from './tool-arguments.js';

describe('internal final tool-argument decoder', () => {
  it('refuses nonstrings without coercion, serializers or getters', () => {
    const getter = vi.fn(() => 'private input');
    const object = Object.defineProperties({}, {
      toString: { get: getter }, toJSON: { get: getter }, [Symbol.toPrimitive]: { get: getter },
    });
    for (const value of [object, [], null, false, 0, 1n, Symbol('private'), () => 'private']) {
      expect(() => parseProviderToolArguments(value)).toThrow(ProviderToolArgumentsError);
      expect(() => parseProviderToolArguments(value)).toThrow('The provider tool arguments were invalid JSON.');
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('preserves the legacy absent/empty form, with no repair of nonempty partial input', () => {
    expect(parseProviderToolArguments(undefined)).toEqual({});
    expect(parseProviderToolArguments('')).toEqual({});
    for (const value of [' ', '{', '{"value":1,}', '{"value":"private']) {
      expect(() => parseProviderToolArguments(value)).toThrow(ProviderToolArgumentsError);
    }
  });
  it('retains valid JSON shapes and treats prototype-looking keys as inert own data', () => {
    const result = parseProviderToolArguments('{"__proto__":{"aih_polluted":true},"constructor":{"value":1}}') as Record<string, unknown>;
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).aih_polluted).toBeUndefined();
    for (const value of ['null', 'false', '0', '[]', '"字🙂"']) expect(parseProviderToolArguments(value)).toEqual(JSON.parse(value));
  });
});
