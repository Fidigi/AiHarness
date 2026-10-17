import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type BeforeProviderData } from '../extensions/extension-registry.js';
import { MockProvider } from '../providers/index.js';
import { CredentialRedactor } from '../providers/credentials.js';
import type { Message } from '../types/index.js';
import { streamProviderTurn, type StreamProviderTurnOptions } from './provider-turn.js';
import { assertProviderRequestBudget as guard, estimateCanonicalProviderRequest as estimate, ProviderRequestContextError } from './provider-request-estimate.js';
import { prepareProviderPayload } from './provider-request-payload.js';

const message = (): Message => ({ id: 'input', role: 'user', content: 'hi', timestamp: new Date(0) });
const policy = () => ({ contextWindow: 3000, reserveTokens: 900 });
const identity = <T>(value: T): T => value;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function redactor(profile: string): typeof identity {
  if (profile === 'json') return json;
  if (profile === 'credential') { const owner = new CredentialRedactor(); return <T>(value: T): T => owner.redactJson(value); }
  return identity;
}

describe('actual requested-output admission and passive options before redaction', () => {
  for (const profile of ['identity', 'json', 'credential']) for (const kind of ['stable', 'exact-reserve', 'output-over-window', 'output-accessor', 'legacy-getter', 'inert-toJSON-data']) {
    it(`${profile}: ${kind} conserves ordinary replies or refuses before provider work without getter execution`, async () => {
      const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['OK']);
      const getter = vi.fn(() => 4096), dispatch = vi.spyOn(provider, 'streamChat'), emit = vi.spyOn(registry, 'emit');
      const onStart = vi.fn(), onError = vi.fn(), onComplete = vi.fn(), onRetryStart = vi.fn(), signal = new AbortController().signal;
      await registry.load('owned-options', api => api.before('before:provider', data => {
        data.options.maxTokens = kind === 'exact-reserve' ? 900 : kind === 'output-over-window' ? 4096 : 64;
        if (kind === 'output-accessor') Object.defineProperty(data.options, 'maxTokens', { get: getter, enumerable: true });
        if (kind === 'legacy-getter') Object.defineProperty(data.options, 'legacy', { get: getter, enumerable: true });
        if (kind === 'inert-toJSON-data') Object.defineProperty(data.options, 'toJSON', { value: 'PUBLIC_INERT_DATA', enumerable: true });
      }));
      try {
        const operation = streamProviderTurn({ provider, providerName: 'mock', messages: [message()], tools: [], extensionRegistry: registry,
          contextBudget: policy(), maxRetries: 3, retryDelayMs: 0, signal, redactJson: redactor(profile), onStart, onError, onComplete, onRetryStart });
        const refusal = ['output-over-window', 'output-accessor'].includes(kind);
        if (refusal) await expect(operation).rejects.toBeInstanceOf(ProviderRequestContextError);
        else await expect(operation).resolves.toMatchObject({ content: 'OK' });
        expect(getter).not.toHaveBeenCalled(); expect(dispatch).toHaveBeenCalledTimes(refusal ? 0 : 1); expect(onRetryStart).not.toHaveBeenCalled();
        expect(onComplete).toHaveBeenCalledTimes(refusal ? 0 : 1);
        const started = kind === 'output-accessor' ? 0 : 1;
        expect(onStart).toHaveBeenCalledTimes(started); expect(onError).toHaveBeenCalledTimes(kind === 'output-over-window' ? 1 : 0);
        expect(emit.mock.calls.filter(([event]) => event === 'provider:call:start')).toHaveLength(started);
        expect(emit.mock.calls.filter(([event]) => event === 'provider:call:error')).toHaveLength(kind === 'output-over-window' ? 1 : 0);
        if (!refusal) { expect(dispatch.mock.calls[0][4]?.signal).toBe(signal); expect(dispatch.mock.calls[0][4]?.maxTokens).toBe(kind === 'exact-reserve' ? 900 : 64); }
      } finally { await registry.shutdown(); }
    });
  }
  it('owns a separate numeric ceiling before a JSON redactor removes or lowers the explicit request', () => {
    for (const lowered of [undefined, 64]) {
      const source = { provider: 'mock', messages: [message()], options: { maxTokens: 4096 } };
      const prepared = prepareProviderPayload(source, <T>(input: T): T => {
        const row = input as unknown as { options: { maxTokens?: number } };
        if (lowered === undefined) delete row.options.maxTokens; else row.options.maxTokens = lowered;
        return input;
      });
      expect(prepared.requestedMaxTokens).toBe(4096); expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.data.messages)).toBe(false);
      expect(() => guard(prepared.data.messages, prepared.data.options, policy(), prepared.requestedMaxTokens)).toThrow('Provider request exceeds the owned context budget.');
    }
  });
  it('uses max(configured reserve, explicit output) and conserves the exact selected-policy boundary', () => {
    const messages = [message()], input = estimate(messages).estimatedTokens;
    expect(() => guard(messages, { maxTokens: 900 }, { contextWindow: input + 900, reserveTokens: 100 })).not.toThrow();
    expect(() => guard(messages, { maxTokens: 900 }, { contextWindow: input + 899, reserveTokens: 100 })).toThrow(ProviderRequestContextError);
    expect(() => guard(messages, { maxTokens: 64 }, { contextWindow: input + 899, reserveTokens: 900 })).toThrow(ProviderRequestContextError);
  });
  it('refuses an impossible output alone, including when media cost is unknown', () => {
    const messages: Message[] = [{ ...message(), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }] }];
    expect(() => guard(messages, { maxTokens: 4096 }, policy())).toThrow('Provider request exceeds the owned context budget.');
  });
  for (const inherited of [false, true]) it(`refuses ${inherited ? 'inherited' : 'own'} explicit-output accessors without reading them in the guard`, () => {
    const getter = vi.fn(() => 4096), target = Object.defineProperty({}, 'maxTokens', { get: getter });
    expect(() => guard([message()], inherited ? Object.create(target) : target, policy())).toThrow(ProviderRequestContextError); expect(getter).not.toHaveBeenCalled();
  });
  it('retains legitimate start-observer changes through a real JSON redactor rather than silently detaching the payload', async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['OK']), dispatch = vi.spyOn(provider, 'streamChat');
    let retained: BeforeProviderData | undefined;
    await registry.load('mutable-start', api => api.before('before:provider', data => { retained = data; data.options.maxTokens = 4096; }));
    try {
      await expect(streamProviderTurn({ provider, providerName: 'mock', messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: policy(), maxRetries: 0, redactJson: json, onStart: () => { retained!.options.maxTokens = 64; retained!.messages[0].content = 'PUBLIC_LATE'; },
      })).resolves.toMatchObject({ content: 'OK' });
      expect(dispatch.mock.calls[0][4]?.maxTokens).toBe(64); expect(dispatch.mock.calls[0][0][0].content).toBe('PUBLIC_LATE');
    } finally { await registry.shutdown(); }
  });
  it('pairs late start-observer shape refusal with one start/error and no provider/retry/getter', async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['OK']), dispatch = vi.spyOn(provider, 'streamChat'), getter = vi.fn(() => 4096);
    const onError = vi.fn(), onStart = vi.fn(), onRetryStart = vi.fn(); let retained: BeforeProviderData | undefined;
    await registry.load('late-getter', api => api.before('before:provider', data => { retained = data; }));
    try {
      await expect(streamProviderTurn({ provider, providerName: 'mock', messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: policy(), maxRetries: 3, redactJson: json, onError, onRetryStart,
        onStart: () => { onStart(); Object.defineProperty(retained!.options, 'maxTokens', { get: getter }); },
      })).rejects.toBeInstanceOf(ProviderRequestContextError);
      expect(onStart).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled(); expect(onRetryStart).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
  for (const key of ['redactJson', 'redactText'] as const) it(`refuses a recognized ${key} callback accessor unread before exposing policy`, async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' }, ['OK']), getter = vi.fn(), dispatch = vi.spyOn(provider, 'streamChat');
    const options: StreamProviderTurnOptions = { provider, providerName: 'mock', messages: [message()], tools: [], extensionRegistry: registry };
    Object.defineProperty(options, key, { get: getter });
    try { await expect(streamProviderTurn(options)).rejects.toBeInstanceOf(ProviderRequestContextError); expect(getter).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); }
    finally { await registry.shutdown(); }
  });
});
