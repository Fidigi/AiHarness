import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { translateMessage } from '../i18n/format.js';
import {
  getLocalePlugin,
  getSupportedLocales,
  isSupportedLocale,
  resolveBrowserLocale,
} from '../i18n/registry.js';
import type {
  Locale,
  LocalePlugin,
  TranslationFunction,
} from '../i18n/types.js';

export const LOCALE_STORAGE_KEY = 'ai-harness-locale';

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslationFunction;
  supportedLocales: LocalePlugin[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

const messagesByLocale = Object.fromEntries(
  getSupportedLocales().flatMap(id => {
    const plugin = getLocalePlugin(id);
    return plugin ? [[id, plugin.messages]] : [];
  }),
);

function readInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';

  try {
    const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(storedLocale)) return storedLocale;
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }

  const browserLanguages = window.navigator.languages.length > 0
    ? window.navigator.languages
    : [window.navigator.language];
  return resolveBrowserLocale(browserLanguages);
}

/** Provide interface locale state and translations to the React application. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);
  const supportedLocales = useMemo(
    () => getSupportedLocales()
      .map(id => getLocalePlugin(id))
      .filter((plugin): plugin is LocalePlugin => plugin !== undefined),
    [],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    if (!isSupportedLocale(nextLocale)) return;

    setLocaleState(nextLocale);
    document.documentElement.lang = nextLocale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // A storage failure must not prevent switching language for this page.
    }
  }, []);

  const t = useCallback<TranslationFunction>(
    (key, params) => translateMessage(locale, key, messagesByLocale, params),
    [locale],
  );
  const value = useMemo(
    () => ({ locale, setLocale, t, supportedLocales }),
    [locale, setLocale, supportedLocales, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Access the current interface locale and translation function. */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}
