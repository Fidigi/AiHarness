import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type ThemeMode = 'dark' | 'light';

export interface TerminalTheme {
  name: string;
  mode: ThemeMode;
  colors: {
    accent: string;
    user: string;
    assistant: string;
    warning: string;
    error: string;
    muted: string;
  };
}

const MAX_THEME_BYTES = 256 * 1024;

async function readThemeFile(filePath: string): Promise<string> {
  const candidate = await lstat(filePath);
  if (candidate.isSymbolicLink() || !candidate.isFile() || candidate.size > MAX_THEME_BYTES) {
    throw new Error(`Fichier de thème invalide : ${filePath}`);
  }
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== candidate.dev || before.ino !== candidate.ino
      || before.size > MAX_THEME_BYTES) {
      throw new Error(`Fichier de thème invalide : ${filePath}`);
    }
    const content = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`Fichier de thème modifié pendant la lecture : ${filePath}`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

const BUILTIN_THEMES: Record<ThemeMode, TerminalTheme> = {
  dark: {
    name: 'dark', mode: 'dark',
    colors: { accent: '#22d3ee', user: '#4ade80', assistant: '#f8fafc', warning: '#facc15', error: '#f87171', muted: '#94a3b8' },
  },
  light: {
    name: 'light', mode: 'light',
    colors: { accent: '#0369a1', user: '#15803d', assistant: '#0f172a', warning: '#a16207', error: '#b91c1c', muted: '#64748b' },
  },
};

export class ThemeManager {
  static detectMode(environment: NodeJS.ProcessEnv = process.env): ThemeMode {
    const configured = environment.AI_HARNESS_THEME;
    if (configured === 'light' || configured === 'dark') return configured;
    const background = environment.COLORFGBG?.split(';').pop();
    if (background !== undefined && Number(background) >= 7) return 'light';
    return 'dark';
  }

  static async load(value?: string, packageThemePaths: readonly string[] = []): Promise<TerminalTheme> {
    const selected = value || process.env.AI_HARNESS_THEME || 'auto';
    if (selected === 'auto') return BUILTIN_THEMES[this.detectMode()];
    if (selected === 'dark' || selected === 'light') return BUILTIN_THEMES[selected];
    const packageTheme = packageThemePaths.find(candidate => (
      path.basename(candidate, path.extname(candidate)).toLocaleLowerCase() === selected.toLocaleLowerCase()
    ));
    const filePath = packageTheme ?? path.resolve(selected.replace(/^~(?=$|\/)/, os.homedir()));
    const parsed = JSON.parse(await readThemeFile(filePath)) as Partial<TerminalTheme>;
    if (!parsed.name || !parsed.mode || !parsed.colors || !['dark', 'light'].includes(parsed.mode)) {
      throw new Error(`Thème terminal invalide : ${filePath}`);
    }
    const fallback = BUILTIN_THEMES[parsed.mode];
    for (const [name, color] of Object.entries(parsed.colors)) {
      if (typeof color !== 'string' || !/^(#[0-9a-f]{6}|[a-z]+)$/i.test(color)) {
        throw new Error(`Couleur invalide pour ${name} dans ${filePath}`);
      }
    }
    return { ...fallback, ...parsed, colors: { ...fallback.colors, ...parsed.colors } } as TerminalTheme;
  }
}
