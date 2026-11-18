import { describe, expect, it } from 'vitest';
import { composerKeySubmits, type ComposerSubmitKey } from './composer-submit';

const enter = (changes: Partial<ComposerSubmitKey> = {}): ComposerSubmitKey => ({
  key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, ...changes,
});

describe('composerKeySubmits', () => {
  it('submits plain Enter in the default mode while preserving Shift+Enter', () => {
    expect(composerKeySubmits(enter(), 'enter')).toBe(true);
    expect(composerKeySubmits(enter({ shiftKey: true }), 'enter')).toBe(false);
  });

  it('requires Control or Command in mod-enter mode', () => {
    expect(composerKeySubmits(enter(), 'mod-enter')).toBe(false);
    expect(composerKeySubmits(enter({ ctrlKey: true }), 'mod-enter')).toBe(true);
    expect(composerKeySubmits(enter({ metaKey: true }), 'mod-enter')).toBe(true);
  });

  it('never submits IME confirmation keys, including Safari keyCode 229', () => {
    expect(composerKeySubmits(enter({ isComposing: true }), 'enter')).toBe(false);
    expect(composerKeySubmits(enter({ ctrlKey: true, keyCode: 229 }), 'mod-enter')).toBe(false);
    expect(composerKeySubmits(enter({ key: 'a' }), 'enter')).toBe(false);
  });
});
