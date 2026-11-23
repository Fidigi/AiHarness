import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { getLocalePlugin } from '../i18n/registry';
import { translateMessage } from '../i18n/format';
import { skillContentMessages } from './skill-content-messages';

it('provides all new feature labels and matching interpolation in both built-in locales', () => {
  expect(Object.keys(skillContentMessages.en)).toEqual(Object.keys(skillContentMessages.fr));
  for (const key of Object.keys(skillContentMessages.en) as Array<keyof typeof skillContentMessages.en>) {
    const placeholders = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    expect(placeholders(skillContentMessages.en[key])).toEqual(placeholders(skillContentMessages.fr[key]));
    expect(getLocalePlugin('en')!.messages[key]).toBe(skillContentMessages.en[key]);
    expect(getLocalePlugin('fr')!.messages[key]).toBe(skillContentMessages.fr[key]);
  }
});
it('registers translated copy through the existing translator, retaining literal skill names as data', () => {
  const messages = { en: getLocalePlugin('en')!.messages, fr: getLocalePlugin('fr')!.messages };
  expect(translateMessage('en', 'settings.skills.instructions', messages, { skill: '__proto__' })).toBe('Instructions: __proto__');
  expect(translateMessage('fr', 'settings.skills.instructions', messages, { skill: '<script>' })).toBe('Instructions : <script>');
});
it('keeps new feature labels outside both eager and historically relocated locale inventories', () => {
  for (const locale of ['en', 'fr']) {
    const eager = readFileSync(new URL(`../i18n/messages/${locale}.ts`, import.meta.url), 'utf8');
    const historical = readFileSync(new URL(`./settings-locale-${locale}.ts`, import.meta.url), 'utf8');
    for (const key of Object.keys(skillContentMessages.en)) { expect(eager).not.toContain(`'${key}'`); expect(historical).not.toContain(`'${key}'`); }
  }
});
