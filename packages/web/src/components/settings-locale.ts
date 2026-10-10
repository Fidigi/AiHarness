import { registerFeatureLocaleMessages } from '../i18n/registry';
import { settingsEnMessages } from './settings-locale-en';
import { settingsFrMessages } from './settings-locale-fr';

/** Both built-ins are registered before any Settings child renders. Locale
 * changes then use the existing translator and its unchanged English fallback. */
export function registerSettingsLocales(): void {
  registerFeatureLocaleMessages({ en: settingsEnMessages, fr: settingsFrMessages });
}
