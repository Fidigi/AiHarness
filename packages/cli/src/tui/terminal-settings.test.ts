import { describe, expect, it } from 'vitest';
import { unsupportedCliSettings } from './terminal-settings.js';

describe('terminal stored-only settings projection', () => {
  it('reports only the still-inert blockImages setting, not effective image autoResize', () => {
    expect(unsupportedCliSettings({ images: { autoResize: false } })).toEqual([]);
    expect(unsupportedCliSettings({ images: { autoResize: true, blockImages: true } })).toEqual(['images.blockImages']);
  });
  it('does not describe implemented cache warming as stored-only', () => {
    for (const cacheWarming of ['off', 'streaming', 'idle'] as const) {
      expect(unsupportedCliSettings({ cacheWarming })).toEqual([]);
    }
  });
  it('does not describe the historical cache-notice control as stored-only', () => {
    expect(unsupportedCliSettings({ cacheWarming: 'streaming', showCacheMissNotices: false })).toEqual([]);
  });
});
