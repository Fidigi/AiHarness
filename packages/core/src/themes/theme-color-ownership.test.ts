import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ThemeManager } from './theme-manager.js';

async function load(document: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-theme-own-colors-'));
  try {
    const target = path.join(root, 'theme.json'); await writeFile(target, JSON.stringify(document));
    return await ThemeManager.load(target);
  } finally { await rm(root, { recursive: true, force: true }); }
}
describe('theme colors never borrow Object.prototype values', () => {
  for (const field of ['colors', 'export'] as const) {
    it.each(['constructor', '__proto__'])(`${field}: rejects inherited literal %s`, async value => {
      const document = { name: 'own colors', appearance: 'dark', colors: {},
        [field]: field === 'colors' ? { accent: value } : { pageBg: value } };
      await expect(load(document)).rejects.toThrow('Theme colors must use');
    });
  }
  it.each(['constructor', 'toString'])('resolves a forward reference to own variable %s as a color string', async variable => {
    const palette = await load({ name: 'own vars', appearance: 'dark',
      vars: { Alias: variable, [variable]: '#abc' }, colors: { accent: 'Alias', mdHeading: variable } });
    expect(palette.colors.accent).toBe('#aabbcc'); expect(palette.colors.mdHeading).toBe('#aabbcc');
    expect(palette.vars.Alias).toBe('#aabbcc'); expect(palette.vars[variable]).toBe('#aabbcc');
  });
});
