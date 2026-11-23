import type { TerminalActionId } from '../utils/terminal-actions.js';

export interface EditorDraft { value: string; cursor: number }
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function boundary(value: string, cursor: number, direction: -1 | 1): number {
  for (const item of segments.segment(value)) {
    const end = item.index + item.segment.length;
    if (direction < 0 && end >= cursor) return item.index;
    if (direction > 0 && end > cursor) return end;
  }
  return direction < 0 ? 0 : value.length;
}
function word(value: string, cursor: number, direction: -1 | 1): number {
  const pattern = direction < 0 ? /\S+\s*$/u : /^\s*\S+\s*/u;
  const text = direction < 0 ? value.slice(0, cursor) : value.slice(cursor);
  const length = text.match(pattern)?.[0].length ?? 0;
  return cursor + direction * length;
}

/** Owned draft/caret and bounded edit history, shared by the two native input hosts. */
export class EditorState {
  private draft: EditorDraft = { value: '', cursor: 0 };
  private undo: EditorDraft[] = [];
  private redo: EditorDraft[] = [];
  snapshot(): EditorDraft { return { ...this.draft }; }
  /** Modal input owns a separate undo history and cannot leak queries into the draft. */
  suspend(): () => void {
    const draft = this.snapshot(), undo = this.undo, redo = this.redo;
    this.reset();
    return () => { this.draft = { ...draft }; this.undo = undo; this.redo = redo; };
  }
  reset(): void { this.draft = { value: '', cursor: 0 }; this.undo = []; this.redo = []; }
  replace(value: string, cursor = value.length): void {
    if (value !== this.draft.value) {
      this.retain(this.undo, this.draft);
      this.redo = [];
    }
    const bounded = Number.isFinite(cursor) ? Math.max(0, Math.min(value.length, cursor)) : value.length;
    // Never leave a caller-supplied caret inside a grapheme.
    this.draft = { value, cursor: bounded === 0 ? 0 : boundary(value, boundary(value, bounded, -1), 1) };
  }
  insert(text: string): void {
    const { value, cursor } = this.draft;
    this.replace(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  }
  perform(action: TerminalActionId): boolean {
    const { value, cursor } = this.draft;
    let target = cursor;
    switch (action) {
      case 'editor.undo':
      case 'editor.redo': {
        const source = action === 'editor.undo' ? this.undo : this.redo;
        const entry = source.pop();
        if (entry) { this.retain(action === 'editor.undo' ? this.redo : this.undo, this.draft); this.draft = entry; }
        return true;
      }
      case 'input.newline': this.insert('\n'); return true;
      case 'editor.clear': this.replace(''); return true;
      case 'editor.left': target = boundary(value, cursor, -1); break;
      case 'editor.right': target = boundary(value, cursor, 1); break;
      case 'editor.wordLeft': target = word(value, cursor, -1); break;
      case 'editor.wordRight': target = word(value, cursor, 1); break;
      case 'editor.home': target = value.slice(0, cursor).lastIndexOf('\n') + 1; break;
      case 'editor.end': { const end = value.indexOf('\n', cursor); target = end < 0 ? value.length : end; break; }
      case 'editor.backspace':
      case 'editor.deleteWordLeft':
        target = action === 'editor.backspace' ? boundary(value, cursor, -1) : word(value, cursor, -1);
        this.replace(value.slice(0, target) + value.slice(cursor), target); return true;
      case 'editor.delete':
      case 'editor.deleteWordRight':
        target = action === 'editor.delete' ? boundary(value, cursor, 1) : word(value, cursor, 1);
        this.replace(value.slice(0, cursor) + value.slice(target), cursor); return true;
      default: return false;
    }
    this.draft.cursor = target;
    return true;
  }
  private retain(stack: EditorDraft[], draft: EditorDraft): void {
    stack.push({ ...draft });
    // Count UTF-16 storage conservatively; a huge draft remains editable without retaining huge undo copies.
    let bytes = stack.reduce((total, entry) => total + entry.value.length * 2, 0);
    while (stack.length > 100 || bytes > 1024 * 1024) bytes -= stack.shift()!.value.length * 2;
  }
}
