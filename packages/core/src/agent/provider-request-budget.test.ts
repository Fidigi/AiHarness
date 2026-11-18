import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { MockProvider } from '../providers/index.js';
import type { Message } from '../types/index.js';
import { SessionManager } from '../sessions/session-manager.js';
import { streamProviderTurn } from './provider-turn.js';
import { assertProviderRequestBudget as guard, captureProviderRequestBudget as capture,
  estimateCanonicalProviderRequest as estimate, captureManagerProviderBudget as captureManager,
  ProviderRequestContextError } from './provider-request-estimate.js';

const message = (): Message => ({ id: 'input', role: 'user', content: 'hi', timestamp: new Date(0) });
const large = 'KNOWN_WIRE_ONLY_OVERHEAD '.repeat(500);
const policy = () => ({ contextWindow: 1000, reserveTokens: 900 });

describe('prototype owned canonical request budget', () => {
  it('keeps absent policy genuinely optional', () => {
    expect(capture({})).toBeUndefined(); expect(capture({ contextBudget: undefined })).toBeUndefined();
  });
  it('captures and freezes numeric policy independently of caller mutation', () => {
    const source = policy(), result = capture({ contextBudget: source });
    source.contextWindow = 1_000_000; source.reserveTokens = 0;
    expect(result).toEqual(policy()); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(source)).toBe(false);
  });
  for (const field of ['contextWindow', 'reserveTokens']) for (const inherited of [false, true]) {
    it(`refuses ${inherited ? 'inherited' : 'own'} ${field} accessors without evaluation`, () => {
      const getter = vi.fn(), source = policy();
      if (inherited) { delete (source as Partial<typeof source>)[field as keyof typeof source]; Object.setPrototypeOf(source, Object.defineProperty({}, field, { get: getter })); }
      else Object.defineProperty(source, field, { get: getter });
      expect(() => capture({ contextBudget: source })).toThrow('Provider request context budget is invalid.');
      expect(getter).not.toHaveBeenCalled();
    });
  }
  for (const inherited of [false, true]) it(`refuses ${inherited ? 'inherited' : 'own'} optional-policy accessors without evaluation`, () => {
    const getter = vi.fn(), options = inherited ? Object.create(Object.defineProperty({}, 'contextBudget', { get: getter })) as object : Object.defineProperty({}, 'contextBudget', { get: getter });
    expect(() => capture(options)).toThrow(ProviderRequestContextError); expect(getter).not.toHaveBeenCalled();
  });
  for (const contextWindow of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) it('refuses invalid finite context limits', () => {
    expect(() => capture({ contextBudget: { contextWindow, reserveTokens: 0 } })).toThrow(ProviderRequestContextError);
  });
  for (const reserveTokens of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) it('refuses invalid reservations', () => {
    expect(() => capture({ contextBudget: { contextWindow: 1000, reserveTokens } })).toThrow(ProviderRequestContextError);
  });
  it('conserves the exact configured canonical boundary', () => {
    const messages = [message()], estimateTokens = estimate(messages).estimatedTokens;
    expect(() => guard(messages, {}, { contextWindow: estimateTokens + 900, reserveTokens: 900 })).not.toThrow();
    expect(() => guard(messages, {}, { contextWindow: estimateTokens + 899, reserveTokens: 900 })).toThrow('Provider request exceeds the owned context budget.');
  });
  it('does not claim unknown media costs zero or certify complete image admission', () => {
    const messages: Message[] = [{ ...message(), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,' + 'A'.repeat(8192) }] }];
    expect(estimate(messages).unknownMedia).toBe(true);
    expect(() => guard(messages, {}, policy())).not.toThrow();
    expect(() => guard(messages, { systemPrompt: large }, policy())).toThrow(ProviderRequestContextError);
  });
  it('retains captured Date operations across later prototype accessors', () => {
    const getTime = Object.getOwnPropertyDescriptor(Date.prototype, 'getTime')!, iso = Object.getOwnPropertyDescriptor(Date.prototype, 'toISOString')!;
    const getter = vi.fn(), input = [message()], options = { tools: [{ name: 'x', description: 'date', parameters: { value: new Date(0) } }] };
    const expected = estimate(input, options); let result;
    try {
      Object.defineProperty(Date.prototype, 'getTime', { configurable: true, get: getter });
      Object.defineProperty(Date.prototype, 'toISOString', { configurable: true, get: getter });
      result = estimate(input, options);
    } finally { Object.defineProperty(Date.prototype, 'getTime', getTime); Object.defineProperty(Date.prototype, 'toISOString', iso); }
    expect(result).toEqual(expected); expect(getter).not.toHaveBeenCalled();
  });
});

describe('internal manager budget authority (no new public capability)', () => {
  const manager = (): SessionManager => {
    const result = new SessionManager(); result.setCompactionContextWindow(5000);
    result.setCompactionSettings({ reserveTokens: 900 }); return result;
  };
  it('does not read unnecessary settings methods without a declared finite window', () => {
    const source = new SessionManager(), getter = vi.fn();
    Object.defineProperty(source, 'getCompactionSettings', { get: getter });
    expect(captureManager(source)).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
  });
  it('retains current-window authority through the public numeric-policy copy', () => {
    const source = manager(), budget = capture({ contextBudget: captureManager(source) })!;
    source.setCompactionContextWindow(1000);
    expect(() => guard([message()], { systemPrompt: large.slice(0, 1600) }, budget)).toThrow('Provider request context budget changed.');
  });
  it('withdraws a changed reservation instead of using an obsolete larger allowance', () => {
    const source = manager(), budget = captureManager(source)!;
    source.setCompactionSettings({ reserveTokens: 4900 });
    expect(() => guard([message()], { systemPrompt: large.slice(0, 1600) }, budget)).toThrow('Provider request context budget changed.');
  });
  it('refuses recognized current policy accessors without reading them', () => {
    const source = manager(), budget = captureManager(source)!, getter = vi.fn(() => 900);
    Object.defineProperty(source.getCompactionSettings(), 'reserveTokens', { get: getter });
    expect(() => guard([message()], {}, budget)).toThrow('Provider request context budget is invalid.');
    expect(getter).not.toHaveBeenCalled();
  });
  it('conserves identical setters and title-only changes across await boundaries', async () => {
    const source = manager(), budget = captureManager(source)!, session = await source.create({ autoCompaction: false });
    source.setCompactionContextWindow(5000); source.setCompactionSettings({ reserveTokens: 900 });
    await source.update(session.id, { title: 'PERMITTED_CURRENT_TITLE' });
    expect(() => guard([message()], {}, budget)).not.toThrow();
  });
  it('pins synchronous manager query methods before extensible observers', () => {
    const source = manager(), budget = captureManager(source)!, getter = vi.fn();
    for (const key of ['getCompactionSettings', 'getCompactionContextWindow']) Object.defineProperty(source, key, { get: getter });
    expect(() => guard([message()], {}, budget)).not.toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});

describe('prototype post-hook stream admission', () => {
  for (const kind of ['system', 'tools', 'messages', 'start-observer']) it(`refuses oversized ${kind} before dispatch and without ordinary retries`, async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['OK']);
    const dispatch = vi.spyOn(provider, 'streamChat'), onStart = vi.fn(), onError = vi.fn(), onComplete = vi.fn(), onRetryStart = vi.fn();
    const budget = policy(); let grow = (): void => undefined;
    await registry.load('wire-growth', api => api.before('before:provider', data => {
      budget.contextWindow = 1_000_000;
      const change = (): void => {
        if (kind === 'system' || kind === 'start-observer') data.options.systemPrompt = large;
        if (kind === 'tools') data.options.tools = [{ name: 'x', description: 'x', parameters: { description: large } }];
        if (kind === 'messages') data.messages.push({ ...message(), content: large });
      };
      if (kind === 'start-observer') grow = change; else change();
    }));
    try {
      await expect(streamProviderTurn({ provider, providerName: 'mock', messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: budget, maxRetries: 3, retryDelayMs: 0, onStart: () => { onStart(); grow(); }, onError, onComplete, onRetryStart,
      })).rejects.toThrow('Provider request exceeds the owned context budget.');
      expect(dispatch).not.toHaveBeenCalled(); expect(onRetryStart).not.toHaveBeenCalled(); expect(onStart).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1); expect(onComplete).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
  it('accepts small requests and historical billed usage without changing signal identity', async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['OK']), controller = new AbortController();
    const dispatch = vi.spyOn(provider, 'streamChat'), source = { ...message(), usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 } };
    try {
      await expect(streamProviderTurn({ provider, providerName: 'mock', messages: [source], tools: [], extensionRegistry: registry,
        contextBudget: policy(), signal: controller.signal, maxRetries: 0,
      })).resolves.toMatchObject({ content: 'OK' });
      expect(dispatch).toHaveBeenCalledTimes(1); expect(dispatch.mock.calls[0][4]?.signal).toBe(controller.signal);
    } finally { await registry.shutdown(); }
  });
  it('leaves unconfigured low-level callers compatible instead of inventing a limit', async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['OK']), dispatch = vi.spyOn(provider, 'streamChat');
    try {
      await expect(streamProviderTurn({ provider, providerName: 'mock', messages: [message()], tools: [], extensionRegistry: registry,
        systemPrompt: large, maxRetries: 0,
      })).resolves.toMatchObject({ content: 'OK' });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { await registry.shutdown(); }
  });
  it('does not evaluate a replacement provider method accessor installed by a start observer', async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['CAPTURED']), getter = vi.fn();
    try {
      await expect(streamProviderTurn({ provider, providerName: 'mock', messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: policy(), maxRetries: 0, onStart: () => { Object.defineProperty(provider, 'streamChat', { get: getter }); },
      })).resolves.toMatchObject({ content: 'CAPTURED' });
      expect(getter).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
  it('refuses malformed post-hook schema without executing serializers, dispatching or retrying', async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['OK']), serializer = vi.fn();
    const dispatch = vi.spyOn(provider, 'streamChat'), retry = vi.fn();
    await registry.load('invalid-schema', api => api.before('before:provider', data => {
      data.options.tools = [{ name: 'x', description: 'x', parameters: { toJSON: serializer } }];
    }));
    try {
      await expect(streamProviderTurn({ provider, providerName: 'mock', messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: policy(), maxRetries: 3, retryDelayMs: 0, onRetryStart: retry,
      })).rejects.toThrow('Provider request cannot be measured by the canonical JSON policy.');
      expect(serializer).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
});
