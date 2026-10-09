import { describe, expect, it } from 'vitest';
import { getMarkdownListContinuation } from './markdown-list-continuation';

function edit(value: string, start = value.length, end = start) { return getMarkdownListContinuation(value, start, end); }
describe('composer Markdown list continuation', () => {
  it('continues bullets, indentation, numbered padding, delimiters and CJK enumeration', () => {
    for (const [value, next] of [['- one', '\n- '], ['  + nested', '\n  + '], ['\t* tab', '\n\t* '], ['009. item', '\n010. '], ['2) item', '\n3) '], ['1、项目', '\n2、'], ['12、 项目', '\n13、 ']]) {
      expect(edit(value!)).toEqual({ start: value!.length, end: value!.length, text: next });
    }
  });
  it('resets checked tasks and exits empty items', () => {
    expect(edit('- [x] done')?.text).toBe('\n- [ ] ');
    expect(edit('2. [X] done')?.text).toBe('\n3. [ ] ');
    expect(edit('prior\n  - [ ] ')).toEqual({ start: 6, end: 14, text: '' });
    expect(edit('1. ')).toEqual({ start: 0, end: 3, text: '' });
  });
  it('splits at the caret, but never replaces selections or item prefixes', () => {
    expect(edit('- first second', 7)?.text).toBe('\n- ');
    expect(edit('- first', 2, 7)).toBeNull();
    expect(edit('- first', 1)).toBeNull();
    expect(edit('prose')).toBeNull();
    expect(edit('2020、2021年')).toBeNull();
    expect(edit('---')).toBeNull();
    expect(edit('* * *')).toBeNull();
  });
  it('ignores fences until a matching bare closing marker, not a shorter/mismatched marker', () => {
    for (const value of ['```md\n- code', '~~~~md\n```\n- code', '````\n```\n- code', '```\n```not-a-close\n- code']) expect(edit(value)).toBeNull();
    expect(edit('```md\n- code\n```\n- actual')?.text).toBe('\n- ');
    expect(edit('~~~\n+ code\n~~~~\n+ actual')?.text).toBe('\n+ ');
  });
});
