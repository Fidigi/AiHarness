/** Built-in interface locales. */
export type Locale = 'en' | 'fr';

/** Values supported by translation message interpolation. */
export type TranslationParams = Record<string, string | number>;

/** A registered interface language package. */
export interface LocalePlugin {
  /** Unique BCP 47-style locale identifier. */
  id: Locale;
  /** Native language name displayed in the locale selector. */
  label: string;
  /** Translated messages indexed by stable, language-neutral keys. */
  messages: Record<string, string>;
}

export type TranslationFunction = (key: string, params?: TranslationParams) => string;
