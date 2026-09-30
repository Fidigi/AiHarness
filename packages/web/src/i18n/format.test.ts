import { describe, expect, it, vi } from 'vitest';
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

  it('falls back to English and then to the stable key', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const messages = { en: { welcome: 'Welcome' }, fr: {} };

    expect(translateMessage('fr', 'welcome', messages)).toBe('Welcome');
    expect(translateMessage('fr', 'missing.key', messages)).toBe('missing.key');

    warning.mockRestore();
  });
});
