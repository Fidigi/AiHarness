import { describe, expect, it } from 'vitest';
import { EditorState } from './editor-state.js';

describe('shared native terminal draft', () => {
  it('moves/deletes whole combining, astral, flag and ZWJ graphemes', () => {
    for (const cluster of ['e\u0301', '🙂', '🇫🇷', '👩🏽‍💻', '界']) {
      const editor = new EditorState(); editor.replace('a' + cluster + 'b', 1 + cluster.length);
      editor.perform('editor.left'); expect(editor.snapshot().cursor).toBe(1);
      editor.perform('editor.right'); expect(editor.snapshot().cursor).toBe(1 + cluster.length);
      editor.perform('editor.backspace'); expect(editor.snapshot()).toEqual({ value: 'ab', cursor: 1 });
      editor.perform('editor.undo'); editor.perform('editor.left'); editor.perform('editor.delete');
      expect(editor.snapshot()).toEqual({ value: 'ab', cursor: 1 });
    }
  });
  it('keeps multiline Home/End and word edits, undo/redo and exact carets', () => {
    const editor = new EditorState(); editor.insert('one two\n界 three');
    editor.perform('editor.home'); expect(editor.snapshot().cursor).toBe(8);
    editor.perform('editor.end'); expect(editor.snapshot().cursor).toBe(15);
    editor.perform('editor.deleteWordLeft'); expect(editor.snapshot().value).toBe('one two\n界 ');
    editor.perform('editor.undo'); expect(editor.snapshot()).toEqual({ value: 'one two\n界 three', cursor: 15 });
    editor.perform('editor.redo'); expect(editor.snapshot().value).toBe('one two\n界 ');
    editor.perform('input.newline'); editor.perform('editor.undo'); expect(editor.snapshot().value).toBe('one two\n界 ');
    editor.insert('new'); editor.perform('editor.redo'); expect(editor.snapshot().value).toBe('one two\n界 new');
  });
  it('bounds undo history and resets it at submission', () => {
    const editor = new EditorState(); for (let i = 0; i < 110; i++) editor.insert('x');
    for (let i = 0; i < 110; i++) editor.perform('editor.undo');
    expect(editor.snapshot().value).toBe('x'.repeat(10));
    editor.reset(); editor.insert('kept'); editor.insert('!');
    const restore = editor.suspend(); editor.insert('modal query'); editor.reset(); restore();
    editor.perform('editor.undo'); expect(editor.snapshot()).toEqual({ value: 'kept', cursor: 4 });
    editor.reset(); editor.perform('editor.undo'); expect(editor.snapshot()).toEqual({ value: '', cursor: 0 });
  });
  it('snaps supplied carets and never admits foreign actions', () => {
    const editor = new EditorState(); editor.replace('🙂', 1); expect(editor.snapshot().cursor).toBe(2);
    expect(editor.perform('app.help')).toBe(false);
  });
});
