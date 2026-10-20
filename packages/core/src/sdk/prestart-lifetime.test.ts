import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiProvider, type ChatResponse } from '../providers/index.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { JsonlSessionStore } from '@ai-harness/core';
import type { Message } from '../types/index.js';
import { createAgentSession } from './agent-session.js';

class Provider extends AiProvider {
  calls = 0;
  constructor() { super({ type: 'mock', model: 'virtual-chat' }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(_messages: Message[], _chunk: (chunk: string) => void, complete?: (result?: ChatResponse) => void): Promise<void> { this.calls++; complete?.({ content: 'native SDK reply' }); }
}
const latch = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), resolve: () => release() }; };
function nativeFile(store: JsonlSessionStore, id: string): string {
  const file = store.getSessionFilePath(id);
  if (!file) throw new Error('Native saved-session file path is unavailable.');
  return file;
}
async function setup(durable: boolean) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-prestart-')), registry = new ExtensionRegistry(), provider = new Provider();
  const entered = latch(), release = latch(); let calls = 0;
  await registry.load('native-pending-hook', extension => { extension.before('before:agent', async () => { calls++; entered.resolve(); await release.promise; }); });
  const store = durable ? new JsonlSessionStore(path.join(cwd, 'sessions')) : undefined;
  const api = await createAgentSession({ cwd, allowedRoots: [cwd], store, extensionRegistry: registry,
    provider: { kind: 'instance', name: 'mock', provider }, isProjectTrusted: () => true,
    runDefaults: { allowedTools: [], codemode: { enabled: false }, maxRetries: 0 } });
  const events: string[] = []; api.subscribe(event => { events.push(event.type); });
  return { cwd, api, registry, store, provider, entered, release, events, calls: () => calls,
    cleanup: async () => { release.resolve(); await api.dispose(); await registry.unloadAll(); await rm(cwd, { recursive: true, force: true }); } };
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('SDK pending-start lifetimes', () => {
  for (const durable of [false, true]) for (const action of ['stop', 'dispose'] as const) {
    it(`${durable ? 'native disk' : 'true memory'} ${action} withdraws an unpublished prompt before an ignored hook resolves`, async () => {
      const f = await setup(durable); const id = f.api.id;
      const before = f.store ? await readFile(nativeFile(f.store, id)) : undefined;
      try {
        const starting = f.api.prompt('must not persist'); const refused = expect(starting).rejects.toMatchObject({ name: 'AbortError' });
        await f.entered.promise;
        await Promise.all([refused, f.api[action]()]); // Still held: cancellation is not queued behind the ignored hook.
        expect(f.events).toEqual([]); expect(f.provider.calls).toBe(0); expect(f.registry.list().map(item => item.id)).toEqual(['native-pending-hook']);
        if (f.store) {
          expect(await readFile(nativeFile(f.store, id))).toEqual(before);
          expect((await f.store.getSessionSnapshot(id))!.session.messages).toEqual([]);
        } else if (action === 'stop') expect(f.api.messages()).toEqual([]);
        f.release.resolve(); await tick(); expect(f.events).toEqual([]); expect(f.provider.calls).toBe(0);
        if (action === 'stop') {
          expect(await f.api.wait()).toBeUndefined();
          const next = await f.api.promptAndWait('replacement'); expect(next.phase).toBe('completed'); expect(f.provider.calls).toBe(1);
        }
      } finally { await f.cleanup(); }
    });
  }
  it('refuses a second accepted prompt and synchronous history preparation while the first hook is pending', async () => {
    const f = await setup(false);
    try {
      const first = f.api.prompt('first'); await f.entered.promise;
      await expect(f.api.prompt('second')).rejects.toThrow('Agent session is busy');
      expect(() => f.api.compactionTarget()).toThrow('Agent session is busy');
      f.release.resolve(); const run = await first; expect((await f.api.wait())?.id).toBe(run.id);
      expect(f.api.messages().filter(message => message.role === 'user').map(message => message.content)).toEqual(['first']);
    } finally { await f.cleanup(); }
  });
  it('keeps a busy refusal rejected when the caller handles it only after the first start', async () => {
    const f = await setup(false);
    try {
      const first = f.api.prompt('first'), second = f.api.prompt('second');
      await f.entered.promise; await tick(); // Native rejection-reporting turn; the first hook is still held.
      f.release.resolve(); await first;
      await expect(second).rejects.toThrow('Agent session is busy');
      expect((await f.api.wait())?.phase).toBe('completed'); expect(f.provider.calls).toBe(1);
      expect(f.api.messages().filter(message => message.role === 'user').map(message => message.content)).toEqual(['first']);
    } finally { await f.cleanup(); }
  });
  it('keeps an earlier accepted model mutation ahead of a pending prompt', async () => {
    const f = await setup(false);
    try {
      const setting = f.api.setModel('next-model'), starting = f.api.prompt('first');
      await setting; await f.entered.promise; expect(f.api.snapshot().model).toBe('next-model');
      f.release.resolve(); const run = await starting; expect(run.model).toBe('next-model'); expect((await f.api.wait())?.phase).toBe('completed');
    } finally { await f.cleanup(); }
  });
  for (const action of ['stop', 'dispose'] as const) it(`awaits an already admitted metadata save during ${action} without claiming rollback`, async () => {
    class HeldMetadataStore extends JsonlSessionStore {
      hold = false; readonly entered = latch(); readonly released = latch();
      override async saveSession(...args: Parameters<JsonlSessionStore['saveSession']>): Promise<void> {
        if (this.hold && !args[2]?.requireAbsent) { this.hold = false; this.entered.resolve(); await this.released.promise; }
        await super.saveSession(...args);
      }
    }
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-admitted-prestart-')), store = new HeldMetadataStore(path.join(cwd, 'sessions'));
    const registry = new ExtensionRegistry(), provider = new Provider(); let api: Awaited<ReturnType<typeof createAgentSession>> | undefined;
    try {
      api = await createAgentSession({ cwd, allowedRoots: [cwd], store, extensionRegistry: registry, isProjectTrusted: () => true,
        provider: { kind: 'instance', name: 'mock', provider }, runDefaults: { allowedTools: [], codemode: { enabled: false }, maxRetries: 0 } });
      const id = api.id, before = await readFile(nativeFile(store, id)), events: string[] = []; api.subscribe(event => { events.push(event.type); });
      store.hold = true;
      const refused = expect(api.prompt('withdraw after save admission')).rejects.toMatchObject({ name: 'AbortError' });
      await store.entered.promise; let returned = false;
      const cancellation = api[action]().then(() => { returned = true; });
      await tick(); expect(returned).toBe(false); expect(provider.calls).toBe(0);
      store.released.resolve(); await Promise.all([refused, cancellation]);
      const after = (await store.getSessionSnapshot(id))!;
      expect(after.session.messages).toEqual([]); expect(typeof after.session.agentId).toBe('string');
      expect(await readFile(nativeFile(store, id))).not.toEqual(before); // The admitted metadata write really settled.
      expect(provider.calls).toBe(0); expect(events).toEqual([]);
    } finally { store.released.resolve(); await api?.dispose(); await registry.unloadAll(); await rm(cwd, { recursive: true, force: true }); }
  });
  it('does not reuse the previous settlement after withdrawing a later unpublished prompt', async () => {
    const f = await setup(false);
    try {
      f.release.resolve(); const prior = await f.api.promptAndWait('completed');
      expect(prior.phase).toBe('completed');
      const entered = latch(), finish = latch();
      await f.registry.load('later-held', extension => { extension.before('before:agent', async () => { entered.resolve(); await finish.promise; }); });
      try {
        const refused = expect(f.api.prompt('withdrawn')).rejects.toMatchObject({ name: 'AbortError' });
        await entered.promise; await f.api.stop(); await refused;
        expect(await f.api.wait()).toBeUndefined();
        expect(f.api.messages().filter(message => message.role === 'user').map(message => message.content)).toEqual(['completed']);
      } finally { finish.resolve(); }
    } finally { await f.cleanup(); }
  });
  it('publishes one disposal promise before synchronous prestart abort reentry', async () => {
    const f = await setup(true); let reentered: Promise<void> | undefined;
    await f.registry.load('reentry', extension => { extension.before('before:agent', data => { data.signal?.addEventListener('abort', () => { reentered = f.api.dispose(); }, { once: true }); }); });
    // Register reentry before a separate held hook in a fresh registry order.
    await f.registry.unload('native-pending-hook');
    await f.registry.load('native-pending-hook', extension => { extension.before('before:agent', async () => { f.entered.resolve(); await f.release.promise; }); });
    try {
      const refused = expect(f.api.prompt('withdrawn')).rejects.toMatchObject({ name: 'AbortError' });
      await f.entered.promise; const disposal = f.api.dispose(); expect(reentered).toBe(disposal);
      await Promise.all([refused, disposal]); f.release.resolve(); await tick(); expect(f.provider.calls).toBe(0); expect(f.events).toEqual([]);
      expect(f.registry.list()).toHaveLength(2);
    } finally { await f.cleanup(); }
  });
});
