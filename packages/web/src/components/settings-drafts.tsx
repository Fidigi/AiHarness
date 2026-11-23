import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Locale } from '../i18n/types';

/** Only dirty flags live here; draft values remain in their owning forms. */
export const SettingsDraftContext = createContext<Set<symbol> | null>(null);

export type SettingsDraftListener = (owner: symbol, dirty: boolean) => void;

export function useSettingsDraft(dirty: boolean, onDraftChange?: SettingsDraftListener): void {
  const drafts = useContext(SettingsDraftContext);
  useLayoutEffect(() => {
    if (!dirty || !drafts && !onDraftChange) return;
    const entry = Symbol();
    drafts?.add(entry); onDraftChange?.(entry, true);
    return () => { drafts?.delete(entry); onDraftChange?.(entry, false); };
  }, [dirty, drafts, onDraftChange]);
}

export const SettingsDiscardContext = createContext<{
  request(owner: symbol, discard: () => void, returnTarget?: HTMLElement | null): void;
  retire(owner: symbol): void;
} | null>(null);

/** Guard an owning form's discard without exposing its values or abandoning peers. */
export function useSettingsDraftGuard(dirty: boolean, returnFocus?: RefObject<HTMLElement | null>): (discard: () => void) => void {
  useSettingsDraft(dirty);
  const commands = useContext(SettingsDiscardContext);
  const owner = useRef(Symbol());
  useLayoutEffect(() => {
    if (!dirty || !commands) return;
    const entry = owner.current;
    return () => commands.retire(entry);
  }, [commands, dirty]);
  return discard => {
    if (dirty && commands) commands.request(owner.current, discard, returnFocus?.current);
    else discard();
  };
}

const messages = {
  en: {
    title: 'Discard unsaved Settings edits?',
    description: 'Unsaved edits will be lost. Saves already started may still finish.',
    keep: 'Keep editing',
    discard: 'Discard edits',
  },
  fr: {
    title: 'Abandonner les modifications non enregistrées des paramètres ?',
    description: 'Les modifications non enregistrées seront perdues. Les enregistrements déjà lancés peuvent encore se terminer.',
    keep: 'Continuer la modification',
    discard: 'Abandonner les modifications',
  },
} as const;

export function settingsDraftMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
