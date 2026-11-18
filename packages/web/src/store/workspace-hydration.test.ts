import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDescriptor } from '@ai-harness/core';
import type * as WorkspaceApi from '../services/api.js';
import { getDefaultWorkspace, validateWorkspace } from '../services/api.js';
import { useSessionStore } from './session-store.js';

vi.mock('../services/api.js', async importOriginal => ({
  ...await importOriginal<typeof WorkspaceApi>(),
  getDefaultWorkspace: vi.fn(), validateWorkspace: vi.fn(),
  listSessions: vi.fn(async () => ({ success: false })),
  getProviders: vi.fn(async () => ({ success: false })),
  getModelCatalog: vi.fn(async () => ({ success: false })),
  getSkillCatalog: vi.fn(async () => ({ success: false })),
}));
const key = 'ai-harness-workspaces-v1';
const storage = new Map<string, string>();
const workspace: WorkspaceDescriptor = { id: 'canonical', cwd: '/home/host/project', displayPath: '~/project', name: 'project', trusted: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
beforeEach(() => {
  vi.clearAllMocks(); storage.clear();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  useSessionStore.setState({ workspace: null, workspaceUnavailable: false, recentWorkspaces: [], sessions: [], runs: {}, runAuthorities: {}, drafts: {}, attachments: {}, activeSessionId: null });
  vi.mocked(getDefaultWorkspace).mockResolvedValue({ success: true, data: workspace });
  vi.mocked(validateWorkspace).mockResolvedValue({ success: true, data: workspace });
});
afterEach(() => vi.unstubAllGlobals());

describe('actual workspace hydration and canonical persistence', () => {
  it('persists only the canonical default, keeps display metadata separate, and revalidates on later hydration', async () => {
    await useSessionStore.getState().hydrateWorkspace();
    expect(getDefaultWorkspace).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().workspace).toEqual(workspace);
    expect(JSON.parse(storage.get(key)!)).toMatchObject({ version: 1, current: workspace.cwd });
    await useSessionStore.getState().hydrateWorkspace();
    expect(validateWorkspace).toHaveBeenCalledWith(workspace.cwd);
    expect(getDefaultWorkspace).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes explicit relative/home selections before saving, never persisting their display text as cwd', async () => {
    await useSessionStore.getState().hydrateWorkspace('./project');
    expect(validateWorkspace).toHaveBeenCalledWith('./project');
    expect(JSON.parse(storage.get(key)!).current).toBe(workspace.cwd);
    await useSessionStore.getState().hydrateWorkspace('~/project');
    expect(validateWorkspace).toHaveBeenLastCalledWith('~/project');
    expect(JSON.parse(storage.get(key)!).current).toBe(workspace.cwd);
  });

  it('falls back from an invalid persisted selection only to the server-validated default', async () => {
    storage.set(key, JSON.stringify({ version: 1, current: '/removed', recent: [] }));
    vi.mocked(validateWorkspace).mockResolvedValue({ success: false, error: 'not found' });
    await useSessionStore.getState().hydrateWorkspace();
    expect(validateWorkspace).toHaveBeenCalledWith('/removed');
    expect(getDefaultWorkspace).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().workspace).toEqual(workspace);
    expect(JSON.parse(storage.get(key)!).current).toBe(workspace.cwd);
  });

  it('settles an unavailable default without retrying, inventing a workspace or overwriting saved state; explicit recovery clears the notice', async () => {
    storage.set(key, JSON.stringify({ version: 1, current: '/removed', recent: [] }));
    const before = storage.get(key);
    vi.mocked(validateWorkspace).mockResolvedValueOnce({ success: false });
    vi.mocked(getDefaultWorkspace).mockResolvedValue({ success: false });
    await useSessionStore.getState().hydrateWorkspace();
    expect(useSessionStore.getState()).toMatchObject({ workspace: null, workspaceUnavailable: true });
    expect(getDefaultWorkspace).toHaveBeenCalledTimes(1);
    expect(storage.get(key)).toBe(before);
    await useSessionStore.getState().hydrateWorkspace(workspace.cwd);
    expect(useSessionStore.getState()).toMatchObject({ workspace, workspaceUnavailable: false });
    expect(JSON.parse(storage.get(key)!).current).toBe(workspace.cwd);
  });

  it('withdraws an old active descriptor when the new selection and default are unavailable, without rewriting saved choices', async () => {
    useSessionStore.setState({ workspace, recentWorkspaces: [workspace] });
    storage.set(key, JSON.stringify({ version: 1, current: workspace.cwd, recent: [workspace] }));
    const saved = storage.get(key);
    vi.mocked(validateWorkspace).mockResolvedValue({ success: false });
    vi.mocked(getDefaultWorkspace).mockResolvedValue({ success: false });
    await useSessionStore.getState().hydrateWorkspace('/removed');
    expect(useSessionStore.getState()).toMatchObject({ workspace: null, workspaceUnavailable: true });
    expect(storage.get(key)).toBe(saved);
    expect(getDefaultWorkspace).toHaveBeenCalledTimes(1);
  });

  it('does not issue a second default request when no persisted candidate exists', async () => {
    vi.mocked(getDefaultWorkspace).mockResolvedValue({ success: false });
    await useSessionStore.getState().hydrateWorkspace();
    expect(getDefaultWorkspace).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().workspaceUnavailable).toBe(true);
  });

  it('cannot publish an obsolete default failure over a newer explicit selection', async () => {
    const held = deferred<Awaited<ReturnType<typeof getDefaultWorkspace>>>();
    vi.mocked(getDefaultWorkspace).mockReturnValueOnce(held.promise);
    const old = useSessionStore.getState().hydrateWorkspace();
    await useSessionStore.getState().hydrateWorkspace(workspace.cwd);
    held.resolve({ success: false }); await old;
    expect(useSessionStore.getState()).toMatchObject({ workspace, workspaceUnavailable: false });
    expect(JSON.parse(storage.get(key)!).current).toBe(workspace.cwd);
  });

  it('ignores malformed cached path/metadata and never restores a cached trust grant', async () => {
    storage.set(key, JSON.stringify({ version: 1, current: { forged: true }, recent: [null, {}, { ...workspace, id: 'cached-other', cwd: '/home/host/other', name: 'other', trusted: true, git: { branch: { invalid: true } }, displayPath: { invalid: true } }] }));
    await useSessionStore.getState().hydrateWorkspace();
    expect(validateWorkspace).not.toHaveBeenCalled();
    expect(useSessionStore.getState().recentWorkspaces).toEqual([workspace, { id: 'cached-other', cwd: '/home/host/other', name: 'other', trusted: false }]);
  });

  it('can activate a validated recovery workspace without preserving the unavailable flag', async () => {
    useSessionStore.setState({ workspaceUnavailable: true });
    await useSessionStore.getState().setWorkspace(workspace);
    expect(useSessionStore.getState()).toMatchObject({ workspace, workspaceUnavailable: false });
    expect(JSON.parse(storage.get(key)!).current).toBe(workspace.cwd);
  });
});
