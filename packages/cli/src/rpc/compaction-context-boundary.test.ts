import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController, type RpcControllerContext } from './rpc-controller.js';

describe('published model context and reserve govern automatic compaction', () => {
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
