import type { KeyBindingActionView } from './keybinding-manager.js';
import { clipTerminalText, terminalText } from '../tui/terminal-text.js';

function safe(value: string): string { return terminalText(value).replace(/[\n\t\u061c\u200e\u200f]/gu, ' '); }
function chord(value: string): string {
  const parts = value.split('+');
  const modifiers = ['ctrl', 'alt', 'shift', 'cmd', 'meta'];
  return [...modifiers.filter(part => parts.includes(part)), ...parts.filter(part => !modifiers.includes(part))]
    .map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('+');
}

/** Read-only, bounded, line-oriented browser: it never executes a selected action. */
export class HotkeyView {
  private query = '';
  private page = 0;
  constructor(private readonly actions: () => readonly KeyBindingActionView[], private readonly redactText: (value: string) => string = value => value) {}
  private safe(value: string): string { return safe(this.redactText(value)); }
  update(input: string): 'close' | 'render' {
    const value = this.safe(input).slice(0, 2048).trim();
    if (value === ':close') return 'close';
    if (value === ':all') { this.query = ''; this.page = 0; return 'render'; }
    if (value === ':next' || !value) this.page++;
    else if (value === ':prev') this.page--;
    else { this.query = [...value].slice(0, 256).join(''); this.page = 0; }
    return 'render';
  }
  render(columns = 80, maxLines = 14): string[] {
    const width = Number.isFinite(columns) ? Math.max(1, Math.min(300, Math.floor(columns))) : 80;
    const budget = Number.isFinite(maxLines) ? Math.max(1, Math.min(100, Math.floor(maxLines))) : 14;
    const rows = this.actions().map(row => ({ ...row, id: this.safe(row.id), description: this.safe(row.description), keys: row.keys.map(key => this.safe(key)) }));
    const query = this.query.toLowerCase();
    const matches = rows.filter(row => [row.id, row.description, ...row.keys].some(value => value.toLowerCase().includes(query)));
    const count = Math.max(1, Math.min(8, budget - 4));
    const pages = Math.max(1, Math.ceil(matches.length / count));
    this.page = ((this.page % pages) + pages) % pages;
    const shown = matches.slice(this.page * count, (this.page + 1) * count).map(row => {
      const state = !row.registered ? ' [unavailable]' : row.reserved ? ' [reserved]' : row.conditional ? ' [conditional]' : '';
      return `${row.id}${state} · ${row.keys.map(chord).join(' / ') || 'unbound'} · ${row.description}`;
    });
    if (!shown.length) shown.push('No matching actions.');
    const title = `Hotkeys ${matches.length}/${rows.length} · ${this.page + 1}/${pages}`;
    const help = ':next / :prev / :all / :close · Escape/F1 returns';
    const lines = budget === 1 ? [shown[0]!] : budget < 5 ? [title, ...shown, help].slice(0, budget)
      : [title, `Filter: ${this.query || '(all actions)'}`, ...shown, 'Type a filter and Enter; empty Enter = next page.', help];
    return lines.map(line => clipTerminalText(line, width));
  }
}
