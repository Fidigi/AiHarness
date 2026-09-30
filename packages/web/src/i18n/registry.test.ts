import { describe, expect, it } from 'vitest';
import {
  getLocalePlugin,
  getSupportedLocales,
  isSupportedLocale,
  resolveBrowserLocale,
} from './registry.js';

describe('i18n locale registry', () => {
  it('uses the first supported browser language and falls back to English', () => {
    expect(resolveBrowserLocale(['fr-FR', 'en-US'])).toBe('fr');
    expect(resolveBrowserLocale(['fr_CA'])).toBe('fr');
    expect(resolveBrowserLocale(['en-GB', 'fr-FR'])).toBe('en');
    expect(resolveBrowserLocale(['de-DE', 'fr-CA'])).toBe('fr');
    expect(resolveBrowserLocale(['de-DE'])).toBe('en');
    expect(resolveBrowserLocale([])).toBe('en');
  });

  it('exposes only registered English and French packages', () => {
    expect(getSupportedLocales()).toEqual(['en', 'fr']);
    expect(getLocalePlugin('en')).toMatchObject({ id: 'en', label: 'English' });
    expect(getLocalePlugin('fr')).toMatchObject({ id: 'fr', label: 'Français' });
    expect(getLocalePlugin('fr')?.messages['common.settings']).toBe('Réglages');
    expect(getLocalePlugin('missing')).toBeUndefined();
    expect(isSupportedLocale('fr')).toBe(true);
    expect(isSupportedLocale('fr-FR')).toBe(false);
  });

  it('keeps every built-in package and interpolation contract complete', () => {
    const englishMessages = getLocalePlugin('en')!.messages;
    const englishKeys = Object.keys(englishMessages).sort();
    const placeholders = (message: string) => [...message.matchAll(/\{([\w.-]+)\}/g)]
      .map(match => match[1])
      .sort();

    for (const locale of getSupportedLocales().filter(id => id !== 'en')) {
      const messages = getLocalePlugin(locale)!.messages;
      expect(Object.keys(messages).sort(), `${locale} keys must match English`).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(placeholders(messages[key]!), `${locale}.${key} placeholders must match English`)
          .toEqual(placeholders(englishMessages[key]!));
      }
    }
  });
});
