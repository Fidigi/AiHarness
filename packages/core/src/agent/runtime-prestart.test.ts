import { describe, expect, it } from 'vitest';
import { AiProvider, type ChatResponse } from '../providers/index.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import type { Message } from '../types/index.js';
import { AgentRuntime } from './runtime.js';

class Provider extends AiProvider {
  calls = 0;
  constructor() { super({ type: 'mock', model: 'virtual-chat' }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(_messages: Message[], _chunk: (chunk: string) => void, complete?: (result?: ChatResponse) => void): Promise<void> {
    this.calls++; complete?.({ content: 'native admission response' });
  }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const latch = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), resolve: () => release() }; };
async function setup(phase: 'trust' | 'hook' | 'provider') {
  const manager = new SessionManager(), registry = new ExtensionRegistry(), provider = new Provider();
  const session = await manager.create({ cwd: process.cwd() }); registry.attachSessionManager(manager);
  const entered = latch(), release = latch(); let held = true;
  const gate = async (): Promise<void> => { if (held) { held = false; entered.resolve(); await release.promise; } };
  if (phase === 'hook') await registry.load('native-prestart-gate', api => { api.before('before:agent', gate); });
  const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry,
    isProjectTrusted: async () => { if (phase === 'trust') await gate(); return true; },
    resolveProvider: async () => { if (phase === 'provider') await gate(); return provider; } });
  const request = (input: string, signal?: AbortSignal) => ({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input, allowedTools: [], maxRetries: 0, signal });
  return { manager, registry, provider, session, runtime, request, entered, release };
}

describe('native runtime prestart admission', () => {
  for (const phase of ['trust', 'hook', 'provider'] as const) {
    it(`reserves the same session before the pending ${phase} await`, async () => {
      const f = await setup(phase);
      try {
        const first = f.runtime.start(f.request('first')); await f.entered.promise;
        await expect(f.runtime.start(f.request('second'))).rejects.toThrow('Un agent est déjà actif pour cette session.');
        expect(f.provider.calls).toBe(0); expect(f.manager.get(f.session.id)!.messages).toEqual([]);
        f.release.resolve(); const run = await first;
        expect((await f.runtime.wait(run.id))?.phase).toBe('completed'); expect(f.provider.calls).toBe(1);
        expect(f.manager.get(f.session.id)!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['first']);
      } finally { f.release.resolve(); await f.registry.unloadAll(); }
    });
    it(`cancels pending ${phase} without waiting for the privileged callback or lending its result to a replacement`, async () => {
      const f = await setup(phase), controller = new AbortController();
      try {
        const starting = f.runtime.start(f.request('withdrawn', controller.signal));
        const refused = expect(starting).rejects.toMatchObject({ name: 'AbortError' });
        await f.entered.promise; controller.abort(); await refused;
        expect(f.runtime.getSessionRun(f.session.id)).toBeUndefined(); expect(f.provider.calls).toBe(0);
        expect(f.manager.get(f.session.id)!.messages).toEqual([]);
        const replacement = await f.runtime.start(f.request('replacement'));
        expect((await f.runtime.wait(replacement.id))?.phase).toBe('completed');
        f.release.resolve(); await tick(); expect(f.provider.calls).toBe(1);
        expect(f.manager.get(f.session.id)!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['replacement']);
      } finally { f.release.resolve(); await f.registry.unloadAll(); }
    });
  }
  it('never invokes later startup hooks after an aborted handler eventually resolves', async () => {
    const f = await setup('hook'), controller = new AbortController(); let later = 0;
    await f.registry.load('later', api => { api.before('before:agent', () => { later++; }); });
    try {
      const refused = expect(f.runtime.start(f.request('withdrawn', controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
      await f.entered.promise; controller.abort(); await refused; expect(later).toBe(0);
      f.release.resolve(); await tick(); expect(later).toBe(0); expect(f.provider.calls).toBe(0);
    } finally { f.release.resolve(); await f.registry.unloadAll(); }
  });
  it('captures mutable request identity, blocks and tool capabilities before trust awaits', async () => {
    const f = await setup('trust'), other = await f.manager.create({ cwd: process.cwd() });
    const request = { ...f.request('original'), blocks: [{ type: 'text' as const, text: 'original block' }], allowedTools: [] as string[] };
    try {
      const starting = f.runtime.start(request); await f.entered.promise;
      request.sessionId = other.id; request.cwd = '/not-the-approved-cwd'; request.provider = 'not-the-provider'; request.input = 'mutated';
      request.blocks[0].text = 'mutated block'; request.allowedTools.push('read');
      f.release.resolve(); const run = await starting;
      expect((await f.runtime.wait(run.id))?.phase).toBe('completed'); expect(run.sessionId).toBe(f.session.id);
      expect(run.cwd).toBe(process.cwd()); expect(run.provider).toBe('mock');
      const users = f.manager.get(f.session.id)!.messages.filter(message => message.role === 'user');
      expect(users.map(message => message.content)).toEqual(['original']); expect(users[0].blocks).toEqual([{ type: 'text', text: 'original block' }]);
      expect(f.manager.get(other.id)!.messages).toEqual([]);
    } finally { f.release.resolve(); await f.registry.unloadAll(); }
  });
  it('does not invoke trust, hooks, provider or writes for an already aborted caller', async () => {
    const manager = new SessionManager(), registry = new ExtensionRegistry(), session = await manager.create({ cwd: process.cwd() }); let calls = 0;
    const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry,
      isProjectTrusted: () => { calls++; return true; }, resolveProvider: () => { calls++; return new Provider(); } });
    await registry.load('observed', api => { api.before('before:agent', () => { calls++; }); });
    const controller = new AbortController(); controller.abort();
    await expect(runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'withdrawn', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0); expect(manager.get(session.id)!.messages).toEqual([]); await registry.unloadAll();
  });
  it('pins the captured host signal across hook transforms rather than accepting a replacement lifetime', async () => {
    const f = await setup('provider'), caller = new AbortController(), replacement = new AbortController(); let captured: AbortSignal | undefined;
    await f.registry.load('signal-transform', api => { api.before('before:agent', data => { captured = data.signal; return { signal: replacement.signal }; }); });
    await f.registry.load('signal-observer', api => { api.before('before:agent', data => { expect(data.signal).toBe(captured); expect(data.signal).not.toBe(replacement.signal); }); });
    try {
      const refused = expect(f.runtime.start(f.request('withdrawn', caller.signal))).rejects.toMatchObject({ name: 'AbortError' });
      await f.entered.promise; caller.abort(); await refused;
      expect(captured?.aborted).toBe(true); expect(replacement.signal.aborted).toBe(false);
      f.release.resolve(); await tick(); expect(f.provider.calls).toBe(0); expect(f.manager.get(f.session.id)!.messages).toEqual([]);
    } finally { f.release.resolve(); await f.registry.unloadAll(); }
  });
  it('refuses a deleted source after a pending hook without calling its provider', async () => {
    const f = await setup('hook');
    try {
      const starting = f.runtime.start(f.request('withdrawn')); const refused = expect(starting).rejects.toThrow('Session introuvable.');
      await f.entered.promise; await f.manager.delete(f.session.id); f.release.resolve(); await refused;
      expect(f.provider.calls).toBe(0); expect(f.runtime.getSessionRun(f.session.id)).toBeUndefined();
    } finally { f.release.resolve(); await f.registry.unloadAll(); }
  });
});
