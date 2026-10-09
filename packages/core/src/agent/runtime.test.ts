import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type BeforeHookMap } from '../extensions/extension-registry.js';
import { AiProvider, MockProvider, type ChatOptions, type ChatResponse } from '../providers/index.js';
import { CredentialRedactor } from '../providers/credentials.js';
import type { McpSessionHost } from '../mcp/session-host.js';
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

class DynamicToolProvider extends AiProvider {
  constructor() { super({ type: 'mock' as never }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    messages: Message[],
    _onChunk: (chunk: string) => void,
    onComplete?: (response?: ChatResponse) => void,
    _onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    const toolName = options?.tools?.find(tool => tool.name.startsWith('mcp__'))?.name;
    if (!messages.some(message => message.role === 'tool') && toolName) {
      onComplete?.({ content: '', toolCalls: [{ id: 'mcp-call', name: toolName, input: { query: 'core' } }] });
      return;
    }
    onComplete?.({ content: 'MCP complete' });
  }
}

class DeferredToolProvider extends AiProvider {
  declarations: string[][] = [];

  constructor() { super({ type: 'mock' as never }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    messages: Message[],
    _onChunk: (chunk: string) => void,
    onComplete?: (response?: ChatResponse) => void,
    _onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    const declarations = options?.tools?.map(tool => tool.name) ?? [];
    this.declarations.push(declarations);
    const toolMessages = messages.filter(message => message.role === 'tool');
    if (toolMessages.length === 0) {
      onComplete?.({
        content: '',
        toolCalls: [{ id: 'search-call', name: 'tool_search', input: { query: 'product documentation' } }],
      });
      return;
    }
    if (toolMessages.length === 1) {
      onComplete?.({
        content: '',
        toolCalls: [{ id: 'lookup-call', name: 'mcp__docs__lookup', input: { query: 'core' } }],
      });
      return;
    }
    onComplete?.({ content: 'Deferred MCP complete' });
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

class FragmentedCredentialProvider extends AiProvider {
  messages: Message[] = [];
  constructor(private readonly secret: string) { super({ type: 'mock' as never }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    messages: Message[],
    onChunk: (chunk: string) => void | Promise<void>,
    onComplete?: (response?: ChatResponse) => void,
  ): Promise<void> {
    this.messages = structuredClone(messages);
    const split = Math.floor(this.secret.length / 2);
    await onChunk(`before:${this.secret.slice(0, split)}`);
    await onChunk(`${this.secret.slice(split)}:after`);
    onComplete?.({ content: `before:${this.secret}:after` });
  }
}

class CapturingProvider extends MockProvider {
  systemPrompt?: string;

  override async streamChat(...args: Parameters<MockProvider['streamChat']>): Promise<void> {
    this.systemPrompt = args[4]?.systemPrompt;
    await super.streamChat(...args);
  }
}

class GatedProvider extends AiProvider {
  calls: string[][] = [];
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private releaseFirst!: () => void;
  private readonly firstGate: Promise<void>;

  constructor() {
    super({ type: 'mock' as never });
    this.started = new Promise(resolve => { this.markStarted = resolve; });
    this.firstGate = new Promise(resolve => { this.releaseFirst = resolve; });
  }

  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    messages: Message[],
    onChunk: (chunk: string) => void,
    onComplete?: (response?: ChatResponse) => void,
  ): Promise<void> {
    this.calls.push(messages.filter(message => message.role === 'user').map(message => message.content));
    if (this.calls.length === 1) {
      this.markStarted();
      await this.firstGate;
    }
    const content = `response ${this.calls.length}`;
    onChunk(content);
    onComplete?.({ content });
  }

  release(): void { this.releaseFirst(); }
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
  it('replays nested model progress under the outer tool and accounts usage once in persisted results', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(provider, 'classify').mockImplementation(async () => {
      await hold;
      return { label: 'yes', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, costUsd: 0.002 } };
    });
    vi.spyOn(provider, 'streamChat').mockImplementation(async (messages, _chunk, complete) => {
      complete?.(messages.some(message => message.role === 'tool') ? { content: 'done' } : {
        content: '', toolCalls: [{ id: 'outer-script', name: 'codemode', input: {
          code: `return await models.classify({model:'virtual-chat:classifier',input:'test',labels:['yes','no']});`,
        } }],
      });
    });
    const usage = vi.fn();
    const { runtime, sessionManager, session, extensionRegistry } = await setup(provider, usage);
    const hook = vi.fn((data: BeforeHookMap['before:model']) => ({ request: { ...data.request, input: 'transformed' } }));
    await extensionRegistry.load('model-hook', api => { api.before('before:model', hook); });
    const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'classify',
      codemode: { enabled: true }, allowedTools: ['codemode'] });
    await vi.waitFor(() => expect(runtime.snapshot(session.id).run?.activeTool?.nestedCalls).toHaveLength(1));
    const snapshot = runtime.snapshot(session.id).run;
    expect(snapshot?.activeTool).toMatchObject({ id: 'outer-script', name: 'codemode', nestedCalls: [{ state: 'running', parentId: 'outer-script' }] });
    const interaction = runtime.requestExtensionInteraction(session.id, { kind: 'confirm', title: 'Retained control' });
    expect(runtime.snapshot(session.id).run?.extensionRequest?.title).toBe('Retained control');
    await extensionRegistry.load('transient-dynamic', api => api.registerTool({ name: 'transient',
      description: 'Transient dynamic tool', execute: () => ({ content: 'unused' }) }));
    await extensionRegistry.unload('transient-dynamic');
    expect(runtime.snapshot(session.id).run?.extensionRequest?.title).toBe('Retained control');
    expect(runtime.snapshot(session.id).run?.activeTool?.nestedCalls).toHaveLength(1);
    const replay = runtime.journal.replay(session.id);
    expect(replay.events.filter(event => event.type === 'tool.started')).toHaveLength(1);
    expect(replay.events.filter(event => event.type === 'tool.progress')).toHaveLength(1);
    release(); await runtime.wait(run.id); await interaction;
    const results = sessionManager.get(session.id)!.messages.filter(message => message.role === 'tool');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: 'outer-script', usage: { totalTokens: 4, costUsd: 0.002 },
      metadata: { codemode: { costComplete: true, nestedCalls: [{ state: 'completed' }] } } });
    expect(sessionManager.get(session.id)?.usage).toMatchObject({ totalTokens: 4, costUsd: 0.002 });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(provider.classify).toHaveBeenCalledWith(expect.objectContaining({ input: 'transformed' }), expect.anything());
    const modelHook = hook.mock.calls[0]![0];
    expect(modelHook.signal.aborted).toBe(true);
    modelHook.context.notify('late-model-hook');
    expect(await modelHook.context.requestInteraction!({ kind: 'confirm', title: 'Late model control' })).toEqual({ cancelled: true });
    expect(runtime.snapshot(session.id).run?.extensionRequest).toBeUndefined();
    expect(runtime.journal.replay(session.id).events.filter(event => event.type === 'notice').map(event => event.data))
      .not.toContainEqual({ message: 'late-model-hook', level: 'info' });
    const finished = runtime.journal.replay(session.id).events;
    expect(finished.filter(event => event.type === 'tool.completed')).toHaveLength(1);
    expect(finished.filter(event => event.type === 'tool.progress')).toHaveLength(2);
  });

  it('persists completed nested usage on Stop without committing store or accepting late work', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' });
    const usage = vi.fn();
    const { runtime, sessionManager, session, extensionRegistry } = await setup(provider, usage);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    await extensionRegistry.load('held-tool', api => api.registerTool({ name: 'hold', description: 'Wait',
      execute: async () => { await hold; return { content: 'late output' }; } }));
    vi.spyOn(provider, 'classify').mockResolvedValue({ label: 'yes',
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, costUsd: 0.002 } });
    const stream = vi.spyOn(provider, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      complete?.({ content: '', toolCalls: [{ id: 'interrupted-script', name: 'codemode', input: {
        code: `store('notCommitted',true); await models.classify({model:'virtual-chat:classifier',input:'test',labels:['yes']}); return await tools.hold({});`,
      } }] });
    });
    const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'classify',
      codemode: { enabled: true }, allowedTools: ['codemode', 'hold'] });
    await vi.waitFor(() => expect(runtime.snapshot(session.id).run?.activeTool?.nestedCalls)
      .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'completed', kind: 'classifier' }),
        expect.objectContaining({ state: 'running', kind: 'tool' })])));
    runtime.stop(run.id);
    await expect(runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'too early' }))
      .rejects.toThrow('déjà actif');
    await runtime.wait(run.id);
    const result = sessionManager.get(session.id)!.messages.at(-1)!;
    expect(result).toMatchObject({ role: 'tool', toolCallId: 'interrupted-script', isError: true,
      content: 'Tool execution interrupted.', usage: { totalTokens: 4, costUsd: 0.002 },
      metadata: { interrupted: true, codemode: { nestedCalls: [{ state: 'completed' }, { state: 'cancelled' }] } } });
    expect((result.metadata?.codemode as Record<string, unknown>).store).toBeUndefined();
    expect(sessionManager.get(session.id)?.usage).toMatchObject({ totalTokens: 4, costUsd: 0.002 });
    expect(usage).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    const events = runtime.journal.replay(session.id).events;
    expect(events.filter(event => event.type === 'tool.failed')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run.stopped');
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(runtime.journal.replay(session.id).events).toEqual(events);
    expect(sessionManager.get(session.id)!.messages.at(-1)).toEqual(result);
    expect(usage).toHaveBeenCalledOnce();
  });

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

  it('redacts known credentials before provider input, streaming events, and session persistence', async () => {
    const secret = 'agent+runtime-secret';
    const provider = new FragmentedCredentialProvider(secret);
    const redactor = new CredentialRedactor([secret]);
    const sessionManager = new SessionManager();
    const session = await sessionManager.create({ cwd: process.cwd() });
    const runtime = new AgentRuntime({
      sessionManager,
      extensionRegistry: new ExtensionRegistry(),
      resolveProvider: () => provider,
      isProjectTrusted: () => true,
      redactText: value => redactor.redact(value),
      redactJson: value => redactor.redactJson(value),
      createTextRedactor: () => redactor.createStream(),
    });

    const started = await runtime.start({
      sessionId: session.id,
      cwd: process.cwd(),
      provider: 'mock',
      input: `do not persist ${secret}`,
    });
    await runtime.wait(started.id);

    const boundary = JSON.stringify({
      session: sessionManager.get(session.id),
      events: runtime.journal.replay(session.id),
      run: runtime.getRun(started.id),
    });
    expect(boundary).not.toContain(secret);
    expect(boundary).not.toContain(encodeURIComponent(secret));
    expect(boundary).toContain('[REDACTED]');
    expect(JSON.stringify(provider.messages)).not.toContain(secret);
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

  it('uses the shared all/one-at-a-time scheduler for detached Web queues', async () => {
    const provider = new GatedProvider();
    const { runtime, sessionManager, session } = await setup(provider);
    const started = await runtime.start({
      sessionId: session.id,
      cwd: process.cwd(),
      provider: 'mock',
      input: 'initial',
      followUpMode: 'all',
    });
    await provider.started;
    runtime.enqueue(started.id, 'follow-up', 'next one', [{ type: 'text', text: 'next one' }]);
    runtime.enqueue(started.id, 'follow-up', 'next two', [{ type: 'text', text: 'next two' }]);
    provider.release();

    await runtime.wait(started.id);
    expect(provider.calls).toEqual([
      ['initial'],
      ['initial', 'next one', 'next two'],
    ]);
    expect(sessionManager.get(session.id)?.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['initial', 'next one', 'next two']);
    expect(runtime.getRun(started.id)).toMatchObject({ steerQueue: [], followUpQueue: [] });
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

  it('prepares and executes persistent MCP tools through the shared tool loop', async () => {
    const provider = new DynamicToolProvider();
    const sessionManager = new SessionManager();
    const session = await sessionManager.create({ cwd: process.cwd() });
    const extensionRegistry = new ExtensionRegistry();
    extensionRegistry.attachSessionManager(sessionManager);
    const execute = vi.fn(async () => ({
      content: 'found in core',
      details: { server: 'docs', tool: 'lookup' },
    }));
    const prepared = {
      tools: [{
        name: 'mcp__docs__lookup',
        description: '[MCP docs] Lookup',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        extensionId: 'builtin:mcp' as const,
        readOnly: true,
        mcp: { scope: 'global' as const, server: 'docs', tool: 'lookup' },
        execute,
      }],
      has: (name: string) => name.toLowerCase() === 'mcp__docs__lookup',
      execute,
    };
    const mcpHost = {
      prepareForPrompt: vi.fn(async () => prepared),
      getPreparedTools: vi.fn(() => prepared),
      finishPrompt: vi.fn(),
      releaseSession: vi.fn(async () => undefined),
    } as unknown as McpSessionHost;
    const runtime = new AgentRuntime({
      sessionManager,
      extensionRegistry,
      resolveProvider: () => provider,
      isProjectTrusted: () => true,
      mcpHost,
    });

    const started = await runtime.start({
      sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'lookup', toolPreset: 'read-only',
    });
    await runtime.wait(started.id);

    expect(mcpHost.prepareForPrompt).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      'mcp__docs__lookup',
      { query: 'core' },
      expect.objectContaining({ currentSessionId: session.id }),
      expect.any(AbortSignal),
    );
    expect(sessionManager.get(session.id)?.messages.map(message => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant',
    ]);
    expect(sessionManager.get(session.id)?.messages[2]).toMatchObject({
      name: 'mcp__docs__lookup', content: 'found in core', isError: false,
    });
  });

  it('discovers deferred MCP tools for the next turn and restores activation after a fork', async () => {
    const provider = new DeferredToolProvider();
    const sessionManager = new SessionManager();
    const session = await sessionManager.create({ cwd: process.cwd() });
    const extensionRegistry = new ExtensionRegistry();
    extensionRegistry.attachSessionManager(sessionManager);
    const callTool = vi.fn(async () => ({ content: 'found deferred documentation' }));
    const deferredTool = {
      name: 'mcp__docs__lookup',
      description: '[MCP docs] Search product documentation',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      extensionId: 'builtin:mcp' as const,
      exposure: 'deferred' as const,
      namespace: { name: 'mcp__docs', description: 'Documentation server' },
      readOnly: true,
      mcp: { scope: 'global' as const, server: 'docs', tool: 'lookup' },
      execute: callTool,
    };
    const prepared = {
      tools: [],
      discoverableTools: [deferredTool],
      hasPotentialDiscoverableTools: true,
      currentDiscoverableTools: () => [deferredTool],
      waitForDiscoverableTools: vi.fn(async () => [deferredTool]),
      has: (name: string) => name.toLowerCase() === deferredTool.name,
      execute: vi.fn(async (_name: string, input: unknown) => callTool(input)),
    };
    const mcpHost = {
      prepareForPrompt: vi.fn(async () => prepared),
      getPreparedTools: vi.fn(() => prepared),
      finishPrompt: vi.fn(),
      releaseSession: vi.fn(async () => undefined),
    } as unknown as McpSessionHost;
    const runtime = new AgentRuntime({
      sessionManager,
      extensionRegistry,
      resolveProvider: () => provider,
      isProjectTrusted: () => true,
      mcpHost,
    });

    const started = await runtime.start({
      sessionId: session.id,
      cwd: process.cwd(),
      provider: 'mock',
      input: 'look up the product documentation',
    });
    await runtime.wait(started.id);

    expect(provider.declarations).toEqual([
      ['tool_search'],
      ['tool_search', deferredTool.name],
      ['tool_search', deferredTool.name],
    ]);
    expect(prepared.waitForDiscoverableTools).toHaveBeenCalledOnce();
    expect(prepared.execute).toHaveBeenCalledWith(
      deferredTool.name,
      { query: 'core' },
      expect.objectContaining({ currentSessionId: session.id }),
      expect.any(AbortSignal),
    );
    const searchResult = sessionManager.get(session.id)?.messages.find(message => message.name === 'tool_search');
    expect(searchResult?.metadata).toEqual({ toolSearch: { loaded: [deferredTool.name] } });

    const fork = await sessionManager.forkSession(session.id, undefined, 'Deferred branch');
    expect(fork).toBeTruthy();
    expect(runtime.getTools('default', undefined, undefined, fork!.id).map(tool => tool.name))
      .toEqual(['tool_search', deferredTool.name]);
    const beforeActivation = await sessionManager.forkSession(session.id, 0, 'Before activation');
    expect(beforeActivation).toBeTruthy();
    expect(runtime.getTools('default', undefined, undefined, beforeActivation!.id).map(tool => tool.name))
      .toEqual(['tool_search']);
  });

  it('does not persist an unsent prompt when Stop aborts the MCP startup wait', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.create({ cwd: process.cwd() });
    const extensionRegistry = new ExtensionRegistry();
    const prepareForPrompt = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const releaseSession = vi.fn(async () => undefined);
    const mcpHost = {
      prepareForPrompt,
      getPreparedTools: () => ({ tools: [], has: () => false }),
      finishPrompt: vi.fn(),
      releaseSession,
    } as unknown as McpSessionHost;
    const runtime = new AgentRuntime({
      sessionManager,
      extensionRegistry,
      resolveProvider: () => new MockProvider({ type: 'mock' as never }),
      isProjectTrusted: () => true,
      mcpHost,
    });

    const started = await runtime.start({
      sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'not sent',
    });
    runtime.stop(started.id);
    await runtime.wait(started.id);

    expect(prepareForPrompt).toHaveBeenCalledOnce();
    expect(runtime.getRun(started.id)?.phase).toBe('stopped');
    expect(sessionManager.get(session.id)?.messages).toEqual([]);
    expect(releaseSession).toHaveBeenCalledWith(session.id);
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
