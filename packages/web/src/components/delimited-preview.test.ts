import { describe, expect, it } from 'vitest';
import { parseDelimited } from './delimited-preview';

describe('bounded literal CSV/TSV preview', () => {
  it('handles BOM, quoted delimiters/newlines/escaped quotes, CRLF, trailing empty fields and ragged rows', () => {
    expect(parseDelimited('\uFEFFname,value\r\n"a,b","line1\nline2"\r\n"a""b",\r\nlast', ','))
      .toEqual([['name', 'value'], ['a,b', 'line1\nline2'], ['a"b', ''], ['last']]);
    expect(parseDelimited('one\ttwo\n"x\ty"\t=SUM(1,2)', '\t')).toEqual([['one', 'two'], ['x\ty', '=SUM(1,2)']]);
    expect(parseDelimited('', ',')).toEqual([]);
  });
  it.each(['"unterminated', 'unquoted"value', '"closed"junk'])('rejects malformed quoting', value => {
    expect(() => parseDelimited(value, ',')).toThrow('invalid');
  });
  it.each(['x'.repeat(2 * 1024 * 1024 + 1), 'x'.repeat(16_385), Array(65).fill('x').join(','),
    Array(501).fill('x').join('\n'), Array(400).fill(Array(64).fill('x').join(',')).join('\n')])('refuses finite input/cell/column/row/total limits', value => {
    expect(() => parseDelimited(value, ',')).toThrow('limit');
  });
});
