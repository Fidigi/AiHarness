import { useI18n } from '../hooks/useI18n.js';
import type { Locale } from '../i18n/types.js';

/** Application-wide language control backed by the registered locale packages. */
function LanguageSelector() {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const label = t('common.language');

  return (
    <label className="language-selector" title={label}>
      <span aria-hidden="true">🌐</span>
      <span className="visually-hidden">{label}</span>
      <select
        aria-label={label}
        value={locale}
        onChange={event => setLocale(event.target.value as Locale)}
      >
        {supportedLocales.map(plugin => (
          <option key={plugin.id} value={plugin.id}>{plugin.label}</option>
        ))}
      </select>
    </label>
  );
}

export default LanguageSelector;
