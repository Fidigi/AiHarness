import { afterEach, describe, expect, it, vi } from 'vitest';
import { sidebarRequest } from './sidebar-state.js';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./api.js', () => ({ apiFetch: api.fetch }));
afterEach(() => vi.resetAllMocks());

describe('sidebar transport preserves revision/undo without replay', () => {
  it('reads the independent state and sends exact mutation primitives with cancellation', async () => {
    const state = { version: 1, revision: 'r', families: [], projects: [] };
    api.fetch.mockResolvedValueOnce(Response.json(state));
    expect(await sidebarRequest()).toEqual({ success: true, data: { state } });
    const body = { revision: 'r', change: { kind: 'families', ids: ['source'], pinned: true } } as const;
    const controller = new AbortController();
    api.fetch.mockResolvedValueOnce(Response.json({ state: { ...state, revision: 'next' }, undoToken: 'opaque' }));
    const result = await sidebarRequest({ ...body, change: { ...body.change, ids: [...body.change.ids] } }, controller.signal);
    expect(result.data?.undoToken).toBe('opaque');
    expect(api.fetch).toHaveBeenLastCalledWith('/api/sessions/ui-state', expect.objectContaining({ method: 'POST', body: JSON.stringify(body), signal: controller.signal }));
  });
  it('retains conflict codes and never retries uncertain writes', async () => {
    api.fetch.mockResolvedValueOnce(Response.json({ code: 'sidebar-state-conflict' }, { status: 409 }));
    expect(await sidebarRequest({ revision: 'old', undoToken: 'opaque' })).toMatchObject({ success: false, code: 'sidebar-state-conflict' });
    api.fetch.mockRejectedValueOnce(new Error('private transport diagnostics'));
    expect(await sidebarRequest({ revision: 'r', undoToken: 'opaque' })).toEqual({ success: false, error: 'Sidebar state unavailable' });
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });
});
