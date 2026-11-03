import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRuntime,
  AiProvider,
  ExtensionRegistry,
  MockProvider,
  ProjectTrustManager,
  ProviderType,
  SessionManager,
  WorkspaceManager,
  type ChatOptions,
  type ChatResponse,
  type Message,
  type StreamEvent,
} from '@ai-harness/core';
import { SubagentRuntime } from './subagent-runtime.js';
import { SubagentService } from './subagent-service.js';

const temporaryDirectories: string[] = [];

class CapturingProvider extends MockProvider {
  systemPrompt?: string;

  override async streamChat(...args: Parameters<MockProvider['streamChat']>): Promise<void> {
    this.systemPrompt = args[4]?.systemPrompt;
    await super.streamChat(...args);
  }
}

class HoldingProvider extends AiProvider {
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'held' }; }
  async streamChat(
    _messages: Message[],
    _onChunk: (chunk: string, event?: StreamEvent) => void,
    _onComplete?: (response?: ChatResponse) => void,
    onError?: (error: Error) => void,
    options?: ChatOptions,
  ): Promise<void> {
    await new Promise<void>(resolve => {
      const abort = () => {
        const error = Object.assign(new Error('aborted'), { name: 'AbortError' });
        onError?.(error);
        resolve();
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

async function fixture(
  provider: AiProvider = new MockProvider({ type: ProviderType.MOCK }),
  resolveSystemPrompt?: (input: { cwd: string; basePrompt: string }) => Promise<string>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-subagent-runtime-'));
  temporaryDirectories.push(root);
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const workspaces = new WorkspaceManager({ allowedRoots: [root], defaultCwd: project });
  await workspaces.initialize();
  const trust = new ProjectTrustManager(path.join(root, 'trust.json'));
  await trust.load();
  await trust.trust(project);
  const descriptor = await workspaces.describe(project, true);
  const profiles = new SubagentService(workspaces, trust, path.join(root, 'subagents.json'));
  await profiles.load();
  const sessions = new SessionManager();
  const extensions = new ExtensionRegistry();
  extensions.attachSessionManager(sessions);
  const agents = new AgentRuntime({
    sessionManager: sessions,
    extensionRegistry: extensions,
    resolveProvider: () => provider,
    isProjectTrusted: () => true,
  });
  const runtime = new SubagentRuntime(profiles, agents, sessions, resolveSystemPrompt);
  const parent = await sessions.create({
    title: 'Parent', cwd: project, workspaceId: descriptor.id, model: 'mock-model', toolPreset: 'read-only',
  });
  await sessions.addMessage(parent.id, { role: 'user', content: 'Parent context' });
  return { project, descriptor, profiles, sessions, agents, runtime, parent, extensions, trust };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('SubagentRuntime', () => {
  it('runs a linked child session with bounded inherited context and publishes completion', async () => {
    const provider = new CapturingProvider({ type: ProviderType.MOCK });
    const resolver = vi.fn(async ({ cwd, basePrompt }: { cwd: string; basePrompt: string }) => (
      `resolved for ${cwd}\n\n${basePrompt}`
    ));
    const { runtime, sessions, agents, parent } = await fixture(provider, resolver);
    for (let index = 0; index < 45; index++) {
      await sessions.addMessage(parent.id, { role: index % 2 ? 'assistant' : 'user', content: `Context ${index}` });
    }
    const started = await runtime.start({
      parentSessionId: parent.id,
      profileId: 'explore',
      task: 'Inspect the project',
      provider: 'mock',
      background: false,
      parentToolPreset: 'read-only',
    });
    const completed = await runtime.wait(started.id);

    expect(completed).toMatchObject({
      parentSessionId: parent.id,
      profileId: 'explore',
      status: 'completed',
      attention: true,
      turn: 1,
    });
    expect(completed?.output).toContain('Mock AI Response');
    expect(resolver).toHaveBeenCalledWith({ cwd: parent.cwd, basePrompt: expect.stringContaining('Explore') });
    expect(provider.systemPrompt).toContain(`resolved for ${parent.cwd}`);
    const child = sessions.get(started.childSessionId);
    expect(child).toMatchObject({ parentId: parent.id, parentAgentId: parent.agentId, cwd: parent.cwd });
    const inherited = child?.messages.filter(message => message.metadata?.inheritedFromSession === parent.id) ?? [];
    expect(inherited).toHaveLength(40);
    expect(inherited[0]?.content).toBe('Context 5');
    expect(agents.journal.replay(parent.id).events.map(event => event.type))
      .toEqual(expect.arrayContaining(['subagent.started', 'subagent.completed']));
    expect(runtime.acknowledge(started.id).attention).toBe(false);
    await runtime.shutdown();
  });

  it('intersects inherited tools, empty denials, skills, extensions and owned reasoning/code-mode budgets', async () => {
    const f = await fixture(new HoldingProvider({ type: ProviderType.MOCK }));
    const thinkingBudgets = { low: 2000, high: 4000 };
    const root = await f.agents.start({ sessionId: f.parent.id, cwd: f.project, provider: 'mock', input: 'parent',
      model: 'owned-model', thinking: 'low', thinkingBudgets, persistSettings: false,
      allowedTools: ['read', 'spawn_subagent'], excludedTools: ['read'], allowedSkills: ['parent-skill'],
      allowedExtensions: ['parent-extension'], codemode: { enabled: false, limits: { timeoutMs: 100 } } });
    const captured = f.agents.getSessionDelegationPolicy(f.parent.id)!;
    captured.allowedTools!.push('write');
    captured.thinkingBudgets!.low = 9999;
    thinkingBudgets.low = 8888;
    expect(f.agents.getSessionDelegationPolicy(f.parent.id)?.allowedTools).not.toContain('write');
    expect(f.agents.getSessionDelegationPolicy(f.parent.id)?.thinkingBudgets).toEqual({ low: 2000, high: 4000 });
    expect(f.parent.model).toBe('mock-model');
    const start = vi.spyOn(f.agents, 'start');
    try {
      await f.profiles.updateProfile({ cwd: f.project }, 'general', {
        tools: ['read', 'write'], skills: ['other-skill'], extensions: ['other-extension'], thinking: 'high',
      });
      const child = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'child', provider: 'mock' });
      expect(start.mock.calls[0]?.[0]).toMatchObject({ allowedTools: ['read'], excludedTools: ['read'],
        allowedSkills: [], allowedExtensions: [], toolPreset: 'read-only', model: 'owned-model', thinking: 'high',
        thinkingBudgets: { low: 2000, high: 4000 },
        codemode: { enabled: false, limits: { timeoutMs: 100 } } });
      start.mock.calls[0]![0].thinkingBudgets!.high = 7777;
      expect(f.agents.getSessionDelegationPolicy(child.childSessionId)?.thinkingBudgets).toEqual({ low: 2000, high: 4000 });
      f.runtime.stop(child.id); await f.runtime.wait(child.id);
      await f.profiles.updateProfile({ cwd: f.project }, 'general', { tools: [], skills: [], extensions: [], thinking: 'off' });
      const inherited = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'inherit', provider: 'mock' });
      expect(start.mock.calls[1]?.[0]).toMatchObject({ allowedTools: ['read', 'spawn_subagent'],
        excludedTools: ['read'], allowedSkills: ['parent-skill'], allowedExtensions: ['parent-extension'],
        thinking: 'off', thinkingBudgets: { low: 2000, high: 4000 } });
      f.runtime.stop(inherited.id); await f.runtime.wait(inherited.id);
    } finally { f.agents.stop(root.id); await f.agents.wait(root.id); await f.runtime.shutdown(); }
  });

  it('removes delegation at depth three without losing dynamic-tool eligibility', async () => {
    const f = await fixture(new HoldingProvider({ type: ProviderType.MOCK }));
    await f.sessions.update(f.parent.id, { metadata: { subagentDepth: 2 } });
    const start = vi.spyOn(f.agents, 'start');
    const child = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'depth three', provider: 'mock' });
    expect(start.mock.calls[0]?.[0]).toMatchObject({ excludedTools: ['spawn_subagent'] });
    expect(start.mock.calls[0]?.[0].allowedTools).toBeUndefined();
    expect(f.sessions.get(child.childSessionId)?.metadata?.subagentDepth).toBe(3);
    f.runtime.stop(child.id); await f.runtime.wait(child.id); await f.runtime.shutdown();
  });

  it.each(['stop', 'shutdown', 'abort'] as const)('withdraws pending prompt admission on %s without resurrection', async action => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(undefined, async () => { entered(); await held; return 'late prompt'; });
    const controller = new AbortController(), start = vi.spyOn(f.agents, 'start');
    const pending = f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'retired', provider: 'mock', signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    if (action === 'stop') f.runtime.stop(f.runtime.list()[0]!.id);
    else if (action === 'shutdown') await f.runtime.shutdown();
    else controller.abort();
    release(); await rejected;
    expect(start).not.toHaveBeenCalled();
    expect(f.runtime.list()[0]).toMatchObject({ status: 'stopped', attention: true });
    await f.runtime.shutdown();
    await expect(f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'closed', provider: 'mock' })).rejects.toThrow('closed');
  });

  it('withdraws admission when parent selection changes during held prompt resolution', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(new MockProvider({ type: ProviderType.MOCK }), async ({ basePrompt }) => {
      entered(); await held; return basePrompt;
    });
    const start = vi.spyOn(f.agents, 'start');
    const pending = f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'old selection', provider: 'mock' });
    const rejected = expect(pending).rejects.toThrow('Parent session changed.');
    await ready; await f.sessions.update(f.parent.id, { model: 'replacement-model', toolPreset: 'chat-only' });
    release(); await rejected;
    expect(start).not.toHaveBeenCalled(); await f.runtime.shutdown();
  });

  it.each(['explore', 'plan'])('retains the %s read-only ceiling under a default parent and edited tools', async profileId => {
    const f = await fixture();
    await f.sessions.update(f.parent.id, { toolPreset: 'default' });
    await f.profiles.updateProfile({ cwd: f.project }, profileId, { tools: ['write'] });
    const start = vi.spyOn(f.agents, 'start');
    const child = await f.runtime.start({ parentSessionId: f.parent.id, profileId, task: 'readonly profile', provider: 'mock' });
    await f.runtime.wait(child.id);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ toolPreset: 'read-only', allowedTools: ['write'] }));
    await f.runtime.shutdown();
  });

  it.each(['configured', 'full'] as const)('retains the %s parent preset without replacing it with default', async toolPreset => {
    const f = await fixture(); await f.sessions.update(f.parent.id, { toolPreset });
    const start = vi.spyOn(f.agents, 'start');
    const child = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'inherit preset', provider: 'mock' });
    await f.runtime.wait(child.id);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ toolPreset }));
    await f.runtime.shutdown();
  });

  it('rejects fresh trust refusal before creating child history', async () => {
    const f = await fixture(); await f.trust.untrust(f.project);
    const before = f.sessions.list().length;
    await expect(f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'refused', provider: 'mock' }))
      .rejects.toMatchObject({ code: 'PROJECT_TRUST_REQUIRED' });
    expect(f.sessions.list()).toHaveLength(before); await f.runtime.shutdown();
  });

  it('inherits bounded plain context without private metadata, tools or binary payloads', async () => {
    const f = await fixture();
    await f.sessions.addMessage(f.parent.id, { role: 'assistant', content: 'public text',
      blocks: [{ type: 'text', text: 'private rich body' }], metadata: { privateReplay: 'private value' } });
    await f.sessions.addMessage(f.parent.id, { role: 'assistant', content: '', blocks: [{ type: 'text', text: 'private rich-only body' }] });
    const child = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'plain context', provider: 'mock' });
    await f.runtime.wait(child.id);
    const copied = f.sessions.get(child.childSessionId)!.messages.find(message => message.content === 'public text');
    expect(copied).toMatchObject({ metadata: { inheritedFromSession: f.parent.id } });
    expect(JSON.stringify(copied)).not.toMatch(/private|blocks|toolCalls/);
    expect(f.sessions.get(child.childSessionId)!.messages.filter(message => message.metadata?.inheritedFromSession)
      .every(message => message.content.length > 0)).toBe(true);
    await f.runtime.shutdown();
  });

  it('keeps inherited messages before the task despite coarse or foreign future timestamps', async () => {
    const seen: string[][] = [];
    const provider = new MockProvider({ type: ProviderType.MOCK });
    provider.streamChat = async (messages, _chunk, complete) => {
      seen.push(messages.map(message => message.content)); complete?.({ content: 'Only the delegated task' });
    };
    const f = await fixture(provider);
    await f.sessions.addMessage(f.parent.id, { role: 'user', content: 'Old parent task must not run again' });
    f.parent.messages.at(-1)!.timestamp = new Date('2098-01-01');
    await f.sessions.addMessage(f.parent.id, { role: 'assistant', content: 'Last inherited answer' });
    f.parent.messages.at(-1)!.timestamp = new Date('2099-01-01');
    const child = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'New child task', provider: 'mock' });
    await f.runtime.wait(child.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(-3)).toEqual(['Old parent task must not run again', 'Last inherited answer', 'New child task']);
    await f.runtime.shutdown();
  });

  it('rejects delegation beyond the maximum child depth', async () => {
    const { runtime, sessions, parent } = await fixture();
    await sessions.update(parent.id, { metadata: { subagent: true, subagentDepth: 3 } });
    await expect(runtime.start({
      parentSessionId: parent.id, profileId: 'explore', task: 'Too deep', provider: 'mock', background: true,
    })).rejects.toMatchObject({ code: 'SUBAGENT_DEPTH_LIMIT' });
    await runtime.shutdown();
  });

  it('retains capacity while a cancelled tool physically settles and publishes one terminal event', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const provider = new MockProvider({ type: ProviderType.MOCK });
    provider.streamChat = async (_messages, _chunk, complete) => { complete?.({ content: '', toolCalls: [{ id: 'physical', name: 'ls', input: {} }] }); };
    const f = await fixture(provider);
    await f.extensions.load('builtin:held', api => { api.registerTool({ name: 'ls', description: 'Physical settlement', parameters: { type: 'object' },
      execute: async () => { entered(); await held; return { content: 'late result' }; } }); });
    await f.profiles.updateSettings({ cwd: f.project }, { maxConcurrency: 1 });
    const first = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'hold tool', provider: 'mock' });
    try {
      await ready; f.runtime.stop(first.id);
      expect(f.runtime.get(first.id)).toMatchObject({ status: 'running', attention: false });
      await expect(f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'must wait', provider: 'mock' }))
        .rejects.toMatchObject({ code: 'SUBAGENT_CONCURRENCY_LIMIT' });
    } finally { release(); await f.runtime.wait(first.id); await f.runtime.shutdown(); }
    expect(f.runtime.get(first.id)).toMatchObject({ status: 'stopped', attention: true });
    expect(f.agents.journal.replay(f.parent.id).events.filter(event => ['subagent.completed', 'subagent.failed'].includes(event.type))).toHaveLength(1);
  });

  it('bounds snapshot results while retaining the complete child journal', async () => {
    const provider = new MockProvider({ type: ProviderType.MOCK });
    provider.streamChat = async (_messages, _chunk, complete) => { complete?.({ content: 'x'.repeat(30_000) }); };
    const f = await fixture(provider);
    const child = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'large result', provider: 'mock' });
    expect((await f.runtime.wait(child.id))?.output).toHaveLength(16_384);
    expect(f.sessions.get(child.childSessionId)?.messages.at(-1)?.content).toHaveLength(30_000);
    await f.runtime.shutdown();
  });

  it('orders retained snapshots by admission even when the wall clock moves backwards', async () => {
    const f = await fixture();
    try {
      vi.setSystemTime(new Date('2030-01-01'));
      const first = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'first', provider: 'mock' });
      await f.runtime.wait(first.id);
      vi.setSystemTime(new Date('2000-01-01'));
      const second = await f.runtime.start({ parentSessionId: f.parent.id, profileId: 'general', task: 'second', provider: 'mock' });
      await f.runtime.wait(second.id);
      expect(f.runtime.list(f.parent.id).map(run => run.id)).toEqual([second.id, first.id]);
    } finally { vi.useRealTimers(); await f.runtime.shutdown(); }
  });

  it('enforces engine and concurrency limits and stops active children', async () => {
    const { runtime, profiles, parent } = await fixture(new HoldingProvider({ type: ProviderType.MOCK }));
    await profiles.updateSettings({ cwd: parent.cwd, projectId: parent.workspaceId }, { maxConcurrency: 1 });
    const first = await runtime.start({
      parentSessionId: parent.id, profileId: 'general', task: 'Wait', provider: 'mock', background: true,
    });
    await expect(runtime.start({
      parentSessionId: parent.id, profileId: 'general', task: 'Second', provider: 'mock', background: true,
    })).rejects.toMatchObject({ code: 'SUBAGENT_CONCURRENCY_LIMIT' });
    expect(runtime.stop(first.id)).toMatchObject({ status: 'running', phase: 'stopping', attention: false });
    expect(await runtime.wait(first.id)).toMatchObject({ status: 'stopped', attention: true });

    await profiles.updateSettings({ cwd: parent.cwd, projectId: parent.workspaceId }, { engineEnabled: false });
    await expect(runtime.start({
      parentSessionId: parent.id, profileId: 'general', task: 'Disabled', provider: 'mock', background: true,
    })).rejects.toMatchObject({ code: 'SUBAGENTS_DISABLED' });
    await runtime.shutdown();
  });
});
