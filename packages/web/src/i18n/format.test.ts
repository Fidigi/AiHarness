import { describe, expect, it, vi } from 'vitest';
import { mcpImportMessage } from '../components/mcp-import-messages.js';
import { interpolateMessage, translateMessage } from './format.js';

describe('i18n message formatting', () => {
  it('interpolates string and numeric parameters without removing unknown placeholders', () => {
    expect(interpolateMessage('Hello, {name} ({count}) {missing}', {
      name: 'AiHarness',
      count: 2,
    })).toBe('Hello, AiHarness (2) {missing}');
  });

  it('uses the selected locale', () => {
    expect(translateMessage('fr', 'welcome', {
      en: { welcome: 'Welcome' },
      fr: { welcome: 'Bienvenue' },
    })).toBe('Bienvenue');
  });

  it('keeps lazy MCP import copy bilingual and interpolated', () => {
    expect(mcpImportMessage('en', 'settings.mcp.import.note.tooManyServers')).toContain('20');
    expect(mcpImportMessage('fr', 'settings.mcp.import.title')).toBe('Coller et prévisualiser un serveur');
    expect(mcpImportMessage('fr', 'settings.mcp.import.note.commandValue', { field: 'oauth.clientSecret' }))
      .toContain('oauth.clientSecret');
  });

  it('falls back to English and then to the stable key', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const messages = { en: { welcome: 'Welcome' }, fr: {} };

    expect(translateMessage('fr', 'welcome', messages)).toBe('Welcome');
    expect(translateMessage('fr', 'missing.key', messages)).toBe('missing.key');

    warning.mockRestore();
  });
});
