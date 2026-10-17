import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, MockProvider, SessionManager } from '@ai-harness/core';
import { CommandHandler, type CommandContext } from './handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const roots: string[] = [];
afterEach(async context => {
  vi.restoreAllMocks(); const completed = roots.splice(0);
  if (context.task.result?.state === 'fail') console.error('Retained CLI compaction roots:', completed);
  else await Promise.all(completed.map(root => rm(root, { recursive: true, force: true })));
});
type Mode = 'memory' | 'native' | 'structural';
async function fixture(mode: Mode, stage: 'provider' | 'prepare' | 'save' = 'provider') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-compaction-lifetime-')); roots.push(root);
  const disk = new JsonlSessionStore(path.join(root, 'source')), replacement = new JsonlSessionStore(path.join(root, 'replacement'));
  const entered = latch(), finish = latch(); let armed = false;
  const save = disk.saveSession.bind(disk), writes = vi.fn(async (...args: Parameters<typeof save>) => {
    if (armed && stage === 'save') { armed = false; entered.release(); await finish.promise; }
    await save(...args);
  }); disk.saveSession = writes;
  class BorrowedStore extends JsonlSessionStore {
    constructor() { super(undefined, false); }
    override setRedaction(...args: Parameters<JsonlSessionStore['setRedaction']>): void { disk.setRedaction(...args); }
    override listSessionIds() { return disk.listSessionIds(); }
    override loadSession(id: string) { return disk.loadSession(id); }
    override saveSession(...args: Parameters<JsonlSessionStore['saveSession']>) { return disk.saveSession(...args); }
    override async getRawEntries(id: string) {
      if (armed && stage === 'prepare') { armed = false; entered.release(); await finish.promise; }
      return disk.getRawEntries(id);
    }
    override deleteSession(id: string) { return disk.deleteSession(id); }
  }
  const store = mode === 'native' ? disk : new BorrowedStore(), manager = new SessionManager(mode === 'memory' ? {} : { store });
  const session = await manager.create({ autoCompaction: false, title: 'Original title' });
  for (let index = 0; index < 6; index++) await manager.addMessage(session.id, { role: index % 2 ? 'assistant' : 'user', content: `Seed ${index}`, blocks: [{ type: 'text', text: `Block ${index}` }] });
  await manager.appendCustomEntry(session.id, 'fixture:private', { revision: 1 });
  const sibling = await manager.create({ title: 'Sibling' }), siblingRaw = await manager.getRawEntries(sibling.id);
  const provider = new MockProvider({ type: 'mock', model: 'mock-model' }), controller = new AbortController();
  const chat = vi.spyOn(provider, 'chat').mockImplementation(async () => {
    if (stage === 'provider') { entered.release(); await finish.promise; }
    return { content: 'Owned CLI summary', model: 'summary-model' };
  });
  const output: string[] = [], errors: string[] = [];
  const terminal = { isCurrentlyStreaming: () => false, writeOutput: (text: string) => { output.push(text); },
    addTranscriptEntry: () => undefined, showError: (text: string) => { errors.push(text); } } as unknown as TerminalUI;
  const handler = new CommandHandler(manager, disk, terminal, undefined, undefined, { cwd: root, providers: new Map([['mock', provider]]) });
  const context = handler.getContext(); context.currentSessionId = session.id; context.signal = controller.signal;
  writes.mockClear();
  return { manager, session, sibling, siblingRaw, disk, replacement, store, handler, context, provider, controller, chat, output, errors, writes, entered, finish,
    arm: () => { armed = true; }, bytes: () => readFile(disk.getSessionFilePath(session.id)!) };
}

for (const mode of ['memory', 'native', 'structural'] as const) describe(`CLI manual compaction ownership (${mode})`, () => {
  const actions = (['abort', 'selection', 'manager', 'journal', 'replace', 'replace-restore', 'same-store', 'title', 'settings'] as const)
    .filter(action => mode !== 'memory' || action !== 'replace-restore' && action !== 'same-store');
  it.each(actions)(
    'retains the original source across %s during non-cooperative generation', async action => {
      const f = await fixture(mode), pending = f.handler.execute('/compact Preserve decisions');
      try {
        await f.entered.promise;
        expect(f.chat).toHaveBeenCalledTimes(1); expect(f.chat.mock.calls[0]![1]).toMatchObject({ signal: f.controller.signal, systemPrompt: 'Preserve decisions', sessionId: f.session.id });
        if (action === 'abort') { f.context.signal = new AbortController().signal; f.controller.abort('PRIVATE_ABORT_REASON'); }
        if (action === 'selection') f.context.currentSessionId = f.sibling.id;
        if (action === 'manager') f.context.sessionManager = new SessionManager();
        if (action === 'journal') await f.manager.appendCustomEntry(f.session.id, 'fixture:private', { revision: 2 });
        if (action === 'replace' || action === 'replace-restore') f.manager.setStore(f.replacement);
        if (action === 'replace-restore' || action === 'same-store') f.manager.setStore(f.store);
        if (action === 'title') await f.manager.update(f.session.id, { title: 'New metadata' });
        if (action === 'settings') f.manager.setCompactionSettings({ enabled: false });
        const raw = await f.manager.getRawEntries(f.session.id), snapshot = structuredClone(f.session), before = mode === 'memory' ? undefined : await f.bytes();
        f.writes.mockClear(); f.finish.release(); await pending;
        const positive = ['same-store', 'title', 'settings'].includes(action), text = f.output.join('\n');
        expect(text.includes('✅ Compacted')).toBe(positive); expect(f.errors).toEqual([]); expect(text).not.toContain('PRIVATE_ABORT_REASON');
        if (positive) {
          expect(f.session.metadata?.compactionSummary).toBe('Owned CLI summary'); expect(f.session.messages).toHaveLength(2);
          expect((await f.manager.getRawEntries(f.session.id)).filter(entry => entry.type === 'compaction')).toHaveLength(1);
          expect(text).toContain(action === 'title' ? 'New metadata' : 'Original title');
        } else {
          expect(text).toContain(action === 'abort' ? 'Compaction cancelled' : 'Compaction context or policy changed.');
          expect(f.session).toEqual(snapshot); expect(f.writes).not.toHaveBeenCalled();
          expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw); if (before) expect(await f.bytes()).toEqual(before);
        }
        expect(await f.manager.getRawEntries(f.sibling.id)).toEqual(f.siblingRaw); expect(await f.replacement.listSessionIds()).toEqual([]);
      } finally { f.finish.release(); await pending; }
    });

  it.each(['initial-getter', 'source-getter', 'sibling-getter', 'value'] as const)(
    'validates canonical identity passively across %s substitution', async action => {
      const f = await fixture(mode), sourceId = f.session.id, siblingId = f.sibling.id;
      const raw = await f.manager.getRawEntries(sourceId), snapshot = structuredClone(f.session);
      const before = mode === 'memory' ? undefined : await f.bytes();
      const siblingBytes = mode === 'memory' ? undefined : await readFile(f.disk.getSessionFilePath(siblingId)!);
      const identity = Object.getOwnPropertyDescriptor(f.session, 'id')!;
      const getter = vi.fn(() => action === 'sibling-getter' ? siblingId : sourceId);
      const substitute = () => {
        if (action === 'value') f.session.id = siblingId;
        else Object.defineProperty(f.session, 'id', { configurable: true, enumerable: true, get: getter });
      };
      if (action === 'initial-getter') { substitute(); f.finish.release(); }
      const pending = f.handler.execute('/compact');
      try {
        if (action !== 'initial-getter') { await f.entered.promise; substitute(); f.finish.release(); }
        await pending;
        expect(getter).not.toHaveBeenCalled();
        expect(f.chat).toHaveBeenCalledTimes(action === 'initial-getter' ? 0 : 1);
        expect(f.output.join('\n')).toContain('Compaction context or policy changed.');
        expect(f.output.join('\n')).not.toContain('✅ Compacted'); expect(f.errors).toEqual([]);
        Object.defineProperty(f.session, 'id', identity);
        expect(f.session).toEqual(snapshot); expect(f.writes).not.toHaveBeenCalled();
        expect(await f.manager.getRawEntries(sourceId)).toEqual(raw);
        expect(await f.manager.getRawEntries(siblingId)).toEqual(f.siblingRaw);
        if (before) expect(await f.bytes()).toEqual(before);
        if (siblingBytes) expect(await readFile(f.disk.getSessionFilePath(siblingId)!)).toEqual(siblingBytes);
      } finally { f.finish.release(); Object.defineProperty(f.session, 'id', identity); await pending; }
    });

  it.each(['pre-aborted', 'validation', 'redaction'] as const)('does not invoke a provider after %s cancellation', async phase => {
    const f = await fixture(mode), raw = await f.manager.getRawEntries(f.session.id), before = mode === 'memory' ? undefined : await f.bytes();
    const validate = vi.spyOn(f.provider, 'validateConfig').mockImplementation(() => { if (phase === 'validation') f.controller.abort(); return true; });
    if (phase === 'pre-aborted') f.controller.abort('PRIVATE_ABORT_REASON');
    if (phase === 'redaction') f.context.redactJson = value => { f.controller.abort(); return value; };
    await f.handler.execute('/compact');
    expect(f.chat).not.toHaveBeenCalled(); expect(validate).toHaveBeenCalledTimes(phase === 'pre-aborted' ? 0 : 1);
    expect(f.output.join('\n')).toContain('Compaction cancelled'); expect(f.errors).toEqual([]); expect(f.writes).not.toHaveBeenCalled();
    expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw); if (before) expect(await f.bytes()).toEqual(before);
  });

  it('copies nested provider input and retains redactor receivers/output authority before callbacks', async () => {
    const f = await fixture(mode), raw = await f.manager.getRawEntries(f.session.id);
    f.context.redactText = function(this: CommandContext, value: string) { expect(this).toBe(f.context); return value.replaceAll('PRIVATE_PROVIDER_VALUE', '[redacted]'); };
    f.chat.mockImplementation(async messages => {
      const block = messages[0]!.blocks![0]!; if (block.type === 'text') block.text = 'PROVIDER_MUTATION';
      f.context.redactText = value => value;
      return { content: 'PRIVATE_PROVIDER_VALUE', model: 'summary-model' };
    });
    await f.handler.execute('/compact');
    expect(f.session.metadata?.compactionSummary).toBe('[redacted]'); expect(f.output.join('\n')).not.toContain('PRIVATE_PROVIDER_VALUE');
    const after = await f.manager.getRawEntries(f.session.id);
    expect(after.filter(entry => entry.type === 'message')).toEqual(raw.filter(entry => entry.type === 'message'));
    expect(f.errors).toEqual([]);
  });

  it('reads authentic cancellation without evaluating a shadowed signal accessor', async () => {
    const f = await fixture(mode), getter = vi.fn(() => { throw new Error('PRIVATE_ACCESSOR'); });
    Object.defineProperty(f.controller.signal, 'aborted', { get: getter }); f.controller.abort('PRIVATE_REASON');
    await f.handler.execute('/compact');
    expect(getter).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.output.join('\n')).toContain('Compaction cancelled'); expect(f.errors).toEqual([]);
  });
});

for (const mode of ['native', 'structural'] as const) describe(`CLI compaction final admission (${mode})`, () => {
  it('finishes an already-admitted save after cancellation without false failure', async () => {
    const f = await fixture(mode, 'save'); f.arm(); const pending = f.handler.execute('/compact');
    try {
      await f.entered.promise; f.controller.abort(); f.finish.release(); await pending;
      expect(f.writes).toHaveBeenCalledTimes(1); expect(f.output.join('\n')).toContain('✅ Compacted'); expect(f.errors).toEqual([]);
      expect((await f.disk.loadSession(f.session.id))?.metadata?.compactionSummary).toBe('Owned CLI summary');
    } finally { f.finish.release(); await pending; }
  });
});

describe('CLI compaction structural preparation', () => {
  it.each(['abort', 'replace-restore'] as const)('withdraws %s before preparation gains save authority', async action => {
    const f = await fixture('structural', 'prepare'), raw = await f.manager.getRawEntries(f.session.id), before = await f.bytes();
    f.arm(); const pending = f.handler.execute('/compact');
    try {
      await f.entered.promise;
      if (action === 'abort') f.controller.abort(); else { f.manager.setStore(f.replacement); f.manager.setStore(f.store); }
      f.finish.release(); await pending;
      expect(f.output.join('\n')).toContain('Compaction failed:'); expect(f.output.join('\n')).not.toContain('✅ Compacted'); expect(f.errors).toEqual([]);
      expect(f.writes).not.toHaveBeenCalled(); expect(await f.disk.getRawEntries(f.session.id)).toEqual(raw); expect(await f.bytes()).toEqual(before);
      expect(await f.replacement.listSessionIds()).toEqual([]);
    } finally { f.finish.release(); await pending; }
  });
});
