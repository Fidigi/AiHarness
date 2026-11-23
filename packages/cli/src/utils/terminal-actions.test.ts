import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { FullscreenInput } from '../tui/fullscreen-input.js';
import { FullscreenUI } from '../tui/fullscreen-ui.js';
import type { TerminalActionId } from './terminal-actions.js';

function fixture() {
  const frames: string[] = [];
  const ui = new FullscreenUI({ output: { write: value => { frames.push(value); }, isTTY: true, columns: 80, rows: 24 } });
  const source = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn() });
  const handlers = { onLine: vi.fn(), onInterrupt: vi.fn(), onEscape: vi.fn(), onExit: vi.fn(), complete: () => ['/help'] };
  const input = new FullscreenInput(ui, handlers, source);
  return { ui, input, source, handlers, frames };
}
describe('real fullscreen named action bridge and passive view', () => {
  it('dispatches actual editor cursor/delete/clear/completion methods', () => {
    const { input } = fixture(); input.replaceValue('abc');
    expect(input.performAction('editor.home')).toBe(true); input.performAction('editor.right'); input.performAction('editor.delete'); expect(input.getValue()).toBe('ac');
    input.performAction('editor.backspace'); expect(input.getValue()).toBe('c'); input.performAction('editor.end'); input.performAction('editor.clear'); expect(input.getValue()).toBe('');
    input.replaceValue('/h'); input.performAction('editor.complete'); expect(input.getValue()).toBe('/help '); input.close();
  });
  it('submits through real steering/follow-up handlers and retains native history', () => {
    const { input, handlers } = fixture(); input.replaceValue('first'); input.performAction('input.submit');
    expect(handlers.onLine).toHaveBeenLastCalledWith('first', 'steer');
    input.replaceValue('second'); input.performAction('input.followUp'); expect(handlers.onLine).toHaveBeenLastCalledWith('second', 'follow-up');
    input.performAction('editor.previous'); expect(input.getValue()).toBe('second'); input.performAction('editor.previous'); expect(input.getValue()).toBe('first');
    input.performAction('editor.next'); expect(input.getValue()).toBe('second'); input.close();
  });
  it('round-trips exact draft/caret snapshots without aliasing the editor cursor', () => {
    const { input } = fixture(); input.replaceValue('draft', 3); expect(input.getCursor()).toBe(3);
    input.replaceValue('query'); input.replaceValue('draft', 3); input.handleKeypress('X', { name: 'x', shift: true });
    expect(input.getValue()).toBe('draXft'); expect(input.getCursor()).toBe(4); input.close();
  });
  it('excludes view queries from native history without suppressing line delivery', () => {
    const { ui, source } = fixture(); let transient = false; const onLine = vi.fn();
    const input = new FullscreenInput(ui, { onLine, onInterrupt: vi.fn(), onEscape: vi.fn(), onExit: vi.fn(), recordHistory: () => !transient }, source);
    input.replaceValue('model draft'); input.performAction('input.submit'); transient = true;
    input.replaceValue('view query'); input.performAction('input.submit'); transient = false;
    input.performAction('editor.previous'); expect(input.getValue()).toBe('model draft'); expect(onLine).toHaveBeenCalledTimes(2); input.close();
  });
  it('projects split Alt+Enter for lookup without mutating or consuming native pass-through', () => {
    vi.useFakeTimers(); const { input, handlers } = fixture();
    try {
      input.replaceValue('draft'); input.handleKeypress('\u001b', { name: 'escape' });
      const original = { name: 'return' };
      expect(input.keyForBindings(original)).toEqual({ name: 'enter', meta: true }); expect(original).toEqual({ name: 'return' });
      input.handleKeypress('\r', original); expect(handlers.onLine).toHaveBeenLastCalledWith('draft', 'follow-up');
      vi.runAllTimers(); expect(handlers.onEscape).not.toHaveBeenCalled();
    } finally { input.close(); vi.useRealTimers(); }
  });
  it('uses host interrupt/exit/escape without direct process authority and respects drafts', () => {
    const { input, handlers } = fixture(); input.replaceValue('draft'); input.performAction('app.exit'); expect(handlers.onExit).not.toHaveBeenCalled();
    input.performAction('app.interrupt'); expect(handlers.onInterrupt).toHaveBeenCalledOnce(); input.performAction('app.escape'); expect(handlers.onEscape).toHaveBeenCalledOnce();
    input.performAction('editor.clear'); input.performAction('app.exit'); expect(handlers.onExit).toHaveBeenCalledOnce(); input.close();
  });
  it('refuses composition-owned/foreign actions and all retired input actions', () => {
    const { input, handlers } = fixture();
    expect(input.performAction('app.help')).toBe(false); expect(input.performAction('app.hotkeys')).toBe(false);
    expect(input.performAction('constructor' as TerminalActionId)).toBe(false);
    input.close(); expect(input.performAction('app.exit')).toBe(false); input.handleKeypress('x', { name: 'x' }); expect(input.getValue()).toBe(''); expect(handlers.onExit).not.toHaveBeenCalled();
  });
  it('does not re-enter raw mode or replace a draft after an external editor outlives close', async () => {
    const { ui, source } = fixture(); let finish!: (value: string) => void;
    const editor = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const input = new FullscreenInput(ui, { onLine: vi.fn(), onInterrupt: vi.fn(), onEscape: vi.fn(), onExit: vi.fn(), onExternalEditor: editor }, source);
    input.replaceValue('owned draft'); input.start(); input.performAction('input.externalEditor'); await setImmediate(); expect(editor).toHaveBeenCalledWith('owned draft');
    input.close(); const starts = source.setRawMode.mock.calls.filter(call => call[0] === true).length;
    finish('late replacement'); await setImmediate();
    expect(input.getValue()).toBe('owned draft'); expect(source.setRawMode.mock.calls.filter(call => call[0] === true)).toHaveLength(starts);
    expect(source.listenerCount('keypress')).toBe(0);
  });
  it('keeps a live view visible over streaming without rendering extension panels or losing input/history', () => {
    const { ui, frames } = fixture(); let open = true; const panel = vi.fn(() => ['extension panel']);
    ui.setViewProvider(() => open ? ['HOTKEY VIEW', 'app.help · Alt+H'] : undefined); ui.setPanelProvider(panel);
    ui.setInput('preserved draft', 4); ui.writeOutput('underlying transcript'); ui.enter();
    const streaming = ui.startStreaming(); streaming.write('underlying live output');
    expect(frames.at(-1)).toContain('HOTKEY VIEW'); expect(frames.at(-1)).toContain('preserved draft'); expect(frames.at(-1)).not.toContain('underlying live output'); expect(panel).not.toHaveBeenCalled();
    open = false; ui.render(); expect(frames.at(-1)).toContain('underlying transcript'); expect(frames.at(-1)).toContain('underlying live output'); expect(frames.at(-1)).toContain('preserved draft'); expect(panel).toHaveBeenCalledOnce();
    streaming.cancel(); ui.leave();
  });
});
