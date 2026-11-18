import { describe, expect, it, vi } from 'vitest';
import { CloudflareWorkersAiMixedProvider, ExtensionRegistry, MockProvider, OpenAiMixedProvider, OpenRouterProvider, SessionManager } from '@ai-harness/core';
import { RpcController, type RpcControllerContext } from './rpc-controller.js';

describe('published model context and reserve govern automatic compaction', () => {
  it.each([
    [() => new OpenAiMixedProvider({ type: 'operator-model', apiKey: 'disposable', baseUrl: 'http://127.0.0.1:1/v1' }), 'gpt-6-luna', 272_000, 'o3-mini', 200_000],
    [() => new OpenRouterProvider({ type: 'operator-model', apiKey: 'disposable', baseUrl: 'http://127.0.0.1:1/v1' }), 'anthropic/claude-sonnet-4.6', 1_000_000, 'openai/gpt-4o', 128_000],
    [() => new CloudflareWorkersAiMixedProvider({ type: 'operator-model', apiKey: 'disposable', baseUrl: 'http://127.0.0.1:1/ai' }), '@cf/google/gemma-4-26b-a4b-it', 256_000, '@cf/ibm-granite/granite-4.0-h-micro', 131_000],
  ] as const)('applies adapter metadata at initialization, model selection and cycling', async (create, first, window, second, secondWindow) => {
    const sessionManager = new SessionManager(), extensionRegistry = new ExtensionRegistry();
    extensionRegistry.attachSessionManager(sessionManager);
    const provider = create(), name = 'operator-model', sessionId = 'native-context-boundary';
    const summary = vi.spyOn(provider, 'chat').mockResolvedValue({ content: 'Summary', model: first });
    const context: RpcControllerContext = {
      provider, providers: new Map([[name, provider]]), sessionManager, extensionRegistry, sessionId,
      providerName: name, model: first, thinking: 'high', offline: true, tools: [],
      scopedModels: [{ provider: name, id: first }, { provider: name, id: second }],
      agentSettings: () => ({ compaction: { enabled: true, reserveTokens: 30_000, keepRecentTokens: 1_000 } }),
      toolContext: { sessionManager, currentSessionId: sessionId, provider, providerName: name,
        cwd: process.cwd(), projectTrusted: false, notify: () => {} },
    };
    const controller = new RpcController(context, () => {});
    try {
      await controller.initialize();
      await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({ success: true, data: { thinkingLevel: 'high' } });
      await expect(controller.handle({ type: 'get_available_thinking_levels' })).resolves.toMatchObject({ success: true, data: { levels: expect.arrayContaining(['high']) } });
      expect(sessionManager.getCompactionContextWindow()).toBe(window);
      for (let index = 0; index < 4; index++) await sessionManager.addMessage(sessionId,
        { role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(110_000) }, { skipAutoCompaction: true });
      await expect(controller.handle({ type: 'get_session_stats' })).resolves.toMatchObject({
        success: true, data: { contextUsage: { contextWindow: window } },
      });
      expect(await sessionManager.checkAndTriggerCompaction(sessionId)).toBe(false);
      expect(summary).not.toHaveBeenCalled();
      const sibling = await sessionManager.create();
      sessionManager.setCompactionContextWindow(75_000, sibling.id);
      sessionManager.setCompactionContextWindow(90_000, sessionId);
      await expect(controller.handle({ type: 'set_model', provider: name, modelId: second })).resolves.toMatchObject({ success: true });
      expect(sessionManager.getCompactionContextWindow()).toBe(secondWindow);
      await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({ success: true, data: { thinkingLevel: provider instanceof OpenAiMixedProvider ? 'high' : 'off' } });
      expect(sessionManager.getCompactionContextWindow(sessionId)).toBe(secondWindow);
      expect(sessionManager.getCompactionContextWindow(sibling.id)).toBe(75_000);
      await expect(controller.handle({ type: 'get_session_stats' })).resolves.toMatchObject({
        success: true, data: { contextUsage: { contextWindow: secondWindow } },
      });
      await expect(controller.handle({ type: 'cycle_model' })).resolves.toMatchObject({ success: true });
      expect(sessionManager.getCompactionContextWindow()).toBe(window);
      await expect(controller.handle({ type: 'set_thinking_level', level: 'high' })).resolves.toMatchObject({ success: true });
      await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({ success: true, data: { thinkingLevel: 'high' } });
      await expect(controller.handle({ type: 'set_model', provider: name, modelId: 'not-reviewed' })).resolves.toMatchObject({ success: false });
      expect(sessionManager.getCompactionContextWindow()).toBe(window);
      expect(sessionManager.getCompactionContextWindow(sessionId)).toBe(window);
      expect(sessionManager.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 30_000, keepRecentTokens: 1_000 });
      expect(summary).not.toHaveBeenCalled();
    } finally { await controller.close(); }
  });

  for (const [reserveTokens, expected] of [[10_000, false], [30_000, true]] as const) {
    it(`uses a 128000-token model window minus reserve ${reserveTokens}, not only keepRecentTokens`, async () => {
      const sessionManager = new SessionManager();
      const extensionRegistry = new ExtensionRegistry();
      extensionRegistry.attachSessionManager(sessionManager);
      const provider = new MockProvider({ type: 'mock' as never, model: 'gpt-4o' });
      const context: RpcControllerContext = {
        provider, sessionManager, extensionRegistry, sessionId: `context-boundary-${reserveTokens}`,
        providerName: 'openai', model: 'gpt-4o', tools: [],
        agentSettings: () => ({ compaction: { enabled: true, reserveTokens, keepRecentTokens: 1_000 } }),
        toolContext: { sessionManager, currentSessionId: `context-boundary-${reserveTokens}`, provider,
          providerName: 'openai', cwd: process.cwd(), projectTrusted: false, notify: () => {} },
      };
      const controller = new RpcController(context, () => {});
      try {
        await controller.initialize();
        for (let index = 0; index < 4; index++) await sessionManager.addMessage(context.sessionId,
          { role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(110_000) }, { skipAutoCompaction: true });
        await expect(controller.handle({ type: 'get_session_stats' })).resolves.toMatchObject({
          success: true, data: { contextUsage: { contextWindow: 128_000 } },
        });
        const summary = vi.spyOn(provider, 'chat').mockResolvedValue({ content: 'Summary', model: 'gpt-4o' });
        expect(await sessionManager.checkAndTriggerCompaction(context.sessionId)).toBe(expected);
        expect(summary).toHaveBeenCalledTimes(expected ? 1 : 0);
        expect((await sessionManager.getRawEntries(context.sessionId)).filter(entry => entry.type === 'compaction'))
          .toHaveLength(expected ? 1 : 0);
      } finally { await controller.close(); }
    });
  }
});
