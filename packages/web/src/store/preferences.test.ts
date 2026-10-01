import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPreferences, writePreferences } from './preferences';

const values = new Map<string, string>();
const properties = new Map<string, string>();

beforeEach(() => {
  values.clear();
  properties.clear();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: { setProperty: (key: string, value: string) => properties.set(key, value) },
    },
  });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: unknown) {} });
});

afterEach(() => vi.unstubAllGlobals());

describe('versioned browser preferences', () => {
  it('uses safe defaults for missing or corrupt state', () => {
    expect(readPreferences()).toMatchObject({ version: 3, theme: 'system', contentWidth: 1000, fontSize: 16 });
    values.set('ai-harness-preferences-v3', '{broken');
    expect(readPreferences()).toMatchObject({ theme: 'system', selectionActions: true });
  });

  it('validates, bounds, persists, and applies preferences', () => {
    writePreferences({
      ...readPreferences(),
      theme: 'pine',
      contentWidth: 99_999,
      fontSize: 1,
      reasoningOpen: true,
      sound: true,
      soundVolume: 2,
      pushNotifications: true,
      selectionActions: false,
      filesOpen: false,
      sidebarVisible: true,
      lastSettingsSection: 'shortcuts',
      keybindings: { newSession: 'Mod+N' } as never,
    });
    expect(JSON.parse(values.get('ai-harness-preferences-v3')!)).toMatchObject({
      version: 3, theme: 'pine', contentWidth: 2000, fontSize: 12, soundVolume: 1, pushNotifications: true,
    });
    expect(document.documentElement.dataset.theme).toBe('pine');
    expect(properties.get('--content-width')).toBe('2000px');
    expect(properties.get('--base-font-size')).toBe('12px');

    writePreferences({ ...readPreferences(), theme: 'system', keybindings: {} as never });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('migrates v1 panel and appearance state into the current schema', () => {
    values.set('ai-harness-preferences-v1', JSON.stringify({
      version: 1, theme: 'rose', filesOpen: false, sidebarVisible: false,
      contentWidth: 1200, fontSize: 18, lastSettingsSection: 'shortcuts',
    }));
    expect(readPreferences()).toMatchObject({
      version: 3, theme: 'rose', filesOpen: false, sidebarVisible: false,
      contentWidth: 1200, fontSize: 18, lastSettingsSection: 'shortcuts',
    });
    expect(JSON.parse(values.get('ai-harness-preferences-v3')!)).toMatchObject({
      version: 3, filesOpen: false, sidebarVisible: false,
    });
  });

  it('rejects unknown themes and coerces boolean values conservatively', () => {
    values.set('ai-harness-preferences-v1', JSON.stringify({
      version: 999, theme: 'malicious', contentWidth: 900, fontSize: 20,
      reasoningOpen: 'yes', sound: 1, notifications: true, selectionActions: false,
    }));
    expect(readPreferences()).toEqual({
      version: 3, theme: 'system', contentWidth: 900, fontSize: 20,
      reasoningOpen: false, sound: false, soundVolume: .25,
      soundEvents: { completion: true, attention: true },
      notifications: true, pushNotifications: false,
      notificationEvents: { completion: true, attention: true },
      pushEvents: { completion: true, attention: true }, selectionActions: false,
      filesOpen: true, sidebarVisible: true, lastSettingsSection: 'appearance',
      keybindings: expect.objectContaining({ commandPalette: 'Mod+K', newSession: 'Mod+Shift+O' }),
    });
  });
});
