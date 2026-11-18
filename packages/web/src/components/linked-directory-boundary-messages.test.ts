import { expect, it } from 'vitest';
import { linkedDirectoryBoundaryMessages } from './linked-directory-boundary-messages';
it('keeps parallel local boundary copy and an explicit truthful page reload retry', () => {
  const en = linkedDirectoryBoundaryMessages('en'); const fr = linkedDirectoryBoundaryMessages('fr-FR');
  expect(Object.keys(fr)).toEqual(Object.keys(en));
  expect(en.failed).toContain('No new access was granted');
  expect(en.reload).toBe('Reload page to retry');
  expect(en.unsent).toContain('unsent text may be lost');
  for (const text of Object.values(fr)) expect(text.trim()).not.toBe('');
  expect(fr.unsent).toContain('non envoyé');
});
