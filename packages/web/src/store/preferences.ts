import { useEffect, useState } from 'react';
import { defaultKeybindings, shortcutActions, type Keybindings } from '../services/keyboard';

export type ThemePreference = 'system' | 'light' | 'dark' | 'mist' | 'rose' | 'pine';
export interface BrowserPreferences {
  version: 3;
  theme: ThemePreference;
  contentWidth: number;
  fontSize: number;
  reasoningOpen: boolean;
  sound: boolean;
  soundVolume: number;
  soundEvents: { completion: boolean; attention: boolean };
  notifications: boolean;
  pushNotifications: boolean;
  notificationEvents: { completion: boolean; attention: boolean };
  pushEvents: { completion: boolean; attention: boolean };
  selectionActions: boolean;
  filesOpen: boolean;
  sidebarVisible: boolean;
  lastSettingsSection: string;
  keybindings: Keybindings;
}

const KEY = 'ai-harness-preferences-v3';
const LEGACY_KEY = 'ai-harness-preferences-v2';
const OLDEST_KEY = 'ai-harness-preferences-v1';
const EVENT = 'aih-preferences';
const defaults: BrowserPreferences = {
  version: 3,
  theme: 'system',
  contentWidth: 1000,
  fontSize: 16,
  reasoningOpen: false,
  sound: false,
  soundVolume: 0.25,
  soundEvents: { completion: true, attention: true },
  notifications: false,
  pushNotifications: false,
  notificationEvents: { completion: true, attention: true },
  pushEvents: { completion: true, attention: true },
  selectionActions: true,
  filesOpen: true,
  sidebarVisible: true,
  lastSettingsSection: 'appearance',
  keybindings: defaultKeybindings,
};

function validated(value: unknown): BrowserPreferences {
  if (!value || typeof value !== 'object') return defaults;
  const input = value as Partial<BrowserPreferences>;
  const themes: ThemePreference[] = ['system', 'light', 'dark', 'mist', 'rose', 'pine'];
  const keybindings = { ...defaultKeybindings };
  if (input.keybindings && typeof input.keybindings === 'object') {
    for (const action of shortcutActions) {
      const chord = input.keybindings[action];
      if (typeof chord === 'string' && chord.length > 0 && chord.length < 64) keybindings[action] = chord;
    }
  }
  return {
    version: 3,
    theme: themes.includes(input.theme as ThemePreference) ? input.theme as ThemePreference : defaults.theme,
    contentWidth: Math.max(820, Math.min(2000, Number(input.contentWidth) || defaults.contentWidth)),
    fontSize: Math.max(12, Math.min(24, Number(input.fontSize) || defaults.fontSize)),
    reasoningOpen: input.reasoningOpen === true,
    sound: input.sound === true,
    soundVolume: typeof input.soundVolume === 'number'
      ? Math.max(0, Math.min(1, input.soundVolume)) : defaults.soundVolume,
    soundEvents: input.soundEvents && typeof input.soundEvents === 'object'
      ? { ...defaults.soundEvents, ...input.soundEvents } : defaults.soundEvents,
    notifications: input.notifications === true,
    pushNotifications: input.pushNotifications === true,
    notificationEvents: input.notificationEvents && typeof input.notificationEvents === 'object'
      ? { ...defaults.notificationEvents, ...input.notificationEvents } : defaults.notificationEvents,
    pushEvents: input.pushEvents && typeof input.pushEvents === 'object'
      ? { ...defaults.pushEvents, ...input.pushEvents }
      : input.notificationEvents && typeof input.notificationEvents === 'object'
        ? { ...defaults.pushEvents, ...input.notificationEvents } : defaults.pushEvents,
    selectionActions: input.selectionActions !== false,
    filesOpen: input.filesOpen !== false,
    sidebarVisible: input.sidebarVisible !== false,
    lastSettingsSection: typeof input.lastSettingsSection === 'string' && /^[a-z-]{1,40}$/.test(input.lastSettingsSection)
      ? input.lastSettingsSection : defaults.lastSettingsSection,
    keybindings,
  };
}

export function readPreferences(): BrowserPreferences {
  try {
    const current = window.localStorage.getItem(KEY);
    const legacy = current === null ? window.localStorage.getItem(LEGACY_KEY) ?? window.localStorage.getItem(OLDEST_KEY) : null;
    const preferences = validated(JSON.parse(current ?? legacy ?? 'null'));
    if (current === null && legacy !== null) {
      try { window.localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* Migration is best effort. */ }
    }
    return preferences;
  } catch {
    return defaults;
  }
}

function applyPreferences(preferences: BrowserPreferences): void {
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  const theme = preferences.theme === 'system' ? systemDark ? 'dark' : 'light' : preferences.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--content-width', `${preferences.contentWidth}px`);
  document.documentElement.style.setProperty('--base-font-size', `${preferences.fontSize}px`);
}

export function writePreferences(preferences: BrowserPreferences): void {
  const next = validated(preferences);
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Optional storage. */ }
  applyPreferences(next);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

export function usePreferences(): [BrowserPreferences, (changes: Partial<BrowserPreferences>) => void] {
  const [preferences, setPreferences] = useState<BrowserPreferences>(readPreferences);
  useEffect(() => {
    applyPreferences(preferences);
    const custom = (event: Event) => setPreferences(validated((event as CustomEvent).detail));
    const storage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === LEGACY_KEY || event.key === OLDEST_KEY) setPreferences(readPreferences());
    };
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const system = () => { if (readPreferences().theme === 'system') applyPreferences(readPreferences()); };
    window.addEventListener(EVENT, custom);
    window.addEventListener('storage', storage);
    media?.addEventListener('change', system);
    return () => {
      window.removeEventListener(EVENT, custom);
      window.removeEventListener('storage', storage);
      media?.removeEventListener('change', system);
    };
  }, []); // Preferences update through the custom event below.
  return [preferences, changes => writePreferences({ ...preferences, ...changes, version: 3 })];
}
