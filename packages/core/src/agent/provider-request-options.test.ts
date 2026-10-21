import { describe, expect, it, vi } from 'vitest';
import { captureProviderOptionSlots as capture, requestedProviderOutputTokens as output,
  ProviderRequestOptionsError } from './provider-request-options.js';
import { ProviderRequestContextError } from './provider-request-estimate.js';
import type { ChatOptions } from '../providers/index.js';

const names = ['model', 'temperature', 'maxTokens', 'systemPrompt', 'tools', 'maxRetries',
  'thinking', 'thinkingBudgets', 'sessionId', 'cacheRetention'] as const;

describe('preparation-only passive top-level provider options', () => {
  for (const key of names) for (const placement of ['own', 'inherited']) it(`refuses ${placement} ${key} getter without execution`, () => {
    const getter = vi.fn(), source = placement === 'own' ? {} : Object.create(Object.defineProperty({}, key, { get: getter }));
    if (placement === 'own') Object.defineProperty(source, key, { get: getter, enumerable: true });
    expect(() => capture(source)).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled();
  });
  it.each(names)('refuses inherited %s presence even when the value is undefined', key => {
    expect(() => capture(Object.create({ [key]: undefined }))).toThrow(ProviderRequestOptionsError);
  });
  it('retains known undefined own data without accidentally granting inherited fallback authority', () => {
    const source = Object.fromEntries(names.map(key => [key, undefined])), result = capture(source);
    for (const key of names) { expect(Object.hasOwn(result, key)).toBe(true); expect(Object.getOwnPropertyDescriptor(result, key)?.value).toBeUndefined(); }
  });
  it('preserves ordinary data, zero temperature/retries and mutable borrowed arrays/maps', () => {
    const tools: NonNullable<ChatOptions['tools']> = [];
    const budgets = { low: 1024 };
    const result = capture({ model: 'MODEL', systemPrompt: '  PUBLIC  ', sessionId: 'session', tools,
      maxTokens: 64, maxRetries: 0, temperature: 0, thinking: 'low', thinkingBudgets: budgets });
    expect(result).toMatchObject({ model: 'MODEL', systemPrompt: '  PUBLIC  ', sessionId: 'session', maxTokens: 64, maxRetries: 0, temperature: 0, thinking: 'low' });
    expect(result.tools).toBe(tools); expect(result.thinkingBudgets).toBe(budgets);
    result.tools!.push({ name: 'public', description: 'public', parameters: { type: 'object' } });
    budgets.low = 2048; expect(tools).toHaveLength(1); expect(result.thinkingBudgets!.low).toBe(2048);
    result.thinkingBudgets = { low: 4096 }; expect(result.thinkingBudgets.low).toBe(4096); expect(budgets.low).toBe(2048);
    expect(Object.isFrozen(result)).toBe(false);
  });
  it('does not inspect unused nested legacy budget getters or claim recursive ownership', () => {
    const getter = vi.fn(), budgets = Object.defineProperty({}, 'low', { get: getter, enumerable: true });
    expect(capture({ thinking: 'off', thinkingBudgets: budgets }).thinkingBudgets).toBe(budgets);
    expect(getter).not.toHaveBeenCalled();
  });
  for (const placement of ['own', 'inherited']) it(`ignores ${placement} unknown legacy getters without losing valid data`, () => {
    const getter = vi.fn(), prototype = placement === 'inherited' ? Object.defineProperty({}, 'legacy', { get: getter }) : null;
    const source = Object.assign(Object.create(prototype), { maxTokens: 64 });
    if (placement === 'own') Object.defineProperty(source, 'legacy', { get: getter, enumerable: true });
    expect(capture(source)).toMatchObject({ maxTokens: 64 }); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['callable', 'accessor'])('ignores unknown %s serializers instead of executing them', kind => {
    const serializer = vi.fn(), source = { maxTokens: 64 };
    Object.defineProperty(source, 'toJSON', kind === 'accessor' ? { get: serializer, enumerable: true } : { value: serializer, enumerable: true });
    const snapshot = capture(source); expect(JSON.stringify(snapshot)).toContain('"maxTokens":64'); expect(serializer).not.toHaveBeenCalled();
  });
  for (const enumerable of [true, false]) for (const data of ['PUBLIC_DATA_KEY', 0, []]) it(`accepts inert toJSON data (enumerable=${enumerable},type=${typeof data})`, () => {
    const source = Object.defineProperty({ maxTokens: 64 }, 'toJSON', { value: data, enumerable });
    expect(() => capture(source)).not.toThrow(); if (enumerable) expect(Object.getOwnPropertyDescriptor(capture(source), 'toJSON')?.value).toBe(data);
  });
  for (const placement of ['own', 'inherited']) it(`uses the captured authentic signal without evaluating ${placement} hook signal replacement`, () => {
    const getter = vi.fn(), signal = new AbortController().signal;
    const prototype = placement === 'inherited' ? Object.defineProperty({}, 'signal', { get: getter }) : null;
    const source = Object.assign(Object.create(prototype), { maxTokens: 64 });
    if (placement === 'own') Object.defineProperty(source, 'signal', { get: getter, enumerable: true });
    expect(capture(source, signal).signal).toBe(signal); expect(getter).not.toHaveBeenCalled();
  });
  it('does not pollute prototypes while preserving ordinary own legacy data and symbols', () => {
    const key = Symbol('legacy'), data = { value: 1 }, source = Object.create(null);
    Object.defineProperty(source, '__proto__', { enumerable: true, value: data });
    Object.defineProperty(source, key, { enumerable: true, value: 'SYMBOL_DATA' });
    const result = capture(source); expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe(data); expect(Object.getOwnPropertyDescriptor(result, key)?.value).toBe('SYMBOL_DATA');
  });
  it.each([
    { label: 'undefined', value: undefined }, { label: 'null', value: null }, { label: 'number', value: 0 },
    { label: 'string', value: 'options' }, { label: 'array', value: [] }, { label: 'function', value: () => undefined },
  ])('refuses malformed option containers: $label', ({ value }) => {
    expect(() => capture(value)).toThrow(ProviderRequestOptionsError);
  });
  it.each([0, -1, 0.5, NaN, Infinity, '64'])('refuses malformed explicit output limits without coercion: %s', maxTokens => {
    expect(() => capture({ maxTokens })).toThrow(ProviderRequestOptionsError);
    expect(() => output({ maxTokens })).toThrow(ProviderRequestOptionsError);
  });
  it('does not run unsafe scalar serializers/coercion methods', () => {
    const serializer = vi.fn(() => 64), maxTokens = { toJSON: serializer, valueOf: serializer, toString: serializer };
    expect(() => capture({ maxTokens })).toThrow(ProviderRequestOptionsError); expect(() => output({ maxTokens })).toThrow(ProviderRequestOptionsError);
    expect(() => capture({ cacheRetention: maxTokens })).toThrow(ProviderRequestOptionsError); expect(serializer).not.toHaveBeenCalled();
  });
  it('normalizes hostile descriptor inspection into a nonretryable local refusal without leaking its payload', () => {
    const source = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('PRIVATE_TRAP_PAYLOAD'); } });
    for (const operation of [capture, output]) {
      try { operation(source); throw new Error('Expected refusal'); }
      catch (error) { expect(error).toBeInstanceOf(ProviderRequestOptionsError); expect(error).toBeInstanceOf(ProviderRequestContextError); expect((error as Error).message).not.toContain('PRIVATE_TRAP_PAYLOAD'); }
    }
  });
  it('reads only an explicit output ceiling and makes no native-default or budget-authority claim', () => {
    expect(output({})).toBeUndefined(); expect(output({ maxTokens: undefined })).toBeUndefined(); expect(output({ maxTokens: 900 })).toBe(900);
    const getter = vi.fn(); expect(output(Object.defineProperty({ maxTokens: 64 }, 'legacy', { get: getter }))).toBe(64); expect(getter).not.toHaveBeenCalled();
  });
  it('refuses an output accessor without reading it', () => {
    const getter = vi.fn(() => 4096); expect(() => output(Object.defineProperty({}, 'maxTokens', { get: getter }))).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled();
  });
});
