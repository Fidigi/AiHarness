import type { Locale, TranslationParams } from './types.js';

export type MessagesByLocale = Record<string, Record<string, string>>;

/** Replace simple `{name}` placeholders with string or numeric values. */
export function interpolateMessage(
  message: string,
  params: TranslationParams = {},
): string {
  return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

/** Resolve a localized message, falling back to English and finally its key. */
export function translateMessage(
  locale: Locale,
  key: string,
  messages: MessagesByLocale,
  params: TranslationParams = {},
): string {
  const localizedMessage = messages[locale]?.[key];
  if (localizedMessage !== undefined) return interpolateMessage(localizedMessage, params);

  if (import.meta.env.DEV) {
    console.warn(`[i18n] Missing ${locale} translation: ${key}`);
  }

  const fallbackMessage = messages.en?.[key];
  return fallbackMessage === undefined ? key : interpolateMessage(fallbackMessage, params);
}
