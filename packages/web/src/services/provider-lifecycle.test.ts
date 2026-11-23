import { afterEach, describe, expect, it, vi } from 'vitest';
import { renameCustomProvider, rebindProviderSelection } from './provider-lifecycle';
import { getCustomProviders } from './api';
import { useSessionStore } from '../store/session-store';
import type { ProviderType } from '@ai-harness/core';

const originalProviders = useSessionStore.getState().providers;
afterEach(() => { vi.unstubAllGlobals(); useSessionStore.setState({ providers: originalProviders }); });
describe('provider rename client', () => {
  it.each([
    [undefined, false],
    [{ supported: true }, false],
    [{ supported: false, mode: 'disabled', reason: 'exclusive-host-required' }, false],
    [{ supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer' }, true],
  ])('reads passive capability metadata and defaults closed (%j)', async (metadata, supported) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', {
      headers: metadata ? { 'X-AiHarness-Provider-Rename': JSON.stringify(metadata) } : {},
    })));
    expect(await getCustomProviders()).toMatchObject({ success: true, data: [], renameCapability: { supported } });
  });
  it('rebinds ephemeral selection/model IDs without copying auth or changing sessions', () => {
    const oldId = 'old-id' as ProviderType; const newId = 'new-id' as ProviderType;
    const sessions = useSessionStore.getState().sessions;
    useSessionStore.setState({ providers: { ...originalProviders, active: oldId,
      available: { ...originalProviders.available,
        [oldId]: { type: oldId, model: 'model-a', apiKey: 'source-private-key', customHeaders: { 'X-Private': 'source-header' } },
        [newId]: { type: newId, apiKey: 'stale-other-key' },
      } } });
    rebindProviderSelection(oldId, newId, true);
    const state = useSessionStore.getState();
    expect(state.providers.active).toBe(newId);
    expect(state.providers.available[oldId]).toBeUndefined();
    expect(state.providers.available[newId]).toEqual({ type: newId, model: '', apiKey: 'configured' });
    expect(state.sessions).toBe(sessions);
    expect(JSON.stringify(state.providers)).not.toMatch(/source-private-key|source-header|stale-other-key/);
  });
  it('submits identity and revision only, then reconciles canonical state', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'new-id', revision: 'b'.repeat(64) }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const descriptor = { id: 'old/id', revision: 'revision', apiKey: 'must-not-leak', headers: { secret: 'never' } };
    expect(await renameCustomProvider(descriptor, 'new-id', reconcile)).toMatchObject({ success: true, uncertain: false });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/provider-registry/custom/old%2Fid/rename');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ id: 'new-id', revision: 'revision' });
    expect(reconcile).toHaveBeenCalledOnce();
  });
  it.each([409, 500])('reconciles %s without reflecting credential-bearing error bodies', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'PROVIDER_EXISTS', error: 'private-key' }), { status })));
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const result = await renameCustomProvider({ id: 'old', revision: 'revision' }, 'new', reconcile);
    expect(result).toEqual({ success: false, code: 'PROVIDER_EXISTS', uncertain: status >= 500 });
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(reconcile).toHaveBeenCalledOnce();
  });
  it.each([{ id: 'wrong-id', revision: 'b'.repeat(64) }, { id: 'new-id' }])('rejects a malformed or retargeted successful result (%j)', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))));
    const reconcile = vi.fn().mockResolvedValue(undefined);
    expect(await renameCustomProvider({ id: 'old-id', revision: 'a'.repeat(64) }, 'new-id', reconcile))
      .toEqual({ success: false, uncertain: true });
    expect(reconcile).toHaveBeenCalledOnce();
  });
  it('treats transport or canonical reload failure as uncertain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-network-error')));
    const reconcile = vi.fn().mockResolvedValue(undefined);
    expect(await renameCustomProvider({ id: 'old', revision: 'revision' }, 'new', reconcile)).toEqual({ success: false, uncertain: true });
    expect(reconcile).toHaveBeenCalledOnce();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    expect(await renameCustomProvider({ id: 'old', revision: 'revision' }, 'new', async () => { throw new Error('read failure'); })).toEqual({ success: false, uncertain: true });
  });
});
