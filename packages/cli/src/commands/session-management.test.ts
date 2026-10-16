import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSessionStore, MockProvider, SessionManager } from '@ai-harness/core';
import { CommandHandler } from './handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';

async function fixture(durable: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-session-commands-'));
  const store = new JsonlSessionStore(path.join(directory, 'sessions'), durable);
  const manager = new SessionManager();
  if (durable) manager.setStore(store);
  const session = await manager.create({ title: 'Initial session', cwd: directory });
  const output: string[] = [];
  const errors: string[] = [];
  const provider = new MockProvider({ type: 'mock', model: 'mock-model' });
  const terminal = { isCurrentlyStreaming: () => false,
    writeOutput: (value: string) => { output.push(value); },
    showError: (value: string) => { errors.push(value); },
    addTranscriptEntry: () => undefined } as unknown as TerminalUI;
  const makeHandler = (target = manager) => new CommandHandler(target, store, terminal, undefined, undefined,
    { cwd: directory, providers: new Map([['mock', provider]]) });
  const handler = makeHandler();
  handler.getContext().currentSessionId = session.id;
  return { directory, manager, session, handler, store, output, errors, makeHandler,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe.each([false, true])('session commands (durable=%s)', durable => {
  it('reports full identity/file, active and historical counts/usage/cost, and separate context estimate', async () => {
    const f = await fixture(durable);
    try {
      await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'Reply',
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0.25 } });
      await f.manager.addBranchSummary(f.session.id, 'Manual summary');
      await f.handler.execute('/session');
      const text = f.output.join('\n');
      expect(text).toContain(f.session.id);
      expect(text).toContain(durable ? f.store.getSessionFilePath(f.session.id)! : 'memory (not saved)');
      expect(text).toContain('Active path:');
      expect(text).toContain('Full history (all branches):');
      expect(text).toContain('tokens 12');
      expect(text).toContain('$0.250000 known subtotal; total unknown');
      expect(text).toContain('Context (est.):');
      expect(text).toContain('effective model context, not accounting totals');
      expect(f.errors).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it('names, searches by title/content and resumes by exact ID without changing its messages', async () => {
    const f = await fixture(durable);
    try {
      await f.manager.addMessage(f.session.id, { role: 'user', content: 'ContentNeedle' });
      await f.handler.execute('/name RenamedNeedle');
      expect(f.manager.get(f.session.id)?.title).toBe('RenamedNeedle');
      for (const query of ['RenamedNeedle', 'ContentNeedle']) {
        f.output.length = 0;
        await f.handler.execute(`/list ${query}`);
        expect(f.output.join('\n')).toContain('RenamedNeedle');
      }
      const manager = durable ? new SessionManager({ store: f.store }) : f.manager;
      const handler = f.makeHandler(manager);
      await handler.execute(`/switch ${f.session.id}`);
      expect(handler.getContext().currentSessionId).toBe(f.session.id);
      expect(manager.get(f.session.id)).toMatchObject({ title: 'RenamedNeedle',
        messages: [{ role: 'user', content: 'ContentNeedle' }] });
      expect(f.errors).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it('does not turn a malformed numeric selector into an unrelated session', async () => {
    const f = await fixture(durable);
    try {
      await f.handler.execute('/new Other');
      const active = f.handler.getContext().currentSessionId;
      await f.handler.execute('/switch 1not-an-index');
      expect(f.handler.getContext().currentSessionId).toBe(active);
      expect(f.output.join('\n')).toContain('Session not found: 1not-an-index');
    } finally { await f.cleanup(); }
  });

  it('refuses active deletion and deletes only an explicitly selected inactive session', async () => {
    const f = await fixture(durable);
    try {
      await f.handler.execute(`/delete ${f.session.id}`);
      expect(f.manager.get(f.session.id)).toBeDefined();
      expect(f.output.join('\n')).toContain('Cannot delete the active session.');
      await f.handler.execute('/new Replacement');
      const active = f.handler.getContext().currentSessionId;
      await f.handler.execute(`/delete ${f.session.id}`);
      expect(f.manager.get(f.session.id)).toBeUndefined();
      expect(f.handler.getContext().currentSessionId).toBe(active);
      expect(active && f.manager.get(active)).toBeDefined();
      if (durable) await expect(readFile(f.store.getSessionFilePath(f.session.id)!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.errors).toEqual([]);
    } finally { await f.cleanup(); }
  });

  for (const operation of ['fork', 'clone'] as const) {
    it(`reports a ${operation} veto without claiming a destination or changing selection`, async () => {
      const f = await fixture(durable);
      try {
        await f.manager.addMessage(f.session.id, { role: 'user', content: 'Selected user' });
        await f.manager.appendCustomEntry(f.session.id, 'fixture:branch-command', { revision: 1 });
        const raw = await f.manager.getRawEntries(f.session.id), leaf = f.session.activeLeafId;
        const before = durable ? await readFile(f.store.getSessionFilePath(f.session.id)!) : undefined;
        f.manager.onBeforeBranch(event => { expect(event.operation).toBe(operation); return false; });
        await f.handler.execute(`/${operation} ${f.session.id}`);
        expect(f.output.join('\n')).toContain('Session branch cancelled.'); expect(f.errors).toEqual([]);
        expect(f.output.join('\n')).not.toContain('✅'); expect(f.manager.list()).toHaveLength(1);
        expect(f.handler.getContext().currentSessionId).toBe(f.session.id); expect(f.session.activeLeafId).toBe(leaf);
        expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw);
        if (durable) expect(await readFile(f.store.getSessionFilePath(f.session.id)!)).toEqual(before);
      } finally { await f.cleanup(); }
    });

    it(`passes the admitted ${operation} signal even if the mutable command context is replaced`, async () => {
      const f = await fixture(durable), controller = new AbortController();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      try {
        await f.manager.addMessage(f.session.id, { role: 'user', content: 'Selected user' });
        const raw = await f.manager.getRawEntries(f.session.id);
        f.handler.getContext().signal = controller.signal;
        f.manager.onBeforeBranch(async () => { entered(); await gate; });
        const pending = f.handler.execute(`/${operation} ${f.session.id}`); await started;
        f.handler.getContext().signal = new AbortController().signal; controller.abort(); await pending;
        expect(f.output.join('\n')).toContain('Session branch cancelled.'); expect(f.errors).toEqual([]);
        release(); await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.manager.list()).toHaveLength(1); expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw);
        expect(f.handler.getContext().currentSessionId).toBe(f.session.id);
      } finally { release(); await f.cleanup(); }
    });
  }
});

it('refuses linked deletion without removing memory state, following the link or touching another file', async () => {
  const f = await fixture(true);
  try {
    const source = f.store.getSessionFilePath(f.session.id)!;
    const outside = path.join(f.directory, 'external.txt');
    await writeFile(outside, 'EXTERNAL FILE MUST SURVIVE');
    await f.handler.execute('/new Replacement');
    await unlink(source);
    await symlink(outside, source);
    await f.handler.execute(`/delete ${f.session.id}`);
    expect(f.errors).toEqual(['Command failed.']);
    expect(f.manager.get(f.session.id)).toBeDefined();
    expect(await readFile(outside, 'utf8')).toBe('EXTERNAL FILE MUST SURVIVE');
  } finally { await f.cleanup(); }
});
