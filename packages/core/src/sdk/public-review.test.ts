import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AiProvider, type ChatOptions, type ChatResponse, type StreamChunkCallback } from '../providers/index.js';
import { JsonlSessionStore } from '../sessions/session-manager.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import type { Message, Session } from '../types/index.js';
import { createAgentSession, type AgentPromptOptions, type AgentSession, type CreateAgentSessionOptions, type SessionStore } from './index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class ReviewProvider extends AiProvider {
  turns: { messages: Message[]; options?: ChatOptions }[] = [];
  constructor() { super({ type: 'mock' }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { throw new Error('Use shared stream loop'); }
  async streamChat(messages: Message[], _chunk: StreamChunkCallback, complete?: (response?: ChatResponse) => void, _error?: (error: Error) => void, options?: ChatOptions): Promise<void> {
    this.turns.push({ messages: structuredClone(messages), options });
    complete?.({ content: 'answer', model: 'review-model', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
  }
}
const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function setup(extra: Partial<CreateAgentSessionOptions> = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-review-'));
  roots.push(cwd);
  const provider = new ReviewProvider();
  const sdk = await createAgentSession({ cwd, provider: { kind: 'instance', name: 'review', provider }, isProjectTrusted: () => true, ...extra });
  sessions.push(sdk);
  return { cwd, provider, sdk };
}

describe('SDK public review regressions', () => {
  it('redacts caller-store initialization errors before factory rejection', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-review-'));
    roots.push(cwd);
    const delegate = new JsonlSessionStore(path.join(cwd, 'sessions'));
    const store: SessionStore = {
      setRedaction: () => { throw new Error('store initialization: review-initialization-secret'); },
      listSessionIds: () => delegate.listSessionIds(),
      loadSession: id => delegate.loadSession(id),
      saveSession: (...args) => delegate.saveSession(...args),
      getRawEntries: id => delegate.getRawEntries(id),
      deleteSession: id => delegate.deleteSession(id),
    };
    await expect(createAgentSession({ cwd, provider: { kind: 'config', config: { type: 'mock' } }, store, auth: { secrets: ['review-initialization-secret'] } })).rejects.toThrow('store initialization: [REDACTED]');
  });
  it('keeps borrowed registry ownership stable when callers mutate factory options', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-review-'));
    roots.push(cwd);
    const registry = new ExtensionRegistry();
    const cleanup = vi.fn();
    await registry.load('borrowed-review', () => cleanup);
    const options: CreateAgentSessionOptions = { cwd, provider: { kind: 'instance', name: 'review', provider: new ReviewProvider() }, extensionRegistry: registry };
    const sdk = await createAgentSession(options);
    sessions.push(sdk);
    options.extensionRegistry = undefined;
    await sdk.dispose();
    try { expect(cleanup).not.toHaveBeenCalled(); }
    finally { await registry.unloadAll(); }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('snapshots prompt options at admission, before queued mutations finish', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-review-store-'));
    roots.push(directory);
    const delegate = new JsonlSessionStore(directory);
    const store: SessionStore = {
      setRedaction: (...args) => delegate.setRedaction(...args),
      listSessionIds: () => delegate.listSessionIds(),
      loadSession: id => delegate.loadSession(id),
      saveSession: (...args) => delegate.saveSession(...args),
      getRawEntries: id => delegate.getRawEntries(id),
      deleteSession: id => delegate.deleteSession(id),
    };
    const { sdk, provider } = await setup({ store });
    const entered = deferred();
    const release = deferred();
    const save = store.saveSession.bind(store);
    vi.spyOn(store, 'saveSession').mockImplementation(async (...args) => {
      if (args[0].title === 'held rename') { entered.resolve(); await release.promise; }
      await save(...args);
    });
    const rename = sdk.rename('held rename');
    await entered.promise;
    const options: AgentPromptOptions = { model: 'admitted-model', blocks: [{ type: 'text', text: 'admitted-block' }] };
    const prompt = sdk.prompt('question', options);
    options.model = 'mutated-model';
    options.blocks![0] = { type: 'text', text: 'mutated-block' };
    release.resolve();
    await rename;
    await prompt;
    await sdk.wait();
    expect(provider.turns[0].options?.model).toBe('admitted-model');
    expect(sdk.messages()[0].blocks).toEqual([{ type: 'text', text: 'admitted-block' }]);
  });

  it('gives usage observers detached redacted values, not mutable provider accounting', async () => {
    const onUsage = vi.fn((_provider: string, _model: string | undefined, usage: NonNullable<ChatResponse['usage']>) => {
      usage.promptTokens = 900;
      usage.totalTokens = 999;
      return 0.04;
    });
    const { sdk } = await setup({ onUsage });
    expect((await sdk.promptAndWait('usage')).phase).toBe('completed');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(sdk.snapshot().usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.04 });
    expect(sdk.messages().at(-1)?.usage?.totalTokens).toBe(5);
  });

  it('isolates automatic compaction policy from live session state', async () => {
    const policy = vi.fn((session: Session) => {
      session.title = 'callback mutation';
      session.messages[0].content = 'callback mutation';
      return false;
    });
    const { sdk } = await setup({ compaction: { summarize: async () => 'summary', policy } });
    expect((await sdk.promptAndWait('original')).phase).toBe('completed');
    expect((await sdk.promptAndWait('second')).phase).toBe('completed');
    expect(policy).toHaveBeenCalled();
    expect(sdk.messages()[0].content).toBe('original');
    expect(sdk.snapshot().title).not.toBe('callback mutation');
  });
});
