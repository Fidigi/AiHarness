import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialRedactor } from '../providers/credentials.js';
import { MockProvider } from '../providers/index.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { AgentRuntime } from './runtime.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reply-checkpoints-')); roots.push(root);
  const secret = 'disposable-reply-secret';
  const redactor = new CredentialRedactor([secret]);
  const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText: text => redactor.redact(text), redactJson: value => redactor.redactJson(value) });
  const session = await manager.create({ cwd: root });
  const provider = new MockProvider({ type: 'mock' });
  const registry = new ExtensionRegistry(); registry.attachSessionManager(manager);
  const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry, resolveProvider: () => provider,
    isProjectTrusted: () => true, redactText: text => redactor.redact(text), redactJson: value => redactor.redactJson(value), createTextRedactor: () => redactor.createStream() });
  const start = () => runtime.start({ sessionId: session.id, cwd: root, provider: 'mock', input: 'prompt', maxRetries: 0 });
  const reload = async () => { const fresh = new SessionManager({ store: new JsonlSessionStore(root) }); await fresh.loadFromStore(session.id); return fresh.get(session.id)!; };
  return { root, secret, manager, session, provider, registry, runtime, start, reload };
}

describe('authoritative reply checkpoints and terminal evidence', () => {
  it('projects trusted compaction lifecycle into cold run phase/watermark and restores the prompt phase', async () => {
    const test = await setup();
    let entered!: () => void; let finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(test.provider, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      entered(); await held; complete?.({ content: 'answer' });
    });
    const started = await test.start(); await ready;
    const start = test.runtime.publishSessionEvent(test.session.id, 'compaction.started', { automatic: true });
    expect(test.runtime.getRun(started.id)).toMatchObject({ phase: 'compacting', lastSequence: start.sequence });
    const end = test.runtime.publishSessionEvent(test.session.id, 'compaction.completed', { automatic: true });
    expect(test.runtime.getRun(started.id)).toMatchObject({ phase: 'prompting', lastSequence: end.sequence });
    finish(); await test.runtime.wait(started.id);
    const terminal = test.runtime.getRun(started.id)!;
    expect(test.runtime.publishSessionEvent(test.session.id, 'compaction.started', { automatic: true }).runId).toBeUndefined();
    expect(test.runtime.getRun(started.id)).toEqual(terminal);
  });

  it('retains the latest authoritative watermark when a trusted observer publishes reentrantly', async () => {
    const test = await setup();
    let entered!: () => void; let finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(test.provider, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      entered(); await held; complete?.({ content: 'answer' });
    });
    const started = await test.start(); await ready;
    const unsubscribe = test.runtime.journal.subscribe(test.session.id, event => {
      if (event.type === 'compaction.started') test.runtime.publishSessionEvent(test.session.id, 'notice', { message: 'Observer notice' });
    });
    const event = test.runtime.publishSessionEvent(test.session.id, 'compaction.started', { automatic: true });
    expect(test.runtime.getRun(started.id)!.lastSequence).toBe(event.sequence + 1);
    expect(test.runtime.getRun(started.id)!.lastSequence).toBe(test.runtime.journal.lastSequence(test.session.id));
    unsubscribe(); finish(); await test.runtime.wait(started.id);
  });

  it('does not revive a cancelling run from a late compaction failure or call cancellation successful output', async () => {
    const test = await setup();
    let entered!: () => void; let finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(test.provider, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
      entered(); await held; complete?.({ content: 'late' });
    });
    const started = await test.start(); await ready;
    test.runtime.publishSessionEvent(test.session.id, 'compaction.started', { automatic: true });
    test.runtime.stop(started.id);
    test.runtime.publishSessionEvent(test.session.id, 'compaction.failed', { automatic: true, cancelled: true });
    expect(test.runtime.getRun(started.id)!.phase).toBe('compacting');
    finish(); expect((await test.runtime.wait(started.id))!.phase).toBe('stopped');
    expect((await test.reload()).messages.map(message => message.role)).toEqual(['user']);
    expect(test.runtime.journal.replay(test.session.id).events.some(event => event.type === 'message.completed')).toBe(false);
  });

  it('identifies complete text/reasoning checkpoints for both intermediate and final provider turns without changing usage', async () => {
    const test = await setup();
    await test.registry.load('checkpoint-tool', api => api.registerTool({ name: 'probe', description: 'probe', execute: () => ({ content: 'result' }) }));
    vi.spyOn(test.provider, 'streamChat').mockImplementation(async (messages, chunk, complete) => {
      const final = messages.some(message => message.role === 'tool');
      await chunk(final ? 'answer' : 'prelude');
      await chunk('', { type: 'reasoning_delta', data: { content: final ? 'final thought' : 'tool thought' } });
      complete?.({ content: final ? 'answer' : 'prelude', reasoning: final ? 'final thought' : 'tool thought',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, costUsd: 0.001 },
        ...(final ? {} : { toolCalls: [{ id: 'outer', name: 'probe', input: {} }] }) });
    });
    await test.runtime.wait((await test.start()).id);
    const events = test.runtime.journal.replay(test.session.id).events;
    const starts = events.filter(event => event.type === 'message.start').map(event => (event.data as { messageId: string }).messageId);
    const checkpoints = events.filter(event => event.type === 'message.completed');
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.map(event => (event.data as { messageId: string }).messageId)).toEqual(starts);
    expect(starts[0]).not.toBe(starts[1]);
    expect(checkpoints.map(event => event.data)).toEqual([
      expect.objectContaining({ content: 'prelude', reasoning: 'tool thought' }),
      expect.objectContaining({ content: 'answer', reasoning: 'final thought' }),
    ]);
    const durable = await test.reload();
    expect(durable.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(durable.usage).toMatchObject({ totalTokens: 10, costUsd: 0.002 });
  });
  for (const content of ['', 'partial answer']) it(`persists explicit length evidence even for content=${JSON.stringify(content)}, across JSONL reload`, async () => {
    const test = await setup();
    vi.spyOn(test.provider, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => complete?.({ content, stopReason: 'length' }));
    const run = await test.runtime.wait((await test.start()).id);
    expect(run!.phase).toBe('completed');
    const durable = await test.reload();
    expect(durable.messages).toHaveLength(2);
    expect(durable.messages[1]).toMatchObject({ content, metadata: { stopReason: 'length' } });
    expect(durable.messages[1]!.usage).toBeUndefined();
  });
  it('persists failed partial text/reasoning and a bounded scrubbed adjacent error without successful completion or invented usage', async () => {
    const test = await setup();
    let calls = 0;
    vi.spyOn(test.provider, 'streamChat').mockImplementation(async (_messages, chunk, _complete, error) => {
      calls++;
      await chunk(`visible ${test.secret} ${'safe tail '.repeat(20)}`);
      await chunk('', { type: 'reasoning_delta', data: { content: 'visible reasoning' } });
      error?.(new Error(`provider error ${test.secret} ${'x'.repeat(5_000)}`));
    });
    const run = await test.runtime.wait((await test.start()).id);
    expect(run!.phase).toBe('failed'); expect(calls).toBe(1);
    const durable = await test.reload();
    expect(durable.messages).toHaveLength(2);
    expect(durable.messages[1]!.content).toContain('visible [REDACTED]');
    expect(durable.messages[1]!.blocks?.[0]).toEqual({ type: 'reasoning', text: expect.stringContaining('visible') });
    expect(String(durable.messages[1]!.metadata!.outputError)).toHaveLength(4_000);
    expect(durable.messages[1]!.usage).toBeUndefined();
    expect(JSON.stringify(durable)).not.toContain(test.secret);
    expect(await readFile(path.join(test.root, `${test.session.id}.jsonl`), 'utf8')).not.toContain(test.secret);
    expect(test.runtime.journal.replay(test.session.id).events.some(event => event.type === 'message.completed')).toBe(false);
  });
  it('persists failure evidence without starting automatic compaction or replacing retained context', async () => {
    const test = await setup();
    await test.manager.addMessage(test.session.id, { role: 'user', content: 'earlier prompt' });
    await test.manager.addMessage(test.session.id, { role: 'assistant', content: 'earlier answer' });
    const summarize = vi.fn(async () => 'unexpected failure-time summary');
    test.manager.setAutoCompactionCallback(summarize);
    test.manager.setCompactionSettings({ enabled: true, reserveTokens: 99_999, keepRecentTokens: 1 });
    vi.spyOn(test.provider, 'streamChat').mockImplementation(async (_messages, chunk, _complete, error) => {
      await chunk('visible failed answer '.repeat(20));
      error?.(new Error('upstream failed'));
    });
    const run = await test.runtime.wait((await test.start()).id);
    expect(run!.phase).toBe('failed');
    expect(summarize).not.toHaveBeenCalled();
    const durable = await test.reload();
    expect(durable.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(durable.messages[3]!.metadata).toEqual({ outputError: 'upstream failed' });
    expect((await test.manager.getRawEntries(test.session.id)).some(entry => entry.type === 'compaction')).toBe(false);
    expect(test.runtime.journal.replay(test.session.id).events.some(event => event.type === 'message.completed')).toBe(false);
  });
  it('does not manufacture failed replies when nothing visible was delivered', async () => {
    const test = await setup();
    vi.spyOn(test.provider, 'streamChat').mockImplementation(async (_messages, _chunk, _complete, error) => error?.(new Error('no output')));
    await test.runtime.wait((await test.start()).id);
    expect((await test.reload()).messages.map(message => message.role)).toEqual(['user']);
  });
});
