import { describe, expect, it } from 'vitest';
import { clipTerminalText, TerminalTextFilter, tailTerminalText, terminalText, terminalWidth, wrapTerminalText } from './terminal-text.js';

describe('terminal text safety', () => {
  it('discards OSC clipboard/title/link, cursor, alternate-screen and string controls', () => {
    const hostile = 'user\x1b]52;c;SECRET\x07text\x1b[2J\x1b[?1049h\x1b]0;title\x1b\\'
      + '\u009d52;c;C1\u009c\x1bPpayload\x1b\\\x1b_coded\x1b\\\r\b\x07\u202eend';
    expect(terminalText(hostile)).toBe('usertextend');
    expect(terminalText('\x1b[31mred\x1b[0m')).toBe('red');
    expect(terminalText('\x1b[31mred\x1b[0m\x1b[2J', true)).toBe('\x1b[31mred\x1b[0m');
  });

  it('filters escape sequences across every possible split without buffering payloads', () => {
    const source = 'a\x1b]52;c;SECRET\x1b\\b\x1b[2Jc\u009dtitle\u009cd';
    for (let split = 0; split <= source.length; split++) {
      const filter = new TerminalTextFilter();
      expect(filter.push(source.slice(0, split)) + filter.push(source.slice(split))).toBe('abcd');
    }
    const filter = new TerminalTextFilter();
    expect(filter.push('a\x1b]')).toBe('a');
    expect(filter.push('x'.repeat(1_000_000))).toBe('');
    expect(filter.push('\x07b')).toBe('b');
  });

  it('handles one huge combining cluster without spreading it into call arguments', () => {
    const cluster = 'a' + '\u0301'.repeat(200_000);
    expect(terminalWidth(cluster)).toBe(1);
    expect(clipTerminalText(cluster + 'b', 1)).toBe(cluster);
    expect(tailTerminalText('b' + cluster, 1)).toBe(cluster);
    expect(wrapTerminalText(cluster + 'b', 1)).toEqual([cluster, 'b']);
    expect(terminalWidth('\u0301'.repeat(200_000))).toBe(0);
  });

  it.each(['🇺🇸', '🇯🇵', '1️⃣', '#️⃣', '*⃣', '©️', '♥️', '☀️', '⌚'])('measures conventional two-cell emoji %s in every layout helper', emoji => {
    expect(terminalWidth(emoji)).toBe(2);
    expect(clipTerminalText(emoji, 1)).toBe('');
    expect(clipTerminalText(emoji + 'x', 2)).toBe(emoji);
    expect(tailTerminalText('x' + emoji, 2)).toBe(emoji);
    expect(tailTerminalText(emoji, 1)).toBe('');
    expect(wrapTerminalText(emoji + 'x', 2)).toEqual([emoji, 'x']);
    expect(wrapTerminalText(emoji, 1)).toEqual(['?']);
  });

  it('keeps narrow text presentation and combining-only clusters narrow', () => {
    expect(terminalWidth('a\u0301©♥☀1#*')).toBe(7);
    expect(terminalWidth('\u0301\ufe0f')).toBe(0);
    expect(terminalWidth('a\ufe0f')).toBe(1);
    expect(terminalWidth('🇺🇸🇯🇵')).toBe(4);
  });

  it('preserves trusted styling and measures/clips graphemes in terminal cells', () => {
    expect(terminalWidth('界🙂e\u0301')).toBe(5);
    expect(terminalWidth('👩‍💻')).toBe(2);
    expect(clipTerminalText('\x1b[31m界🙂e\u0301\x1b[0m', 4)).toBe('\x1b[31m界🙂\x1b[0m');
    expect(wrapTerminalText('界🙂e\u0301', 2)).toEqual(['界', '🙂', 'e\u0301']);
    expect(wrapTerminalText('界', 1)).toEqual(['?']);
    expect(tailTerminalText('abc界👩‍💻', 4)).toBe('界👩‍💻');
    expect(tailTerminalText('abc界', 1)).toBe('');
    expect(tailTerminalText('x'.repeat(100_000) + 'end', 3)).toBe('end');
  });
});
