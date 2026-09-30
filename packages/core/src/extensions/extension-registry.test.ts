import { describe, expect, it, vi } from 'vitest';
import { MockProvider, ProviderFactory } from '../providers';
import { SessionManager } from '../sessions/session-manager';
import { ExtensionRegistry, type ExtensionRuntimeContext } from './extension-registry';

function context(sessionManager = new SessionManager()): ExtensionRuntimeContext {
  return {
    sessionManager,
    notify: vi.fn(),
  };
}

describe('ExtensionRegistry', () => {
  it('loads, invokes and unloads extension commands', async () => {
    const registry = new ExtensionRegistry();
    await registry.load('hello', api => {
      api.registerCommand('hello', {
        description: 'Dire bonjour',
        handler: name => `Bonjour ${name || 'monde'}`,
      });
    });

    expect(await registry.getCommand('hello')?.handler('Ada', context())).toBe('Bonjour Ada');
    expect(registry.list()[0]).toMatchObject({ id: 'hello', commands: ['hello'] });

    await registry.unload('hello');
    expect(registry.getCommand('hello')).toBeUndefined();
  });

  it('registers and executes tools with structured details', async () => {
    const registry = new ExtensionRegistry();
    const onCall = vi.fn();
    const onResult = vi.fn();
    registry.on('tool:call', onCall);
    registry.on('tool:result', onResult);
    await registry.load('tools', api => {
      api.registerTool({
        name: 'sum',
        description: 'Additionner deux nombres',
        parameters: { type: 'object' },
        execute: input => {
          const values = input as { a: number; b: number };
          return { content: String(values.a + values.b), details: { operation: 'sum' } };
        },
      });
    });

    await expect(registry.executeTool('sum', { a: 2, b: 3 }, context())).resolves.toEqual({
      content: '5',
      details: { operation: 'sum' },
    });
    expect(onCall).toHaveBeenCalledWith({ tool: 'sum', input: { a: 2, b: 3 } });
    expect(onResult).toHaveBeenCalledWith({ tool: 'sum', isError: false, contentLength: 1 });
    await expect(registry.executeTool('missing', {}, context())).rejects.toThrow('Unknown extension tool');
  });

  it('runs transform hooks sequentially', async () => {
    const registry = new ExtensionRegistry();
    await registry.load('first', api => {
      api.before('before:agent', data => ({ input: `${data.input} one` }));
    });
    await registry.load('second', api => {
      api.before('before:agent', data => ({ input: `${data.input} two` }));
    });

    const result = await registry.runBefore('before:agent', {
      sessionId: 'session-1',
      provider: 'mock',
      input: 'start',
    });

    expect(result).toEqual({
      cancelled: false,
      data: { sessionId: 'session-1', provider: 'mock', input: 'start one two' },
    });
  });

  it('stops hooks on cancellation and preserves the reason', async () => {
    const registry = new ExtensionRegistry();
    const skipped = vi.fn();
    await registry.load('policy', api => {
      api.before('before:provider', () => ({ cancel: true, reason: 'Provider interdit' }));
      api.before('before:provider', skipped);
    });

    const result = await registry.runBefore('before:provider', {
      provider: 'openai',
      messages: [],
      options: {},
    });

    expect(result.cancelled).toBe(true);
    expect(result.reason).toBe('Provider interdit');
    expect(skipped).not.toHaveBeenCalled();
  });

  it('transforms tool input and can cancel tool execution', async () => {
    const registry = new ExtensionRegistry();
    const execute = vi.fn(input => ({ content: String((input as { value: number }).value) }));
    await registry.load('tool-policy', api => {
      api.registerTool({ name: 'number', description: 'Number', execute });
      api.before('before:tool', data => ({ input: { value: Number((data.input as any).value) * 2 } }));
    });

    await expect(registry.executeTool('number', { value: 3 }, context())).resolves.toEqual({ content: '6' });
    expect(execute).toHaveBeenCalledWith({ value: 6 }, expect.anything(), undefined);

    await registry.load('blocker', api => {
      api.before('before:tool', () => false);
    });
    await expect(registry.executeTool('number', { value: 4 }, context())).rejects.toThrow(
      'Tool execution cancelled by extension hook',
    );
  });

  it('removes owned transform hooks when unloading', async () => {
    const registry = new ExtensionRegistry();
    await registry.load('temporary', api => {
      api.before('before:agent', data => ({ input: data.input.toUpperCase() }));
    });
    expect(registry.list()[0].hooks).toEqual(['before:agent']);

    await registry.unload('temporary');
    const result = await registry.runBefore('before:agent', {
      sessionId: 'session-1', provider: 'mock', input: 'unchanged',
    });
    expect(result.data.input).toBe('unchanged');
  });

  it('registers owned fullscreen UI components and removes them on unload', async () => {
    const registry = new ExtensionRegistry();
    await registry.load('ui', api => {
      api.registerUI({
        name: 'status',
        placement: 'status',
        render: context => `Session: ${context.currentSessionId ?? 'aucune'}`,
      });
    });

    const component = registry.getUIComponents()[0];
    expect(component.render({ currentSessionId: 's1' })).toBe('Session: s1');
    expect(registry.list()[0].uiComponents).toEqual(['status']);
    await registry.unload('ui');
    expect(registry.getUIComponents()).toEqual([]);
  });

  it('bridges SessionManager lifecycle events', async () => {
    const registry = new ExtensionRegistry();
    const manager = new SessionManager();
    const listener = vi.fn();
    let unsubscribe: (() => void) | undefined;
    registry.attachSessionManager(manager);
    await registry.load('observer', api => {
      unsubscribe = api.on('session:create', listener);
    });

    const session = await manager.create({ title: 'Extension event' });
    expect(listener).toHaveBeenCalledWith({ sessionId: session.id, title: 'Extension event' });

    unsubscribe?.();
    await manager.create({ title: 'Ignored event' });
    expect(listener).toHaveBeenCalledOnce();
    await registry.shutdown();
  });

  it('registers dynamic providers and removes them on unload', async () => {
    const registry = new ExtensionRegistry();
    await registry.load('provider-extension', api => {
      api.registerProvider('example-provider', {
        defaultConfig: { model: 'example-model' },
        create: config => new MockProvider(config, ['Extension provider response']),
      });
    });

    expect(ProviderFactory.has('example-provider')).toBe(true);
    const provider = ProviderFactory.create({ type: 'example-provider' as never });
    expect(await provider.chat([])).toMatchObject({ content: 'Extension provider response' });

    await registry.unload('provider-extension');
    expect(ProviderFactory.has('example-provider')).toBe(false);
  });

  it('rolls back partial registrations when a factory fails', async () => {
    const registry = new ExtensionRegistry();

    await expect(registry.load('broken', api => {
      api.registerCommand('temporary', { description: 'Temporary', handler: () => undefined });
      throw new Error('Factory failure');
    })).rejects.toThrow('Factory failure');

    expect(registry.getCommand('temporary')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('supports an application-provided reload handler', async () => {
    const registry = new ExtensionRegistry();
    const reload = vi.fn().mockResolvedValue(undefined);
    registry.setReloadHandler(reload);

    await registry.reload();

    expect(reload).toHaveBeenCalledOnce();
  });
});
