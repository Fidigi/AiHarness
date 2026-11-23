import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AiProvider, type ChatOptions, type ChatResponse, type StreamChunkCallback } from '../providers/index.js';
import type { Message } from '../types/index.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { JsonlSessionStore } from '../sessions/session-manager.js';
import { createAgentSession } from './agent-session.js';
import type { AgentSession } from './types.js';

class Provider extends AiProvider {
  calls: Message[][] = [];
  constructor() { super({ type: 'mock' }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { throw new Error('stream only'); }
  async streamChat(messages: Message[], _chunk: StreamChunkCallback, complete?: (response?: ChatResponse) => void, _error?: (error: Error) => void, options?: ChatOptions): Promise<void> {
    if (options?.signal?.aborted) throw new Error('aborted');
    this.calls.push(structuredClone(messages));
    complete?.({ content: 'raw', model: 'physical', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
  }
}
const roots: string[] = [], handles: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-ext-hooks-')); roots.push(cwd);
  const registry = new ExtensionRegistry(), provider = new Provider();
  const options = { cwd, provider: { kind: 'instance' as const, name: 'mock', provider }, isProjectTrusted: () => true, extensionRegistry: registry };
  return { registry, provider, options };
}

it('continues through typed custom context, conserves authentic usage and reconstructs state on resume/copy', async () => {
  const { registry, provider, options } = await fixture();
  const order: string[] = [];
  await registry.load('review', api => {
    api.before('before:message', data => ({ content: `owned:${data.content}` }));
    api.before('before:turn:end', async data => {
      order.push(`turn:${data.round}:${data.trigger.kind}`);
      const manager = data.context.sessionManager;
      const entries = await manager.getActiveBranchEntries(data.sessionId);
      if (!entries.some(entry => entry.type === 'custom' && entry.customType === 'review:state')) {
        await manager.appendCustomEntry(data.sessionId, 'review:state', { reviewed: true });
        return { continuation: { type: 'review:check', content: 'CHECK_AGAIN' } };
      }
      return undefined;
    });
    api.before('before:agent:settle', data => { order.push(`settle:${data.round}`); });
  });
  const store = new JsonlSessionStore(path.join(options.cwd, 'sessions'));
  const sdk = await createAgentSession({ ...options, store }); handles.push(sdk);
  expect((await sdk.promptAndWait('question')).phase).toBe('completed');
  expect(order).toEqual(['turn:0:user', 'settle:0', 'turn:1:custom', 'settle:1']);
  expect(provider.calls).toHaveLength(2);
  expect(JSON.stringify(provider.calls[1])).toContain('CHECK_AGAIN');
  expect(JSON.stringify(provider.calls[1])).not.toContain('reviewed');
  expect(sdk.messages().filter(message => message.role === 'user').map(message => message.content)).toEqual(['question']);
  expect(sdk.messages().filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['owned:raw', 'owned:raw']);
  expect(sdk.snapshot().usage.totalTokens).toBe(6);
  const clone = await sdk.clone(); handles.push(clone);
  expect((await clone.history()).some(entry => entry.type === 'custom' && entry.customType === 'review:state')).toBe(true);
  const id = sdk.id;
  await sdk.dispose();
  const resumed = await createAgentSession({ ...options, store, session: { kind: 'resume', id } }); handles.push(resumed);
  expect((await resumed.promptAndWait('resumed')).phase).toBe('completed');
  expect(provider.calls).toHaveLength(3);
});

it('conserves completed provider accounting when message publication is vetoed', async () => {
  const { registry, options } = await fixture();
  let charged = 0;
  await registry.load('veto', api => { api.before('before:message', () => false); });
  const sdk = await createAgentSession({ ...options, onUsage: (_provider, _model, usage) => { charged += usage.totalTokens; return undefined; } }); handles.push(sdk);
  expect((await sdk.promptAndWait('question')).phase).toBe('failed');
  expect(charged).toBe(3); expect(sdk.snapshot().usage.totalTokens).toBe(3);
  expect(sdk.messages().at(-1)).toMatchObject({ content: 'raw', metadata: { outputError: 'Extension message publication refused.' } });
});

it('admits a custom trigger without inventing a user message and bills an erased provider answer', async () => {
  const { registry, provider, options } = await fixture();
  const triggers: unknown[] = [];
  await registry.load('observe', api => {
    api.before('before:agent', data => { triggers.push(data.trigger); });
    api.before('before:message', () => ({ content: '' }));
  });
  const sdk = await createAgentSession(options); handles.push(sdk);
  expect((await sdk.promptAndWait('CUSTOM_INPUT', { trigger: { kind: 'custom', type: 'automation:review' } })).phase).toBe('completed');
  expect(triggers).toEqual([{ kind: 'custom', type: 'automation:review' }]);
  expect(sdk.messages().filter(message => message.role === 'user')).toEqual([]);
  expect((await sdk.history()).find(entry => entry.type === 'custom_message')).toMatchObject({ customType: 'automation:review', content: 'CUSTOM_INPUT' });
  expect(JSON.stringify(provider.calls[0])).toContain('CUSTOM_INPUT');
  expect(sdk.messages().filter(message => message.role === 'assistant')).toMatchObject([{ content: '', usage: { totalTokens: 3 } }]);
  expect(sdk.snapshot().usage.totalTokens).toBe(3);
});

it('bounds runaway continuations without persisting an unserviceable trigger', async () => {
  const { registry, provider, options } = await fixture();
  await registry.load('loop', api => { api.before('before:agent:settle', () => ({ continuation: { type: 'loop', content: 'again' } })); });
  const sdk = await createAgentSession(options); handles.push(sdk);
  expect((await sdk.promptAndWait('start', { maxToolRounds: 2 })).phase).toBe('failed');
  expect(provider.calls).toHaveLength(2);
  expect((await sdk.history()).filter(entry => entry.type === 'custom_message')).toHaveLength(1);
});

it('clears an earlier continuation explicitly and refuses reentrant admission while settlement is held', async () => {
  const { registry, options } = await fixture();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  await registry.load('first', api => { api.before('before:turn:end', () => ({ continuation: { type: 'review', content: 'again' } })); });
  await registry.load('second', api => {
    api.before('before:agent:settle', data => {
      expect(data.continuation?.content).toBe('again'); entered();
      return new Promise(() => undefined);
    });
  });
  const sdk = await createAgentSession(options); handles.push(sdk);
  await sdk.prompt('start'); await ready;
  await expect(sdk.prompt('reentrant')).rejects.toThrow('busy');
  await sdk.stop();
  expect((await sdk.wait())?.phase).toBe('stopped');
  expect((await sdk.history()).filter(entry => entry.type === 'custom_message')).toEqual([]);
  await registry.unload('second');
  await registry.load('clear', api => { api.before('before:agent:settle', () => ({ continuation: null })); });
  expect((await sdk.promptAndWait('next')).phase).toBe('completed');
});
