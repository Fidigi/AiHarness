import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSettingsNavigation, writeSettingsNavigation, settingsScopeControls } from './settings-navigation';
import { useSettingsScope } from './use-settings-scope';
const hooks = vi.hoisted(() => ({ value: undefined as unknown, workspace: { cwd: '/one' } as { cwd: string } | undefined }));
vi.mock('react', () => ({ useState: (initial: () => unknown) => {
  hooks.value ??= initial(); return [hooks.value, (next: unknown) => { hooks.value = next; }];
} }));
vi.mock('./session-store', () => ({ useSessionStore: (select: (state: { workspace?: { cwd: string } }) => unknown) => select({ workspace: hooks.workspace }) }));
let values: Map<string, string>;
beforeEach(() => {
  hooks.value = undefined; hooks.workspace = { cwd: '/one' }; values = new Map();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('mounted Settings scope intent', () => {
  it.each(settingsScopeControls)('%s restores its own scope at the keyed context mount without changing navigation or another control', control => {
    writeSettingsNavigation('/one', { section: 'mcp', positions: { skills: { selection: 'skill' } }, scopes: {} });
    const [initial, update] = useSettingsScope(control, 'project'); expect(initial).toBe('project'); update('global');
    expect(readSettingsNavigation('/one')).toEqual({ section: 'mcp', positions: { skills: { selection: 'skill' } }, scopes: { [control]: 'global' } });
    hooks.value = undefined; let [scope] = useSettingsScope(control, 'project'); expect(scope).toBe('global');
    hooks.value = undefined; hooks.workspace = { cwd: '/two' }; [scope] = useSettingsScope(control, 'project'); expect(scope).toBe('project');
    hooks.value = undefined; hooks.workspace = undefined; [scope] = useSettingsScope(control, 'project'); expect(scope).toBe('global');
  });
  it('keeps an own scope change while storage is denied, without synthesizing project availability', () => {
    window.localStorage.setItem = () => { throw Error('denied'); };
    const [initial, update] = useSettingsScope('tools', 'project'); expect(initial).toBe('project'); update('global');
    let [scope] = useSettingsScope('tools', 'project'); expect(scope).toBe('global');
    hooks.workspace = undefined; update('project'); [scope] = useSettingsScope('tools', 'project'); expect(scope).toBe('global');
  });
});
