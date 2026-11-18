import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useI18n } from '../hooks/useI18n';
import { publishNotice } from '../services/notices';

type PaletteProps = { onClose: () => void };
let load: Promise<ComponentType<PaletteProps>> | undefined;

/** Closed palettes fetch nothing. Pending imports never suspend the app or own focus. */
export default function CommandPaletteBoundary({ onClose }: PaletteProps) {
  const { locale } = useI18n();
  const close = useRef(onClose);
  close.current = onClose;
  const [Palette, setPalette] = useState<ComponentType<PaletteProps>>();
  useEffect(() => {
    let current = true;
    // Retain rejections as well as success: retrying a failed ESM load needs reload.
    load ??= import('./CommandPalette').then(module => module.default);
    void load.then(component => {
      if (current) setPalette(() => component);
    }, () => {
      if (!current) return;
      publishNotice(locale.startsWith('fr')
        ? 'La palette de commandes n’a pas pu être chargée. Rechargez la page pour réessayer.'
        : 'The command palette could not load. Reload the page to try again.',
      { id: 'command-palette-load', level: 'error', timeoutMs: 0 });
      close.current();
    });
    return () => { current = false; };
  }, [locale]);
  return Palette ? <Palette onClose={onClose} /> : null;
}
