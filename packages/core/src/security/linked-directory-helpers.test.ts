import { describe, expect, it } from 'vitest';
import { linkedDirectoryHasHiddenCharacters, parseLinkedDirectoryStoreJson } from './linked-directory-helpers.js';
describe('linked directory metadata helpers', () => {
  it('detects bidi, controls, invisible marks and nonstandard spaces but not ordinary names', () => {
    expect(linkedDirectoryHasHiddenCharacters('ordinary project')).toBe(false);
    for (const value of ['a\u202e', '\u200b', '\u034f', '\u3164', '\u00a0', '\n']) expect(linkedDirectoryHasHiddenCharacters(value)).toBe(true);
  });
  it('bounds store syntax depth before parsing while treating braces inside strings as data', () => {
    expect(parseLinkedDirectoryStoreJson('{"value":"[[[[[[[[[[[[[[[[["}')).toEqual({ value: '[[[[[[[[[[[[[[[[[' });
    expect(() => parseLinkedDirectoryStoreJson(`${'['.repeat(9)}0${']'.repeat(9)}`)).toThrow();
  });
});
