import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import inventory from './settings-locale-inventory.json';
import { settingsEnMessages } from './settings-locale-en';
import { settingsFrMessages } from './settings-locale-fr';
import { getLocalePlugin, registerFeatureLocaleMessages } from '../i18n/registry';
import { translateMessage } from '../i18n/format';
import { settingsLocaleBoundaryMessage } from './settings-locale-boundary-messages';

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const entryLines = (text: string) => text.match(/^ {4}'[^']+': .*\n/gm) ?? [];

describe('Settings locale allocation', () => {
  it('relocates all projected inventoried EN/FR literals byte-for-byte and changes no retained key/value', () => {
    expect(inventory.moved).toHaveLength(228);
    for (const locale of ['en', 'fr'] as const) {
      const eager = entryLines(source(`../i18n/messages/${locale}.ts`));
      const lazy = entryLines(source(`./settings-locale-${locale}.ts`));
      const moved = inventory.moved.map(entry => entry[locale === 'en' ? 'enLine' : 'frLine']);
      expect(lazy).toEqual(moved);
      expect([...eager, ...lazy].sort()).toEqual([...inventory.original[locale].lines].sort());
      expect(eager).toEqual(inventory.original[locale].lines.filter(line => !moved.includes(line)));
    }
  });

  it('moves only direct Settings-tree consumers, not shared/dynamic/dirty/default keys', () => {
    const allowed = new Set(['SettingsView.tsx', 'EcosystemSettings.tsx', 'McpSettings.tsx', 'McpImportPreview.tsx', 'PluginSettings.tsx']);
    for (const entry of inventory.moved) {
      expect(inventory.dirty).not.toContain(entry.key);
      expect(entry.key.startsWith('settings.defaults.')).toBe(false);
      expect(inventory.dynamic.some(dynamic => entry.key.startsWith(dynamic.prefix))).toBe(false);
      for (const consumer of entry.consumers) {
        const name = consumer.path.split('/').at(-1)!;
        expect(allowed.has(name)).toBe(true);
        expect(source(`./${name}`)).toContain(consumer.source);
        expect(consumer.source).toContain(`t('${entry.key}'`);
      }
    }
  });

  it('keeps bilingual placeholders complete and existing package references/overrides live', () => {
    const english = getLocalePlugin('en')!.messages;
    const french = getLocalePlugin('fr')!.messages;
    const messages = { en: english, fr: french };
    const key = 'settings.providerLifecycle';
    const previous = french[key];
    french[key] = 'Plugin override';
    registerFeatureLocaleMessages({ en: settingsEnMessages, fr: settingsFrMessages });
    expect(getLocalePlugin('en')!.messages).toBe(english);
    expect(getLocalePlugin('fr')!.messages).toBe(french);
    expect(translateMessage('fr', key, messages)).toBe('Plugin override');
    delete french[key];
    expect(translateMessage('fr', key, messages)).toBe(settingsEnMessages[key]);
    if (previous !== undefined) french[key] = previous;
    registerFeatureLocaleMessages({ fr: settingsFrMessages });
    expect(translateMessage('fr', key, messages)).toBe(settingsFrMessages[key]);
    for (const entry of inventory.moved) {
      const placeholders = (value: string) => [...value.matchAll(/\{([\w.-]+)\}/g)].map(match => match[1]).sort();
      expect(placeholders(settingsFrMessages[entry.key]!)).toEqual(placeholders(settingsEnMessages[entry.key]!));
    }
  });

  it('bounds fill-only registration, preserves custom empty overrides, and ignores unregistered locales', () => {
    const plugin = getLocalePlugin('fr')!;
    const reference = plugin.messages;
    const key = 'settings.localeUnitProbe';
    const previous = reference[key];
    const label = plugin.label;
    try {
      reference[key] = '';
      registerFeatureLocaleMessages({ fr: { [key]: 'must not replace' }, de: { [key]: 'not registered' } });
      expect(reference[key]).toBe('');
      expect(getLocalePlugin('de')).toBeUndefined();
      expect(getLocalePlugin('fr')!.messages).toBe(reference);
      expect(plugin.label).toBe(label);
      delete reference[key];
      registerFeatureLocaleMessages({ fr: { [key]: 'filled' } });
      expect(reference[key]).toBe('filled');
      expect(() => registerFeatureLocaleMessages({ fr: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [String(i), 'x'])) })).toThrow('512');
      expect(() => registerFeatureLocaleMessages({ fr: { [key]: 'x'.repeat(16_385) } })).toThrow();
      expect(() => registerFeatureLocaleMessages({ fr: JSON.parse('{"__proto__":"bad"}') as Record<string, string> })).toThrow();
      expect(Object.getPrototypeOf(reference)).toBe(Object.prototype);
    } finally {
      if (previous === undefined) delete reference[key]; else reference[key] = previous;
    }
  });

  it('has real French loading/error copy, never transient English', () => {
    expect(settingsLocaleBoundaryMessage('fr', 'loading')).toBe('Chargement des traductions des réglages…');
    expect(settingsLocaleBoundaryMessage('fr', 'failed')).toContain('Rechargez la page');
  });
});

describe('Settings locale loader', () => {
  it('joins actual import success and registers once', async () => {
    vi.resetModules();
    const registerSettingsLocales = vi.fn();
    vi.doMock('./settings-locale', () => ({ registerSettingsLocales }));
    const { loadSettingsLocales } = await import('./settings-locale-loader');
    const first = loadSettingsLocales();
    expect(loadSettingsLocales()).toBe(first);
    await first;
    expect(registerSettingsLocales).toHaveBeenCalledTimes(1);
    vi.doUnmock('./settings-locale');
  });

  it('retains real failure across reopen instead of claiming readiness', async () => {
    vi.resetModules();
    vi.doMock('./settings-locale', () => { throw new Error('asset unavailable'); });
    const { loadSettingsLocales } = await import('./settings-locale-loader');
    const first = loadSettingsLocales();
    await expect(first).rejects.toThrow();
    expect(loadSettingsLocales()).toBe(first);
    await expect(loadSettingsLocales()).rejects.toThrow();
    vi.doUnmock('./settings-locale');
  });
});
