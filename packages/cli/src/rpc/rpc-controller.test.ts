import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AiProvider,
  ExtensionRegistry,
  MockProvider,
  SessionManager,
  type ChatOptions,
  type ChatResponse,
  type Message,
} from '@ai-harness/core';
import { ResourceManager } from '../resources/resource-manager';
import { RpcController, type RpcControllerContext } from './rpc-controller';
import { EXPORT_PRIVACY_WARNING } from '../security/privacy-warnings.js';

class RpcToolProvider extends AiProvider {
  constructor() { super({ type: 'mock' as never }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(
    messages: Message[],
    _onChunk: (chunk: string) => void,
    onComplete?: (response?: ChatResponse) => void,
  ): Promise<void> {
    if (!messages.some(message => message.role === 'tool')) {
      onComplete?.({
        content: '',
        toolCalls: [{ id: 'mcp-rpc', name: 'mcp__docs__lookup', input: { query: 'rpc' } }],
      });
      return;
    }
    onComplete?.({ content: 'done' });
  }
}

class RpcSearchProvider extends AiProvider {
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
    this.declarations.push(options?.tools?.map(tool => tool.name) ?? []);
    const results = messages.filter(message => message.role === 'tool').length;
    if (results === 0) {
      onComplete?.({ content: '', toolCalls: [{ id: 'search', name: 'tool_search', input: { query: 'docs' } }] });
    } else if (results === 1) {
      onComplete?.({
        content: '',
        toolCalls: [{ id: 'deferred', name: 'mcp__docs__lookup', input: { query: 'rpc' } }],
      });
    } else {
      onComplete?.({ content: 'done' });
    }
  }
}

class CapturingProvider extends MockProvider {
  systemPrompt?: string;

  override async streamChat(...args: Parameters<MockProvider['streamChat']>): Promise<void> {
    this.systemPrompt = args[4]?.systemPrompt;
    await super.streamChat(...args);
  }
}

function createController(responses = ['RPC response']): {
  controller: RpcController;
  context: RpcControllerContext;
  records: Array<Record<string, unknown>>;
} {
  const sessionManager = new SessionManager();
  const extensionRegistry = new ExtensionRegistry();
  extensionRegistry.attachSessionManager(sessionManager);
  const provider = new MockProvider({ type: 'mock' as any, model: 'mock-model' }, responses);
  const context: RpcControllerContext = {
    provider,
    sessionManager,
    sessionId: 'rpc-test-session',
    extensionRegistry,
    providerName: 'mock',
    model: 'mock-model',
    thinking: 'medium',
    tools: [],
    toolContext: {
      sessionManager,
      currentSessionId: 'rpc-test-session',
      provider,
      providerName: 'mock',
      cwd: process.cwd(),
      projectTrusted: false,
      notify: vi.fn(),
    },
  };
  const records: Array<Record<string, unknown>> = [];
  return { controller: new RpcController(context, record => { records.push(record); }), context, records };
}

describe('RPC command controller', () => {
  it('reads only an explicit current-session MCP reference and suppresses a read retired by EOF', async () => {
    const { controller, context } = createController();
    const reference = '00000000-0000-4000-8000-000000000001';
    const content = { data: Buffer.from('disposable-RPC'), mediaType: 'audio/wav', size: 14, sha256: 'a'.repeat(64) };
    const read = vi.fn(async () => content); context.readMcpContent = read;
    expect((await controller.handle({ type: 'read_mcp_content', reference, sessionId: 'foreign' }))?.success).toBe(false);
    expect((await controller.handle({ type: 'read_mcp_content', reference: '../private' }))?.success).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const result = await controller.handle({ type: 'read_mcp_content', reference });
    expect(result?.data).toMatchObject({ reference, mediaType: 'audio/wav', data: content.data.toString('base64') });
    expect(read).toHaveBeenCalledWith(context.sessionId, reference);
    let release!: (value: typeof content) => void;
    context.readMcpContent = () => new Promise(resolve => { release = resolve; });
    const pending = controller.handle({ type: 'read_mcp_content', reference });
    await controller.close(); release(content);
    expect((await pending)?.success).toBe(false);
  });
  it('durably retains failed provider text/reasoning without inventing usage or retrying visible output', async () => {
    const { controller, context, records } = createController();
    context.redactText = text => text.replaceAll('disposable-private', '[REDACTED]');
    const stream = vi.spyOn(context.provider, 'streamChat').mockImplementation(async (_messages, chunk) => {
      await chunk('', { type: 'reasoning_delta', data: { content: 'reasoning disposable-private' } });
      await chunk('visible disposable-private');
      throw new Error('failed disposable-private');
    });
    await controller.initialize();
    await expect(controller.handle({ type: 'prompt', message: 'initial' })).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));
    const raw = await context.sessionManager.getRawEntries(context.sessionId);
    expect(raw.filter(entry => entry.type === 'message' && entry.role === 'assistant')).toEqual([
      expect.objectContaining({ content: 'visible [REDACTED]', metadata: { outputError: 'failed [REDACTED]' },
        blocks: [{ type: 'reasoning', text: 'reasoning [REDACTED]' }, { type: 'text', text: 'visible [REDACTED]' }] }),
    ]);
    expect(JSON.stringify(raw)).not.toContain('disposable-private'); expect(stream).toHaveBeenCalledOnce();
  });

  it('refreshes compaction policy on model selection, scoped cycling and saved-session switching', async () => {
    const { controller, context } = createController();
    context.agentSettings = () => ({ compaction: {
      reserveTokens: 100, keepRecentTokens: 1_000,
      modelOverrides: { 'mock/mock-model-v1': { reserveTokens: 200, keepRecentTokens: 10 } },
    } });
    context.scopedModels = [
      { provider: 'mock', id: 'mock-model-v1' }, { provider: 'mock', id: 'mock-model' },
    ];
    const manager = context.sessionManager;
    await controller.initialize();
    expect(manager.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 100, keepRecentTokens: 1_000 });
    await expect(controller.handle({ type: 'set_model', provider: 'mock', modelId: 'mock-model-v1' }))
      .resolves.toMatchObject({ success: true });
    expect(manager.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 200, keepRecentTokens: 10 });
    await expect(controller.handle({ type: 'set_model', provider: 'mock', modelId: 'missing' }))
      .resolves.toMatchObject({ success: false });
    expect(manager.getCompactionSettings().keepRecentTokens).toBe(10);
    await expect(controller.handle({ type: 'cycle_model' })).resolves.toMatchObject({ success: true });
    expect(manager.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 100, keepRecentTokens: 1_000 });
    const other = new MockProvider({ type: 'mock' as never, model: 'mock-model-v1' });
    vi.spyOn(other, 'getProviderType').mockReturnValue('other');
    context.providers = new Map([['mock', context.provider], ['other', other]]);
    const saved = await manager.create({ model: 'mock-model-v1', providerConfig: { type: 'mock' as never } });
    await expect(controller.handle({ type: 'switch_session', sessionPath: `${saved.id}.jsonl` }))
      .resolves.toMatchObject({ success: true });
    expect(manager.getCompactionSettings().keepRecentTokens).toBe(10);
    const otherSession = await manager.create({ model: 'mock-model-v1', providerConfig: { type: 'other' as never } });
    await expect(controller.handle({ type: 'switch_session', sessionPath: `${otherSession.id}.jsonl` }))
      .resolves.toMatchObject({ success: true });
    expect(manager.getCompactionSettings().keepRecentTokens).toBe(1_000);
  });

  it('applies the newly selected keep threshold to journal-backed automatic compaction, preserving session opt-out', async () => {
    const { controller, context } = createController();
    context.agentSettings = () => ({ compaction: {
      keepRecentTokens: 1_000, modelOverrides: { 'mock/mock-model-v1': { keepRecentTokens: 30 } },
    } });
    await controller.initialize();
    const manager = context.sessionManager;
    const id = context.sessionId;
    for (let index = 0; index < 4; index++) {
      await manager.addMessage(id, { role: 'user', content: 'x'.repeat(80) }, { skipAutoCompaction: true });
    }
    const chat = vi.spyOn(context.provider, 'chat').mockResolvedValue({ content: 'Summary', model: 'mock-model-v1' });
    expect(await manager.checkAndTriggerCompaction(id)).toBe(false);
    await controller.handle({ type: 'set_model', provider: 'mock', modelId: 'mock-model-v1' });
    await manager.update(id, { autoCompaction: false });
    expect(await manager.checkAndTriggerCompaction(id)).toBe(false);
    expect(chat).not.toHaveBeenCalled();
    await manager.update(id, { autoCompaction: true });
    expect(await manager.checkAndTriggerCompaction(id)).toBe(true);
    expect(chat).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ model: 'mock-model-v1' }));
    const compacted = (await manager.getRawEntries(id)).find(entry => entry.type === 'compaction');
    expect(compacted).toMatchObject({ type: 'compaction', summary: 'Summary', provider: 'mock', model: 'mock-model-v1' });
    expect(manager.getEffectiveContext(id)).toHaveLength(2); // Summary plus one retained message.
  });

  it('preserves host-configured compaction policy when the optional settings reader is absent', async () => {
    const { controller, context } = createController();
    context.sessionManager.setCompactionSettings({ enabled: false, reserveTokens: 3, keepRecentTokens: 7 });
    await controller.initialize();
    await controller.handle({ type: 'set_model', provider: 'mock', modelId: 'mock-model-v1' });
    expect(context.sessionManager.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 3, keepRecentTokens: 7 });
  });

  it('scavenges expired private bash output directories without following symlinks', async () => {
    const stale = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-bash-'));
    const target = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-retention-target-'));
    const linked = path.join(os.tmpdir(), `ai-harness-bash-link-${Date.now()}`);
    try {
      await writeFile(path.join(stale, 'output.log'), 'old', { mode: 0o600 });
      await utimes(stale, new Date(0), new Date(0));
      await symlink(target, linked);
      const { controller, context } = createController();
      context.fullOutputRetentionMs = 60_000;
      await controller.initialize();

      await expect(readFile(path.join(stale, 'output.log'))).rejects.toThrow();
      expect((await lstat(target)).isDirectory()).toBe(true);
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(stale, { recursive: true, force: true });
      await rm(linked, { force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it('returns correlated response envelopes and mutable state', async () => {
    const { controller } = createController();
    await controller.initialize();

    await expect(controller.handle({ type: 'get_state', id: 'state-1' })).resolves.toMatchObject({
      type: 'response',
      command: 'get_state',
      id: 'state-1',
      success: true,
      data: {
        sessionId: 'rpc-test-session',
        model: {
          provider: 'mock', id: 'mock-model', name: 'Mock model', reasoning: false, input: ['text'],
        },
        thinkingLevel: 'off',
        isStreaming: false,
      },
    });
    await expect(controller.handle({ type: 'set_thinking_level', level: 'high' })).resolves.toEqual({
      type: 'response', command: 'set_thinking_level', success: true,
    });
    await expect(controller.handle({ type: 'get_available_thinking_levels' })).resolves.toMatchObject({
      data: { levels: ['off'] },
    });
    await expect(controller.handle({ type: 'cycle_thinking_level' })).resolves.toMatchObject({ data: null });
    await expect(controller.handle({ type: 'does_not_exist', id: 'bad' })).resolves.toEqual({
      type: 'response', command: 'does_not_exist', id: 'bad', success: false,
      error: 'Unknown command: does_not_exist',
    });
  });

  it('forwards the resolved system prompt to protocol turns', async () => {
    const { controller, context, records } = createController(['done']);
    const provider = new CapturingProvider({ type: 'mock' as any, model: 'mock-model' }, ['done']);
    context.provider = provider;
    context.toolContext.provider = provider;
    context.systemPrompt = 'resolved RPC instructions';
    await controller.initialize();

    await controller.handle({ type: 'prompt', message: 'hello' });
    await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));
    expect(provider.systemPrompt).toBe('resolved RPC instructions');
  });

  it('prepares and executes session-scoped dynamic tools for every RPC prompt', async () => {
    const { controller, context, records } = createController();
    const provider = new RpcToolProvider();
    context.provider = provider;
    context.toolContext.provider = provider;
    const execute = vi.fn(async () => ({ content: 'rpc lookup result' }));
    context.prepareDynamicTools = vi.fn(async () => ({
      tools: [{
        name: 'mcp__docs__lookup',
        description: 'MCP docs lookup',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }],
      execute,
    }));
    await controller.initialize();

    await controller.handle({ type: 'prompt', message: 'look it up' });
    await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));

    expect(context.prepareDynamicTools).toHaveBeenCalledWith('rpc-test-session', expect.any(AbortSignal));
    expect(execute).toHaveBeenCalledWith(
      'mcp__docs__lookup',
      { query: 'rpc' },
      expect.objectContaining({ currentSessionId: 'rpc-test-session' }),
      expect.any(AbortSignal),
    );
    expect(context.sessionManager.get('rpc-test-session')?.messages.map(message => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant',
    ]);
  });

  it('refreshes RPC declarations after tool_search and persists the activation', async () => {
    const { controller, context, records } = createController();
    const provider = new RpcSearchProvider();
    context.provider = provider;
    context.toolContext.provider = provider;
    let loaded = false;
    const details = { loaded: ['mcp__docs__lookup'] };
    const execute = vi.fn(async (name: string) => {
      if (name === 'tool_search') {
        loaded = true;
        return { content: 'loaded docs', details };
      }
      return { content: 'rpc deferred lookup' };
    });
    const search = { name: 'tool_search', description: 'Search tools', parameters: { type: 'object' } };
    const lookup = { name: 'mcp__docs__lookup', description: 'Lookup docs', parameters: { type: 'object' } };
    context.prepareDynamicTools = vi.fn(async () => ({
      tools: [search],
      resolveTools: () => loaded ? [search, lookup] : [search],
      execute,
      getActivatedTools: (name: string, result: { details?: unknown }) => name === 'tool_search' && result.details === details
        ? details.loaded
        : undefined,
    }));
    await controller.initialize();

    await controller.handle({ type: 'prompt', message: 'find docs' });
    await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));

    expect(provider.declarations).toEqual([
      ['tool_search'],
      ['tool_search', 'mcp__docs__lookup'],
      ['tool_search', 'mcp__docs__lookup'],
    ]);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'mcp__docs__lookup',
      { query: 'rpc' },
      expect.objectContaining({ currentSessionId: 'rpc-test-session' }),
      expect.any(AbortSignal),
    );
    expect(context.sessionManager.get('rpc-test-session')?.messages.find(message => message.name === 'tool_search')?.metadata)
      .toEqual({ toolSearch: { loaded: ['mcp__docs__lookup'] } });
  });

  it('handles extension commands immediately without starting an agent run', async () => {
    const { controller, context, records } = createController();
    const handler = vi.fn(async (args: string) => `handled ${args}`);
    await context.extensionRegistry.load('test:command', api => {
      api.registerCommand('hello', { description: 'test command', handler });
    });
    await controller.initialize();

    await expect(controller.handle({ type: 'prompt', message: '/hello world' })).resolves.toMatchObject({
      success: true, data: { disposition: 'handled' },
    });
    expect(handler).toHaveBeenCalledWith('world', expect.objectContaining({ currentSessionId: 'rpc-test-session' }));
    expect(context.toolContext.notify).toHaveBeenCalledWith('handled world', 'info');
    expect(records).toEqual([]);
    await expect(controller.handle({ type: 'steer', message: '/hello later' })).resolves.toMatchObject({
      success: false, error: expect.stringContaining('not allowed'),
    });
  });

  it('lists and expands discovered prompt resources', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-resources-'));
    try {
      const promptDirectory = path.join(directory, '.ai-harness', 'prompts');
      const skillDirectory = path.join(directory, '.ai-harness', 'skills', 'assist');
      await mkdir(promptDirectory, { recursive: true });
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(path.join(promptDirectory, 'review.md'), 'Review $1 carefully.');
      await writeFile(path.join(skillDirectory, 'SKILL.md'), '---\nname: assist\n---\nAssist carefully.');
      const resources = new ResourceManager({
        cwd: directory,
        homeDir: path.join(directory, 'home'),
        projectTrusted: true,
      });
      await resources.loadAll();
      const { controller, context, records } = createController();
      context.resourceManager = resources;
      await controller.initialize();

      await expect(controller.handle({ type: 'get_commands' })).resolves.toMatchObject({
        data: { commands: expect.arrayContaining([
          expect.objectContaining({ name: 'review', source: 'prompt' }),
          expect.objectContaining({ name: 'skill:assist', source: 'skill' }),
        ]) },
      });
      context.enableSkillCommands = false;
      await expect(controller.handle({ type: 'get_commands' })).resolves.toMatchObject({
        data: { commands: [expect.objectContaining({ name: 'review', source: 'prompt' })] },
      });
      await controller.handle({ type: 'prompt', message: '/review target.ts' });
      await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));
      expect(context.sessionManager.get('rpc-test-session')?.messages[0]?.content)
        .toBe('Review target.ts carefully.');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forks in place before a selected user entry', async () => {
    const { controller, context } = createController();
    await controller.initialize();
    const session = context.sessionManager.get('rpc-test-session')!;
    await context.sessionManager.addMessage(session.id, { role: 'user', content: 'First' });
    await context.sessionManager.addMessage(session.id, { role: 'assistant', content: 'Answer' });
    await context.sessionManager.addMessage(session.id, { role: 'user', content: 'Rewrite me' });
    const entryId = session.activeLeafId!;
    await context.sessionManager.addMessage(session.id, { role: 'assistant', content: 'Old branch' });

    await expect(controller.handle({ type: 'fork', entryId })).resolves.toEqual({
      type: 'response', command: 'fork', success: true,
      data: { text: 'Rewrite me', cancelled: false },
    });
    expect(context.sessionManager.get(session.id)?.messages.map(message => message.content))
      .toEqual(['First', 'Answer']);
    await expect(controller.handle({ type: 'get_entries' })).resolves.toMatchObject({
      data: { entries: expect.arrayContaining([
        expect.objectContaining({ message: expect.objectContaining({ content: expect.anything() }) }),
      ]) },
    });
    expect((await context.sessionManager.getRawEntries(session.id)).some(
      entry => entry.type === 'message' && entry.content === 'Old branch',
    )).toBe(true);
    await expect(controller.handle({ type: 'get_fork_messages' })).resolves.toMatchObject({
      data: { messages: [{ text: 'First' }] },
    });
    await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({
      data: { sessionId: session.id },
    });
  });

  it('accepts prompts before asynchronously streaming the lifecycle', async () => {
    const { controller, context, records } = createController(['Hello']);
    await controller.initialize();

    const response = await controller.handle({ type: 'prompt', id: 'prompt-1', message: 'Hi' });
    expect(response).toEqual({
      type: 'response', command: 'prompt', id: 'prompt-1', success: true,
      data: { disposition: 'started' },
    });
    expect(records).toEqual([]);

    await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));
    expect(records.map(record => record.type)).toEqual(expect.arrayContaining([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ]));
    expect(records[0]).toEqual({ type: 'agent_start' });
    expect(records.at(-1)).toEqual({ type: 'agent_settled' });
    expect(context.sessionManager.get('rpc-test-session')?.messages.map(message => message.role))
      .toEqual(['user', 'assistant']);

    const messages = await controller.handle({ type: 'get_messages', id: 'messages' });
    expect(messages).toMatchObject({
      success: true,
      data: { messages: [{ role: 'user' }, { role: 'assistant', stopReason: 'stop' }] },
    });
    await expect(controller.handle({ type: 'get_tree' })).resolves.toMatchObject({
      success: true,
      data: {
        tree: [{ entry: { message: { role: 'user' } }, children: [
          { entry: { type: 'loadout', changedFields: ['provider', 'model', 'systemPrompt', 'tools', 'thinking'] }, children: [
            { entry: { message: { role: 'assistant' } }, children: [] },
          ] },
        ] }],
        leafId: expect.any(String),
      },
    });
  });

  it('serializes event delivery and waits for downstream backpressure', async () => {
    const { context } = createController(['Hello']);
    const records: Array<Record<string, unknown>> = [];
    let releaseFirst = (): void => undefined;
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve; });
    let first = true;
    let deliveryStarted = false;
    let deliveriesInFlight = 0;
    let maximumDeliveriesInFlight = 0;
    const controller = new RpcController(context, async record => {
      deliveriesInFlight++;
      maximumDeliveriesInFlight = Math.max(maximumDeliveriesInFlight, deliveriesInFlight);
      deliveryStarted = true;
      try {
        if (first) {
          first = false;
          await firstWrite;
        }
        records.push(record);
      } finally {
        deliveriesInFlight--;
      }
    });
    await controller.initialize();

    await expect(controller.handle({ type: 'prompt', message: 'Hi' })).resolves.toMatchObject({
      success: true, data: { disposition: 'started' },
    });
    await vi.waitFor(() => expect(deliveryStarted).toBe(true));
    expect(records).toEqual([]);
    expect(maximumDeliveriesInFlight).toBe(1);

    releaseFirst();
    await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));
    await controller.close();
    expect(maximumDeliveriesInFlight).toBe(1);
    expect(records[0]).toEqual({ type: 'agent_start' });
    expect(records.at(-1)).toEqual({ type: 'agent_settled' });
  });

  it('makes an asynchronous event delivery failure terminal', async () => {
    const { context } = createController(['Hello']);
    let deliveryFailed = false;
    const controller = new RpcController(context, async record => {
      await Promise.resolve();
      if (record.type === 'message_update') {
        deliveryFailed = true;
        throw new Error('RPC sink disconnected');
      }
    });
    await controller.initialize();

    await expect(controller.handle({ type: 'prompt', message: 'Hi' })).resolves.toMatchObject({
      success: true, data: { disposition: 'started' },
    });
    await vi.waitFor(() => expect(deliveryFailed).toBe(true));
    await vi.waitFor(async () => {
      await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({
        success: false,
        error: 'RPC sink disconnected',
      });
    });
    await expect(controller.close()).rejects.toThrow('RPC sink disconnected');
  });

  it('runs queued follow-up prompts after the active agent lifecycle', async () => {
    const { controller, context, records } = createController(['First', 'Second']);
    await controller.initialize();

    await controller.handle({ type: 'prompt', message: 'One' });
    await expect(controller.handle({ type: 'follow_up', id: 'follow', message: 'Two' })).resolves.toMatchObject({
      success: true,
      data: { disposition: 'queued' },
    });

    await vi.waitFor(() => expect(records.filter(record => record.type === 'turn_start')).toHaveLength(2));
    await vi.waitFor(() => expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(1));
    expect(records.at(-1)?.type).toBe('agent_settled');
    expect(records.filter(record => record.type === 'agent_start')).toHaveLength(2);
    expect(records.filter(record => record.type === 'agent_end')).toHaveLength(2);
    expect(context.sessionManager.get('rpc-test-session')?.messages.map(message => message.content))
      .toEqual(['One', 'First', 'Two', 'Second']);
  });

  it('injects steering after tool results and before the next provider turn', async () => {
    const { controller, context, records } = createController();
    await context.extensionRegistry.load('test:steering-tool', api => {
      api.registerTool({
        name: 'inspect',
        description: 'test tool',
        parameters: { type: 'object' },
        async execute() { return { content: 'tool output' }; },
      });
    });
    context.tools = [{ name: 'inspect', description: 'test tool', parameters: { type: 'object' } }];
    let attempt = 0;
    let secondTurnContents: string[] = [];
    vi.spyOn(context.provider, 'streamChat').mockImplementation(async (
      messages, onChunk, onComplete,
    ) => {
      attempt += 1;
      if (attempt === 1) {
        onComplete?.({
          content: '',
          toolCalls: [{ id: 'tool-1', name: 'inspect', input: {} }],
        });
        return;
      }
      secondTurnContents = messages.map(message => message.content);
      onChunk('finished');
      onComplete?.({ content: 'finished' });
    });
    await controller.initialize();
    await controller.handle({ type: 'prompt', message: 'initial' });
    await controller.handle({ type: 'steer', message: 'new direction' });

    await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));
    expect(attempt).toBe(2);
    expect(secondTurnContents).toContain('new direction');
    expect(records.filter(record => record.type === 'agent_start')).toHaveLength(1);
    expect(records.filter(record => record.type === 'turn_start')).toHaveLength(2);
  });

  it('aborts an active provider retry delay', async () => {
    const { controller, context, records } = createController();
    const stream = vi.spyOn(context.provider, 'streamChat').mockImplementation(async (
      _messages, _onChunk, _onComplete, onError,
    ) => { onError?.(new Error('retry me')); });
    await controller.initialize();
    await controller.handle({ type: 'prompt', message: 'start retry' });
    await vi.waitFor(() => expect(records.some(record => record.type === 'auto_retry_start')).toBe(true));

    await expect(controller.handle({ type: 'abort_retry' })).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(records.some(record => record.type === 'agent_settled')).toBe(true));
    expect(stream).toHaveBeenCalledTimes(1);
    expect(records).toContainEqual(expect.objectContaining({ type: 'auto_retry_end', success: false }));
    expect(records).toContainEqual(expect.objectContaining({
      type: 'message_end', message: expect.objectContaining({ stopReason: 'error' }),
    }));
  });

  it('retries failed summarization with the RPC retry lifecycle', async () => {
    const { controller, context, records } = createController();
    context.summarizationRetryDelayMs = 1;
    const chat = vi.spyOn(context.provider, 'chat')
      .mockRejectedValueOnce(new Error('summary unavailable'))
      .mockResolvedValueOnce({ content: 'Recovered summary' });
    await controller.initialize();
    await context.sessionManager.addMessage('rpc-test-session', { role: 'user', content: 'one' });
    await context.sessionManager.addMessage('rpc-test-session', { role: 'assistant', content: 'two' });
    await context.sessionManager.addMessage('rpc-test-session', { role: 'user', content: 'three' });

    await expect(controller.handle({ type: 'compact' })).resolves.toMatchObject({ success: true });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(records).toContainEqual(expect.objectContaining({
      type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 1,
    }));
    expect(records).toContainEqual({
      type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'manual',
    });
    expect(records).toContainEqual({ type: 'summarization_retry_finished' });
  });

  it('compacts a session and emits the RPC compaction lifecycle', async () => {
    const { controller, context, records } = createController(['Summary']);
    await controller.initialize();
    await context.sessionManager.addMessage('rpc-test-session', { role: 'user', content: 'one' });
    await context.sessionManager.addMessage('rpc-test-session', { role: 'assistant', content: 'two' });
    await context.sessionManager.addMessage('rpc-test-session', { role: 'user', content: 'three' });

    await expect(controller.handle({ type: 'compact', id: 'compact-1' })).resolves.toMatchObject({
      type: 'response', command: 'compact', id: 'compact-1', success: true,
      data: { summary: 'Summary', firstKeptEntryId: expect.any(String) },
    });
    expect(records).toContainEqual({ type: 'compaction_start', reason: 'manual' });
    expect(records).toContainEqual(expect.objectContaining({
      type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false,
      result: expect.objectContaining({ summary: 'Summary' }),
    }));
  });

  it('streams direct bash chunks with the originating request id', async () => {
    const { controller, context, records } = createController();
    await context.extensionRegistry.load('test:bash', api => {
      api.registerTool({
        name: 'bash',
        description: 'test shell',
        parameters: { type: 'object' },
        async execute(_input, toolContext) {
          toolContext.onProcessOutput?.('first');
          await Promise.resolve();
          toolContext.onProcessOutput?.(' second');
          return { content: 'first second', details: { exitCode: 0, truncated: false } };
        },
      });
    });
    context.tools = [{ name: 'bash', description: 'test shell', parameters: { type: 'object' } }];
    await controller.initialize();

    await expect(controller.handle({ type: 'bash', id: 'bash-1', command: 'ignored' })).resolves.toMatchObject({
      id: 'bash-1', success: true,
      data: { output: 'first second', exitCode: 0, cancelled: false, truncated: false },
    });
    expect(records).toEqual([
      { type: 'bash_execution_update', id: 'bash-1', delta: 'first' },
      { type: 'bash_execution_update', id: 'bash-1', delta: ' second' },
    ]);
  });

  it('retains complete bash output in a private temporary file when the result is truncated', async () => {
    const { controller, context } = createController();
    await context.extensionRegistry.load('test:truncated-bash', api => {
      api.registerTool({
        name: 'bash',
        description: 'test shell',
        parameters: { type: 'object' },
        async execute(_input, toolContext) {
          await toolContext.onProcessOutput?.('complete output');
          return { content: '...output', details: { exitCode: 0, truncated: true } };
        },
      });
    });
    context.tools = [{ name: 'bash', description: 'test shell', parameters: { type: 'object' } }];
    await controller.initialize();

    const response = await controller.handle({ type: 'bash', id: 'bash-file', command: 'ignored' });
    expect(response).toMatchObject({
      success: true,
      data: {
        output: '...output', exitCode: 0, cancelled: false, truncated: true,
        fullOutputPath: expect.any(String),
      },
    });
    const fullOutputPath = (response as { data: { fullOutputPath: string } }).data.fullOutputPath;
    await expect(readFile(fullOutputPath, 'utf8')).resolves.toBe('complete output');
    await rm(path.dirname(fullOutputPath), { recursive: true, force: true });
  });

  it('returns bounded partial output and a complete file when direct bash is aborted', async () => {
    const { controller, context, records } = createController();
    const completeOutput = 'x'.repeat(60 * 1024);
    await context.extensionRegistry.load('test:aborted-bash', api => {
      api.registerTool({
        name: 'bash',
        description: 'test shell',
        parameters: { type: 'object' },
        async execute(_input, toolContext, signal) {
          await toolContext.onProcessOutput?.(completeOutput);
          if (signal?.aborted) throw new Error('Operation aborted.');
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('Operation aborted.')), { once: true });
          });
          return { content: '' };
        },
      });
    });
    context.tools = [{ name: 'bash', description: 'test shell', parameters: { type: 'object' } }];
    await controller.initialize();

    let executionSettled = false;
    const execution = controller.handle({ type: 'bash', id: 'bash-abort', command: 'ignored' }).then(response => {
      executionSettled = true;
      return response;
    });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    await expect(controller.handle({ type: 'abort_bash', id: 'abort' })).resolves.toMatchObject({ success: true });
    expect(executionSettled).toBe(true);
    const response = await execution;
    expect(response).toMatchObject({
      success: true,
      data: {
        output: expect.any(String), exitCode: 130, cancelled: true, truncated: true,
        fullOutputPath: expect.any(String),
      },
    });
    const data = (response as { data: { output: string; fullOutputPath: string } }).data;
    expect(Buffer.byteLength(data.output)).toBeLessThanOrEqual(50 * 1024);
    await expect(readFile(data.fullOutputPath, 'utf8')).resolves.toBe(completeOutput);
    await rm(path.dirname(data.fullOutputPath), { recursive: true, force: true });
  });

  it('exposes direct shell records as RPC bash execution messages', async () => {
    const { controller, context } = createController();
    await controller.initialize();
    await context.sessionManager.addCommand('rpc-test-session', {
      command: 'printf hello',
      cwd: process.cwd(),
      status: 'completed',
      output: 'hello',
      exitCode: 0,
      excludedFromContext: false,
    });

    await expect(controller.handle({ type: 'get_messages' })).resolves.toMatchObject({
      success: true,
      data: { messages: [expect.objectContaining({
        role: 'bashExecution', command: 'printf hello', output: 'hello', excludeFromContext: false,
      })] },
    });
  });

  it('deduplicates concurrent model discovery behind a bounded cache', async () => {
    const { controller, context } = createController();
    const discover = vi.fn(async () => [{ provider: 'mock', id: 'mock-model' }]);
    context.providerModels = discover;
    context.modelDiscoveryCacheMs = 60_000;
    await controller.initialize();

    await Promise.all([
      controller.handle({ type: 'get_available_models' }),
      controller.handle({ type: 'get_available_models' }),
    ]);
    await controller.handle({ type: 'get_available_models' });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('withdraws cached discovery and configured IDs when an adapter is replaced or removed', async () => {
    const { controller, context } = createController();
    const original = context.provider;
    const oldDiscovery = vi.spyOn(original, 'getAvailableModels').mockResolvedValue(['old-live', 'old-configured']);
    context.providers = new Map([['mock', original]]);
    await controller.initialize();
    const ids = async () => ((await controller.handle({ type: 'get_available_models' }))?.data as { models: Array<{ id: string }> }).models.map(model => model.id);
    expect(await ids()).toContain('old-live');
    await expect(controller.handle({ type: 'set_model', provider: 'mock', modelId: 'old-configured' })).resolves.toMatchObject({ success: true });
    const replacement = new MockProvider({ type: 'mock', model: 'new-configured' });
    const newDiscovery = vi.spyOn(replacement, 'getAvailableModels').mockResolvedValue(['new-live']);
    const retiredSelection = controller.handle({ type: 'set_model', provider: 'mock', modelId: 'old-live' });
    const retiredCycle = controller.handle({ type: 'cycle_model' });
    context.providers.set('mock', replacement);
    for (const request of [retiredSelection, retiredCycle]) {
      await expect(request).resolves.toMatchObject({ success: false, error: 'Model catalogue changed during selection.' });
    }
    expect(original.getConfiguredModel()).toBe('old-configured');
    const current = await ids();
    expect(current).toContain('new-live');
    expect(current).toContain('new-configured');
    expect(current).not.toContain('old-live');
    expect(current).not.toContain('old-configured');
    await expect(controller.handle({ type: 'set_model', provider: 'mock', modelId: 'old-live' })).resolves.toMatchObject({ success: false });
    expect(replacement.getConfiguredModel()).toBe('new-configured');
    context.providers.delete('mock');
    expect(await ids()).toEqual([]);
    expect(oldDiscovery).toHaveBeenCalledTimes(1);
    expect(newDiscovery).toHaveBeenCalledTimes(1);
    await controller.close();
  });

  it('refuses retired in-flight discovery without clearing a replacement adapter cache', async () => {
    const { controller, context } = createController();
    let release!: (models: string[]) => void;
    vi.spyOn(context.provider, 'getAvailableModels').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    context.providers = new Map([['mock', context.provider]]);
    await controller.initialize();
    const retired = controller.handle({ type: 'set_model', provider: 'mock', modelId: 'private-retired-live' });
    const joinedRetired = controller.handle({ type: 'get_available_models' });
    const replacement = new MockProvider({ type: 'mock', model: 'new-configured' });
    let releaseCurrent!: (models: string[]) => void;
    const discovery = vi.spyOn(replacement, 'getAvailableModels').mockImplementation(() => new Promise(resolve => { releaseCurrent = resolve; }));
    context.providers.set('mock', replacement);
    const current = controller.handle({ type: 'get_available_models' });
    release(['private-retired-live']);
    for (const request of [retired, joinedRetired]) {
      await expect(request).resolves.toMatchObject({ success: false, error: 'Model catalogue changed during discovery.' });
    }
    expect(context.provider.getConfiguredModel()).toBe('mock-model');
    const joinedCurrent = controller.handle({ type: 'get_available_models' });
    expect(discovery).toHaveBeenCalledTimes(1);
    releaseCurrent(['new-live']);
    for (const request of [current, joinedCurrent]) {
      await expect(request).resolves.toMatchObject({ success: true, data: { models: expect.arrayContaining([expect.objectContaining({ id: 'new-live' })]) } });
    }
    const cached = await controller.handle({ type: 'get_available_models' });
    expect(JSON.stringify(cached)).not.toContain('private-retired-live');
    expect(discovery).toHaveBeenCalledTimes(1);
    await controller.close();
  });

  it.each([false, true])('respects discovery capability independently of availability (configured=%s)', async configured => {
    const { controller, context } = createController();
    vi.spyOn(context.provider, 'validateConfig').mockReturnValue(configured);
    const capability = vi.spyOn(context.provider, 'canDiscoverModels').mockReturnValue(!configured);
    const discovery = vi.spyOn(context.provider, 'getAvailableModels').mockResolvedValue(['live-only']);
    await controller.initialize();
    const result = await controller.handle({ type: 'get_available_models' });
    expect(capability).toHaveBeenCalledTimes(1);
    expect(discovery).toHaveBeenCalledTimes(configured ? 0 : 1);
    const models = (result?.data as { models: Array<{ id: string }> }).models;
    expect(models.some(model => model.id === 'live-only')).toBe(!configured);
    expect(models.some(model => model.id === 'mock-model')).toBe(true);
    await controller.close();
  });

  it('lists, switches, and cycles configured provider models', async () => {
    const { controller, context } = createController();
    const second = new MockProvider({ type: 'mock' as any, model: 'second-model' });
    context.providers = new Map([
      ['mock', context.provider],
      ['secondary', second],
    ]);
    await controller.initialize();

    const available = await controller.handle({ type: 'get_available_models' });
    expect(available).toMatchObject({
      success: true,
      data: { models: expect.arrayContaining([
        expect.objectContaining({ provider: 'mock', id: 'mock-model' }),
        expect.objectContaining({ provider: 'secondary', id: 'second-model' }),
      ]) },
    });
    const unknownDescriptor = ((available!.data as any).models as Array<Record<string, unknown>>)
      .find(model => model.provider === 'mock' && model.id === 'mock-model');
    expect(unknownDescriptor).not.toHaveProperty('cost');
    expect(unknownDescriptor).not.toHaveProperty('contextWindow');
    await expect(controller.handle({
      type: 'set_model', provider: 'secondary', modelId: 'second-model',
    })).resolves.toMatchObject({
      success: true,
      data: { provider: 'secondary', id: 'second-model' },
    });
    expect(context.provider).toBe(second);
    await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({
      data: { model: { provider: 'secondary', id: 'second-model' } },
    });

    await expect(controller.handle({ type: 'cycle_model' })).resolves.toMatchObject({
      success: true,
      data: { model: { provider: 'mock', id: 'mock-model' }, isScoped: false },
    });
    expect(context.providerName).toBe('mock');

    context.scopedModels = [
      { provider: 'mock', id: 'mock-model' },
      { provider: 'secondary', id: 'second-model' },
    ];
    await expect(controller.handle({ type: 'cycle_model' })).resolves.toMatchObject({
      success: true,
      data: { model: { provider: 'secondary', id: 'second-model' }, isScoped: true },
    });
    context.scopedModels = undefined;
    context.scopedModelPatterns = ['MOCK/mock-*', 'secondary/second*'];
    await expect(controller.handle({ type: 'cycle_model' })).resolves.toMatchObject({
      success: true,
      data: { model: { provider: 'mock', id: 'mock-model' }, isScoped: true },
    });
    context.scopedModelPatterns = ['missing/no-match-*'];
    await expect(controller.handle({ type: 'cycle_model' })).resolves.toMatchObject({
      success: false,
      error: 'No models match the active model scope.',
    });

    await context.sessionManager.addMessage('rpc-test-session', {
      role: 'assistant',
      content: 'Unpriced',
      provider: 'secondary',
      model: 'second-model',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    await expect(controller.handle({ type: 'get_session_stats' })).resolves.toMatchObject({
      data: { cost: null },
    });
  });

  it('uses shared model metadata and clamps thinking to model capabilities', async () => {
    const { controller, context } = createController();
    const openai = new MockProvider({ type: 'mock' as any, model: 'o3' });
    const anthropic = new MockProvider({ type: 'mock' as any, model: 'claude-sonnet-4-6' });
    context.providers = new Map([
      ['mock', context.provider],
      ['openai', openai],
      ['anthropic', anthropic],
    ]);
    await controller.initialize();

    await expect(controller.handle({ type: 'set_model', provider: 'openai', modelId: 'o3' }))
      .resolves.toMatchObject({
        success: true,
        data: {
          provider: 'openai', id: 'o3', name: 'o3', reasoning: true,
          input: ['text', 'image'], contextWindow: 200_000, maxTokens: 100_000,
          cost: { input: 2, output: 8, cacheRead: 0.5 },
        },
      });
    await expect(controller.handle({ type: 'get_available_thinking_levels' })).resolves.toMatchObject({
      data: { levels: ['low', 'medium', 'high'] },
    });
    await controller.handle({ type: 'set_thinking_level', level: 'max' });
    await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({
      data: { thinkingLevel: 'high' },
    });
    await controller.handle({
      type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet-4-6',
    });
    await expect(controller.handle({ type: 'get_available_thinking_levels' })).resolves.toMatchObject({
      data: { levels: ['off', 'minimal', 'low', 'medium', 'high', 'max'] },
    });
    await controller.handle({ type: 'set_thinking_level', level: 'max' });
    await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({
      data: { thinkingLevel: 'max' },
    });
    await controller.handle({ type: 'set_model', provider: 'openai', modelId: 'o3' });
    await expect(controller.handle({ type: 'get_session_stats' })).resolves.toMatchObject({
      data: { contextUsage: { tokens: 0, contextWindow: 200_000, percent: 0 } },
    });

    const session = context.sessionManager.get('rpc-test-session')!;
    await context.sessionManager.addMessage(session.id, { role: 'user', content: 'Account for this' });
    const firstKeptEntryId = session.activeLeafId!;
    await context.sessionManager.addMessage(session.id, {
      role: 'assistant',
      content: 'Done',
      provider: 'openai',
      model: 'o3',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 200_000,
        totalTokens: 1_700_000,
      },
    });
    await context.sessionManager.applyCompaction(session.id, 'Summary', firstKeptEntryId, {
      provider: 'openai',
      model: 'o3',
      usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
    });
    expect(await context.sessionManager.getRawEntries(session.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'compaction',
        provider: 'openai',
        model: 'o3',
        usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
      }),
    ]));
    const stats = await controller.handle({ type: 'get_session_stats' });
    if (!stats) throw new Error('Missing RPC session statistics response.');
    expect((stats.data as any).tokens).toMatchObject({ input: 1_001_000, output: 500_100, cacheRead: 200_000 });
    expect((stats.data as any).cost).toBeCloseTo(6.1028);
    await expect(controller.handle({ type: 'get_entries' })).resolves.toMatchObject({
      data: { entries: expect.arrayContaining([
        expect.objectContaining({
          type: 'compaction',
          parentId: expect.any(String),
          provider: 'openai',
          model: 'o3',
          usage: expect.objectContaining({ input: 1_000, output: 100, totalTokens: 1_100 }),
        }),
      ]) },
    });
  });

  it('exports escaped HTML inside the active workspace only', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-export-'));
    try {
      const { controller, context } = createController();
      context.toolContext.cwd = directory;
      await controller.initialize();
      await context.sessionManager.addMessage('rpc-test-session', { role: 'user', content: '<unsafe>' });

      const response = await controller.handle({ type: 'export_html', outputPath: 'exports/review.html' });
      expect(response).toMatchObject({ success: true, data: { path: path.join(directory, 'exports/review.html'), warnings: [EXPORT_PRIVACY_WARNING] } });
      const exportedPath = path.join(directory, 'exports/review.html');
      expect(await readFile(exportedPath, 'utf8')).toContain('&lt;unsafe&gt;');
      await chmod(exportedPath, 0o644);
      await controller.handle({ type: 'export_html', outputPath: 'exports/review.html' });
      expect((await stat(exportedPath)).mode & 0o777).toBe(0o600);
      await expect(controller.handle({ type: 'export_html', outputPath: '../outside.html' })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('active workspace'),
      });
      await mkdir(path.join(directory, 'actual'));
      await symlink(path.join(directory, 'actual'), path.join(directory, 'linked'), 'dir');
      await expect(controller.handle({ type: 'export_html', outputPath: 'linked/out.html' })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('symbolic links'),
      });
      const hardLinkTarget = path.join(directory, 'hard-link-target.html');
      await writeFile(hardLinkTarget, 'preserve me');
      await link(hardLinkTarget, path.join(directory, 'hard-link.html'));
      await expect(controller.handle({ type: 'export_html', outputPath: 'hard-link.html' })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('regular, unlinked file'),
      });
      expect(await readFile(hardLinkTarget, 'utf8')).toBe('preserve me');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('returns a value-free additive export warning with registered redaction=%s and no extra protocol records', async redact => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-privacy-'));
    const { controller, context, records } = createController();
    const text = 'disposable-sensitive-rpc-export-text';
    try {
      context.toolContext.cwd = directory;
      if (redact) context.redactJson = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(text, '[REDACTED]')) as T;
      await controller.initialize();
      await context.sessionManager.addMessage('rpc-test-session', { role: 'user', content: text });
      const before = records.length;
      const response = await controller.handle({ type: 'export_html', id: 'privacy', outputPath: 'review.html' });
      expect(response).toEqual({ type: 'response', command: 'export_html', id: 'privacy', success: true,
        data: { path: path.join(directory, 'review.html'), warnings: [EXPORT_PRIVACY_WARNING] } });
      expect(JSON.stringify(response)).not.toContain(text); expect(records).toHaveLength(before);
      const body = await readFile(path.join(directory, 'review.html'), 'utf8');
      if (redact) { expect(body).not.toContain(text); expect(body).toContain('[REDACTED]'); }
      else expect(body).toContain(text);
    } finally { await context.extensionRegistry.shutdown(); await rm(directory, { recursive: true, force: true }); }
  });

  it('supports queue clearing, naming, cloning, and session replacement', async () => {
    const { controller } = createController();
    await controller.initialize();

    await controller.handle({ type: 'steer', message: 'Later' });
    await expect(controller.handle({ type: 'clear_queue', id: 'clear' })).resolves.toEqual({
      type: 'response', command: 'clear_queue', id: 'clear', success: true,
      data: { steering: ['Later'], followUp: [] },
    });
    await controller.handle({ type: 'set_session_name', name: 'Named' });
    await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({
      data: { sessionName: 'Named' },
    });
    await expect(controller.handle({ type: 'new_session', id: 'new' })).resolves.toMatchObject({
      id: 'new', success: true, data: { cancelled: false },
    });
    await expect(controller.handle({ type: 'get_state' })).resolves.toMatchObject({
      data: { messageCount: 0, sessionName: undefined },
    });
  });
});
