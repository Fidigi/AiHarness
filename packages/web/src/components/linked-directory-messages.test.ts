import { describe, expect, it } from 'vitest';
import { linkedDirectoryFailure, linkedDirectoryLiteral, linkedDirectoryMessages } from './linked-directory-messages';

describe('linked directory presentation', () => {
  it('provides parallel EN/FR visible reasons, failures, loading and independent trust warnings', () => {
    const en = linkedDirectoryMessages('en'); const fr = linkedDirectoryMessages('fr-FR');
    expect(Object.keys(fr)).toEqual(Object.keys(en));
    for (const text of Object.values(fr)) expect(text.trim()).not.toBe('');
    expect(en.risk).toContain('does not grant project trust');
    expect(en.restriction).toContain('provider maintenance scanners');
    expect(linkedDirectoryFailure('en', 'store-unavailable')).toContain('No allowance');
    expect(linkedDirectoryFailure('fr', 'PROVIDER_REFERENCE_OWNER_UNAVAILABLE')).toContain('maintenance');
    expect(linkedDirectoryFailure('en', 'UNKNOWN_PRIVATE_SECRET')).toBe(en.failure);
    expect(linkedDirectoryFailure('en', '__proto__')).toBe(en.failure);
    expect(linkedDirectoryFailure('fr', 'constructor')).toBe(fr.failure);
  });
  it('exposes hidden bidi/format/control characters as exact escaped literals without mutating values', () => {
    const raw = '../hidden\u202e\u200b\n\t"\\target';
    const rendered = linkedDirectoryLiteral(raw);
    expect(rendered).toBe('"../hidden\\u202e\\u200b\\n\\t\\"\\\\target"');
    expect(JSON.parse(rendered)).toBe(raw);
    expect(rendered).not.toMatch(/[\u202e\u200b\n\t]/u);
  });
});
