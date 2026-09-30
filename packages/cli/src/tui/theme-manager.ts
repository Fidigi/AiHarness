import { readFile } from 'fs/promises';
import path from 'path';
import os from 'os';

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

  static async load(value?: string): Promise<TerminalTheme> {
    const selected = value || process.env.AI_HARNESS_THEME || 'auto';
    if (selected === 'auto') return BUILTIN_THEMES[this.detectMode()];
    if (selected === 'dark' || selected === 'light') return BUILTIN_THEMES[selected];
    const filePath = path.resolve(selected.replace(/^~(?=$|\/)/, os.homedir()));
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<TerminalTheme>;
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
