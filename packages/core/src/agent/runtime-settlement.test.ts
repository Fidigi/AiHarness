import { describe, expect, it } from 'vitest';
import { MockProvider, type ChatResponse } from '../providers/index.js';
import { streamProviderTurn } from './provider-turn.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import type { McpSessionHost } from '../mcp/session-host.js';
import { AgentRuntime } from './runtime.js';

const latch = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('run settlement owns preparation and cleanup', () => {
  it('withdraws an admitted tool hook without invoking later hooks or the tool, and durably records interruption', async () => {
    const manager = new SessionManager(), registry = new ExtensionRegistry(), session = await manager.create({ cwd: process.cwd() });
    const entered = latch(), finish = latch(); let executed = 0, later = 0;
    await registry.load('held-tool', api => {
      api.registerTool({ name: 'held', description: 'held', execute: () => { executed++; return { content: 'must not execute' }; } });
      api.before('before:tool', async () => { entered.release(); await finish.promise; });
      api.before('before:tool', () => { later++; });
    });
    const provider = new MockProvider({ type: 'mock' });
    provider.streamChat = async (_messages, _chunk, complete) => { complete?.({ content: '', toolCalls: [{ id: 'held', name: 'held', input: {} }] }); };
    const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry, isProjectTrusted: () => true, resolveProvider: () => provider });
    const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'admitted', allowedTools: ['held'] });
    try {
      await entered.promise; runtime.stop(run.id); finish.release();
      expect((await runtime.wait(run.id))?.phase).toBe('stopped'); expect(executed).toBe(0); expect(later).toBe(0);
      expect(session.messages.at(-1)).toMatchObject({ role: 'tool', isError: true, metadata: { interrupted: true } });
    } finally { finish.release(); await runtime.wait(run.id); await registry.unloadAll(); }
  });

  it('retires retained stream callbacks after the real provider promise returns', async () => {
    const manager = new SessionManager(), registry = new ExtensionRegistry(), session = await manager.create({ cwd: process.cwd() });
    const provider = new MockProvider({ type: 'mock' }); let late!: (chunk: string) => void | Promise<void>;
    provider.streamChat = async (_messages, chunk, complete) => { late = chunk; await chunk('accepted'); complete?.({ content: 'accepted' }); };
    const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry, isProjectTrusted: () => true, resolveProvider: () => provider });
    const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'first' });
    expect((await runtime.wait(run.id))?.phase).toBe('completed');
    const before = runtime.journal.replay(session.id); await late('forbidden late output');
    expect(runtime.journal.replay(session.id)).toEqual(before); expect(session.messages.at(-1)?.content).toBe('accepted');
  });
  for (const callback of ['complete', 'error'] as const) it(`retires retained ${callback} callbacks while accepted stream delivery is still draining`, async () => {
    const registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock' });
    const returned = latch(), entered = latch(), finish = latch();
    let complete!: (result?: ChatResponse) => void, error!: (error: Error) => void;
    provider.streamChat = async (_messages, chunk, onComplete, onError) => {
      complete = onComplete!; error = onError!;
      void chunk('accepted');
      onComplete?.({ content: 'accepted', model: 'accepted-model' });
      returned.release();
    };
    const operation = streamProviderTurn({ provider, providerName: 'mock', messages: [], tools: [], extensionRegistry: registry,
      maxRetries: 0, onTextDelta: async () => { entered.release(); await finish.promise; } });
    try {
      await returned.promise; await entered.promise; await tick(); // Transport returned, but accepted output still owns settlement.
      if (callback === 'complete') complete({ content: 'forbidden', model: 'late-model',
        toolCalls: [{ id: 'late', name: 'must-not-execute', input: {} }], usage: { promptTokens: 999, completionTokens: 999, totalTokens: 1998 } });
      else error(new Error('forbidden late error'));
      const result = expect(operation).resolves.toEqual({ content: 'accepted', model: 'accepted-model' });
      finish.release(); await result;
    } finally { finish.release(); await operation.catch(() => undefined); }
  });

  for (const cleanupError of [false, true]) it(`keeps admission and terminal replay behind MCP release (failure=${cleanupError})`, async () => {
    const manager = new SessionManager(), registry = new ExtensionRegistry(), session = await manager.create({ cwd: process.cwd() });
    const preparing = latch(), preparation = latch(), cleaning = latch(), cleanup = latch();
    const host = {
      prepareForPrompt: async () => { preparing.release(); await preparation.promise; return { tools: [], has: () => false }; },
      getPreparedTools: () => ({ tools: [], has: () => false }), finishPrompt: () => undefined,
      releaseSession: async () => { cleaning.release(); await cleanup.promise; if (cleanupError) throw new Error('owned cleanup failed'); },
    } as unknown as McpSessionHost;
    const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry, mcpHost: host,
      isProjectTrusted: () => true, resolveProvider: () => new MockProvider({ type: 'mock' }) });
    const request = { sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'never publish' };
    const run = await runtime.start(request); await preparing.promise;
    try {
      expect(runtime.stop(run.id).phase).toBe('stopped');
      let waited = false; const waiting = runtime.wait(run.id).then(value => { waited = true; return value; });
      await tick(); expect(waited).toBe(false); expect(session.messages).toEqual([]);
      preparation.release(); await cleaning.promise;
      await expect(runtime.start(request)).rejects.toThrow('Un agent est déjà actif');
      expect(runtime.stop(run.id).phase).toBe('stopped');
      expect(runtime.journal.replay(session.id).events.some(event => /^run\.(completed|failed|stopped)$/.test(event.type))).toBe(false);
      await tick(); expect(waited).toBe(false); cleanup.release();
      expect((await waiting)?.phase).toBe(cleanupError ? 'failed' : 'stopped');
      expect(runtime.getRun(run.id)?.error).toBe(cleanupError ? 'owned cleanup failed' : undefined);
      expect(session.messages).toEqual([]);
    } finally { preparation.release(); cleanup.release(); await runtime.wait(run.id); }
  });

  it('waits for a non-cooperative admitted provider hook without admitting later hooks or output', async () => {
    const manager = new SessionManager(), registry = new ExtensionRegistry(), session = await manager.create({ cwd: process.cwd() });
    const entered = latch(), finish = latch(); let later = 0, providerCalls = 0;
    await registry.load('held-provider-hook', api => {
      api.before('before:provider', async () => { entered.release(); await finish.promise; });
      api.before('before:provider', () => { later++; });
    });
    const provider = new MockProvider({ type: 'mock' }); provider.streamChat = async () => { providerCalls++; };
    const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry,
      isProjectTrusted: () => true, resolveProvider: () => provider });
    const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'admitted', maxRetries: 0 });
    try {
      await entered.promise; runtime.stop(run.id);
      let waited = false; const waiting = runtime.wait(run.id).then(value => { waited = true; return value; });
      await tick(); expect(waited).toBe(false);
      finish.release(); expect((await waiting)?.phase).toBe('stopped');
      expect(later).toBe(0); expect(providerCalls).toBe(0);
      expect(session.messages.map(message => message.role)).toEqual(['user']);
    } finally { finish.release(); await runtime.wait(run.id); await registry.unloadAll(); }
  });
});
