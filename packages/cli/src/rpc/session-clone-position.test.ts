import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionRegistry, JsonlSessionStore, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController } from './rpc-controller.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(durable: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-clone-position-'));
  roots.push(root);
  const store = new JsonlSessionStore(root, durable);
  const manager = new SessionManager({ store });
  const session = await manager.create({ id: 'position-source', title: 'Selected position' });
  const provider = new MockProvider({ type: 'mock', model: 'mock-model' });
  const controller = new RpcController({ sessionManager: manager, sessionId: session.id,
    provider, providerName: 'mock', model: 'mock-model', extensionRegistry: new ExtensionRegistry(), tools: [],
    toolContext: { sessionManager: manager, currentSessionId: session.id, provider, providerName: 'mock',
      cwd: root, projectTrusted: false, notify: () => undefined },
  }, () => undefined);
  await controller.initialize();
  return { root, store, manager, session, controller };
}

for (const durable of [false, true]) describe(`RPC exact clone position (${durable ? 'durable' : 'memory'})`, () => {
  it.each(['custom', 'custom_message', 'branch_summary'] as const)('clones a selected %s leaf without requiring projected messages', async type => {
    const f = await fixture(durable);
    try {
      const selected = type === 'custom'
        ? await f.manager.appendCustomEntry(f.session.id, 'fixture:position', { revision: 1, private: 'PRIVATE_STATE' })
        : type === 'branch_summary'
          ? await f.manager.addBranchSummary(f.session.id, 'VISIBLE_SUMMARY', 'Summary position')
          : await f.manager.appendCustomMessage(f.session.id, 'fixture:position', 'VISIBLE_CONTENT', {
            display: false, details: { private: 'PRIVATE_DETAILS' },
          });
      expect(selected).not.toBeNull();
      expect(f.session.messages).toEqual([]);
      const source = await f.manager.getRawEntries(f.session.id);
      const file = path.join(f.root, `${f.session.id}.jsonl`);
      const bytes = durable ? await readFile(file) : undefined;
      const mtime = durable ? (await stat(file, { bigint: true })).mtimeNs : undefined;
      expect(await f.controller.handle({ type: 'get_entries' })).toMatchObject({ success: true,
        data: { leafId: selected!.id, entries: expect.arrayContaining([expect.objectContaining({ id: selected!.id, type })]) } });

      expect(await f.controller.handle({ type: 'clone', id: 'clone-position' }))
        .toEqual({ type: 'response', command: 'clone', id: 'clone-position', success: true, data: { cancelled: false } });
      const clones = f.manager.list().filter(session => session.id !== f.session.id);
      expect(clones).toHaveLength(1);
      const clone = clones[0];
      expect(clone.messages).toEqual([]);
      expect(clone.parentId).toBeUndefined();
      expect(clone.branchId).toBeUndefined();
      const entries = await f.manager.getActiveBranchEntries(clone.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ ...selected, id: clone.activeLeafId });
      expect(clone.activeLeafId).not.toBe(selected!.id);
      expect(await f.controller.handle({ type: 'get_entries' })).toMatchObject({ success: true,
        data: { leafId: clone.activeLeafId } });
      const model = JSON.stringify(f.manager.getEffectiveContext(clone.id));
      expect(model).not.toContain('PRIVATE_STATE');
      expect(model).not.toContain('PRIVATE_DETAILS');
      if (type === 'custom_message') expect(model).toContain('VISIBLE_CONTENT');
      if (type === 'branch_summary') expect(model).toContain('VISIBLE_SUMMARY');
      expect(await f.manager.getRawEntries(f.session.id)).toEqual(source);
      expect(f.session.activeLeafId).toBe(selected!.id);
      if (durable) {
        expect(await readFile(file)).toEqual(bytes);
        expect((await stat(file, { bigint: true })).mtimeNs).toBe(mtime);
        const restarted = new SessionManager({ store: new JsonlSessionStore(f.root) });
        expect(await restarted.loadFromStore(clone.id)).toMatchObject({ activeLeafId: clone.activeLeafId, messages: [] });
        expect(await restarted.getActiveBranchEntries(clone.id)).toEqual(entries);
      }
    } finally { await f.controller.close(); }
  });

  it('copies the selected private position, not an abandoned private descendant', async () => {
    const f = await fixture(durable);
    try {
      const selected = await f.manager.appendCustomEntry(f.session.id, 'fixture:position', { revision: 1 });
      const abandoned = await f.manager.appendCustomEntry(f.session.id, 'fixture:position', { revision: 2 });
      expect(await f.manager.navigateTree(f.session.id, selected!.id)).toMatchObject({ status: 'navigated' });
      expect(f.session.messages).toEqual([]);
      const before = await f.manager.getRawEntries(f.session.id);
      expect(before.some(entry => entry.id === abandoned!.id)).toBe(true);
      expect(await f.controller.handle({ type: 'clone' })).toMatchObject({ success: true, data: { cancelled: false } });
      const clone = f.manager.list().find(session => session.id !== f.session.id)!;
      const entries = await f.manager.getActiveBranchEntries(clone.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ type: 'custom', data: { revision: 1 }, id: clone.activeLeafId });
      expect(entries[0].id).not.toBe(selected!.id);
      expect(await f.manager.getRawEntries(f.session.id)).toEqual(before);
      expect(f.session.activeLeafId).toBe(selected!.id);
    } finally { await f.controller.close(); }
  });

  it('clones a completed command-only current position and retains its context exclusion', async () => {
    const f = await fixture(durable);
    try {
      const selected = await f.manager.addCommand(f.session.id, { command: 'echo COMMAND_ONLY', cwd: f.root,
        status: 'completed', output: 'COMMAND_OUTPUT', exitCode: 0, excludedFromContext: true });
      expect(selected).not.toBeNull(); expect(f.session.messages).toEqual([]);
      const before = await f.manager.getRawEntries(f.session.id);
      expect(f.session.activeLeafId).toBe(selected!.id);
      expect(await f.controller.handle({ type: 'clone' })).toMatchObject({ success: true, data: { cancelled: false } });
      const clone = f.manager.list().find(session => session.id !== f.session.id)!;
      const entries = await f.manager.getActiveBranchEntries(clone.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ type: 'command', command: 'echo COMMAND_ONLY', output: 'COMMAND_OUTPUT',
        excludedFromContext: true, timestamp: selected!.timestamp.getTime(), id: clone.activeLeafId });
      expect(clone.activeLeafId).not.toBe(selected!.id);
      expect(JSON.stringify(f.manager.getEffectiveContext(clone.id))).not.toContain('COMMAND_OUTPUT');
      expect(await f.manager.getRawEntries(f.session.id)).toEqual(before);
      expect(f.session.activeLeafId).toBe(selected!.id);
      if (durable) {
        const restarted = new SessionManager({ store: new JsonlSessionStore(f.root) });
        expect(await restarted.loadFromStore(clone.id)).toMatchObject({ activeLeafId: clone.activeLeafId, messages: [] });
        expect(await restarted.getActiveBranchEntries(clone.id)).toEqual(entries);
      }
    } finally { await f.controller.close(); }
  });

  it('still refuses a genuinely empty source without publishing a destination', async () => {
    const f = await fixture(durable);
    try {
      const before = await f.manager.getRawEntries(f.session.id);
      expect(f.session.activeLeafId).toBeUndefined();
      expect(await f.controller.handle({ type: 'clone', id: 'empty' })).toEqual({ id: 'empty', type: 'response',
        command: 'clone', success: false, error: 'Cannot clone session: no current entry selected' });
      expect(f.manager.list().map(session => session.id)).toEqual([f.session.id]);
      expect(await f.manager.getRawEntries(f.session.id)).toEqual(before);
      expect(await f.store.listSessionIds()).toEqual(durable ? [f.session.id] : []);
    } finally { await f.controller.close(); }
  });
});
