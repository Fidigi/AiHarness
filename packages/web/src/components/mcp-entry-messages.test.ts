import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { McpEntryProblemReason } from '@ai-harness/core';
import { getSupportedLocales } from '../i18n/registry';
import { enLocale } from '../i18n/messages/en';
import { frLocale } from '../i18n/messages/fr';
import { settingsEnMessages } from './settings-locale-en';
import { settingsFrMessages } from './settings-locale-fr';
import { mcpImportMessage, type McpImportMessageKey } from './mcp-import-messages';
import { mcpTestMessage, type McpTestMessageKey } from './mcp-test-messages';
import { toolProgressMessages } from './tool-progress-messages';
import { mcpEntryProblemMessage } from './mcp-entry-messages';

const reasons: McpEntryProblemReason[] = [
  'entry-shape', 'server-name', 'unsupported-properties', 'target', 'command', 'url',
  'transport', 'stdio-transport', 'http-transport', 'args', 'cwd', 'description',
  'env', 'headers', 'stdio-fields', 'http-fields', 'enabled', 'exposure', 'tool-exposure', 'oauth',
  'override-fields', 'orphan-override',
];
const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const placeholders = (value: string) => [...value.matchAll(/\{([\w.-]+)\}/gu)].map(match => match[1]).sort();

describe('typed MCP diagnostic localization', () => {
  it.each(reasons)('has complete inert English and French copy for %s', reason => {
    const en = mcpEntryProblemMessage('en', reason), fr = mcpEntryProblemMessage('fr', reason);
    expect(en).toBeTruthy();
    expect(fr).toBeTruthy();
    expect(fr).not.toBe(en);
    expect(en.length).toBeLessThan(512);
    expect(fr.length).toBeLessThan(512);
    expect(en).not.toMatch(/[<>\u0000-\u001f\u007f]/u);
    expect(fr).not.toMatch(/[<>\u0000-\u001f\u007f]/u);
    expect(placeholders(fr)).toEqual(placeholders(en));
    expect(mcpEntryProblemMessage('unregistered', reason)).toBe(en);
  });

  it('describes the supported star-pattern keys in both languages under the same typed code', () => {
    expect(mcpEntryProblemMessage('en', 'tool-exposure')).toBe('Per-tool exposure must be a bounded map of tool names or * patterns and exposure modes.');
    expect(mcpEntryProblemMessage('fr', 'tool-exposure')).toBe('L’exposition par outil doit être une table bornée de noms d’outils ou de motifs * et de modes d’exposition.');
  });

  it.each([undefined, null, '__proto__', 'constructor', 'toString', 'unknown-code', 17, {}])(
    'uses localized fallback for unrecognized codes, not an English-text lookup: %j', reason => {
      expect(mcpEntryProblemMessage('fr', reason)).toBe('L’entrée du serveur ne respecte pas le schéma MCP pris en charge.');
      expect(mcpEntryProblemMessage('en', reason)).toBe('The server entry does not match the supported MCP schema.');
    },
  );

  it('does not inspect or stringify unknown diagnostic objects', () => {
    let reads = 0;
    const value = { get toString() { reads++; throw new Error('must stay unread'); } };
    expect(mcpEntryProblemMessage('fr', value)).toContain('schéma MCP');
    expect(reads).toBe(0);
  });

  it('renders typed codes and preserves legacy/remote details without reclassifying their English', () => {
    const component = source('./McpSettings.tsx');
    expect(component).toContain('Array.isArray(server.problemReasons) && server.problemReasons.length');
    expect(component).toContain('server.problemReasons.map(reason => mcpEntryProblemMessage(locale, reason))');
    expect(component).toContain(': server.problems).map');
    const helper = source('./mcp-entry-messages.ts');
    expect(helper).not.toMatch(/\.problems|\.message|\.includes\(|\.startsWith\(|\.match\(/u);
    const union = source('../../../core/src/mcp/config-inventory.ts')
      .split('export type McpEntryProblemReason =')[1]!.split(';')[0]!;
    expect([...union.matchAll(/'([^']+)'/gu)].map(match => match[1]).sort()).toEqual([...reasons].sort());
  });
});

describe('complete built-in delta localization coverage', () => {
  it('covers every current eager/Settings MCP/code-mode/trust/status/validation key in both registered locales', () => {
    expect(getSupportedLocales()).toEqual(['en', 'fr']);
    const en = { ...enLocale.messages, ...settingsEnMessages }, fr = { ...frLocale.messages, ...settingsFrMessages };
    const keys = Object.keys(en).filter(key => /^(settings\.(mcp|codemode|tools\.reason)\.|chat\.(codemode|status)\.|workspace\.trust)/u.test(key));
    expect(keys.length).toBeGreaterThan(70);
    expect(Object.keys(fr).filter(key => keys.includes(key)).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(en[key], key).toBeTruthy();
      expect(fr[key], key).toBeTruthy();
      expect(placeholders(fr[key]!)).toEqual(placeholders(en[key]!));
    }
    for (const state of ['running', 'completed', 'failed', 'cancelled']) {
      expect(en[`chat.codemode.${state}`]).toBeTruthy();
      expect(fr[`chat.codemode.${state}`]).toBeTruthy();
    }
    for (const state of ['connecting', 'connected', 'needs-auth', 'failed', 'disconnected', 'closed']) {
      expect(en[`settings.mcp.runtime.${state}`]).toBeTruthy();
      expect(fr[`settings.mcp.runtime.${state}`]).toBeTruthy();
    }
  });

  it('covers every lazy importer/replacement/validation and connection-test literal with bilingual interpolation', () => {
    for (const [file, translate] of [
      ['./mcp-import-messages.ts', (locale: 'en' | 'fr', key: string) => mcpImportMessage(locale, key as McpImportMessageKey)],
      ['./mcp-test-messages.ts', (locale: 'en' | 'fr', key: string) => mcpTestMessage(locale, key as McpTestMessageKey)],
    ] as const) {
      const first = source(file).split('} as const;')[0]!;
      const keys = [...first.matchAll(/^ {2}'([^']+)':/gmu)].map(match => match[1]!);
      expect(keys.length).toBeGreaterThan(10);
      for (const key of keys) {
        const en = translate('en', key), fr = translate('fr', key);
        expect(en, key).toBeTruthy();
        expect(fr, key).toBeTruthy();
        expect(fr).not.toBe(key);
        expect(placeholders(fr)).toEqual(placeholders(en));
      }
    }
  });

  it('covers all progress phases, outcomes and disclosures without translating tool-reported content', () => {
    const en = toolProgressMessages('en'), fr = toolProgressMessages('fr');
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      if (key === 'status') continue;
      expect(fr[key]).toBeTruthy();
      expect(fr[key]).not.toBe(en[key]);
      expect(placeholders(fr[key])).toEqual(placeholders(en[key]));
    }
    expect(Object.keys(fr.status).sort()).toEqual(['cancelled', 'completed', 'failed', 'running']);
    for (const key of Object.keys(en.status) as Array<keyof typeof en.status>) expect(fr.status[key]).not.toBe(en.status[key]);
    expect(source('./ToolProgressCard.tsx')).toContain('{progress.content ||');
    expect(source('./CodemodeCard.tsx')).toContain('{output.slice(0, 8_000)}');
    expect(source('./mcp-test-messages.ts')).toContain('Redacted server stderr');
  });
});
