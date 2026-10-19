import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from './Sidebar.js';
import { I18nProvider } from '../hooks/useI18n.js';
import { useSessionStore } from '../store/session-store.js';

const fixture = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock('../store/session-store.js', async original => {
  const module = await original<typeof import('../store/session-store.js')>();
  return { ...module, useSessionStore: Object.assign((select: (state: unknown) => unknown) => select(fixture.state), module.useSessionStore) };
});
function sidebar() {
  const state = useSessionStore.getInitialState();
  fixture.state = { ...state,
    workspace: { id: 'workspace', cwd: '/work space', name: 'Workspace', displayPath: '/work space', trusted: true },
    activeSessionId: 'old',
    sessions: [{ id: 'selected', title: 'Chosen', messages: [], createdAt: new Date(0), updatedAt: new Date(0), cwd: '/work space' },
      { id: 'draft:local', title: 'Unsent', messages: [], createdAt: new Date(0), updatedAt: new Date(0), draft: true }],
  };
  return renderToStaticMarkup(h(MemoryRouter, { basename: '/mount', initialEntries: ['/mount/chat/selected?token=PRIVATE&cwd=old#old'] },
    h(I18nProvider, null, h(Sidebar, { isOpen: true }))));
}
afterEach(() => { fixture.state = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('actual Sidebar native session/project controls', () => {
  it('renders the actual row identity as a native basename-aware link, never the previous query or hash', () => {
    const html = sidebar();
    const row = html.match(/<a[^>]*class="session-main"[^>]*>/g)?.find(tag => tag.includes('/chat/selected?'));
    expect(row).toContain('aria-current="page"');
    expect(row).toContain('href="/mount/chat/selected?cwd=%2Fwork%20space"');
    expect(html).not.toContain('PRIVATE');
    expect(html).not.toContain('#old');
  });
  it('offers explicit isolated new-tab session/project links, without an unsaved-draft new-tab action', () => {
    const html = sidebar();
    expect(html).toContain('aria-label="Open conversation in a new tab"');
    expect(html).toContain('aria-label="Open project in a new tab"');
    expect(html.match(/class="session-new-tab"/g)).toHaveLength(1);
    const project = html.match(/<a[^>]*class="workspace-new-tab"[^>]*>/)?.[0];
    expect(project).toContain('target="_blank"');
    expect(project).toContain('rel="noopener noreferrer"');
    expect(project).toContain('href="/mount?cwd=%2Fwork%20space"');
  });
  it('keeps the unsaved draft as a local button, not a cross-tab or context-menu link', () => {
    const html = sidebar();
    const buttons = (html.match(/<button class="session-main">.*?<\/button>/g) ?? []).filter(button => button.includes('Unsent'));
    expect(buttons).toHaveLength(1);
    expect(html).not.toContain('/chat/draft%3Alocal');
  });
  it('conserves ordinary workspace, rename and delete controls', () => {
    const html = sidebar();
    expect(html).toContain('class="workspace-button"');
    expect(html).toContain('aria-label="Rename conversation"');
    expect(html).toContain('aria-label="Delete conversation"');
  });
  it('renders metadata only and neither fetches nor changes source/browser store selection', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const before = useSessionStore.getState();
    sidebar();
    expect(fetch).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toBe(before);
  });
});
