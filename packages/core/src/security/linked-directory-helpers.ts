import { LinkedDirectoryError } from './linked-directory-types.js';

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;
export function linkedDirectoryHasHiddenCharacters(value: string): boolean { return HIDDEN.test(value); }

/** Bound syntax depth before JSON parsing. The consent schema itself has depth three. */
export function parseLinkedDirectoryStoreJson(text: string): unknown {
  let depth = 0; let inString = false; let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{' || character === '[') {
      if (++depth > 8) throw new LinkedDirectoryError('store-unavailable');
    } else if (character === '}' || character === ']') depth--;
  }
  return JSON.parse(text) as unknown;
}
