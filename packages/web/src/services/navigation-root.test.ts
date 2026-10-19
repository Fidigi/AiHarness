import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ render: vi.fn(), createRoot: vi.fn() }));
vi.mock('react-dom/client', () => ({ default: { createRoot: capture.createRoot } }));
vi.mock('../App', () => ({ default: function TestApplication() { return null; } }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

describe('actual root entry composition (not browser/DOM rendering)', () => {
  it.each(['/', '/navigation/', 'https://cdn.example/assets/'])('keeps urgent root/prefix publication for %s without startup API work', async base => {
    vi.resetModules(); vi.stubEnv('BASE_URL', base);
    const root = { id: 'root' }, getElementById = vi.fn(() => root), fetch = vi.fn();
    vi.stubGlobal('document', { getElementById }); vi.stubGlobal('fetch', fetch);
    capture.createRoot.mockReturnValue({ render: capture.render });
    await import('../index.js');
    const { BrowserRouter } = await import('react-router-dom');
    const { default: Application } = await import('../App');
    expect(getElementById).toHaveBeenCalledExactlyOnceWith('root');
    expect(capture.createRoot).toHaveBeenCalledExactlyOnceWith(root); expect(capture.render).toHaveBeenCalledOnce();
    type Element = ReactElement<{ children: Element; basename?: string; useTransitions?: boolean }>;
    const strict = capture.render.mock.calls[0][0] as Element;
    const router = strict.props.children.props.children;
    expect(router.type).toBe(BrowserRouter); expect(router.props.useTransitions).toBe(false);
    expect(router.props.basename).toBe(base === '/navigation/' ? base : undefined);
    expect(router.props.children.type).toBe(Application); expect(fetch).not.toHaveBeenCalled();
  });
});
