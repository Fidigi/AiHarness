import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ButtonHTMLAttributes, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import TerminalExtraKeys, { terminalControlMessages, useTerminalExtraKeysVisible } from './TerminalExtraKeys';
import { NO_TERMINAL_MODIFIERS } from './terminal-extra-keys';
const hooks = vi.hoisted(() => ({ subscribe: undefined as ((listener: () => void) => () => void) | undefined, server: undefined as (() => boolean) | undefined }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, get: () => boolean, server: () => boolean) => {
    hooks.subscribe = subscribe; hooks.server = server; return get();
  },
}));
afterEach(() => vi.unstubAllGlobals());
function buttons(disabled = false) {
  const onKey = vi.fn(), onModifier = vi.fn();
  const tree = TerminalExtraKeys({ disabled, modifiers: { ctrl: true, alt: false }, locale: 'en', onKey, onModifier });
  return { onKey, onModifier, elements: (tree.props as { children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>[] }).children };
}
function pointer(button = 0, isPrimary = true) { return { button, isPrimary, preventDefault: vi.fn() }; }
describe('literal extra-key controls and touch-portrait ownership', () => {
  it('retains native focus on a primary press, uses one command, and does not duplicate its click', () => {
    const b = buttons(); const up = b.elements.find(el => el.key === 'ArrowUp')!;
    const press = pointer(); up.props.onPointerDown!(press as unknown as ReactPointerEvent<HTMLButtonElement>);
    expect(press.preventDefault).toHaveBeenCalledOnce(); expect(b.onKey).toHaveBeenCalledExactlyOnceWith('ArrowUp');
    up.props.onClick!({ detail: 1 } as ReactMouseEvent<HTMLButtonElement>); expect(b.onKey).toHaveBeenCalledTimes(1);
    const mouse = pointer(); up.props.onMouseDown!(mouse as unknown as ReactMouseEvent<HTMLButtonElement>);
    expect(mouse.preventDefault).toHaveBeenCalledOnce();
  });
  it('supports native keyboard/assistive clicks, real toggle state and inactive guards', () => {
    const b = buttons(); const ctrl = b.elements.find(el => el.key === 'ctrl')!;
    expect(ctrl.props['aria-pressed']).toBe(true);
    ctrl.props.onClick!({ detail: 0 } as ReactMouseEvent<HTMLButtonElement>);
    expect(b.onModifier).toHaveBeenCalledExactlyOnceWith('ctrl');
    for (const press of [pointer(2), pointer(0, false)]) ctrl.props.onPointerDown!(press as unknown as ReactPointerEvent<HTMLButtonElement>);
    expect(b.onModifier).toHaveBeenCalledTimes(1);
    const disabled = buttons(true);
    for (const el of disabled.elements) {
      expect(el.props.disabled).toBe(true);
      el.props.onClick!({ detail: 0 } as ReactMouseEvent<HTMLButtonElement>);
      el.props.onPointerDown!(pointer() as unknown as ReactPointerEvent<HTMLButtonElement>);
    }
    expect(disabled.onModifier).not.toHaveBeenCalled(); expect(disabled.onKey).not.toHaveBeenCalled();
    expect(NO_TERMINAL_MODIFIERS).toEqual({ ctrl: false, alt: false });
  });
  it('keeps new copy lazy/local, bilingual and no arbitrary executable key names', () => {
    expect(terminalControlMessages('fr')).toMatchObject({ keys: 'Touches supplémentaires du terminal', theme: 'Thème du terminal', ArrowLeft: 'Gauche' });
    expect(terminalControlMessages('en')).toMatchObject({ keys: 'Terminal extra keys', theme: 'Terminal theme', ArrowLeft: 'Left' });
    expect(terminalControlMessages('unknown')).toEqual(terminalControlMessages('en'));
    expect(buttons().elements).toHaveLength(14);
  });
  it('uses physical orientation so keyboard-only height loss cannot hide keys; disposes all listeners', () => {
    const coarse = Object.assign(new EventTarget(), { matches: true });
    const orientation = Object.assign(new EventTarget(), { type: 'portrait-primary' });
    const browser = Object.assign(new EventTarget(), { screen: { orientation }, innerHeight: 844, innerWidth: 390, matchMedia: () => coarse });
    vi.stubGlobal('window', browser);
    expect(useTerminalExtraKeysVisible()).toBe(true); expect(hooks.server!()).toBe(false);
    const callback = vi.fn(), add = vi.spyOn(browser, 'addEventListener'), remove = vi.spyOn(browser, 'removeEventListener');
    const stop = hooks.subscribe!(callback);
    browser.innerHeight = 300; browser.dispatchEvent(new Event('resize'));
    expect(useTerminalExtraKeysVisible()).toBe(true);
    orientation.type = 'landscape-primary'; orientation.dispatchEvent(new Event('change'));
    expect(useTerminalExtraKeysVisible()).toBe(false);
    orientation.type = 'portrait-secondary'; coarse.matches = false; coarse.dispatchEvent(new Event('change'));
    expect(useTerminalExtraKeysVisible()).toBe(false); expect(callback).toHaveBeenCalledTimes(3);
    stop(); expect(remove.mock.calls).toEqual(add.mock.calls);
    orientation.dispatchEvent(new Event('change')); coarse.dispatchEvent(new Event('change')); browser.dispatchEvent(new Event('resize'));
    expect(callback).toHaveBeenCalledTimes(3);
  });
  it('supports legacy orientation and conservative dimensions when no screen orientation exists', () => {
    const browser = { screen: {}, orientation: 90 as number | undefined, innerHeight: 844, innerWidth: 390, matchMedia: () => ({ matches: true }) };
    vi.stubGlobal('window', browser); expect(useTerminalExtraKeysVisible()).toBe(false);
    browser.orientation = 180; expect(useTerminalExtraKeysVisible()).toBe(true);
    browser.orientation = undefined; expect(useTerminalExtraKeysVisible()).toBe(true);
    browser.innerWidth = 900; expect(useTerminalExtraKeysVisible()).toBe(false);
  });
});
