import { createContext, useContext, useLayoutEffect } from 'react';
import type { Locale } from '../i18n/types';

/** Only dirty flags live here; draft values remain in their owning forms. */
export const SettingsDraftContext = createContext<Set<symbol> | null>(null);

export function useSettingsDraft(dirty: boolean): void {
  const drafts = useContext(SettingsDraftContext);
  useLayoutEffect(() => {
    if (!dirty || !drafts) return;
    const entry = Symbol();
    drafts.add(entry);
    return () => { drafts.delete(entry); };
  }, [dirty, drafts]);
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
