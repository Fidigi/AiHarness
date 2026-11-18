import type { SendMode } from '../store/preferences';

export interface ComposerSubmitKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** Whether a composer key should submit rather than insert a line break. */
export function composerKeySubmits(event: ComposerSubmitKey, mode: SendMode): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return false;
  return mode === 'enter' || event.ctrlKey || event.metaKey;
}
