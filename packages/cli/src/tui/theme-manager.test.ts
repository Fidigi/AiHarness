import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  createSystemTerminalTheme,
  startSystemThemeProbe,
  TerminalThemeResponseFilter,
  ThemeManager,
} from './theme-manager';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(item => rm(item, { recursive: true, force: true })));
});

describe('ThemeManager', () => {
  it('detects light and dark terminal backgrounds', () => {
    expect(ThemeManager.detectMode({ COLORFGBG: '0;15' })).toBe('light');
    expect(ThemeManager.detectMode({ COLORFGBG: '15;0' })).toBe('dark');
    expect(ThemeManager.detectMode({ AI_HARNESS_THEME: 'light' })).toBe('light');
  });

  it('builds a readable system palette from the real terminal background and ANSI colors', () => {
    const palette = Array.from({ length: 16 }, (_, index) => ({
      r: index === 5 ? 120 : index * 8,
      g: index === 5 ? 20 : index * 8,
      b: index === 5 ? 180 : index * 8,
    }));
    const light = createSystemTerminalTheme({
      foreground: { r: 10, g: 10, b: 10 },
      background: { r: 250, g: 250, b: 250 },
      palette,
    });
    const dark = createSystemTerminalTheme({
      foreground: { r: 245, g: 245, b: 245 },
      background: { r: 5, g: 5, b: 5 },
      palette,
    });

    expect(light).toMatchObject({ name: 'system', mode: 'light', appearance: 'light' });
    expect(dark).toMatchObject({ name: 'system', mode: 'dark', appearance: 'dark' });
    expect(light.colors.text).not.toBe(dark.colors.text);
    expect(light.provenance.path).toBe('builtin:system');
  });

  it('bounds ANSI probing, accepts fragmented and late replies, and follows scheme reports', async () => {
    vi.useFakeTimers();
    const input = Object.assign(new EventEmitter(), { isTTY: true });
    const writes: string[] = [];
    const output = { isTTY: true, write: (value: string) => { writes.push(value); } };
    const updates: string[] = [];
    const probe = startSystemThemeProbe({
      input, output, force: true, timeoutMs: 100,
      environment: { COLORFGBG: '15;0' },
      onTheme: theme => updates.push(theme.mode),
    });

    expect(writes.join('')).toContain('\u001b]10;?\u0007');
    await vi.advanceTimersByTimeAsync(100);
    await expect(probe.initial).resolves.toMatchObject({ name: 'system', mode: 'dark' });

    input.emit('data', Buffer.from('\u001b]10;rgb:0000/0000/0000\u0007\u001b]11;rgb:ffff/'));
    input.emit('data', Buffer.from('ffff/ffff\u0007\u001b[?1;2c'));
    await Promise.resolve();
    expect(updates).toContain('light');

    input.emit('data', '\u001b[?997;1n');
    await Promise.resolve();
    expect(writes.filter(value => value.includes('\u001b]11;?\u0007')).length).toBeGreaterThan(1);
    const writesAfterScheme = writes.length;
    input.emit('data', 'normal user input');
    await Promise.resolve();
    expect(writes).toHaveLength(writesAfterScheme);
    probe.close();
    expect(writes.at(-1)).toBe('\u001b[?2031l');
  });

  it('filters fragmented theme reports without consuming normal terminal input', () => {
    const filter = new TerminalThemeResponseFilter();
    const output = [
      filter.push('hello'),
      filter.push('\u001b]11;rgb:ffff/'),
      filter.push('ffff/ffff\u0007world'),
      filter.push('\u001b[?997;'),
      filter.push('2n!'),
      filter.push('\u001b[A'),
    ];

    expect(Buffer.concat(output).toString()).toBe('helloworld!\u001b[A');
    expect(filter.hasPending()).toBe(false);
    expect(filter.push('\u001b').length).toBe(0);
    expect(filter.flush().toString()).toBe('\u001b');
  });

  it('discards a delayed theme report instead of releasing its prefix to the editor', () => {
    const filter = new TerminalThemeResponseFilter();
    expect(filter.push('\u001b]11;rgb:ffff/').length).toBe(0);
    expect(filter.flush().length).toBe(0);
    expect(filter.hasPending()).toBe(true);
    expect(filter.push('ffff/ffff\u0007typed').toString()).toBe('typed');
    expect(filter.hasPending()).toBe(false);
  });

  it('loads and validates custom JSON themes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-theme-'));
    directories.push(directory);
    const filePath = path.join(directory, 'ocean.json');
    await writeFile(filePath, JSON.stringify({
      name: 'ocean',
      appearance: 'dark',
      vars: { primary: '#123456', indexed: 45 },
      colors: { accent: 'primary', mdHeading: 'indexed', userMessageText: 'primary' },
      export: { pageBg: '#000000' },
    }));

    const theme = await ThemeManager.load(filePath);

    expect(theme.name).toBe('ocean');
    expect(theme.colors.accent).toBe('#123456');
    expect(theme.colors.error).toBeDefined();
    expect(theme.colors.mdHeading).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme.vars.primary).toBe('#123456');
    expect(theme.export?.pageBg).toBe('#000000');

    const packageTheme = await ThemeManager.load('ocean', [filePath]);
    expect(packageTheme.colors.accent).toBe('#123456');

    const linkedTheme = path.join(directory, 'linked.json');
    await symlink(filePath, linkedTheme);
    await expect(ThemeManager.load(linkedTheme)).rejects.toBeDefined();
  });

  it('tracks source provenance and never reads untrusted project themes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-theme-trust-'));
    directories.push(directory);
    const filePath = path.join(directory, 'project.json');
    await writeFile(filePath, '{not-json');

    const inventory = await ThemeManager.inventory([{
      // Location wins over a caller-provided global classification.
      path: filePath, scope: 'user', source: 'package', trusted: true,
    }], 'project', { cwd: directory, projectTrusted: false });
    expect(inventory).toHaveLength(3);
    expect(inventory.every(item => item.valid)).toBe(true);

    await expect(ThemeManager.load(filePath, [], process.env, {
      cwd: directory, projectTrusted: false,
    })).rejects.toThrow(/trust/i);

    const trusted = await ThemeManager.inventory([{
      path: filePath, scope: 'project', source: 'package', trusted: true,
    }], 'project', { cwd: directory, projectTrusted: true });
    expect(trusted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'project', valid: false,
        provenance: expect.objectContaining({ scope: 'project', source: 'package', trusted: true }),
      }),
    ]));
  });
});
