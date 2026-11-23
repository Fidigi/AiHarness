import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPreferences, usePreferences } from './preferences';
const hooks = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock('react', () => ({
  useState: (initial: () => unknown) => {
    hooks.state ??= initial();
    return [hooks.state, (next: unknown) => { hooks.state = next; }];
  },
  useEffect: () => {}, // Deliberately before the real passive subscription.
}));
let values: Map<string, string>;
beforeEach(() => {
  hooks.state = undefined; values = new Map();
  values.set('ai-harness-preferences-v4', JSON.stringify({ version: 4, filesOpen: false }));
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }, matchMedia: () => ({ matches: false }), dispatchEvent: vi.fn() });
  vi.stubGlobal('document', { documentElement: { dataset: {}, style: { setProperty: vi.fn() } } });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: unknown) {} });
});
afterEach(() => vi.unstubAllGlobals());
describe('preference writes before passive registration', () => {
  it('owns an early change before broadcasting, retaining it across an unrelated write', () => {
    let [, update] = usePreferences(); update({ filesOpen: true });
    [, update] = usePreferences(); update({ sidebarVisible: false });
    expect(readPreferences()).toMatchObject({ filesOpen: true, sidebarVisible: false });
  });
  it('keeps own state even when optional storage is unavailable and validates it', () => {
    window.localStorage.setItem = () => { throw Error('unavailable'); };
    let [, update] = usePreferences(); update({ filesOpen: true, contentWidth: 99_999 });
    let current; [current, update] = usePreferences();
    expect(current).toMatchObject({ filesOpen: true, contentWidth: 2000 });
    update({ sidebarVisible: false }); [current] = usePreferences();
    expect(current).toMatchObject({ filesOpen: true, sidebarVisible: false });
  });
});
