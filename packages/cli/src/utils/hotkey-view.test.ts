import { describe, expect, it, vi } from 'vitest';
import { HotkeyView } from './hotkey-view.js';
import { KeyBindingManager } from './keybinding-manager.js';
import { defaultTerminalBindings, EDITOR_ACTION_KEYS, TERMINAL_ACTIONS } from './terminal-actions.js';
import { KeyBindingConfigError, parseKeyBindingConfig } from './keybinding-config.js';
import { terminalWidth } from '../tui/terminal-text.js';

function fixture() {
  const manager = new KeyBindingManager(), handler = vi.fn(), predicate = vi.fn(() => true);
  for (const action of TERMINAL_ACTIONS) manager.registerAction(action.id, { description: action.description, handler, when: predicate });
  return { manager, handler, predicate, view: new HotkeyView(() => manager.getActionViews()) };
}
describe('declarative complete action inventory and passive interactive view', () => {
  it('redacts complete metadata before cell clipping can expose a credential prefix', () => {
    const secret = 'KNOWN_VIEW_SECRET_' + 'x'.repeat(200);
    const view = new HotkeyView(() => [{ id: 'sample', description: secret, keys: ['f1'], registered: true, conditional: false, reserved: false }], value => value.replaceAll(secret, '[REDACTED]'));
    const output = view.render(80).join('\n'); expect(output).toContain('[REDACTED]'); expect(output).not.toContain('KNOWN_VIEW_SECRET_');
  });
  it('redacts complete queries before bounding and echoing them', () => {
    const secret = 'KNOWN_VIEW_SECRET_' + 'x'.repeat(2200);
    const view = new HotkeyView(() => [], value => value.replaceAll(secret, '[REDACTED]'));
    view.update(secret); const output = view.render(80).join('\n'); expect(output).toContain('Filter: [REDACTED]'); expect(output).not.toContain('KNOWN_VIEW_SECRET_');
  });
  it('round-trips the complete default schema with unique action/chord IDs', () => {
    const defaults = defaultTerminalBindings();
    expect(TERMINAL_ACTIONS).toHaveLength(22);
    expect(new Set(TERMINAL_ACTIONS.map(action => action.id)).size).toBe(22);
    expect(parseKeyBindingConfig(JSON.stringify(defaults))).toEqual(defaults);
    for (const action of TERMINAL_ACTIONS) {
      expect(defaults.some(binding => binding.action === action.id)).toBe(true);
      expect(EDITOR_ACTION_KEYS[action.id] !== undefined || ['app.help', 'app.hotkeys', 'transcript.up', 'transcript.down'].includes(action.id)).toBe(true);
    }
  });
  it('grants no ambient exit/interrupt/output authority before a real host registers', async () => {
    const manager = new KeyBindingManager();
    await expect(manager.processKey(['ctrl+d'])).resolves.toBe(false);
    await expect(manager.processKey(['ctrl+c'], { isStreaming: true })).resolves.toBe(false);
    await expect(manager.processKey(['alt+h'])).resolves.toBe(false);
    expect(manager.getActionViews().every(action => !action.registered)).toBe(true);
  });
  it.each(['ctrl+c', 'ctrl+d', 'escape'])('refuses remapping the reserved %s safety key', key => {
    try { parseKeyBindingConfig(JSON.stringify([{ id: 'unsafe', keys: [key], action: 'app.help' }])); }
    catch (error) { expect(error).toBeInstanceOf(KeyBindingConfigError); expect((error as KeyBindingConfigError).reason).toBe('reserved'); return; }
    throw new Error('reserved key admitted');
  });
  it('exposes every action across pages without executing handlers or predicates', () => {
    const { view, handler, predicate } = fixture(); const pages: string[] = [];
    for (let index = 0; index < 3; index++) { pages.push(view.render(300).join('\n')); view.update(':next'); }
    for (const action of TERMINAL_ACTIONS) expect(pages.join('\n')).toContain(action.id);
    expect(handler).not.toHaveBeenCalled(); expect(predicate).not.toHaveBeenCalled();
    expect(view.update(':close')).toBe('close'); expect(handler).not.toHaveBeenCalled();
  });
  it('filters IDs, keys and descriptions, resets page and supports backward/empty-next navigation', () => {
    const { view } = fixture(); const first = view.render(300).join('\n');
    view.update(':prev'); expect(view.render(300).join('\n')).toContain('3/3');
    view.update(''); expect(view.render(300).join('\n')).toBe(first);
    view.update('external editor'); expect(view.render(300).join('\n')).toContain('input.externalEditor');
    expect(view.render(300).join('\n')).toContain('1/1');
    view.update('ctrl+slash'); expect(view.render(300).join('\n')).toContain('app.help');
    view.update('not-found'); expect(view.render(300).join('\n')).toContain('No matching actions.');
  });
  it('lists registered unbound actions and reflects later registration without caching callbacks', () => {
    const { view, manager } = fixture();
    manager.registerAction('extra.action', { description: 'Additional action', handler: vi.fn() });
    view.update('extra.action'); expect(view.render(300).join('\n')).toContain('unbound');
    expect(view.render(300).join('\n')).not.toContain('[unavailable]');
    const absent = new KeyBindingManager(), dynamic = new HotkeyView(() => absent.getActionViews());
    dynamic.update('app.help'); expect(dynamic.render(300).join('\n')).toContain('[unavailable]');
    absent.registerAction('app.help', { handler: vi.fn() }); expect(dynamic.render(300).join('\n')).not.toContain('[unavailable]');
  });
  it('owns returned metadata and rejects callback/accessor authority without evaluating it', () => {
    const { manager } = fixture(); const rows = manager.getActionViews(); rows[0]!.keys.push('foreign'); rows[0]!.description = 'foreign';
    expect(manager.getActionViews().some(row => row.description === 'foreign' || row.keys.includes('foreign'))).toBe(false);
    let reads = 0;
    expect(() => manager.registerAction('bad', { handler: vi.fn(), get when() { reads++; return () => true; } })).toThrow(TypeError);
    const inherited = Object.create({ get handler() { reads++; return vi.fn(); } });
    expect(() => manager.registerAction('bad', inherited)).toThrow(TypeError); expect(reads).toBe(0);
  });
  it.each([1, 2, 4, 5, 8, 14])('bounds all rows and terminal cells at a %s-line viewport', lines => {
    const { view } = fixture(); const rendered = view.render(20, lines);
    expect(rendered.length).toBeLessThanOrEqual(lines); expect(rendered.every(line => terminalWidth(line) <= 20)).toBe(true);
  });
  it('filters terminal controls, bounds queries, and treats prototypes as inert text', () => {
    const { manager } = fixture(); manager.registerAction('constructor', { description: '\u001b]0;forbidden\u0007'+ '日本語😀', handler: vi.fn() });
    const view = new HotkeyView(() => manager.getActionViews()); view.update('constructor');
    const output = view.render(300).join('\n'); expect(output).toContain('日本語😀'); expect(output).not.toContain('forbidden');
    expect(output).not.toContain('\u001b'); view.update('x'.repeat(1000)); expect(view.render(300).join('\n')).not.toContain('x'.repeat(257));
  });
});
