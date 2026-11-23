import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ render: vi.fn(), createRoot: vi.fn(), createRouter: vi.fn(), router: {} }));
vi.mock('react-dom/client', () => ({ default: { createRoot: capture.createRoot } }));
vi.mock('react-router-dom', async importOriginal => ({
  ...await importOriginal<typeof import('react-router-dom')>(), createBrowserRouter: capture.createRouter,
}));
vi.mock('../App', () => ({ default: function TestApplication() { return null; } }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

describe('actual root entry composition (not browser/DOM rendering)', () => {
  it.each(['/', '/navigation/', 'https://cdn.example/assets/'])('keeps urgent root/prefix publication for %s without startup API work', async base => {
    vi.resetModules(); vi.stubEnv('BASE_URL', base);
    const root = { id: 'root' }, getElementById = vi.fn(() => root), fetch = vi.fn();
    vi.stubGlobal('document', { getElementById }); vi.stubGlobal('fetch', fetch);
    capture.createRoot.mockReturnValue({ render: capture.render }); capture.createRouter.mockReturnValue(capture.router);
    await import('../index.js');
    const { RouterProvider } = await import('react-router-dom');
    const { default: Application } = await import('../App');
    expect(getElementById).toHaveBeenCalledExactlyOnceWith('root');
    expect(capture.createRoot).toHaveBeenCalledExactlyOnceWith(root); expect(capture.render).toHaveBeenCalledOnce();
    type Element = ReactElement<{ children: Element; router?: object; useTransitions?: boolean }>;
    const strict = capture.render.mock.calls[0][0] as Element;
    const router = strict.props.children.props.children;
    expect(router.type).toBe(RouterProvider); expect(router.props.useTransitions).toBe(false);
    expect(router.props.router).toBe(capture.router);
    expect(capture.createRouter).toHaveBeenCalledExactlyOnceWith([{ path: '*', element: expect.objectContaining({ type: Application }) }],
      base === '/navigation/' ? { basename: base } : {});
    expect(fetch).not.toHaveBeenCalled();
  });
});
