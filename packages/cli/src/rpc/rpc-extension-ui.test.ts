import { describe, expect, it } from 'vitest';
import { RpcExtensionUiBridge } from './rpc-extension-ui';

describe('RpcExtensionUiBridge', () => {
  it('correlates select and confirm dialogs with Pi extension UI responses', async () => {
    const records: Array<Record<string, unknown>> = [];
    const bridge = new RpcExtensionUiBridge(record => records.push(record));
    const selected = bridge.request({
      kind: 'select',
      title: 'Choose',
      options: [{ label: 'First label', value: 'first' }, { label: 'Second label', value: 'second' }],
    });
    expect(records[0]).toMatchObject({
      type: 'extension_ui_request', method: 'select', title: 'Choose',
      options: ['First label', 'Second label'], id: expect.any(String),
    });
    expect(bridge.handleResponse({
      type: 'extension_ui_response', id: records[0]!.id, value: 'Second label',
    })).toBe(true);
    await expect(selected).resolves.toEqual({ cancelled: false, value: 'second' });

    const confirmed = bridge.request({ kind: 'confirm', title: 'Continue?', message: 'Proceed' });
    expect(bridge.handleResponse({
      type: 'extension_ui_response', id: records[1]!.id, confirmed: true,
    })).toBe(true);
    await expect(confirmed).resolves.toEqual({ cancelled: false, value: true });
  });

  it('enforces dialog timeouts and cancellation signals host-side', async () => {
    const records: Array<Record<string, unknown>> = [];
    const bridge = new RpcExtensionUiBridge(record => records.push(record));
    const timedOut = bridge.request({ kind: 'confirm', title: 'Wait?', timeoutMs: 5 });
    expect(records[0]).toMatchObject({ method: 'confirm', timeout: 5 });
    await expect(timedOut).resolves.toEqual({ cancelled: false, value: false });

    const controller = new AbortController();
    const aborted = bridge.request({ kind: 'editor', title: 'Edit', signal: controller.signal });
    controller.abort();
    await expect(aborted).resolves.toEqual({ cancelled: true });
  });

  it('cancels a dialog when protocol delivery fails', async () => {
    const bridge = new RpcExtensionUiBridge(async () => { throw new Error('closed output'); });
    await expect(bridge.request({ kind: 'input', title: 'Value' })).resolves.toEqual({ cancelled: true });

    const synchronous = new RpcExtensionUiBridge(() => { throw new Error('closed output'); });
    await expect(synchronous.request({ kind: 'input', title: 'Value' })).resolves.toEqual({ cancelled: true });
    expect(() => synchronous.notify('ignored')).not.toThrow();
  });

  it('emits fire-and-forget notifications and cancels pending dialogs on close', async () => {
    const records: Array<Record<string, unknown>> = [];
    const bridge = new RpcExtensionUiBridge(record => records.push(record));
    bridge.notify('Careful', 'warning');
    expect(records[0]).toMatchObject({
      type: 'extension_ui_request', method: 'notify', message: 'Careful', notifyType: 'warning',
    });

    const pending = bridge.request({ kind: 'input', title: 'Value', placeholder: 'text' });
    bridge.close();
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});
