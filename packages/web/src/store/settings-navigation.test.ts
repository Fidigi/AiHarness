import { describe, expect, it } from 'vitest';
import {
  readSettingsNavigation, writeSettingsNavigation, settingsSections, settingsScopeControls, settingsSectionCategory,
  settingsSectionForContext, settingsScopeForContext, type NavigationStorage, type SettingsNavigation,
} from './settings-navigation';
const key = 'ai-harness-settings-navigation-v1';
function storage(initial?: string) {
  const values = new Map<string, string>(initial ? [[key, initial]] : []);
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}
const state = (section: SettingsNavigation['section'] = 'skills'): SettingsNavigation => ({
  section, positions: { skills: { group: '["project",""]', selection: '/one/skill.md' } }, scopes: { tools: 'global' },
});

describe('bounded per-context Settings presentation metadata', () => {
  it('isolates canonical cwd and no-project contexts, including prototype-like and selector-like identities', () => {
    const local = storage();
    for (const cwd of [undefined, 'mcp', '/one', '/two', '__proto__', '/["#]']) {
      writeSettingsNavigation(cwd, { ...state(), positions: { model: { group: '__proto__', selection: cwd ?? 'no-project' } } }, local);
    }
    for (const cwd of [undefined, 'mcp', '/one', '/two', '__proto__', '/["#]']) {
      expect(readSettingsNavigation(cwd, undefined, local).positions.model).toEqual({ group: '__proto__', selection: cwd ?? 'no-project' });
    }
    expect(readSettingsNavigation('/other', 'about', local)).toEqual({ section: 'about', positions: {}, scopes: {} });
  });
  it.each(settingsSections)('retains the global/read-only %s surface without a project', section => {
    const local = storage();
    const category = settingsSectionCategory[section];
    writeSettingsNavigation(undefined, { ...state(section), categories: { [category]: section } }, local);
    expect(readSettingsNavigation(undefined, 'appearance', local).section).toBe(section);
    expect(readSettingsNavigation(undefined, 'appearance', local).categories).toEqual({ [category]: section });
    expect(settingsSectionForContext(section)).toBe(section);
  });
  it.each(settingsScopeControls)('preserves %s scope intent but falls back only the project scope without cwd', control => {
    const local = storage(); writeSettingsNavigation('/one', { ...state('mcp'), scopes: { [control]: 'project' } }, local);
    const saved = readSettingsNavigation('/one', undefined, local);
    expect(saved.section).toBe('mcp');
    expect(settingsScopeForContext(saved.scopes[control], '/one')).toBe('project');
    expect(settingsScopeForContext(saved.scopes[control])).toBe('global');
    expect(settingsScopeForContext('global', '/one', 'project')).toBe('global');
  });
  it.each(['{', 'null', '[]', '{"version":2,"entries":[]}', 'x'.repeat(65_537)])('refuses malformed, oversized or future state (%#)', text => {
    expect(readSettingsNavigation('/one', 'shortcuts', storage(text))).toEqual({ section: 'shortcuts', positions: {}, scopes: {} });
  });
  it('conserves legacy section fallback but never admits unknown section identifiers', () => {
    expect(readSettingsNavigation('/one', 'unknown', storage()).section).toBe('appearance');
    const local = storage(JSON.stringify({ version: 1, entries: [{ cwd: '/one', section: 'unknown' }] }));
    expect(readSettingsNavigation('/one', 'about', local).section).toBe('appearance');
  });
  it('copies only recognized identifiers and scopes, dropping secrets, authority, drafts and inherited keys', () => {
    const local = storage();
    const value = { ...state(), apiKey: 'SECRET', trusted: true, form: 'DRAFT',
      categories: { models: 'model', general: 'mcp', mcp: 'SECRET', forged: 'appearance' }, positions: {
      skills: { group: 'project', selection: 'skill', revision: 'SECRET', config: { token: 'SECRET' } },
      forged: { selection: 'SECRET' },
    }, scopes: { tools: 'global', defaults: 'SECRET', forged: 'project' } };
    writeSettingsNavigation('/one', value as SettingsNavigation, local);
    const text = local.values.get(key)!;
    expect(text).not.toMatch(/SECRET|DRAFT|trusted|apiKey|revision|config|forged/);
    expect(readSettingsNavigation('/one', undefined, local)).toEqual({ section: 'skills', categories: { models: 'model' },
      positions: { skills: { group: 'project', selection: 'skill' } }, scopes: { tools: 'global' } });
    writeSettingsNavigation('/one', { section: 'mcp', categories: Object.create({ mcp: 'mcp' }), positions: Object.create({ mcp: { selection: 'SECRET' } }), scopes: Object.create({ tools: 'project' }) }, local);
    expect(readSettingsNavigation('/one', undefined, local)).toEqual({ section: 'mcp', positions: {}, scopes: {} });
  });
  it('bounds IDs/cwd, count and document size, evicting oldest contexts while preserving the newest valid entry', () => {
    const local = storage();
    for (let n = 0; n < 30; n++) writeSettingsNavigation(`/p${n}`, state(), local);
    expect(JSON.parse(local.values.get(key)!).entries).toHaveLength(24);
    expect(readSettingsNavigation('/p0', 'appearance', local).section).toBe('appearance');
    expect(readSettingsNavigation('/p29', 'appearance', local).section).toBe('skills');
    for (let n = 0; n < 20; n++) writeSettingsNavigation(`/large${n}`, { ...state(), positions: {
      skills: { group: 'g'.repeat(4_096), selection: 's'.repeat(4_096) }, model: { selection: 'x'.repeat(4_097) },
    } }, local);
    expect(local.values.get(key)!.length).toBeLessThanOrEqual(65_536);
    expect(readSettingsNavigation('/large19', undefined, local).positions).toEqual({ skills: { group: 'g'.repeat(4_096), selection: 's'.repeat(4_096) }, model: {} });
    const before = local.values.get(key); writeSettingsNavigation('c'.repeat(8_193), state(), local);
    expect(local.values.get(key)).toBe(before);
    expect(readSettingsNavigation('c'.repeat(8_193), 'about', local).section).toBe('about');
  });
  it('rejects excessive input contexts, filters malformed entries, and chooses the last duplicate exact cwd', () => {
    const tooMany = storage(JSON.stringify({ version: 1, entries: Array.from({ length: 25 }, () => ({ cwd: '/one', ...state() })) }));
    expect(readSettingsNavigation('/one', undefined, tooMany).section).toBe('appearance');
    const local = storage(JSON.stringify({ version: 1, entries: [null, [], { cwd: '' }, { cwd: '/one', ...state('skills') }, { cwd: '/one', ...state('mcp') }] }));
    expect(readSettingsNavigation('/one', undefined, local).section).toBe('mcp');
  });
  it('degrades safely when optional storage reads/writes are denied', () => {
    const unavailable: NavigationStorage = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
    expect(readSettingsNavigation('/one', 'mcp', unavailable).section).toBe('mcp');
    expect(() => writeSettingsNavigation('/one', state(), unavailable)).not.toThrow();
    const readonly = { getItem: storage().getItem, setItem() { throw Error('denied'); } };
    expect(() => writeSettingsNavigation('/one', state(), readonly)).not.toThrow();
  });
});
