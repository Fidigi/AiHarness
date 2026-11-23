import { createElement as h, type MouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Link, MemoryRouter } from 'react-router-dom';
import { isPlainLinkActivation, projectLinkTo, SessionLink, sessionLinkTo, type SessionContextMenuTarget } from './session-links.js';

const plain = { button: 0, defaultPrevented: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
describe('native same-instance session links', () => {
  it.each(['plain-id', 'space 雪/🙂?#', 'https://foreign.example/?token=not-authority', '__proto__'])('encodes %s only as identity, never a supplied URL', id => {
    expect(sessionLinkTo(id, '/work space', 'message/#')).toBe(`/chat/${encodeURIComponent(id)}?cwd=%2Fwork%20space#message%2F%23`);
  });
  it.each(['', '/nested', '/nested/worktree'])('retains router basename %s but drops old query/hash/auth data', basename => {
    const html = renderToStaticMarkup(h(MemoryRouter, { basename: basename || '/', initialEntries: [`${basename}/chat/old?token=PRIVATE&cwd=stale#old`] },
      h(SessionLink, { sessionId: 'new/id', cwd: '/work' }, 'Session'), h(Link, { to: projectLinkTo('/project') }, 'Project')));
    expect(html).toContain(`href="${basename}/chat/new%2Fid?cwd=%2Fwork"`);
    expect(html).toContain(`href="${basename || '/'}?cwd=%2Fproject"`);
    expect(html).not.toContain('PRIVATE');
    expect(html).not.toContain('<button');
  });
  it('renders explicit new-tab links with browser-owned isolated activation', () => {
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(SessionLink, { sessionId: 'chosen', target: '_blank', rel: 'noopener noreferrer' }, 'Chosen')));
    expect(html).toContain('href="/chat/chosen"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it.each([{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{button:2},{defaultPrevented:true}])('classifies modified/native activation %j without consuming it', change => {
    expect(isPlainLinkActivation({...plain,...change})).toBe(false);
  });
  it('recognizes plain activation, including the browser-generated Enter click', () => {
    expect(isPlainLinkActivation(plain)).toBe(true);
  });
  it('forwards context-menu metadata from the actual anchor without an API command', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      const preventDefault = vi.fn();
      const getAttribute = vi.fn(() => '/mount/chat/chosen?cwd=%2Fwork');
      const hook = vi.fn((event: MouseEvent<HTMLAnchorElement>, _target: Readonly<SessionContextMenuTarget>) => event.preventDefault());
      // Pure callback boundary, not a simulated browser/new-tab proof.
      const element = SessionLink({ sessionId: 'chosen', cwd: '/work', onSessionContextMenu: hook });
      const event = { currentTarget: { getAttribute }, preventDefault } as unknown as MouseEvent<HTMLAnchorElement>;
      element.props.onContextMenu(event);
      expect(hook).toHaveBeenCalledExactlyOnceWith(event, {sessionId:'chosen',cwd:'/work',href:'/mount/chat/chosen?cwd=%2Fwork'});
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(getAttribute).toHaveBeenCalledExactlyOnceWith('href');
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('does not consume a native context menu when no host hook exists', () => {
    const event = { preventDefault: vi.fn(), currentTarget: { getAttribute: vi.fn() } };
    SessionLink({ sessionId: 'chosen' }).props.onContextMenu(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.currentTarget.getAttribute).not.toHaveBeenCalled();
  });
});
