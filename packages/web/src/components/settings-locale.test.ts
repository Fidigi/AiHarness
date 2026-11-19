import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import inventory from './settings-locale-inventory.json';
import { settingsEnMessages } from './settings-locale-en';
import { settingsFrMessages } from './settings-locale-fr';
import { getLocalePlugin, registerFeatureLocaleMessages } from '../i18n/registry';
import { translateMessage } from '../i18n/format';
import { settingsLocaleBoundaryMessage } from './settings-locale-boundary-messages';
import { settingsCategories } from './settings-categories';

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const entryLines = (text: string) => text.match(/^ {4}'[^']+': .*\n/gm) ?? [];
// Explicit COMP-02 removals; preserve the historical inventory and every retained literal.
const retiredTransportKeys = new Set(['settings.realtimeTransport', 'settings.selectTransport']);
const retainedMoved = inventory.moved.filter(entry => !retiredTransportKeys.has(entry.key));

// Explicit post-inventory addition.
const mcpExposureHelp = {
  en: "    'settings.mcp.exposureHelp': 'Missing exposure defaults to direct. Code mode is script-only; deferred tools need tool_search before a later model turn; hidden tools are not model-callable. All modes retain allowlists, exclusions and read-only checks. Overrides match original remote names: exact first, then the first matching * pattern.',\n",
  fr: "    'settings.mcp.exposureHelp': 'Sans exposition définie, les outils sont directs. Le mode Code est réservé aux scripts ; les outils différés nécessitent tool_search avant un tour ultérieur du modèle ; les outils cachés ne sont pas appelables par le modèle. Les listes autorisées, exclusions et contrôles de lecture seule restent prioritaires. Les surcharges visent les noms distants : nom exact, puis premier motif * correspondant.',\n",
};

const mcpRegistrationHelp = {
  en: "    'settings.mcp.registrationHelp': 'Temporary server registered by {extension}. Its extension controls changes; a file with the same name takes priority.',\n",
  fr: "    'settings.mcp.registrationHelp': 'Serveur temporaire inscrit par {extension}. Les changements dépendent de son extension ; un fichier homonyme est prioritaire.',\n",
};

// Explicit stored-Vertex mode additions; do not regenerate the historical inventory.
const vertexCredentials = {
  en: [
    "    'settings.vertexCredentialMode': 'Vertex credential type to save',\n",
    "    'settings.vertexBearerCredential': 'Access token (legacy Bearer)',\n",
    "    'settings.vertexCloudCredential': 'Google Cloud API key',\n",
  ],
  fr: [
    "    'settings.vertexCredentialMode': 'Type d’identifiant Vertex à enregistrer',\n",
    "    'settings.vertexBearerCredential': 'Jeton d’accès (Bearer historique)',\n",
    "    'settings.vertexCloudCredential': 'Clé API Google Cloud',\n",
  ],
};

// AUDIT-1 explorer feedback is an explicit eager addition, not a Settings relocation.
const explorerFeedback = {
  en: [
    "    'files.clearSearch': 'Clear search',\n",
    "    'files.searchLoading': 'Searching files…',\n",
    "    'files.searchEmpty': 'No matching files.',\n",
    "    'files.searchFailed': 'File search failed.',\n",
    "    'files.searchWhitespace': 'Enter a file name to search.',\n",
    "    'files.loadingDirectory': 'Loading {name}…',\n",
  ],
  fr: [
    "    'files.clearSearch': 'Effacer la recherche',\n",
    "    'files.searchLoading': 'Recherche de fichiers…',\n",
    "    'files.searchEmpty': 'Aucun fichier correspondant.',\n",
    "    'files.searchFailed': 'La recherche de fichiers a échoué.',\n",
    "    'files.searchWhitespace': 'Indiquez un nom de fichier à rechercher.',\n",
    "    'files.loadingDirectory': 'Chargement de {name}…',\n",
  ],
};

describe('Settings locale allocation', () => {
  it('relocates all projected inventoried EN/FR literals byte-for-byte and changes no retained key/value', () => {
    expect(inventory.moved).toHaveLength(228);
    expect(retainedMoved).toHaveLength(226);
    for (const locale of ['en', 'fr'] as const) {
      const eager = entryLines(source(`../i18n/messages/${locale}.ts`));
      const lazy = entryLines(source(`./settings-locale-${locale}.ts`));
      const withVertexCredentials = (line: string) => line.startsWith("    'settings.apiKeyForProvider':")
        ? [line, ...vertexCredentials[locale]] : [line];
      const retired = inventory.moved.filter(entry => retiredTransportKeys.has(entry.key))
        .map(entry => entry[locale === 'en' ? 'enLine' : 'frLine']);
      const moved = retainedMoved.map(entry => entry[locale === 'en' ? 'enLine' : 'frLine']).flatMap(withVertexCredentials);
      // New category copy belongs only to the lazy Settings owner; the historical
      // inventory still verifies every existing literal without regeneration.
      const additions = ['settings.categories', ...settingsCategories.map(category => `settings.category.${category.id}`),
        'settings.generalNavigation', 'settings.generalBack', 'settings.behavior', 'settings.notificationPreferences', 'settings.access'].map(key => {
        const lines = lazy.filter(line => line.startsWith(`    '${key}':`));
        expect(lines).toHaveLength(1); return lines[0]!;
      });
      expect(lazy).toEqual([...additions, ...moved]);
      const projected = inventory.original[locale].lines.filter(line => !retired.includes(line)).flatMap(line =>
        line.startsWith("    'settings.mcp.exposureLabel':") ? [mcpExposureHelp[locale], mcpRegistrationHelp[locale], line] : [line]).flatMap(withVertexCredentials)
        .flatMap(line => line.startsWith("    'files.search':") ? [line, ...explorerFeedback[locale]] : [line]);
      expect([...eager, ...lazy].sort()).toEqual([...projected, ...additions].sort());
      expect(eager).toEqual(projected.filter(line => !moved.includes(line)));
    }
  });

  it('moves only direct Settings-tree consumers, not shared/dynamic/dirty/default keys', () => {
    const allowed = new Set(['SettingsView.tsx', 'EcosystemSettings.tsx', 'McpSettings.tsx', 'McpImportPreview.tsx', 'PluginSettings.tsx']);
    for (const entry of retainedMoved) {
      expect(inventory.dirty).not.toContain(entry.key);
      expect(entry.key.startsWith('settings.defaults.')).toBe(false);
      expect(inventory.dynamic.some(dynamic => entry.key.startsWith(dynamic.prefix))).toBe(false);
      for (const consumer of entry.consumers) {
        const name = consumer.path.split('/').at(-1)!;
        expect(allowed.has(name)).toBe(true);
        // AUDIT-1 changes glyphs/grouping/alignment, not locale ownership/copy.
        const projectedSource = entry.key === 'settings.starOnGitHub'
          ? consumer.source.replace('⭐', '<Icon name="star" />')
          : entry.key === 'settings.documentation' ? consumer.source.replace('📖', '<Icon name="file" />')
          : entry.key === 'settings.push.unsupported' ? consumer.source.replace('<label title=', '<label className="preference-toggle" title=')
          : entry.key === 'settings.sessions' ? consumer.source.replace('<h3>', '<h4>').replace('</h3>', '</h4>')
          : consumer.source;
        expect(source(`./${name}`)).toContain(projectedSource);
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
    for (const entry of retainedMoved) {
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
