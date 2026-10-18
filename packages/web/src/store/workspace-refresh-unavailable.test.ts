import { afterEach, expect, it, vi } from 'vitest';
import { useSessionStore } from './session-store';
vi.mock('./workspace-refresh', () => { throw Error('Optional asset unavailable'); });
afterEach(() => vi.unstubAllGlobals());
it('an unavailable optional Settings refresh asset cannot publish a descriptor, trust grant or old catalogue', async () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn() } });
  const workspace = { id: 'project', cwd: '/project', name: 'project', trusted: false, operationTrusted: false };
  useSessionStore.setState({ workspace, recentWorkspaces: [workspace] });
  const before = useSessionStore.getState();
  await expect(before.refreshWorkspace()).resolves.toBeUndefined();
  expect(useSessionStore.getState()).toBe(before);
});
