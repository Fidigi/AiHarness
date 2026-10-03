import { describe, expect, it } from 'vitest';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { AiProvider, MockProvider, type ChatOptions, type ChatResponse } from '../providers/index.js';
import { SessionManager } from '../sessions/session-manager.js';
import type { Message } from '../types/index.js';
import { AgentRuntime, type AgentRuntimeOptions } from './runtime.js';

class ToolProvider extends AiProvider {
  constructor() { super({ type: 'mock' as never }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    messages: Message[],
    onChunk: (chunk: string) => void,
    onComplete?: (response?: ChatResponse) => void,
  ): Promise<void> {
    if (!messages.some(message => message.role === 'tool')) {
      onComplete?.({
        content: '', model: 'tool-model',
        usage: { promptTokens: 6, completionTokens: 2, totalTokens: 8 },
        toolCalls: [{ id: 'call-1', name: 'sum', input: { a: 2, b: 5 } }],
      });
      return;
    }
    onChunk('The result ');
    onChunk('is 7.');
    onComplete?.({
      content: 'The result is 7.',
      model: 'tool-model',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  }
}

class RetryProvider extends AiProvider {
  attempts = 0;
  constructor() { super({ type: 'mock' as never }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    _messages: Message[],
    onChunk: (chunk: string) => void,
    onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    this.attempts++;
    if (this.attempts === 1) {
      onError?.(new Error('temporary outage'));
      return;
    }
    onChunk('recovered');
    onComplete?.({ content: 'recovered' });
  }
}

class CapturingProvider extends MockProvider {
  systemPrompt?: string;

  override async streamChat(...args: Parameters<MockProvider['streamChat']>): Promise<void> {
    this.systemPrompt = args[4]?.systemPrompt;
    await super.streamChat(...args);
  }
}

class BlockingProvider extends AiProvider {
  constructor() { super({ type: 'mock' as never }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    _messages: Message[],
    _onChunk: (chunk: string) => void,
    _onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    await new Promise<void>(resolve => {
      options?.signal?.addEventListener('abort', () => {
        onError?.(new Error('aborted'));
        resolve();
      }, { once: true });
    });
  }
}

async function setup(provider: AiProvider, onUsage?: AgentRuntimeOptions['onUsage']) {
  const sessionManager = new SessionManager();
  const session = await sessionManager.create({ cwd: process.cwd(), workspaceId: 'workspace-1' });
  const extensionRegistry = new ExtensionRegistry();
  extensionRegistry.attachSessionManager(sessionManager);
  const runtime = new AgentRuntime({
    sessionManager,
    extensionRegistry,
    resolveProvider: () => provider,
    isProjectTrusted: () => true,
    onUsage,
  });
  return { runtime, sessionManager, session, extensionRegistry };
}

describe('AgentRuntime', () => {
  it('runs model/tool turns, persists rich entries, and publishes ordered replayable events', async () => {
    const turns: Array<{ provider: string; model?: string; tokens: number }> = [];
    const { runtime, sessionManager, session, extensionRegistry } = await setup(new ToolProvider(), (provider, model, usage) => {
      turns.push({ provider, model, tokens: usage.totalTokens });
      return 0.001;
    });
    await extensionRegistry.load('math', api => api.registerTool({
      name: 'sum',
      description: 'Add numbers',
      parameters: { type: 'object', required: ['a', 'b'] },
      execute: input => {
        const { a, b } = input as { a: number; b: number };
        return { content: String(a + b) };
      },
    }));

    const started = await runtime.start({
      sessionId: session.id,
      cwd: process.cwd(),
      workspaceId: 'workspace-1',
      provider: 'mock',
      input: 'Calculate',
    });
    const completed = await runtime.wait(started.id);

    expect(completed?.phase).toBe('completed');
    expect(sessionManager.get(session.id)?.messages.map(message => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant',
    ]);
    expect(sessionManager.get(session.id)?.messages[1].toolCalls?.[0]).toMatchObject({ name: 'sum' });
    expect(sessionManager.get(session.id)?.messages[2]).toMatchObject({ content: '7', toolCallId: 'call-1' });
    expect(sessionManager.get(session.id)?.usage).toMatchObject({ totalTokens: 23, costUsd: 0.002 });
    expect(turns).toEqual([
      { provider: 'mock', model: 'tool-model', tokens: 8 },
      { provider: 'mock', model: 'tool-model', tokens: 15 },
    ]);

    const replay = runtime.journal.replay(session.id, 0);
    expect(replay.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'run.queued', 'run.started', 'tool.started', 'tool.completed', 'message.delta', 'run.completed',
    ]));
    expect(replay.events.map(event => event.sequence)).toEqual(
      replay.events.map(event => event.sequence).sort((left, right) => left - right),
    );
    expect(runtime.journal.replay(session.id, replay.events.at(-2)!.sequence).events).toHaveLength(1);
  });

  it('validates declarative extension interaction responses before resuming a tool', async () => {
    const { runtime, session, extensionRegistry } = await setup(new ToolProvider());
    await extensionRegistry.load('interaction', api => api.registerTool({
      name: 'sum', description: 'Ask before adding', execute: async (_input, context) => {
        const answer = await context.requestInteraction!({
          kind: 'custom', title: 'Approve calculation', fields: [
            { name: 'mode', label: 'Mode', type: 'select', required: true, options: [{ value: 'safe', label: 'Safe' }] },
            { name: 'remember', label: 'Remember', type: 'checkbox' },
          ],
        });
        return { content: answer.cancelled ? 'cancelled' : '7' };
      },
    }));
    const started = await runtime.start({
      sessionId: session.id, cwd: process.cwd(), workspaceId: 'workspace-1', provider: 'mock', input: 'Calculate',
    });
    let request = runtime.getRun(started.id)?.extensionRequest;
    for (let attempt = 0; !request && attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0));
      request = runtime.getRun(started.id)?.extensionRequest;
    }
    expect(request).toMatchObject({ kind: 'custom', title: 'Approve calculation' });
    expect(() => runtime.respondToInteraction(session.id, request!.id, {
      cancelled: false, value: { mode: 'unsafe', remember: false },
    })).toThrow('not an available option');
    runtime.respondToInteraction(session.id, request!.id, {
      cancelled: false, value: { mode: 'safe', remember: false },
    });
    expect((await runtime.wait(started.id))?.phase).toBe('completed');
  });

  it('exposes the exact tools selected by each preset', async () => {
    const { runtime, extensionRegistry } = await setup(new MockProvider({ type: 'mock' as never }, ['ok']));
    await extensionRegistry.load('workspace', api => {
      for (const name of ['read', 'write', 'custom_tool']) {
        api.registerTool({ name, description: name, execute: () => ({ content: 'ok' }) });
      }
    });

    expect(runtime.getTools('chat-only')).toEqual([]);
    expect(runtime.getTools('read-only').map(tool => tool.name)).toEqual(['read']);
    expect(runtime.getTools('full').map(tool => tool.name)).toEqual(['read', 'write', 'custom_tool']);
  });

  it('keeps queued follow-ups in snapshots and consumes them after the active response', async () => {
    const provider = new MockProvider({ type: 'mock' as never }, ['first', 'second']);
    const { runtime, sessionManager, session } = await setup(provider);
    const started = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'initial' });
    const queued = runtime.enqueue(started.id, 'follow-up', 'next request');

    expect(queued.followUpQueue).toHaveLength(1);
    await runtime.wait(started.id);
    expect(sessionManager.get(session.id)?.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['initial', 'next request']);
    expect(runtime.getRun(started.id)?.followUpQueue).toEqual([]);
  });

  it('retries only failures that happen before a delta and does not duplicate assistant messages', async () => {
    const provider = new RetryProvider();
    const { runtime, sessionManager, session } = await setup(provider);
    const started = await runtime.start({
      sessionId: session.id,
      cwd: process.cwd(),
      provider: 'mock',
      input: 'retry',
      maxRetries: 2,
    });
    await runtime.wait(started.id);

    expect(provider.attempts).toBe(2);
    const retry = runtime.journal.replay(session.id).events.find(event => event.type === 'retry.scheduled');
    expect(retry?.data).toMatchObject({
      attempt: 1, max: 3, delayMs: 500, message: 'temporary outage', scheduledAt: expect.any(String),
    });
    expect(runtime.getRun(started.id)?.retry).toBeUndefined();
    expect(sessionManager.get(session.id)?.messages.filter(message => message.role === 'assistant'))
      .toHaveLength(1);
  });

  it('filters tools by child-agent tool and extension allowlists', async () => {
    const { runtime, extensionRegistry } = await setup(new MockProvider({ type: 'mock' as never }));
    await extensionRegistry.load('extension-alpha', api => api.registerTool({
      name: 'alpha_tool', description: 'Alpha', execute: () => ({ content: 'alpha' }),
    }));
    await extensionRegistry.load('extension-beta', api => api.registerTool({
      name: 'beta_tool', description: 'Beta', execute: () => ({ content: 'beta' }),
    }));

    expect(runtime.getTools('default', ['alpha_tool'], ['extension-alpha']).map(tool => tool.name))
      .toEqual(['alpha_tool']);
    expect(runtime.getTools('default', ['alpha_tool'], ['extension-beta'])).toEqual([]);
    expect(runtime.getTools('default', undefined, ['extension-beta']).map(tool => tool.name))
      .toEqual(['beta_tool']);
    expect(runtime.getTools('read-only')).toEqual([]);
  });

  it('forwards ephemeral resolved instructions without persisting their contents', async () => {
    const provider = new CapturingProvider({ type: 'mock' as never }, ['ok']);
    const { runtime, sessionManager, session } = await setup(provider);
    const started = await runtime.start({
      sessionId: session.id,
      cwd: process.cwd(),
      provider: 'mock',
      input: 'prompt',
      systemPrompt: 'resolved instructions including local context',
      persistSettings: false,
    });
    await runtime.wait(started.id);

    expect(provider.systemPrompt).toBe('resolved instructions including local context');
    expect(sessionManager.get(session.id)?.metadata?.systemPrompt).toBeUndefined();
  });

  it('stops a detached provider request and requires explicit project trust', async () => {
    const { runtime, session } = await setup(new BlockingProvider());
    const started = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'wait' });
    expect(runtime.stop(started.id).phase).toBe('stopped');
    await runtime.wait(started.id);
    expect(runtime.getRun(started.id)?.phase).toBe('stopped');

    const manager = new SessionManager();
    const untrustedSession = await manager.create({ cwd: process.cwd() });
    const guarded = new AgentRuntime({
      sessionManager: manager,
      extensionRegistry: new ExtensionRegistry(),
      resolveProvider: () => new MockProvider({ type: 'mock' as never }),
      isProjectTrusted: () => false,
    });
    await expect(guarded.start({ sessionId: untrustedSession.id, cwd: process.cwd(), provider: 'mock', input: 'blocked' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED', status: 409 });
  });
});
