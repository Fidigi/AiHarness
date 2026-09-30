import { describe, expect, it } from 'vitest';
import type { Session } from '@ai-harness/core';
import { escapeHtml, renderSessionHtml, sanitizeFilename } from './session-export';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Conversation de test',
    messages: [],
    createdAt: new Date('2025-01-01T10:00:00.000Z'),
    updatedAt: new Date('2025-01-01T10:00:00.000Z'),
    ...overrides,
  } as Session;
}

describe('session HTML export', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<script data-x="a&b">'x'</script>`)).toBe(
      '&lt;script data-x=&quot;a&amp;b&quot;&gt;&#39;x&#39;&lt;/script&gt;',
    );
  });

  it('renders a standalone document with conversation messages', () => {
    const html = renderSessionHtml(session({
      messages: [
        { id: 'm1', role: 'user', content: 'Bonjour', timestamp: new Date('2025-01-01T10:01:00.000Z') },
        { id: 'm2', role: 'assistant', content: 'Salut !', timestamp: new Date('2025-01-01T10:02:00.000Z') },
      ],
    }));

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('class="message user"');
    expect(html).toContain('class="message assistant"');
    expect(html).toContain('<pre>Salut !</pre>');
  });

  it('does not allow message or title markup injection', () => {
    const html = renderSessionHtml(session({
      title: '<img src=x onerror=alert(1)>',
      messages: [
        { id: 'm1', role: 'user', content: '<script>alert(1)</script>', timestamp: new Date() },
      ],
    }));

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders an explicit empty-state paragraph', () => {
    expect(renderSessionHtml(session())).toContain('aucun message');
  });

  it('sanitizes filenames and preserves readable titles', () => {
    expect(sanitizeFilename(' Projet: test / démo? ')).toBe('Projet- test - démo-');
    expect(sanitizeFilename('...')).toBe('conversation');
  });
});
