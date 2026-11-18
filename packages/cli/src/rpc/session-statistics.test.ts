import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExtensionRegistry, JsonlSessionStore, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController } from './rpc-controller.js';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7,
  cacheWriteTokens: 2, totalTokens: 24, costUsd: 0.01 };

async function fixture(durable: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-session-statistics-'));
  const manager = new SessionManager();
  const store = new JsonlSessionStore(directory);
  if (durable) manager.setStore(store);
  const session = await manager.create({ title: 'Accounting', cwd: directory });
  const provider = new MockProvider({ type: 'mock', model: 'mock-model' });
  const registry = new ExtensionRegistry();
  const controller = new RpcController({ sessionManager: manager, sessionId: session.id,
    sessionDir: durable ? directory : undefined, extensionRegistry: registry,
    provider, providerName: 'mock', model: 'mock-model', thinking: 'off', tools: [],
    toolContext: { sessionManager: manager, currentSessionId: session.id, provider,
      providerName: 'mock', cwd: directory, projectTrusted: false, notify: () => undefined },
  }, () => undefined);
  await controller.initialize();
  return { directory, manager, store, session, controller,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe.each([false, true])('session accounting (durable=%s)', durable => {
  it('separates complete journal and active ancestors, including summary and outer nested usage once', async () => {
    const f = await fixture(durable);
    try {
      await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'Root', usage });
      const rootId = f.manager.get(f.session.id)!.activeLeafId;
      expect(rootId).toBeTypeOf('string');
      await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'Abandoned', usage: { ...usage, costUsd: 1 } });
      await f.manager.update(f.session.id, { activeLeafId: rootId });
      await f.manager.addBranchSummary(f.session.id, 'Branch summary', 'Selected', {
        provider: 'mock', model: 'mock-model', usage,
      });
      await f.manager.addMessage(f.session.id, { role: 'tool', name: 'codemode', content: 'Nested', usage,
        metadata: { codemode: { costComplete: false, nestedCalls: [{ usage: { costUsd: 999 } }] },
          toolProgress: { details: { usage: { costUsd: 999 } } } } });
      await f.manager.addMessage(f.session.id, { role: 'user', content: 'User', usage: { costUsd: 999 } });
      const response = await f.controller.handle({ type: 'get_session_stats', id: 'stats', includeAccounting: true });
      expect(response).toMatchObject({ id: 'stats', success: true, data: {
        sessionId: f.session.id, userMessages: 1, assistantMessages: 2, toolResults: 1, totalMessages: 4,
        tokens: { input: 40, output: 20, cacheRead: 28, cacheWrite: 8, total: 96 }, cost: null,
        accounting: {
          activePathComplete: true,
          active: { requests: 3, knownCostUsd: 0.03, cost: 'partial',
            userMessages: 1, assistantMessages: 1, totalMessages: 3,
            usage: { totalTokens: 72 } },
          history: { requests: 4, knownCostUsd: 1.03, cost: 'partial', usage: { totalTokens: 96 } },
        },
      } });
      if (durable) {
        const reloaded = new SessionManager();
        reloaded.setStore(f.store);
        await reloaded.loadAllSessions();
        const summary = (await reloaded.getRawEntries(f.session.id)).find(entry => entry.type === 'branch_summary');
        expect(summary).toMatchObject({ provider: 'mock', model: 'mock-model', usage });
      }
    } finally { await f.cleanup(); }
  });

  it('does not price an unproven historical model using the currently selected model', async () => {
    const f = await fixture(durable);
    try {
      await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'Unattributed',
        usage: { inputTokens: 1_000_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      const provider = new MockProvider({ type: 'mock', model: 'o3' });
      const controller = new RpcController({ sessionManager: f.manager, sessionId: f.session.id,
        extensionRegistry: new ExtensionRegistry(), provider, providerName: 'openai', model: 'o3',
        thinking: 'off', tools: [], toolContext: { sessionManager: f.manager,
          currentSessionId: f.session.id, provider, providerName: 'openai', cwd: f.directory,
          projectTrusted: false, notify: () => undefined } }, () => undefined);
      await controller.initialize();
      expect(await controller.handle({ type: 'get_session_stats', includeAccounting: true })).toMatchObject({ success: true,
        data: { cost: null, accounting: { history: { cost: 'unknown' } } } });
    } finally { await f.cleanup(); }
  });

  it('retains legacy empty-session framing unless accounting is explicitly requested', async () => {
    const f = await fixture(durable);
    try {
      for (const includeAccounting of [undefined, false]) {
        const response = await f.controller.handle({ type: 'get_session_stats', id: 'legacy', includeAccounting });
        expect(response).toMatchObject({ id: 'legacy', success: true, data: { cost: 0,
          userMessages: 0, assistantMessages: 0, totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        if (!response) throw new Error('Missing statistics response.');
        expect(response.data).not.toHaveProperty('accounting');
        expect(response.data).not.toHaveProperty('contextUsage');
      }
      for (const value of [null, 'true', 0, [], {}]) {
        expect(await f.controller.handle({ type: 'get_session_stats', id: 'invalid', includeAccounting: value as boolean }))
          .toMatchObject({ id: 'invalid', success: false, error: 'includeAccounting must be a boolean.' });
      }
    } finally { await f.cleanup(); }
  });

  it('distinguishes missing usage from a measured zero and always reports effective context', async () => {
    const f = await fixture(durable);
    try {
      await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'No measurement' });
      expect(await f.controller.handle({ type: 'get_session_stats', includeAccounting: true })).toMatchObject({ success: true,
        data: { cost: null, accounting: { history: { cost: 'unknown', partial: true } },
          contextUsage: { tokens: f.manager.estimateContextTokens(f.session.id), contextWindow: null, percent: null } } });
    } finally { await f.cleanup(); }
  });
});
