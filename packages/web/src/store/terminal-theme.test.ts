import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ subscribe: undefined as ((listener: () => void) => () => void) | undefined }));
vi.mock('react', () => ({ useSyncExternalStore: (subscribe: (listener: () => void) => () => void, get: () => unknown) => {
  hooks.subscribe = subscribe; return get();
} }));
let values: Map<string, string>, browser: EventTarget & { localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void } };
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.resetModules(); values = new Map(); hooks.subscribe = undefined;
  browser = Object.assign(new EventTarget(), { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  vi.stubGlobal('window', browser);
});
afterEach(() => { cleanup.splice(0).forEach(stop => stop()); vi.unstubAllGlobals(); });
function peer(key: string | null, storageArea?: unknown): void {
  browser.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea }));
}
describe('terminal-only optional browser theme preference', () => {
  it('admits only the literal bounded enum and conserves the original default palette', async () => {
    const m = await import('./terminal-theme');
    for (const value of [null, undefined, {}, true, 0, 'LIGHT', 'system', 'dark', '<script>', 'x'.repeat(100_000)]) expect(m.parseTerminalTheme(value)).toBe('dark');
    expect(m.parseTerminalTheme('light')).toBe('light');
    expect(m.TERMINAL_THEMES.dark).toEqual({ background: '#111827', foreground: '#e5e7eb', cursor: '#a4c2f4', selectionBackground: '#334155' });
    expect(m.TERMINAL_THEMES.light).toMatchObject({ background: '#f8fafc', foreground: '#1e293b', white: '#64748b', brightWhite: '#475569' });
    expect(Object.isFrozen(m.TERMINAL_THEMES)).toBe(true); expect(Object.isFrozen(m.TERMINAL_THEMES.light)).toBe(true);
  });
  it('publishes own writes, restores a choice and never rewrites application preferences', async () => {
    const m = await import('./terminal-theme'); values.set(m.TERMINAL_THEME_KEY, 'light');
    values.set('ai-harness-preferences-v4', '{"theme":"pine"}');
    expect(m.useTerminalTheme()).toBe('light');
    const listener = vi.fn(); cleanup.push(hooks.subscribe!(listener));
    m.setTerminalTheme('dark'); expect(listener).toHaveBeenCalledTimes(1);
    expect(m.useTerminalTheme()).toBe('dark'); expect(values.get(m.TERMINAL_THEME_KEY)).toBe('dark');
    expect(values.get('ai-harness-preferences-v4')).toBe('{"theme":"pine"}');
  });
  it('retains an early own write through denied storage and first subscription/remount', async () => {
    const m = await import('./terminal-theme');
    browser.localStorage.setItem = () => { throw Error('blocked'); };
    m.setTerminalTheme('light'); expect(m.useTerminalTheme()).toBe('light');
    const stop = hooks.subscribe!(vi.fn()); expect(m.useTerminalTheme()).toBe('light'); stop();
    cleanup.push(hooks.subscribe!(vi.fn())); expect(m.useTerminalTheme()).toBe('light');
    browser.localStorage.getItem = () => { throw Error('blocked'); };
    expect(m.useTerminalTheme()).toBe('light');
  });
  it('reconciles exact peer writes/clear and ignores unrelated/session storage events', async () => {
    const m = await import('./terminal-theme'); expect(m.useTerminalTheme()).toBe('dark');
    const listener = vi.fn(); cleanup.push(hooks.subscribe!(listener));
    values.set(m.TERMINAL_THEME_KEY, 'light'); peer('other'); peer(m.TERMINAL_THEME_KEY, {});
    expect(listener).not.toHaveBeenCalled(); expect(m.useTerminalTheme()).toBe('dark');
    peer(m.TERMINAL_THEME_KEY, browser.localStorage); expect(m.useTerminalTheme()).toBe('light');
    values.clear(); peer(null); expect(m.useTerminalTheme()).toBe('dark'); expect(listener).toHaveBeenCalledTimes(2);
  });
  it('owns one shared storage listener and rereads a choice made with no subscribers', async () => {
    const m = await import('./terminal-theme'); m.useTerminalTheme();
    const add = vi.spyOn(browser, 'addEventListener'), remove = vi.spyOn(browser, 'removeEventListener');
    const first = hooks.subscribe!(vi.fn()), second = hooks.subscribe!(vi.fn());
    expect(add).toHaveBeenCalledTimes(1); first(); expect(remove).not.toHaveBeenCalled();
    second(); expect(remove).toHaveBeenCalledTimes(1);
    values.set(m.TERMINAL_THEME_KEY, 'light'); cleanup.push(hooks.subscribe!(vi.fn()));
    expect(m.useTerminalTheme()).toBe('light');
  });
});
