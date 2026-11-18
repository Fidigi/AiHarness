import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../hooks/useI18n';
import { OAuthPastePanel, safeOAuthAuthorizationUrl } from './OAuthPastePanel';
import { providerSettingsMessage } from './provider-settings-messages';

describe('passive reusable OAuth paste panel', () => {
  it('is inert before explicit operation and never calls callbacks on render', () => {
    const onPaste = vi.fn(); const onCancel = vi.fn();
    expect(renderToStaticMarkup(createElement(OAuthPastePanel, { active: false, operationId: '', onPaste, onCancel }))).toBe('');
    expect(onPaste).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
  });
  it('renders inline without dialog, autofocus, form submission or unsafe links', () => {
    const onPaste = vi.fn(); const onCancel = vi.fn();
    const markup = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(OAuthPastePanel, { active: true, operationId: 'explicit-flow', authorizationUrl: 'javascript:alert(1)', onPaste, onCancel })));
    expect(markup).toContain('Paste the full OAuth callback address');
    expect(markup).not.toMatch(/autofocus|role="dialog"|<form|javascript:/i);
    expect(markup).toMatch(/autocomplete="off"/i);
    expect(onPaste).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
  });
  it.each(['javascript:alert(1)', 'http://remote.example/oauth', 'https://user:secret@example.test/oauth', 'data:text/html,hello'])('refuses unsafe authorization links', url => {
    expect(safeOAuthAuthorizationUrl(url)).toBeUndefined();
  });
  it('allows HTTPS and exact loopback HTTP, and supplies EN/FR copy', () => {
    expect(safeOAuthAuthorizationUrl('https://issuer.example/authorize')).toBe('https://issuer.example/authorize');
    expect(safeOAuthAuthorizationUrl('http://127.0.0.1:123/oauth')).toBe('http://127.0.0.1:123/oauth');
    expect(providerSettingsMessage('fr', 'paste')).toBe('Coller l’adresse complète de retour OAuth');
    expect(providerSettingsMessage('fr', 'uncertain')).not.toBe(providerSettingsMessage('en', 'uncertain'));
  });
});
