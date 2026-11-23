import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { MockProvider } from '../providers/index.js';
import { SessionManager } from '../sessions/session-manager.js';
import { streamProviderTurn } from './provider-turn.js';

describe('final request loadout provenance', () => {
  it('records final post-hook/start data before dispatch, deduplicates retries, and records switches as deltas', async () => {
    const manager = new SessionManager(), session = await manager.create(), registry = new ExtensionRegistry();
    const provider = new MockProvider({ type: 'mock', model: 'mock-model' });
    let effective: { systemPrompt?: string; tools?: unknown[] } | undefined;
    await registry.load('loadout', api => {
      api.before('before:provider', data => {
        effective = data.options;
        Object.assign(data.options, { model: 'hook-model', systemPrompt: 'HOOK_PROMPT', tools: [
          { name: 'hook_tool', description: 'Hook', parameters: { type: 'object' } },
        ] });
      });
    });
    let calls = 0;
    vi.spyOn(provider, 'streamChat').mockImplementation(async (_messages, _delta, complete, _error, options) => {
      const recorded = manager.getSessionLoadout(session.id);
      expect(recorded?.systemPrompt).toBe(options?.systemPrompt ?? '');
      expect(recorded?.tools).toEqual(options?.tools);
      if (calls++ === 0) throw new Error('Transient');
      complete?.({ content: 'Done' });
    });
    const turn = () => streamProviderTurn({ provider, providerName: 'mock', model: 'initial',
      sessionManager: manager, sessionId: session.id, messages: [], tools: [], extensionRegistry: registry,
      retryDelayMs: 0, onStart: () => { if (effective) effective.systemPrompt = 'START_PROMPT'; },
    });
    await turn();
    expect((await manager.getRawEntries(session.id)).filter(entry => entry.type === 'loadout')).toHaveLength(1);
    expect(manager.getSessionLoadout(session.id)).toMatchObject({ model: 'hook-model', systemPrompt: 'START_PROMPT' });
    await registry.unload('loadout');
    await turn();
    expect(manager.getSessionLoadout(session.id)).toMatchObject({ model: 'initial', systemPrompt: '', tools: [], thinking: null });
    expect((await manager.getRawEntries(session.id)).filter(entry => entry.type === 'loadout')).toHaveLength(2);
    await registry.shutdown();
  });

  it('does not dispatch or publish provenance after a cancelled start observer', async () => {
    const manager = new SessionManager(), session = await manager.create(), registry = new ExtensionRegistry();
    const provider = new MockProvider({ type: 'mock' }), dispatch = vi.spyOn(provider, 'streamChat'), controller = new AbortController();
    await expect(streamProviderTurn({ provider, providerName: 'mock', sessionManager: manager, sessionId: session.id,
      messages: [], tools: [], extensionRegistry: registry, signal: controller.signal, onStart: () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispatch).not.toHaveBeenCalled(); expect(manager.getSessionLoadout(session.id)).toBeUndefined();
  });
});
