import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ThemeManager } from './theme-manager';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(item => rm(item, { recursive: true, force: true }))));

describe('ThemeManager', () => {
  it('detects light and dark terminal backgrounds', () => {
    expect(ThemeManager.detectMode({ COLORFGBG: '0;15' })).toBe('light');
    expect(ThemeManager.detectMode({ COLORFGBG: '15;0' })).toBe('dark');
    expect(ThemeManager.detectMode({ AI_HARNESS_THEME: 'light' })).toBe('light');
  });

  it('loads and validates custom JSON themes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-theme-'));
    directories.push(directory);
    const filePath = path.join(directory, 'ocean.json');
    await writeFile(filePath, JSON.stringify({ name: 'ocean', mode: 'dark', colors: { accent: '#123456' } }));

    const theme = await ThemeManager.load(filePath);

    expect(theme.name).toBe('ocean');
    expect(theme.colors.accent).toBe('#123456');
    expect(theme.colors.error).toBeDefined();
  });
});
