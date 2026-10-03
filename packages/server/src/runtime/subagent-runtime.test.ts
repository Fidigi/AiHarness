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
  return { project, descriptor, profiles, sessions, agents, runtime, parent };
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

  it('rejects delegation beyond the maximum child depth', async () => {
    const { runtime, sessions, parent } = await fixture();
    await sessions.update(parent.id, { metadata: { subagent: true, subagentDepth: 3 } });
    await expect(runtime.start({
      parentSessionId: parent.id, profileId: 'explore', task: 'Too deep', provider: 'mock', background: true,
    })).rejects.toMatchObject({ code: 'SUBAGENT_DEPTH_LIMIT' });
    await runtime.shutdown();
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
    expect(runtime.stop(first.id)).toMatchObject({ status: 'stopped', attention: true });

    await profiles.updateSettings({ cwd: parent.cwd, projectId: parent.workspaceId }, { engineEnabled: false });
    await expect(runtime.start({
      parentSessionId: parent.id, profileId: 'general', task: 'Disabled', provider: 'mock', background: true,
    })).rejects.toMatchObject({ code: 'SUBAGENTS_DISABLED' });
    await runtime.shutdown();
  });
});
