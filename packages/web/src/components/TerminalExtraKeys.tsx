import { useSyncExternalStore } from 'react';
import { TERMINAL_EXTRA_KEYS, type TerminalExtraKey, type TerminalModifier, type TerminalModifiers } from './terminal-extra-keys';

function portrait(): boolean {
  const orientation = window.screen.orientation?.type;
  if (orientation) return orientation.startsWith('portrait');
  const angle = (window as Window & { orientation?: number }).orientation;
  return typeof angle === 'number' ? angle % 180 === 0 : window.innerHeight >= window.innerWidth;
}
const visible = () => window.matchMedia('(pointer: coarse)').matches && portrait();
function subscribe(listener: () => void): () => void {
  const coarse = window.matchMedia('(pointer: coarse)');
  coarse.addEventListener('change', listener);
  window.screen.orientation?.addEventListener('change', listener);
  window.addEventListener('orientationchange', listener);
  window.addEventListener('resize', listener);
  return () => {
    coarse.removeEventListener('change', listener);
    window.screen.orientation?.removeEventListener('change', listener);
    window.removeEventListener('orientationchange', listener);
    window.removeEventListener('resize', listener);
  };
}
export function useTerminalExtraKeysVisible(): boolean { return useSyncExternalStore(subscribe, visible, () => false); }
const labels: Record<TerminalExtraKey | TerminalModifier, string> = {
  Escape: 'ESC', '/': '/', '-': '-', Home: 'HOME', ArrowUp: '↑', End: 'END', PageUp: 'PGUP',
  Tab: 'TAB', ctrl: 'CTRL', alt: 'ALT', ArrowLeft: '←', ArrowDown: '↓', ArrowRight: '→', PageDown: 'PGDN',
};
export function terminalControlMessages(locale: string) {
  return locale === 'fr'
    ? { keys: 'Touches supplémentaires du terminal', theme: 'Thème du terminal', dark: 'Sombre', light: 'Clair',
      ArrowUp: 'Haut', ArrowDown: 'Bas', ArrowLeft: 'Gauche', ArrowRight: 'Droite' }
    : { keys: 'Terminal extra keys', theme: 'Terminal theme', dark: 'Dark', light: 'Light',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
}
export default function TerminalExtraKeys({ disabled, modifiers, locale, onKey, onModifier }: {
  disabled: boolean; modifiers: Readonly<TerminalModifiers>; locale: string;
  onKey(key: TerminalExtraKey): void; onModifier(key: TerminalModifier): void;
}) {
  const messages = terminalControlMessages(locale);
  return <div className="terminal-extra-keys" role="group" aria-label={messages.keys}>
    {TERMINAL_EXTRA_KEYS.map(key => {
      const modifier = key === 'ctrl' || key === 'alt';
      const invoke = () => modifier ? onModifier(key) : onKey(key);
      return <button type="button" key={key} disabled={disabled}
        aria-label={key in messages ? messages[key as keyof typeof messages] : undefined}
        aria-pressed={modifier ? modifiers[key] : undefined}
        onPointerDown={event => {
          // Retain the xterm textarea and its mobile keyboard; secondary pointers never type.
          event.preventDefault();
          if (event.button === 0 && event.isPrimary && !disabled) invoke();
        }}
        onMouseDown={event => event.preventDefault()}
        onClick={event => { if (event.detail === 0 && !disabled) invoke(); }}>
        {labels[key]}
      </button>;
    })}
  </div>;
}
