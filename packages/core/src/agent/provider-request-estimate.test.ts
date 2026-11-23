import { describe, expect, it, vi } from 'vitest';
import type { ChatOptions } from '../providers/index.js';
import type { Message } from '../types/index.js';
import { estimateCanonicalProviderRequest as estimate } from './provider-request-estimate.js';

const message = (): Message => ({ id: 'history-id', role: 'user', content: 'hi', timestamp: new Date(0) });
const failure = 'Provider request cannot be measured by the canonical JSON policy.';
const tool = (parameters: Record<string, unknown>) => ({ name: 'read', description: 'Read', parameters });

describe('canonical provider-request estimation (not vendor tokenization or admission)', () => {
  it('matches the declared finite UTF8/4 wire without charging historical IDs or billed usage', () => {
    const source = { ...message(), usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 }, metadata: { secret: 'PRIVATE' } };
    const bytes = Buffer.byteLength(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], systemPrompt: '', tools: [] }));
    expect(estimate([source])).toEqual({ policy: 'canonical-json-utf8/4-v1', bytes, estimatedTokens: Math.ceil(bytes / 4), unknownMedia: false });
    expect(estimate([source])).toEqual(estimate([message()]));
  });
  for (const part of ['system', 'tools', 'messages'] as const) it(`counts actual post-hook ${part} overhead in this canonical policy`, () => {
    const input = [message()], options: ChatOptions = {}, large = 'KNOWN_WIRE_ONLY_OVERHEAD '.repeat(500);
    if (part === 'system') options.systemPrompt = large;
    if (part === 'tools') options.tools = [tool({ type: 'object', description: large })];
    if (part === 'messages') input.push({ ...message(), content: large });
    const before = JSON.stringify({ input, options });
    expect(estimate(input, options).estimatedTokens + 900).toBeGreaterThan(1000);
    expect(estimate([message()]).estimatedTokens + 900).toBeLessThanOrEqual(1000);
    expect(JSON.stringify({ input, options })).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
  });
  for (const content of ['é😀\n\u0000', '"\\', '\ud800']) it('measures UTF8 and JSON escaping rather than JS string length', () => {
    const bytes = Buffer.byteLength(JSON.stringify({ messages: [{ role: 'user', content }], systemPrompt: '', tools: [] }));
    expect(estimate([{ ...message(), content }]).bytes).toBe(bytes);
  });
  it('retains rich tool/content fields in the canonical representation', () => {
    const blocks: Message['blocks'] = [{ type: 'text', text: 'rich' }];
    const toolCalls = [{ id: 'call', name: 'read', input: { key: 'value' } }];
    const source: Message = { ...message(), role: 'assistant', blocks, toolCalls, toolCallId: 'previous', name: 'assistant-name' };
    const wire = { messages: [{ role: source.role, content: source.content, blocks, toolCalls, toolCallId: source.toolCallId, name: source.name }], systemPrompt: '', tools: [] };
    expect(estimate([source]).bytes).toBe(Buffer.byteLength(JSON.stringify(wire)));
  });
  it('does not pretend that encoded image bytes establish the model image-token cost', () => {
    expect(estimate([{ ...message(), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }] }]).unknownMedia).toBe(true);
  });
  it('ignores unknown message/options serializers and history accounting getters', () => {
    const getter = vi.fn(() => { throw new Error('must not execute'); });
    const source = message(), options: ChatOptions = {};
    for (const key of ['usage', 'metadata', 'id', 'timestamp', 'toJSON', 'legacy']) Object.defineProperty(source, key, { get: getter });
    for (const key of ['model', 'signal', 'thinking', 'maxTokens', 'toJSON']) Object.defineProperty(options, key, { get: getter });
    expect(estimate([source], options)).toEqual(estimate([message()]));
    expect(getter).not.toHaveBeenCalled();
  });
  for (const key of ['role', 'content', 'blocks', 'toolCalls', 'toolCallId', 'name']) it(`refuses recognized ${key} accessors without evaluating them`, () => {
    const getter = vi.fn(), source = message(); Object.defineProperty(source, key, { get: getter });
    expect(() => estimate([source])).toThrow(failure); expect(getter).not.toHaveBeenCalled();
  });
  for (const key of ['systemPrompt', 'tools']) it(`refuses inherited recognized ${key} without evaluating prototype getters`, () => {
    const getter = vi.fn(), prototype = Object.create(null) as object;
    Object.defineProperty(prototype, key, { get: getter });
    const options = Object.create(prototype) as ChatOptions;
    expect(() => estimate([message()], options)).toThrow(failure); expect(getter).not.toHaveBeenCalled();
  });
  it('refuses malformed roles without evaluating arbitrary conversion methods', () => {
    const toString = vi.fn(() => 'user');
    const source = { ...message(), role: { toString } } as unknown as Message;
    expect(() => estimate([source])).toThrow(failure); expect(toString).not.toHaveBeenCalled();
  });
  it('refuses nested schema getters without execution', () => {
    const getter = vi.fn(), parameters: Record<string, unknown> = {};
    Object.defineProperty(parameters, 'description', { get: getter, enumerable: true });
    expect(() => estimate([message()], { tools: [tool(parameters)] })).toThrow(failure); expect(getter).not.toHaveBeenCalled();
  });
  it('refuses callable and accessor nested serializers without executing them', () => {
    const serializer = vi.fn(() => ({})), getter = vi.fn(() => serializer);
    for (const value of [{ toJSON: serializer }, Object.defineProperty({}, 'toJSON', { get: getter })]) {
      expect(() => estimate([message()], { tools: [tool({ value })] })).toThrow(failure);
    }
    expect(serializer).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });
  it('accepts inert toJSON data and null-prototype nested JSON', () => {
    const parameters = Object.assign(Object.create(null) as Record<string, unknown>, { toJSON: 'PUBLIC_DATA', zero: 0, absent: undefined });
    expect(estimate([message()], { tools: [tool(parameters)] }).bytes).toBeGreaterThan(estimate([message()]).bytes);
    const array = Object.defineProperty(['x'], 'toJSON', { value: 12 });
    expect(estimate([message()], { tools: [tool({ enum: array })] }).estimatedTokens).toBeGreaterThan(0);
  });
  it('normalizes only pristine finite Dates without invoking own serializers', () => {
    const value = new Date(0), options = { tools: [tool({ value })] };
    const expected = { messages: [{ role: 'user', content: 'hi' }], systemPrompt: '', tools: [tool({ value: value.toISOString() })] };
    expect(estimate([message()], options).bytes).toBe(Buffer.byteLength(JSON.stringify(expected)));
    const getter = vi.fn(); Object.defineProperty(value, 'toJSON', { get: getter });
    expect(() => estimate([message()], options)).toThrow(failure); expect(getter).not.toHaveBeenCalled();
    expect(() => estimate([message()], { tools: [tool({ value: new Date(NaN) })] })).toThrow(failure);
  });
  for (const value of [NaN, Infinity, 1n, () => 1, Symbol('private')]) it('refuses non-JSON data without coercion', () => {
    expect(() => estimate([message()], { tools: [tool({ value })] })).toThrow(failure);
  });
  it('refuses cycles, sparse arrays, deep graphs and excessive node counts', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let deep: Record<string, unknown> = {}; for (let i = 0; i < 40; i++) deep = { next: deep };
    for (const value of [cyclic, new Array(2), deep, new Array(65_536).fill(0)]) {
      expect(() => estimate([message()], { tools: [tool({ value })] })).toThrow(failure);
    }
  });
});
