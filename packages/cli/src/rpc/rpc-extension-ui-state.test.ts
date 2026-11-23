import { describe, expect, it, vi } from 'vitest';
import { CredentialRedactor } from '@ai-harness/core';
import { RpcExtensionUiBridge } from './rpc-extension-ui.js';

function fixture() {
  const records: Record<string, unknown>[] = [];
  const bridge = new RpcExtensionUiBridge(record => { records.push(record); });
  return { records, bridge };
}

describe('RPC extension UI replay and lifecycle', () => {
  it('replays ordered IDs without emitting, settling, or replaying notifications', async () => {
    const { records, bridge } = fixture();
    const first = bridge.request({ kind: 'input', title: 'First' });
    const second = bridge.request({ kind: 'editor', title: 'Second', output: 'draft' });
    bridge.notify('once');
    const snapshot = bridge.snapshot();
    expect(snapshot).toMatchObject({ version: 1, mode: 'rpc', closed: false,
      capabilities: { dialogs: ['select', 'confirm', 'input', 'editor'], custom: false, terminal: false },
      requests: [{ id: first.id, title: 'First' }, { id: second.id, prefill: 'draft' }], presentation: [],
    });
    (snapshot.requests as Record<string, unknown>[])[0]!.title = 'foreign mutation';
    expect(bridge.snapshot()).not.toEqual(snapshot);
    expect(records).toHaveLength(3);
    bridge.handleResponse({ type: 'extension_ui_response', id: second.id, value: 'done' });
    await expect(second).resolves.toEqual({ cancelled: false, value: 'done' });
    expect(bridge.snapshot().requests).toHaveLength(1);
    bridge.close();
    await expect(first).resolves.toEqual({ cancelled: true });
  });

  it('updates a capability in place and validates against the current schema', async () => {
    const { records, bridge } = fixture();
    const original = { kind: 'select' as const, title: 'Old', options: [{ label: 'Old', value: 'old' }] };
    const first = bridge.request(original);
    const next = bridge.request({ kind: 'input', title: 'Next' });
    original.options[0]!.value = 'caller mutation';
    expect(first.update?.({ kind: 'select', title: 'New', options: [{ label: 'New', value: 'new' }] })).toBe(true);
    expect((bridge.snapshot().requests as Record<string, unknown>[]).map(record => record.id)).toEqual([first.id, next.id]);
    bridge.handleResponse({ type: 'extension_ui_response', id: first.id, value: 'Old' });
    expect(bridge.snapshot().requests).toHaveLength(2);
    bridge.handleResponse({ type: 'extension_ui_response', id: first.id, value: 'New' });
    await expect(first).resolves.toEqual({ cancelled: false, value: 'new' });
    expect(first.close?.()).toBe(false);
    expect(first.update?.({ kind: 'input', title: 'Too late' })).toBe(false);
    expect(records[2]).toMatchObject({ id: first.id, title: 'New' });
    next.close?.();
    await expect(next).resolves.toEqual({ cancelled: true });
  });

  it('retains the real AbortSignal through JSON redaction and removes its listener', async () => {
    const records: Record<string, unknown>[] = [];
    const redactor = new CredentialRedactor();
    redactor.add('private-token');
    const bridge = new RpcExtensionUiBridge(record => { records.push(record); }, text => redactor.redact(text), value => redactor.redactJson(value));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = bridge.request({ kind: 'input', title: 'private-token', signal: controller.signal });
    expect(JSON.stringify(bridge.snapshot())).not.toContain('private-token');
    expect(JSON.stringify(records)).not.toContain('signal');
    controller.abort('private-token');
    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(records[1]).toEqual({ type: 'extension_ui_closed', id: pending.id, reason: 'aborted' });
  });

  it('preserves the original timeout across updates and emits one closure', async () => {
    vi.useFakeTimers();
    try {
      const { records, bridge } = fixture();
      const pending = bridge.request({ kind: 'input', title: 'Original', timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(90);
      pending.update?.({ kind: 'confirm', title: 'Replacement' });
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toEqual({ cancelled: false, value: false });
      expect(records.filter(record => record.type === 'extension_ui_closed')).toEqual([
        { type: 'extension_ui_closed', id: pending.id, reason: 'timeout' },
      ]);
      expect(pending.close?.()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not settle malformed, foreign, or stale UI replies', async () => {
    const { bridge } = fixture();
    const pending = bridge.request({ kind: 'confirm', title: 'Confirm' });
    for (const response of [
      { id: pending.id, confirmed: 'yes' }, { id: pending.id }, { id: pending.id, confirmed: true, value: 'extra' },
      { id: pending.id, cancelled: 'yes' }, { id: pending.id, confirmed: true, unknown: true }, { id: 'foreign', confirmed: true },
    ]) expect(bridge.handleResponse({ type: 'extension_ui_response', ...response })).toBe(true);
    expect(bridge.snapshot().requests).toHaveLength(1);
    bridge.handleResponse({ type: 'extension_ui_response', id: pending.id, confirmed: false });
    await expect(pending).resolves.toEqual({ cancelled: false, value: false });
    expect(bridge.handleResponse({ type: 'extension_ui_response', id: pending.id, confirmed: true })).toBe(true);
    expect(bridge.handleResponse({ type: 'prompt', id: pending.id })).toBe(false);
  });

  it('ignores overlarge reply values without terminating RPC or settling input', async () => {
    const { bridge } = fixture();
    const pending = bridge.request({ kind: 'input', title: 'Input' });
    expect(bridge.handleResponse({ type: 'extension_ui_response', id: pending.id, value: 'x'.repeat(128_001) })).toBe(true);
    expect(bridge.snapshot().requests).toHaveLength(1);
    pending.close?.();
    await expect(pending).resolves.toEqual({ cancelled: true });
  });

  it('replays last plain-text presentation intents and clears individual keys', () => {
    const { records, bridge } = fixture();
    bridge.ui.setStatus('build', 'running');
    bridge.ui.setStatus('build', 'done');
    const lines = ['<script>not markup</script>'];
    bridge.ui.setWidget('summary', lines);
    lines[0] = 'caller mutation';
    bridge.ui.setTitle('title');
    bridge.ui.setEditorText('!never executed');
    expect(bridge.snapshot().presentation).toEqual([
      expect.objectContaining({ method: 'setStatus', key: 'build', value: 'done' }),
      expect.objectContaining({ method: 'setWidget', key: 'summary', value: ['<script>not markup</script>'] }),
      expect.objectContaining({ method: 'setTitle', value: 'title' }),
      expect.objectContaining({ method: 'setEditorText', value: '!never executed' }),
    ]);
    bridge.ui.setStatus('build');
    expect(bridge.snapshot().presentation).toHaveLength(3);
    expect(records.at(-1)).toMatchObject({ method: 'setStatus', key: 'build', cleared: true });
    expect(Object.isFrozen(bridge.ui)).toBe(true);
    expect(Object.isFrozen(bridge.ui.capabilities.dialogs)).toBe(true);
  });

  it('keeps state detached from a mutating output sink', async () => {
    const bridge = new RpcExtensionUiBridge(record => { record.title = 'sink'; record.value = 'sink'; });
    const pending = bridge.request({ kind: 'input', title: 'owned' });
    bridge.ui.setTitle('owned');
    expect(bridge.snapshot()).toMatchObject({ requests: [{ title: 'owned' }], presentation: [{ value: 'owned' }] });
    bridge.close();
    await pending;
  });

  it('bounds pending count and allows capacity recovery', async () => {
    const { bridge } = fixture();
    const pending = Array.from({ length: 16 }, () => bridge.request({ kind: 'input', title: 'Bounded' }));
    expect(() => bridge.request({ kind: 'input', title: 'Overflow' })).toThrow('queue is full');
    pending[0]!.close?.();
    const replacement = bridge.request({ kind: 'input', title: 'Replacement' });
    bridge.close();
    await Promise.all([...pending, replacement]);
  });

  it('bounds aggregate bytes and refuses an oversized update without altering state', async () => {
    const { bridge } = fixture();
    const pending = Array.from({ length: 4 }, () => bridge.request({ kind: 'input', title: 'x'.repeat(60_000) }));
    const before = bridge.snapshot();
    expect(() => pending[0]!.update?.({ kind: 'editor', title: 'x'.repeat(100_000) })).toThrow('state is full');
    expect(bridge.snapshot()).toEqual(before);
    expect(() => bridge.request({ kind: 'input', title: 'x'.repeat(128_001) })).toThrow('Invalid RPC UI text');
    bridge.close();
    await Promise.all(pending);
  });

  it('bounds presentation keys without discarding the last valid state', () => {
    const { bridge } = fixture();
    for (let i = 0; i < 100; i++) bridge.ui.setStatus(String(i), 'ok');
    expect(() => bridge.ui.setStatus('overflow', 'no')).toThrow('presentation is full');
    expect(bridge.snapshot().presentation).toHaveLength(100);
    bridge.ui.setStatus('0');
    bridge.ui.setStatus('replacement', 'yes');
    expect(bridge.snapshot().presentation).toHaveLength(100);
  });

  it('cancels on close, rejects later admission, and makes late controls inert', async () => {
    const { records, bridge } = fixture();
    const first = bridge.request({ kind: 'input', title: 'First' });
    const second = bridge.request({ kind: 'editor', title: 'Second' });
    bridge.close();
    bridge.close();
    await expect(first).resolves.toEqual({ cancelled: true });
    await expect(second).resolves.toEqual({ cancelled: true });
    await expect(bridge.request({ kind: 'confirm', title: 'Late' })).resolves.toEqual({ cancelled: true });
    bridge.notify('late');
    bridge.ui.setTitle('late');
    expect(records.filter(record => record.type === 'extension_ui_closed').map(record => record.id)).toEqual([first.id, second.id]);
    expect(bridge.snapshot()).toMatchObject({ closed: true, requests: [], presentation: [] });
  });

  it('allows new dialogs after abort while leaving presentation intact', async () => {
    const { bridge } = fixture();
    bridge.ui.setTitle('Title');
    const first = bridge.request({ kind: 'input', title: 'First' });
    bridge.cancelPending();
    await expect(first).resolves.toEqual({ cancelled: true });
    const next = bridge.request({ kind: 'input', title: 'Next' });
    expect(bridge.snapshot()).toMatchObject({ closed: false, presentation: [{ value: 'Title' }], requests: [{ id: next.id }] });
    bridge.close();
    await next;
  });

  it('bounds fire-and-forget delivery under a blocked sink and keeps latest replay state', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const records: Record<string, unknown>[] = [];
    const bridge = new RpcExtensionUiBridge(record => { records.push(record); return blocked; });
    for (let i = 0; i < 1_000; i++) bridge.ui.setStatus('same-key', String(i));
    expect(records).toHaveLength(256);
    expect(bridge.snapshot()).toMatchObject({ presentation: [{ value: '999' }] });
    const pending = bridge.request({ kind: 'input', title: 'Cannot deliver' });
    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(bridge.snapshot().requests).toEqual([]);
    release();
    await blocked;
    await Promise.resolve();
    bridge.ui.setStatus('same-key', 'recovered');
    expect(records).toHaveLength(257);
    bridge.close();
  });

  it('cancels unsupported custom forms and pre-aborted requests without emission', async () => {
    const { records, bridge } = fixture();
    await expect(bridge.request({ kind: 'custom', title: 'Unsupported' })).resolves.toEqual({ cancelled: true });
    await expect(bridge.request({ kind: 'input', title: 'Aborted', signal: AbortSignal.abort() })).resolves.toEqual({ cancelled: true });
    expect(records).toEqual([]);
  });

  it.each([0, -1, 1.5, 2_147_483_648])('refuses invalid timeout %s before emission', async timeoutMs => {
    const { records, bridge } = fixture();
    await expect(bridge.request({ kind: 'input', title: 'Timeout', timeoutMs })).rejects.toThrow('timeoutMs');
    expect(records).toEqual([]);
  });
});
