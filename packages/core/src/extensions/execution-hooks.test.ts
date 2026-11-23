import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type ExtensionAPI } from './extension-registry.js';
import { copyAgentRunTrigger, copyExtensionContinuation } from './execution-hooks.js';

const message = () => ({ sessionId: 'session', content: 'original', signal: new AbortController().signal });
describe('native execution hooks', () => {
  it('orders explicit transformations, detaches returned data and pins authority', async () => {
    const registry = new ExtensionRegistry();
    const result = { content: 'first' };
    await registry.load('first', api => { api.before('before:message', () => result); });
    await registry.load('second', api => {
      api.before('before:message', data => {
        expect(Object.isFrozen(data)).toBe(true);
        expect(data.sessionId).toBe('session');
        return { content: `${data.content}:second` };
      });
    });
    const execution = await registry.runBefore('before:message', message());
    result.content = 'late';
    expect(execution.data.content).toBe('first:second');
  });

  it.each(['authority', 'accessor', 'error', 'cancel'])('fails closed on %s and skips subsequent hooks', async scenario => {
    const registry = new ExtensionRegistry(), skipped = vi.fn(), getter = vi.fn();
    await registry.load('policy', api => {
      api.before('before:message', () => {
        if (scenario === 'error') throw new Error('PRIVATE_FAILURE');
        if (scenario === 'cancel') return false;
        if (scenario === 'accessor') return Object.defineProperty({}, 'content', { get: getter }) as { content: string };
        return { content: 'rewrite', sessionId: 'foreign' } as { content: string };
      });
      api.before('before:message', skipped);
    });
    if (scenario === 'cancel') expect((await registry.runBefore('before:message', message())).cancelled).toBe(true);
    else await expect(registry.runBefore('before:message', message())).rejects.toThrow('Extension execution hook failed.');
    expect(skipped).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });

  it.each(['abort', 'unload', 'unsubscribe'])('retires ignored callbacks on %s without accepting late output', async scenario => {
    const registry = new ExtensionRegistry(), controller = new AbortController(), skipped = vi.fn();
    let entered!: () => void, release!: (value: { content: string }) => void, unsubscribe!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    await registry.load('held', api => {
      unsubscribe = api.before('before:message', () => { entered(); return new Promise(resolve => { release = resolve; }); });
      api.before('before:message', skipped);
    });
    const pending = registry.runBefore('before:message', { ...message(), signal: controller.signal });
    await ready;
    if (scenario === 'abort') controller.abort();
    else if (scenario === 'unload') await registry.unload('held');
    else unsubscribe();
    expect((await pending).cancelled).toBe(true);
    release({ content: 'late' });
    expect(skipped).not.toHaveBeenCalled();
  });

  it('owns result data and refuses forged accounting/details and continuation fields', async () => {
    const registry = new ExtensionRegistry();
    await registry.load('replace', api => {
      api.before('before:tool:result', data => {
        (data.result.structuredContent as { value: number }).value = 9;
        return { result: { content: 'replacement', structuredContent: { value: 2 } } };
      });
    });
    const original = { content: 'original', structuredContent: { value: 1 } };
    const transformed = await registry.runBefore('before:tool:result', { sessionId: 'session', tool: 'read', result: original, signal: message().signal });
    expect(original.structuredContent.value).toBe(1);
    expect(transformed.data.result).toMatchObject({ content: 'replacement', structuredContent: { value: 2 } });
    await registry.load('forge', api => {
      api.before('before:tool:result', () => ({ result: { content: 'forged', details: { usage: 999 } } }));
    });
    await expect(registry.runBefore('before:tool:result', { sessionId: 'session', tool: 'read', result: original, signal: message().signal })).rejects.toThrow('Extension execution hook failed.');
  });

  it('refuses foreign event names and all retained registration methods after unload', async () => {
    const registry = new ExtensionRegistry(); let api!: ExtensionAPI;
    await registry.load('native', value => { api = value; });
    expect(() => api.on('turn_end' as never, () => undefined)).toThrow('Unsupported native lifecycle');
    expect(() => api.before('agent_before_settle' as never, () => undefined)).toThrow('Unsupported native execution');
    await registry.unload('native');
    for (const register of [
      () => api.registerCommand('late', { description: 'late', handler() {} }),
      () => api.registerTool({ name: 'late', description: 'late', execute: () => ({ content: '' }) }),
      () => api.registerUI({ name: 'late', render: () => '' }),
      () => api.on('agent:end', () => undefined),
      () => api.before('before:message', () => undefined),
    ]) expect(register).toThrow('retired');
    expect(registry.getCommands()).toEqual([]); expect(registry.getTools()).toEqual([]);
  });

  it('keeps cleanup single-owned during synchronous abort reentry', async () => {
    const registry = new ExtensionRegistry(), cleanup = vi.fn();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    await registry.load('reentrant', api => {
      api.before('before:message', data => {
        data.signal.addEventListener('abort', () => { void registry.unload('reentrant'); }, { once: true });
        entered(); return new Promise(() => undefined);
      });
      return cleanup;
    });
    const pending = registry.runBefore('before:message', message());
    await ready; await registry.unload('reentrant');
    expect((await pending).cancelled).toBe(true); expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.list()).toEqual([]);
  });

  it('bounds continuation payloads and rejects unknown authority fields', () => {
    expect(copyExtensionContinuation(null)).toBeNull();
    expect(copyExtensionContinuation({ type: 'review', content: 'ok' })).toEqual({ type: 'review', content: 'ok' });
    for (const value of [
      { type: 'review', content: '' }, { type: 'bad type', content: 'ok' },
      { type: 'review', content: 'x'.repeat(64 * 1024) }, { type: 'review', content: 'ok', usage: 1 },
      { type: 'review', content: 'has\0nul' },
    ]) expect(() => copyExtensionContinuation(value)).toThrow();
  });

  it('validates typed run triggers without invoking accessors', () => {
    expect(copyAgentRunTrigger(undefined)).toEqual({ kind: 'user' });
    expect(copyAgentRunTrigger({ kind: 'custom', type: 'review:check' })).toEqual({ kind: 'custom', type: 'review:check' });
    expect(() => copyAgentRunTrigger({ kind: 'custom', type: 'bad type' })).toThrow();
    expect(() => copyAgentRunTrigger({ kind: 'user', extra: true })).toThrow();
    const getter = vi.fn();
    expect(() => copyAgentRunTrigger(Object.defineProperty({}, 'kind', { get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
