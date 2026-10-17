import { describe, expect, it, vi } from 'vitest';
import { captureProviderCallLabels, captureProviderMessages, redactProviderPayload } from './provider-request-payload.js';
import { ProviderRequestOptionsError } from './provider-request-options.js';

const json = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const identity = <T>(input: T): T => input;
const tracked = (callback: typeof identity) => {
  const spy = vi.fn();
  const apply = <T>(input: T): T => { spy(input); return callback(input); };
  return Object.assign(apply, { spy });
};
const fixture = () => ({ provider: 'mock', model: 'MODEL', messages: [{ id: 'message-1', role: 'user',
  content: 'PUBLIC_CONTEXT', timestamp: new Date('2026-01-01T00:00:00Z'), usage: { promptTokens: 2_000_000, completionTokens: 3 } }],
options: { model: 'MODEL', systemPrompt: 'PUBLIC_SYSTEM', maxTokens: 64, thinking: 'off', tools: [{ name: 'public', description: 'public', parameters: { type: 'object' } }] } });

describe('owned post-observer payload redaction preparation', () => {
  it('keeps ordinary history fields and mutable owned arrays without charging/rewriting billed usage', () => {
    const source = fixture(), result = redactProviderPayload(source, identity);
    expect(result.messages[0]).toEqual(source.messages[0]); expect(result.messages).not.toBe(source.messages);
    expect(result.messages[0].timestamp).toBeInstanceOf(Date); expect(result.messages[0].timestamp).not.toBe(source.messages[0].timestamp);
    expect(result.messages[0].usage).toEqual(source.messages[0].usage);
    result.messages[0].content = 'OWNED_CHANGE'; result.options.tools![0].description = 'OWNED_DESCRIPTION';
    expect(source.messages[0].content).toBe('PUBLIC_CONTEXT'); expect(source.options.tools[0].description).toBe('public');
    expect(Object.isFrozen(result.messages)).toBe(false); expect(Object.isFrozen(result.options.tools)).toBe(false);
  });
  it('captures legitimate array/options changes made before the final snapshot', () => {
    const source = fixture(); source.messages[0].content = 'PUBLIC_LATE'; source.options.maxTokens = 900;
    source.messages.push({ ...source.messages[0], id: 'message-2', content: 'PUBLIC_SUFFIX' });
    const result = redactProviderPayload(source, identity); expect(result.messages.map(message => message.content)).toEqual(['PUBLIC_LATE', 'PUBLIC_SUFFIX']); expect(result.options.maxTokens).toBe(900);
  });
  it('passes no original mutable model objects to an extensible redactor and snapshots its result again', () => {
    const source = fixture(); let retained: ReturnType<typeof fixture> | undefined;
    const result = redactProviderPayload(source, <T>(input: T): T => {
      retained = input as unknown as ReturnType<typeof fixture>; source.messages[0].content = 'RAW_MUTATION';
      return input;
    });
    expect(result.messages[0].content).toBe('PUBLIC_CONTEXT'); retained!.messages[0].content = 'REDACTOR_RETAINED_MUTATION';
    expect(result.messages[0].content).toBe('PUBLIC_CONTEXT');
  });
  it('preserves the authentic signal and does not serialize an unused borrowed thinking map', () => {
    const signal = new AbortController().signal, getter = vi.fn(() => 999), budgets = Object.defineProperty({ low: 1024 }, 'legacy', { get: getter, enumerable: true });
    const source = { ...fixture(), options: { ...fixture().options, thinkingBudgets: budgets } };
    const redact = tracked(json), result = redactProviderPayload(source, redact, signal);
    expect(result.options.signal).toBe(signal); expect(result.options.thinkingBudgets).toBe(budgets); expect(getter).not.toHaveBeenCalled();
    const argument = redact.spy.mock.calls[0][0] as { options: object };
    expect(Object.hasOwn(argument.options, 'signal')).toBe(false); expect(Object.hasOwn(argument.options, 'thinkingBudgets')).toBe(false);
    expect(result.messages[0].timestamp).toBe(source.messages[0].timestamp.toISOString());
  });
  for (const key of ['provider', 'model', 'messages', 'options']) it(`refuses a recognized root ${key} accessor before redaction without execution`, () => {
    const getter = vi.fn(), source = fixture(), redact = tracked(identity); Object.defineProperty(source, key, { get: getter, enumerable: true });
    expect(() => redactProviderPayload(source, redact)).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled(); expect(redact.spy).not.toHaveBeenCalled();
  });
  it('does not let a redactor erase recognized maxTokens getter evidence and falsely authorize default output', () => {
    const getter = vi.fn(() => 4096), source = fixture(), redact = tracked(<T>(input: T): T => { delete (input as unknown as { options: { maxTokens?: number } }).options.maxTokens; return input; });
    Object.defineProperty(source.options, 'maxTokens', { get: getter, enumerable: true });
    expect(() => redactProviderPayload(source, redact)).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled(); expect(redact.spy).not.toHaveBeenCalled();
  });
  it('ignores unrelated source getters/serializers before real JSON cloning while preserving ordinary content', () => {
    const getter = vi.fn(), serializer = vi.fn(), source = fixture();
    Object.defineProperty(source.options, 'legacy', { get: getter, enumerable: true });
    Object.defineProperty(source.messages[0], 'legacy', { get: getter, enumerable: true });
    Object.defineProperty(source.messages[0], 'toJSON', { value: serializer, enumerable: true });
    const result = redactProviderPayload(source, json); expect(result.messages[0].content).toBe('PUBLIC_CONTEXT'); expect(getter).not.toHaveBeenCalled(); expect(serializer).not.toHaveBeenCalled();
  });
  for (const kind of ['accessor', 'callable']) it(`refuses ${kind} model-schema serializer without invocation before redaction`, () => {
    const source = fixture(), fn = vi.fn(), redact = tracked(json);
    Object.defineProperty(source.options.tools[0].parameters, 'toJSON', kind === 'accessor' ? { get: fn } : { value: fn });
    expect(() => redactProviderPayload(source, redact)).toThrow(ProviderRequestOptionsError); expect(fn).not.toHaveBeenCalled(); expect(redact.spy).not.toHaveBeenCalled();
  });
  it('refuses nested model schema getters without executing them', () => {
    const source = fixture(), getter = vi.fn(), redact = tracked(json);
    Object.defineProperty(source.options.tools[0].parameters, 'properties', { get: getter, enumerable: true });
    expect(() => redactProviderPayload(source, redact)).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled(); expect(redact.spy).not.toHaveBeenCalled();
  });
  it('accepts inert own nonenumerable/object/array serializer data as ordinary JSON', () => {
    const list = Object.defineProperty(['PUBLIC_ITEM'], 'toJSON', { value: 'INERT_ARRAY_KEY' });
    const parameters = { type: 'object', toJSON: 'INERT_OBJECT_KEY', list };
    const source = { ...fixture(), options: { ...fixture().options, tools: [{ name: 'public', description: 'public', parameters }] } };
    expect(redactProviderPayload(source, json).options.tools![0].parameters).toEqual({ type: 'object', toJSON: 'INERT_OBJECT_KEY', list: ['PUBLIC_ITEM'] });
  });
  it('refuses invalid recognized output supplied by the redactor without invoking a replacement getter', () => {
    const getter = vi.fn(() => 4096);
    expect(() => redactProviderPayload(fixture(), <T>(input: T): T => {
      Object.defineProperty((input as unknown as { options: object }).options, 'maxTokens', { get: getter }); return input;
    })).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled();
  });
  it('does not copy inherited canonical identity presence or execute ID getters', () => {
    const getter = vi.fn(), source = fixture(); Object.defineProperty(source.messages[0], 'id', { get: getter });
    expect(() => captureProviderMessages(source.messages)).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled();
    expect(() => captureProviderMessages([Object.assign(Object.create({ id: undefined }), { role: 'user', content: 'PUBLIC' })])).toThrow(ProviderRequestOptionsError);
  });
  it('refuses cycles, sparse/model-accessor arrays and excessive depth/array length without inherited index reads', () => {
    const getter = vi.fn(), sparse = new Array(1); Object.setPrototypeOf(sparse, Object.defineProperty([], '0', { get: getter }));
    expect(() => captureProviderMessages(sparse)).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled();
    expect(() => captureProviderMessages(new Array(65_537))).toThrow(ProviderRequestOptionsError);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => redactProviderPayload({ ...fixture(), options: { ...fixture().options, tools: [{ name: 'public', description: 'public', parameters: cycle }] } }, json)).toThrow(ProviderRequestOptionsError);
    let deep: unknown = 'PUBLIC'; for (let n = 0; n < 35; n++) deep = { nested: deep };
    expect(() => redactProviderPayload({ ...fixture(), options: { ...fixture().options, tools: [{ name: 'public', description: 'public', parameters: deep }] } }, json)).toThrow(ProviderRequestOptionsError);
  });
  it('captures display labels passively and grants no dispatch/source authority', () => {
    const source = fixture(); expect(captureProviderCallLabels(source)).toEqual({ provider: 'mock', model: 'MODEL' });
    const getter = vi.fn(); Object.defineProperty(source, 'provider', { get: getter });
    expect(() => captureProviderCallLabels(source)).toThrow(ProviderRequestOptionsError); expect(getter).not.toHaveBeenCalled();
  });
});
