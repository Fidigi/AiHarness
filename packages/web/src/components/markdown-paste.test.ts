import { describe, expect, it } from 'vitest';
import { clipboardMetadataLimits, clipboardTextToMarkdown, replaceClipboardLinks } from './markdown-paste';

describe('plain-text clipboard links', () => {
  it('keeps pasted plain lines, whitespace, numbering and CRLF unchanged', () => {
    const text = '  First\r\nSecond\r\n\r\n1、第三\n\tfinal  ';
    expect(replaceClipboardLinks(text, [])).toBe(text);
  });
  it('rewrites labelled safe links without changing surrounding line layout', () => {
    expect(replaceClipboardLinks('first\nDocs\nlast', [{ label: 'Docs', href: 'https://example.com/docs' }]))
      .toBe('first\n[Docs](https://example.com/docs)\nlast');
    expect(replaceClipboardLinks('Docs Docs', [{ label: 'Docs', href: 'file:README.md', occurrence: 1 }])).toBe('Docs [Docs](file:README.md)');
  });
  it('bounds optional metadata without truncating or normalizing plain text', () => {
    const text = '  Docs\r\n\t原文  '.repeat(10_000);
    const link = { label: 'Docs', href: 'https://example.com' };
    expect(clipboardTextToMarkdown(text, 'x'.repeat(clipboardMetadataLimits.htmlLength + 1))).toBe(text);
    expect(replaceClipboardLinks(text, Array.from({ length: clipboardMetadataLimits.links + 1 }, () => link))).toBe(text);
    expect(replaceClipboardLinks(text, [{ ...link, label: 'x'.repeat(clipboardMetadataLimits.labelLength + 1) }])).toBe(text);
    expect(replaceClipboardLinks(text, [{ ...link, href: 'https://a.com/' + 'x'.repeat(clipboardMetadataLimits.hrefLength) }])).toBe(text);
    for (const occurrence of [-1, 0.5, Infinity, NaN, clipboardMetadataLimits.nodes + 1]) {
      expect(replaceClipboardLinks(text, [{ ...link, occurrence }])).toBe(text);
    }
    expect(clipboardTextToMarkdown(text, '')).toBe(text);
    expect(clipboardTextToMarkdown('', '<a href="https://example.com">Docs</a>')).toBe('');
    // A DOM-unavailable metadata parse is optional; plaintext must still survive.
    expect(clipboardTextToMarkdown(text, '<a href="https://example.com">Docs</a>')).toBe(text);
  });
  it('rejects executable/ambiguous URLs and escapes Markdown delimiters', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,danger', ' https://a.com/\nattack', 'https://a.com/\u0000attack']) {
      expect(replaceClipboardLinks('label', [{ label: 'label', href }])).toBe('label');
    }
    expect(replaceClipboardLinks('a]b', [{ label: 'a]b', href: 'https://example.com/(x)' }])).toBe('[a\\]b](https://example.com/%28x%29)');
    expect(replaceClipboardLinks('https://a.com', [{ label: 'https://a.com', href: 'https://a.com' }])).toBe('https://a.com');
    expect(replaceClipboardLinks('[Docs](https://a.com)', [{ label: 'Docs', href: 'https://b.com' }])).toBe('[Docs](https://a.com)');
    expect(replaceClipboardLinks('missing', [{ label: 'Docs', href: 'https://a.com' }])).toBe('missing');
  });
});
