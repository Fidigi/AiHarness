import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { ExtensionRegistry, type ExtensionRuntimeContext, type SessionManager } from '@ai-harness/core';
import { ExtensionLoader } from '../extensions/extension-loader.js';
import { runRpcMode } from './rpc-server.js';

for (const operation of ['fork', 'clone'] as const) it.each([true, false])(
  `keeps or retires branch-created RPC UI only according to ${operation} publication (veto=%s)`, async veto => {
    const registry = new ExtensionRegistry(), input = new PassThrough(), records: Record<string, unknown>[] = [];
    let requestInteraction!: NonNullable<ExtensionRuntimeContext['requestInteraction']>;
    let manager!: SessionManager, sourceId = '', target = '', interaction: unknown;
    await registry.load('branch-ui', api => {
      api.registerCommand('branch-ui-seed', { description: 'Seed branch UI fixture', handler: async (_args, context) => {
        manager = context.sessionManager; sourceId = context.currentSessionId!;
        await manager.addMessage(sourceId, { role: 'user', content: 'Root user' });
        await manager.addMessage(sourceId, { role: 'user', content: 'Selected user' });
        target = manager.get(sourceId)!.activeLeafId!;
        await manager.appendCustomEntry(sourceId, 'fixture:branch-ui', { revision: 1 });
        requestInteraction = context.requestInteraction!;
      } });
      api.before('before:session:branch', () => {
        void Promise.resolve(requestInteraction({ kind: 'confirm', title: 'Owned branch dialog' })).then(value => { interaction = value; });
        if (veto) return { cancel: true };
        return undefined;
      });
    });
    const running = runRpcMode({ noSession: true, provider: 'mock', model: 'mock-model', offline: true,
      projectTrust: true, input, output: record => { records.push(record); },
      extensionRegistry: registry, extensionLoader: new ExtensionLoader(registry),
    });
    const command = async (type: string, id: string, fields: Record<string, unknown> = {}) => {
      input.write(JSON.stringify({ type, id, ...fields }) + '\n');
      await vi.waitFor(() => expect(records.some(record => record.type === 'response' && record.id === id)).toBe(true), { timeout: 5_000, interval: 10 });
      return records.find(record => record.type === 'response' && record.id === id)!;
    };
    try {
      expect(await command('prompt', 'seed', { message: '/branch-ui-seed' })).toMatchObject({ success: true });
      const raw = await manager.getRawEntries(sourceId), leaf = manager.get(sourceId)!.activeLeafId;
      expect(await command(operation, 'branch', operation === 'fork' ? { entryId: target } : {}))
        .toMatchObject({ success: true, data: { cancelled: veto } });
      const opened = records.find(record => record.type === 'extension_ui_request' && record.title === 'Owned branch dialog')!;
      expect(opened).toMatchObject({ method: 'confirm', id: expect.any(String) });
      if (veto) {
        expect(await command('get_extension_ui', 'pending')).toMatchObject({ success: true, data: { requests: [{ id: opened.id }] } });
        expect(records.some(record => record.type === 'extension_ui_closed' && record.id === opened.id)).toBe(false);
        expect(interaction).toBeUndefined(); expect(manager.list()).toHaveLength(1);
        expect(manager.get(sourceId)!.activeLeafId).toBe(leaf); expect(await manager.getRawEntries(sourceId)).toEqual(raw);
        input.write(JSON.stringify({ type: 'extension_ui_response', id: opened.id, confirmed: true }) + '\n');
        await vi.waitFor(() => expect(interaction).toEqual({ cancelled: false, value: true }), { timeout: 5_000, interval: 10 });
      } else {
        expect(await command('get_extension_ui', 'retired')).toMatchObject({ success: true, data: { requests: [] } });
        expect(records).toContainEqual({ type: 'extension_ui_closed', id: opened.id, reason: 'session-changed' });
        expect(interaction).toEqual({ cancelled: true }); expect(manager.list()).toHaveLength(operation === 'clone' ? 2 : 1);
      }
    } finally { input.end(); await running; }
  }, 15_000);

for (const mode of ['publish', 'cancel', 'stale'] as const) it(`retires summary-created RPC UI only on navigation publication (${mode})`, async () => {
  const registry = new ExtensionRegistry(), input = new PassThrough(), records: Record<string, unknown>[] = [];
  let requestInteraction!: NonNullable<ExtensionRuntimeContext['requestInteraction']>;
  let manager!: SessionManager, sourceId = '', target = '', interaction: unknown;
  await registry.load('summary-ui', api => {
    api.registerCommand('summary-ui-seed', { description: 'Seed summary UI fixture', handler: async (_args, context) => {
      manager = context.sessionManager; sourceId = context.currentSessionId!;
      await manager.addMessage(sourceId, { role: 'user', content: 'Shared user' }); target = manager.get(sourceId)!.activeLeafId!;
      await manager.addMessage(sourceId, { role: 'assistant', content: 'Abandoned answer' }); requestInteraction = context.requestInteraction!;
    } });
    api.before('before:session:summary', async () => {
      void Promise.resolve(requestInteraction({ kind: 'confirm', title: 'Owned summary dialog' })).then(value => { interaction = value; });
      if (mode === 'stale') await manager.addMessage(sourceId, { role: 'user', content: 'Concurrent advance' });
      return mode === 'cancel' ? { cancel: true as const } : { summary: 'Published summary override' };
    });
  });
  const running = runRpcMode({ noSession: true, provider: 'mock', model: 'mock-model', offline: true, projectTrust: true,
    input, output: record => { records.push(record); }, extensionRegistry: registry, extensionLoader: new ExtensionLoader(registry) });
  const command = async (type: string, id: string, fields: Record<string, unknown> = {}) => {
    input.write(JSON.stringify({ type, id, ...fields }) + '\n');
    await vi.waitFor(() => expect(records.some(record => record.type === 'response' && record.id === id)).toBe(true), { timeout: 5_000, interval: 10 });
    return records.find(record => record.type === 'response' && record.id === id)!;
  };
  try {
    expect(await command('prompt', 'seed', { message: '/summary-ui-seed' })).toMatchObject({ success: true });
    expect(await command('navigate_tree', 'navigate', { entryId: target, summarize: true }))
      .toMatchObject({ success: true, data: { cancelled: mode === 'cancel', stale: mode === 'stale' } });
    const opened = records.find(record => record.type === 'extension_ui_request' && record.title === 'Owned summary dialog')!;
    expect(opened).toMatchObject({ method: 'confirm', id: expect.any(String) });
    if (mode === 'publish') {
      expect((await manager.getBranchSummaries(sourceId)).at(-1)?.summary).toBe('Published summary override');
      expect(await command('get_extension_ui', 'retired')).toMatchObject({ success: true, data: { requests: [] } });
      expect(records).toContainEqual({ type: 'extension_ui_closed', id: opened.id, reason: 'session-changed' }); expect(interaction).toEqual({ cancelled: true });
    } else {
      expect(await manager.getBranchSummaries(sourceId)).toEqual([]);
      expect(await command('get_extension_ui', 'pending')).toMatchObject({ success: true, data: { requests: [{ id: opened.id }] } });
      expect(interaction).toBeUndefined(); expect(records.some(record => record.type === 'extension_ui_closed' && record.id === opened.id)).toBe(false);
      input.write(JSON.stringify({ type: 'extension_ui_response', id: opened.id, confirmed: true }) + '\n');
      await vi.waitFor(() => expect(interaction).toEqual({ cancelled: false, value: true }), { timeout: 5_000, interval: 10 });
    }
  } finally { input.end(); await running; }
}, 15_000);
