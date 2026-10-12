import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AiProvider, MockProvider, ProviderFactory, type ChatOptions, type ChatResponse, type StreamChunkCallback } from '../providers/index.js';
import { JsonlSessionStore } from '../sessions/session-manager.js';
import { PROVIDER_NETWORK_SCOPE, fetchProviderResponse, type ProviderNetworkScope } from '../providers/provider-network.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import type { Message } from '../types/index.js';
import { createAgentSession, createAgentResourceLoader, deserializeSession, type AgentSession, type SessionStore } from './index.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class Provider extends AiProvider {
  turns: { messages: Message[]; options?: ChatOptions }[] = [];
  constructor(readonly execute?: (chunk: StreamChunkCallback, options?: ChatOptions) => Promise<ChatResponse>) {
    super({ type: 'mock' });
  }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { throw new Error('SDK conversation must not bypass stream runtime.'); }
  override async getAvailableModels(): Promise<string[]> { throw new Error('No surprise discovery.'); }
  async streamChat(messages: Message[], chunk: StreamChunkCallback, complete?: (response?: ChatResponse) => void, _error?: (error: Error) => void, options?: ChatOptions): Promise<void> {
    this.turns.push({ messages: structuredClone(messages), options });
    const response = this.execute ? await this.execute(chunk, options) : {
      content: 'answer', model: options?.model ?? 'mock-model',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, cacheReadTokens: 1, costUsd: 0.01 },
    };
    complete?.(response);
  }
}

const roots: string[] = [];
const handles: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map(session => session.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function root(): Promise<string> {
  const result = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-'));
  roots.push(result);
  return result;
}
async function session(cwd: string, provider: AiProvider = new Provider(), extra: Partial<Parameters<typeof createAgentSession>[0]> = {}): Promise<AgentSession> {
  const result = await createAgentSession({ cwd, provider: { kind: 'instance', name: 'mock', provider }, isProjectTrusted: () => true, ...extra });
  handles.push(result);
  return result;
}

/** Structural caller store composed over real disposable v2 persistence. */
function customStore(delegate: JsonlSessionStore): SessionStore {
  return {
    setRedaction: (...args) => delegate.setRedaction(...args),
    listSessionIds: () => delegate.listSessionIds(),
    loadSession: id => delegate.loadSession(id),
    saveSession: (value, entries, options) => delegate.saveSession(value, entries, options),
    getRawEntries: id => delegate.getRawEntries(id),
    deleteSession: id => delegate.deleteSession(id),
  };
}

describe('high-level Core session SDK', () => {
  it('keeps factories/reads passive and true memory operation never opens a disk store', async () => {
    const cwd = await root();
    const disk = vi.spyOn(JsonlSessionStore.prototype, 'ensureDir');
    const construct = vi.spyOn(ProviderFactory, 'create');
    const loader = { load: vi.fn() };
    const sdk = await session(cwd, undefined, { provider: { kind: 'config', config: { type: 'mock', model: 'chosen' } }, resourceLoader: loader });
    expect(construct).not.toHaveBeenCalled();
    expect(loader.load).not.toHaveBeenCalled();
    expect(sdk.capabilities.persistence).toBe('memory');
    expect(sdk.resources()).toEqual([]);
    expect(sdk.messages()).toEqual([]);
    expect(await sdk.history()).toEqual([]);
    sdk.state(); sdk.events(); sdk.exportSession();
    expect(construct).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
    const run = await sdk.promptAndWait('hello');
    expect(run.phase).toBe('completed');
    expect(construct).toHaveBeenCalledTimes(1);
    expect(disk).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
    expect(sdk.capabilities).toMatchObject({ executableLoading: false, modelDiscovery: false, oauthLogin: false, mcpHosting: false });
  });

  it('fails closed without trust and rechecks canonical workspace trust on each prompt', async () => {
    const cwd = await root();
    const provider = new Provider();
    const sdk = await session(cwd, provider, { isProjectTrusted: undefined });
    await expect(sdk.prompt('not approved')).rejects.toThrow(/approuvé/);
    expect(provider.turns).toEqual([]);
    let trusted = true;
    const check = vi.fn((candidate: string) => candidate === cwd && trusted);
    const allowed = await session(cwd, provider, { isProjectTrusted: check });
    expect((await allowed.promptAndWait('approved')).phase).toBe('completed');
    trusted = false;
    await expect(allowed.prompt('revoked')).rejects.toThrow(/approuvé/);
    expect(provider.turns).toHaveLength(1);
    expect(check).toHaveBeenCalledWith(cwd);
    const outside = await root();
    await expect(createAgentSession({ cwd, allowedRoots: [outside], provider: { kind: 'instance', name: 'mock', provider } })).rejects.toThrow(/racines/);
  });

  it('delegates conversation, usage, settings, redaction, detached snapshots and replay', async () => {
    const cwd = await root();
    const secret = 'disposable-sdk-secret';
    const provider = new Provider(async chunk => {
      await chunk(`before:${secret.slice(0, 8)}`);
      await chunk(`${secret.slice(8)}:after`);
      return { content: `before:${secret}:after`, usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } };
    });
    const onUsage = vi.fn(() => 0.03);
    const sdk = await session(cwd, provider, { auth: { secrets: [secret] }, onUsage });
    await sdk.setModel('model-two');
    await sdk.setThinking('high');
    const observed: string[] = [];
    const unsubscribe = sdk.subscribe(event => { observed.push(event.type); throw new Error('consumer failure'); });
    sdk.subscribe(async () => { throw new Error('async consumer failure'); });
    expect((await sdk.promptAndWait(`question ${secret}`)).phase).toBe('completed');
    expect(provider.turns[0].options).toMatchObject({ model: 'model-two', thinking: 'high' });
    expect(sdk.snapshot().usage).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0.03 });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([sdk.snapshot(), sdk.events(), await sdk.history()])).not.toContain(secret);
    expect(sdk.messages().at(-1)?.content).toBe('before:[REDACTED]:after');
    expect(observed).toContain('run.completed');
    const events = sdk.events();
    expect(events.events.map(event => event.sequence)).toEqual(events.events.map((_, i) => i + 1));
    expect(sdk.events(events.lastSequence).events).toEqual([]);
    expect(() => sdk.events(-1)).toThrow(/cursor/);
    const copy = sdk.snapshot();
    copy.messages[0].content = 'mutated';
    expect(sdk.messages()[0].content).not.toBe('mutated');
    const replay = sdk.events();
    replay.events[0].type = 'notice';
    expect(sdk.events().events[0].type).not.toBe('notice');
    expect(deserializeSession(sdk.exportSession()).messages[0].timestamp).toBeInstanceOf(Date);
    unsubscribe(); unsubscribe();
    await sdk.rename('named');
    expect(sdk.snapshot().title).toBe('named');
  });

  it('allows stop while wait is pending and prevents mutations until durable settlement', async () => {
    const cwd = await root();
    const entered = deferred();
    const released = deferred();
    const aborted = deferred();
    const provider = new Provider(async (_chunk, options) => {
      entered.resolve();
      await new Promise<void>(done => options?.signal?.addEventListener('abort', () => { aborted.resolve(); done(); }, { once: true }));
      await released.promise;
      throw new DOMException('cancelled', 'AbortError');
    });
    const sdk = await session(cwd, provider);
    await sdk.prompt('start');
    await entered.promise;
    const waiting = sdk.wait();
    expect((await sdk.stop())?.phase).toBe('stopped');
    await aborted.promise;
    await expect(sdk.rename('too early')).rejects.toThrow(/busy/);
    await expect(sdk.clone()).rejects.toThrow(/busy/);
    await expect(sdk.prompt('too early')).rejects.toThrow(/busy/);
    released.resolve();
    expect((await waiting)?.phase).toBe('stopped');
    await sdk.rename('settled');
    expect(sdk.snapshot().title).toBe('settled');
  });

  it('queues steering/follow-up using Core scheduler and serializes concurrent starts', async () => {
    const cwd = await root();
    const entered = deferred();
    const released = deferred();
    let turns = 0;
    const provider = new Provider(async () => {
      if (++turns === 1) { entered.resolve(); await released.promise; }
      return { content: `turn-${turns}` };
    });
    const sdk = await session(cwd, provider, { runDefaults: { steeringMode: 'one-at-a-time', followUpMode: 'all' } });
    const first = sdk.prompt('initial');
    const second = sdk.prompt('concurrent');
    await first;
    await expect(second).rejects.toThrow(/busy/);
    await entered.promise;
    sdk.steer('steer');
    sdk.followUp('follow-up');
    sdk.followUp('remove');
    expect(sdk.clearQueue('follow-up').followUpQueue).toEqual([]);
    sdk.followUp('follow-up');
    released.resolve();
    expect((await sdk.wait())?.phase).toBe('completed');
    expect(sdk.messages().filter(message => message.role === 'user').map(message => message.content)).toEqual(['initial', 'steer', 'follow-up']);
  });

  it('uses caller stores without deletion and preserves compaction/abandoned history across resume', async () => {
    const cwd = await root();
    const dir = path.join(cwd, 'sessions');
    const delegate = new JsonlSessionStore(dir);
    const store = customStore(delegate);
    const deleted = vi.spyOn(store, 'deleteSession');
    const sdk = await session(cwd, undefined, { store, auth: { secrets: ['private-sdk-value'] } });
    await sdk.promptAndWait('first private-sdk-value');
    await sdk.promptAndWait('second');
    const firstId = sdk.messages()[0].id;
    const lastId = sdk.messages().at(-1)!.id;
    const originalIds = sdk.messages().map(message => message.id);
    await sdk.applyCompaction('summary private-sdk-value', sdk.messages()[2].id, { provider: 'mock', model: 'compact', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
    expect(sdk.messages()).toHaveLength(2);
    expect(sdk.effectiveContext()[0]).toMatchObject({ role: 'system', content: '[Context Summary] summary [REDACTED]' });
    expect((await sdk.history()).filter(entry => entry.type === 'message').map(entry => entry.id)).toEqual(originalIds);
    expect(sdk.events().events.map(event => event.type)).toContain('compaction.completed');
    await expect(sdk.applyCompaction('summary', 'nonexistent')).rejects.toThrow(/boundary/);
    const fork = await sdk.fork(firstId, { before: true }); handles.push(fork);
    expect(fork.messages()).toEqual([]);
    expect(fork.snapshot().parentId).toBe(sdk.id);
    const clone = await sdk.clone('copy'); handles.push(clone);
    expect(clone.snapshot()).toMatchObject({ title: 'copy', metadata: { clonedFromSessionId: sdk.id } });
    expect(clone.snapshot().parentId).toBeUndefined();
    expect(clone.messages().map(message => message.id)).not.toEqual(sdk.messages().map(message => message.id));
    await sdk.branchBefore(firstId);
    await sdk.promptAndWait('replacement');
    expect((await sdk.history()).some(entry => entry.id === lastId)).toBe(true);
    expect(sdk.messages().some(message => message.id === lastId)).toBe(false);
    const id = sdk.id;
    await sdk.dispose();
    expect(deleted).not.toHaveBeenCalled();
    expect(await readFile(path.join(dir, `${id}.jsonl`), 'utf8')).not.toContain('private-sdk-value');
    const resumed = await session(cwd, undefined, { store, session: { kind: 'resume', id } });
    expect(resumed.messages().filter(message => message.role === 'user').map(message => message.content)).toEqual(['replacement']);
    expect((await resumed.history()).some(entry => entry.id === lastId)).toBe(true);
    expect(resumed.capabilities.persistence).toBe('caller-store');
    // Parent disposal must not close shared fork/clone runtime.
    expect((await fork.promptAndWait('independent')).phase).toBe('completed');
  });

  it('isolates the owned provider network scope and closes only after the last copied handle', async () => {
    const cwd = await root();
    const constructed = vi.spyOn(ProviderFactory, 'create');
    const sdk = await session(cwd, undefined, { provider: { kind: 'config', config: { type: 'mock' } } });
    await sdk.promptAndWait('start');
    const config = constructed.mock.calls[0][0] as Parameters<typeof ProviderFactory.create>[0] & { [PROVIDER_NETWORK_SCOPE]: ProviderNetworkScope };
    const scope = config[PROVIDER_NETWORK_SCOPE];
    expect(scope).toBeDefined();
    const clone = await sdk.clone(); handles.push(clone);
    await sdk.dispose();
    expect((await clone.promptAndWait('still open')).phase).toBe('completed');
    await clone.dispose();
    const fetcher = vi.fn();
    const settings = (constructed.mock.results[0].value as AiProvider).getNetworkSettings();
    await expect(fetchProviderResponse('https://example.invalid', {}, settings, { scope, fetcher })).rejects.toThrow(/closed/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports persistence failures, keeps failed writes out of memory, and isolates custom store references', async () => {
    const cwd = await root();
    const store = customStore(new JsonlSessionStore(path.join(cwd, 'sessions')));
    const sdk = await session(cwd, undefined, { store });
    const save = vi.spyOn(store, 'saveSession').mockRejectedValue(new Error('store-secret'));
    await expect(sdk.rename('not saved')).rejects.toThrow('Session persistence failed.');
    expect(sdk.snapshot().title).not.toBe('not saved');
    await expect(sdk.promptAndWait('fail')).rejects.toThrow('Session persistence failed.');
    expect(sdk.messages()).toEqual([]);
    save.mockRestore();
    const delegate = store.saveSession.bind(store);
    vi.spyOn(store, 'saveSession').mockImplementation(async (value, entries, options) => {
      await delegate(value, entries, options);
      value.title = 'mutation from caller store';
      if (value.messages[0]) value.messages[0].content = 'mutation from caller store';
    });
    await sdk.rename('safe title');
    expect(sdk.snapshot().title).toBe('safe title');
    expect((await sdk.promptAndWait('retry')).phase).toBe('completed');
    expect(sdk.messages()[0].content).toBe('retry');
  });

  it('explicit resource loader uses Core trust gate and never executes project modules', async () => {
    const cwd = await root();
    const home = await root();
    const prompts = path.join(cwd, '.ai-harness', 'prompts');
    await mkdir(prompts, { recursive: true });
    await writeFile(path.join(prompts, 'hello.md'), 'Hello $1');
    const skills = path.join(cwd, '.ai-harness', 'skills', 'guide');
    await mkdir(skills, { recursive: true });
    await writeFile(path.join(skills, 'SKILL.md'), '---\nname: guide\ndescription: Guidance\n---\nKeep it concise.');
    await writeFile(path.join(cwd, '.ai-harness', 'extension.js'), 'throw new Error("must never execute");');
    let trusted = false;
    const sdk = await session(cwd, undefined, {
      isProjectTrusted: () => trusted,
      resourceLoader: createAgentResourceLoader({ homeDir: home }),
    });
    expect(sdk.resources()).toEqual([]);
    expect(await sdk.reloadResources()).toEqual([]);
    await expect(sdk.expandPrompt('hello', ['SDK'])).rejects.toThrow('Unknown prompt.');
    trusted = true;
    expect(await sdk.expandPrompt('hello', ['SDK'])).toBe('Hello SDK');
    expect(await sdk.invokeSkill('guide', 'question')).toContain('Keep it concise.');
    expect(sdk.resources()).toHaveLength(2);
    trusted = false;
    await expect(sdk.invokeSkill('guide')).rejects.toThrow('Unknown skill.');
    expect(sdk.resources()).toEqual([]);
    expect(sdk.resourceDiagnostics()).toEqual([]);
  });

  it('delegates automatic compaction and blocks application if a summarizer ignores abort', async () => {
    const cwd = await root();
    const entered = deferred();
    const release = deferred();
    const summarize = vi.fn(async () => { entered.resolve(); await release.promise; return 'must not apply'; });
    const messages: Message[] = Array.from({ length: 4 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', content: 'long '.repeat(80), timestamp: new Date(100 + i) }));
    const sdk = await session(cwd, undefined, {
      session: { kind: 'new', options: { messages } },
      compaction: { settings: { keepRecentTokens: 1, reserveTokens: 99999 }, summarize },
    });
    await sdk.prompt('trigger');
    await entered.promise;
    const ack = await sdk.stop();
    expect(ack?.phase).toBe('stopped');
    release.resolve();
    expect((await sdk.wait())?.phase).toBe('stopped');
    expect((await sdk.history()).some(entry => entry.type === 'compaction')).toBe(false);
    expect(sdk.snapshot().metadata?.compactionSummary).toBeUndefined();
    expect(sdk.events().events.map(event => event.type)).toContain('compaction.failed');
  });

  it('preserves interrupted nested accounting before durable stop and ignores late tool work', async () => {
    const cwd = await root();
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' });
    const registry = new ExtensionRegistry();
    const held = deferred();
    const started = deferred();
    await registry.load('hold-tool', api => api.registerTool({
      name: 'hold', description: 'wait', parameters: { type: 'object' },
      execute: async () => { started.resolve(); await held.promise; return { content: 'late' }; },
    }));
    vi.spyOn(provider, 'classify').mockResolvedValue({ label: 'yes', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, costUsd: 0.002 } });
    const stream = vi.spyOn(provider, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      complete?.({ content: '', toolCalls: [{ id: 'interrupted-script', name: 'codemode', input: {
        code: "store('uncommitted',true); await models.classify({model:'virtual-chat:classifier',input:'test',labels:['yes']}); return await tools.hold({});",
      } }] });
    });
    const usage = vi.fn();
    const store = customStore(new JsonlSessionStore(path.join(cwd, 'sessions')));
    const durableResult = deferred();
    const allowWrite = deferred();
    const originalSave = store.saveSession.bind(store);
    vi.spyOn(store, 'saveSession').mockImplementation(async (value, entries, options) => {
      if (value.messages.at(-1)?.metadata?.interrupted === true) {
        durableResult.resolve();
        await allowWrite.promise;
      }
      await originalSave(value, entries, options);
    });
    const sdk = await session(cwd, provider, { store, extensionRegistry: registry, onUsage: usage, runDefaults: { codemode: { enabled: true } } });
    await sdk.prompt('work');
    await started.promise;
    const waiting = sdk.wait();
    expect((await sdk.stop())?.phase).toBe('stopped');
    await durableResult.promise;
    expect(sdk.events().events.some(event => event.type === 'run.stopped')).toBe(false);
    await expect(sdk.rename('before durable')).rejects.toThrow(/busy/);
    allowWrite.resolve();
    expect((await waiting)?.phase).toBe('stopped');
    const result = sdk.messages().at(-1)!;
    expect(result).toMatchObject({ role: 'tool', isError: true, usage: { totalTokens: 4, costUsd: 0.002 }, metadata: { interrupted: true } });
    expect((result.metadata?.codemode as Record<string, unknown>).store).toBeUndefined();
    expect(sdk.snapshot().usage).toMatchObject({ totalTokens: 4, costUsd: 0.002 });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    const raw = await sdk.history();
    expect(raw.find(entry => entry.id === result.id)).toMatchObject({ usage: { totalTokens: 4 } });
    const events = sdk.events();
    expect(events.events.findIndex(event => event.type === 'tool.failed')).toBeLessThan(events.events.findIndex(event => event.type === 'run.stopped'));
    held.resolve();
    await new Promise(done => setTimeout(done, 20));
    expect(sdk.events()).toEqual(events);
    expect(sdk.messages().at(-1)).toEqual(result);
    await registry.unloadAll();
  }, 15_000);

  it('disposes idempotently without unloading a caller registry/provider/store', async () => {
    const cwd = await root();
    const registry = new ExtensionRegistry();
    const cleanup = vi.fn();
    await registry.load('owned-by-caller', () => cleanup);
    const sdk = await session(cwd, undefined, { extensionRegistry: registry });
    const unsubscribe = sdk.subscribe(() => undefined);
    const first = sdk.dispose();
    expect(sdk.dispose()).toBe(first);
    await first;
    expect(cleanup).not.toHaveBeenCalled();
    unsubscribe();
    expect(() => sdk.snapshot()).toThrow(/disposed/);
    expect(() => sdk.prompt('closed')).toThrow(/disposed/);
    await registry.unloadAll();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(createAgentSession({ cwd, provider: { kind: 'config', config: { type: 'mock' } }, session: { kind: 'resume', id: 'missing' } })).rejects.toThrow(/SessionStore/);
  });
});
