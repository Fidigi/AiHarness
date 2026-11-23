import { enLocale } from './messages/en.js';
import { frLocale } from './messages/fr.js';
import type { Locale, LocalePlugin } from './types.js';

const localePlugins: readonly LocalePlugin[] = [enLocale, frLocale];

/** Bounded in-place feature fill; language-package references and custom
 * overrides stay live. Unknown locale ids are ignored, never registered. */
export function registerFeatureLocaleMessages(
  messages: Readonly<Record<string, Readonly<Record<string, string>>>>,
): void {
  for (const plugin of localePlugins) {
    const feature = Object.hasOwn(messages, plugin.id) ? messages[plugin.id] : undefined;
    if (!feature) continue;
    const keys = Object.keys(feature);
    if (keys.length > 512) throw new Error('Feature locale exceeds 512 keys');
    for (const key of keys) {
      const value = feature[key];
      if (key.length > 256 || typeof value !== 'string' || value.length > 16_384
        || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error('Invalid feature locale message');
      }
    }
    for (const key of keys) {
      if (plugin.messages[key] === undefined) plugin.messages[key] = feature[key]!;
    }
  }
}

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
