import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ThemeManager } from '@ai-harness/core';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(await readFile(new URL('../../schemas/theme.schema.json', import.meta.url), 'utf8'));
const tokens: string[] = schema.properties.colors.propertyNames.enum;
async function load(document: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-theme-schema-'));
  try {
    const target = path.join(root, 'theme.json'); await mkdir(path.join(root, 'work'));
    await writeFile(target, JSON.stringify(document));
    return await ThemeManager.load(target, [], {}, { cwd: path.join(root, 'work'), projectTrusted: false });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const theme = (colors: Record<string, unknown> = {}) => ({ name: 'Schema example', appearance: 'dark', colors });
const literalAllowed = (value: unknown): boolean => typeof value === 'number'
  ? Number.isInteger(value) && value >= schema.$defs.literalColor.oneOf[0].minimum && value <= schema.$defs.literalColor.oneOf[0].maximum
  : typeof value === 'string' && value.length <= schema.$defs.literalColor.oneOf[1].maxLength
    && new RegExp(schema.$defs.literalColor.oneOf[1].pattern, 'u').test(value);

describe('complete shipped terminal theme schema and authoritative Core runtime', () => {
  it('covers every rich, optional and legacy token without inventing renderer fields', () => {
    expect(tokens).toHaveLength(58); expect(new Set(tokens).size).toBe(58);
    expect([...tokens].sort()).toEqual([...Object.keys(ThemeManager.builtins({})[0]!.colors),
      'scrollbarTrack', 'scrollbarThumb', 'searchMatchBg', 'searchMatchText'].sort());
    expect(schema.type).toBe('object'); expect(schema.required).toEqual(['name', 'colors']);
    expect(Object.keys(schema.properties).sort()).toEqual(['appearance', 'colors', 'export', 'mode', 'name', 'vars']);
    expect(schema.additionalProperties).toBe(true); expect(schema['x-maxUtf8Bytes']).toBe(262_144);
    expect(schema.properties.vars.maxProperties).toBe(256); expect(schema.properties.colors.maxProperties).toBe(128);
    expect(schema.properties.export.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.export.properties).sort()).toEqual(['cardBg', 'infoBg', 'pageBg']);
    expect(schema.properties.name['x-maxUtf16CodeUnits']).toBe(128);
    expect(schema.$defs.literalColor.oneOf[1]['x-maxUtf16CodeUnits']).toBe(256);
  });
  it.each(tokens)('documents and really loads color token %s', async token => {
    expect((await load(theme({ [token]: '#123456' }))).colors[token]).toBe('#123456');
  });
  it.each([0, 15, 16, 231, 232, 255, '#abc', '#123456', '#123456ff', ' RED ', 'Black', 'WHITE', 'cyan', 'magenta', 'grey', 'transparent'])('literal schema and actual export/color admission agree on %s', async value => {
    expect(literalAllowed(value)).toBe(true);
    const loaded = await load({ ...theme({ accent: value }), export: { pageBg: value, cardBg: value, infoBg: value } });
    expect(loaded.export?.pageBg).toBe(loaded.colors.accent); expect(loaded.colors.accent).toMatch(/^#[0-9a-f]{6}$/u);
  });
  it.each([-1, 256, 1.5, '', 'base', '#abcd', '#12345', '#1234567', 'rgb(1,2,3)', '\u0000red'])('literal schema and actual export refusal agree on %s', async value => {
    expect(literalAllowed(value)).toBe(false);
    await expect(load({ ...theme(), export: { pageBg: value } })).rejects.toThrow();
  });
  it('resolves complete case-sensitive variable chains, not export references', async () => {
    const loaded = await load({ ...theme({ accent: 'Base', mdHeading: 'Alias' }), vars: { Base: '#abc', Alias: 'Base' } });
    expect(loaded.colors.accent).toBe('#aabbcc'); expect(loaded.colors.mdHeading).toBe('#aabbcc');
    expect(loaded.vars).toEqual({ Base: '#aabbcc', Alias: '#aabbcc' });
    await expect(load({ ...theme(), vars: { Base: '#abc' }, export: { pageBg: 'Base' } })).rejects.toThrow();
    await expect(load({ ...theme({ accent: 'base' }), vars: { Base: '#abc' } })).rejects.toThrow();
    await expect(load({ ...theme(), vars: { Base: 'Alias', Alias: 'Base' } })).rejects.toThrow('cycle');
  });
  it('documents legacy/null appearance fallback and nonnull precedence without rejecting inert root metadata', async () => {
    expect(schema.properties.appearance.enum).toEqual(['dark', 'light', null]);
    expect(schema.anyOf[1].required).toEqual(['mode']); expect(schema.anyOf[1].properties.appearance.type).toBe('null');
    expect((await load({ name: 'legacy', mode: 'light', colors: {} })).mode).toBe('light');
    expect((await load({ name: 'nullable', appearance: null, mode: 'light', colors: {} })).mode).toBe('light');
    expect((await load({ name: 'preferred', appearance: 'dark', mode: { ignored: true }, colors: {}, $schema: 'local-editor-metadata', custom: { inert: true } })).mode).toBe('dark');
    await expect(load({ name: 'missing', colors: {} })).rejects.toThrow('appearance');
    await expect(load({ ...theme(), appearance: false, mode: 'light' })).rejects.toThrow('appearance');
  });
  it.each(['unknownColor', 'constructor', '__proto__'])('refuses unknown color/export token %s without echoing it', async token => {
    expect(tokens).not.toContain(token);
    await expect(load(theme({ [token]: '#123456' }))).rejects.toThrow('Unknown theme color token.');
    await expect(load({ ...theme(), export: { [token]: '#123456' } })).rejects.toThrow('Unknown theme export token.');
  });
  it.each(['', '   ', '/', 'a/b', 'x'.repeat(129)])('documents invalid name constraints for %j', async name => {
    const permitted = name.length > 0 && name.length <= schema.properties.name.maxLength
      && schema.properties.name.allOf.every((entry: { pattern: string }) => new RegExp(entry.pattern, 'u').test(name));
    expect(permitted).toBe(false); await expect(load({ ...theme(), name })).rejects.toThrow('name');
  });
  it('retains exact variable counts and token-name constraints', async () => {
    const vars = Object.fromEntries(Array.from({ length: 256 }, (_, i) => ['color' + i, '#abc']));
    expect(Object.keys((await load({ ...theme(), vars })).vars)).toHaveLength(256);
    await expect(load({ ...theme(), vars: { ...vars, overflow: '#abc' } })).rejects.toThrow('bounded object');
    for (const name of ['0bad', 'bad space', 'x'.repeat(65)]) {
      expect(new RegExp(schema.properties.vars.propertyNames.pattern, 'u').test(name)).toBe(false);
      await expect(load({ ...theme(), vars: { [name]: '#abc' } })).rejects.toThrow('variable name');
    }
  });
  it('copies the exact theme schema into real emitted CLI assets', async () => {
    const source = await readFile(new URL('../../schemas/theme.schema.json', import.meta.url));
    const emitted = await readFile(new URL('../../dist/schemas/theme.schema.json', import.meta.url));
    expect(emitted.equals(source)).toBe(true);
  });
});
