import { enLocale } from './messages/en.js';
import { frLocale } from './messages/fr.js';
import type { Locale, LocalePlugin } from './types.js';

const localePlugins: readonly LocalePlugin[] = [enLocale, frLocale];

/** Return a registered language package by locale identifier. */
export function getLocalePlugin(id: string): LocalePlugin | undefined {
  return localePlugins.find(plugin => plugin.id === id);
}

/** Return registered locale identifiers in their stable display order. */
export function getSupportedLocales(): Locale[] {
  return localePlugins.map(plugin => plugin.id);
}

/** Check whether an unknown value is a registered locale identifier. */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && getLocalePlugin(value) !== undefined;
}

/**
 * Resolve the browser's ordered language preferences to a built-in locale.
 * Unsupported preferences are skipped and English is the final fallback.
 */
export function resolveBrowserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const normalized = language.trim().replaceAll('_', '-').toLowerCase();
    const primaryLanguage = normalized.split('-')[0];
    const plugin = localePlugins.find(candidate => {
      const candidateId = candidate.id.toLowerCase();
      return candidateId === normalized || candidateId === primaryLanguage;
    });
    if (plugin) return plugin.id;
  }
  return 'en';
}
