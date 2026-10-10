import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAuthToken } from './api';
import { updateModelBatch, updateSkillBatch } from './resource-batches';

afterEach(() => { setAuthToken(''); vi.unstubAllGlobals(); });

describe('resource batch client', () => {
  it('sends one exact authenticated request for the changed selectors, not replacement lists', async () => {
    const result = { outcomes: [{ key: 'openai:one', enabled: false, status: 'changed' }], catalog: {} };
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetch); setAuthToken('disposable');
    await expect(updateModelBatch([{ key: 'openai:one', enabled: false }], 'workspace')).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/models/enabled/batch', { method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer disposable' },
      body: JSON.stringify({ changes: [{ key: 'openai:one', enabled: false }], projectId: 'workspace' }),
    });
    await updateSkillBatch([{ key: 'package:one', enabled: true }], '/workspace', 'workspace');
    expect(fetch).toHaveBeenLastCalledWith('/api/skills/enabled/batch', expect.objectContaining({
      body: JSON.stringify({ changes: [{ key: 'package:one', enabled: true }], cwd: '/workspace', projectId: 'workspace' }),
    }));
  });
  it('surfaces transport/HTTP failures without pretending an outcome succeeded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Refused' }), { status: 403 })));
    await expect(updateSkillBatch([], '/workspace')).rejects.toThrow('Refused');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(updateModelBatch([])).rejects.toThrow('offline');
  });
});
