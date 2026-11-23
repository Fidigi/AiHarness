import { describe, expect, it } from 'vitest';
import { replyMessages } from './reply-messages';

describe('reply evidence copy', () => {
  it('provides the supported French notice/action without global dictionary registration', () => {
    expect(replyMessages('fr')).toEqual({ truncated: 'Limite de sortie. Demandez la suite.', compact: 'Compacter le contexte' });
  });
  it('keeps English fallback and stable built-in copy', () => {
    expect(replyMessages('en')).toEqual({ truncated: 'Output limit reached. Ask to continue.', compact: 'Compact context' });
    expect(replyMessages('unregistered')).toBe(replyMessages('en'));
  });
});
