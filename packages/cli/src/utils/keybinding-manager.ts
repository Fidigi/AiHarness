import { readBoundedResourceText, type KeyBinding, type KeyBindingHandler, type KeyBindingContext } from '@ai-harness/core';
import { KeyBindingConfigError, MAX_KEYBINDING_CONFIG_BYTES, normalizedKeyParts, parseKeyBindingConfig } from './keybinding-config.js';
import { defaultTerminalBindings, TERMINAL_ACTIONS } from './terminal-actions.js';
export type { KeyBindingContext } from '@ai-harness/core';

export interface KeyBindingActionView {
  id: string;
  description: string;
  keys: string[];
  registered: boolean;
  conditional: boolean;
  reserved: boolean;
}
interface ResolvedKeyBinding extends KeyBindingHandler { preventDefault?: boolean; }
type Action = Omit<KeyBindingHandler, 'keys'>;
/** Declarative defaults contain NO ambient process/stdout authority or placeholder handlers. */
export const DEFAULT_KEYBINDINGS: KeyBinding[] = defaultTerminalBindings();
function actionSnapshot(value: Action): Action {
  const slots = Object.getOwnPropertyDescriptors(value);
  for (const key of ['handler', 'description', 'when']) {
    if ((slots[key] && !('value' in slots[key]!)) || (!slots[key] && key in value)) {
      throw new TypeError('Keybinding actions require own data fields.');
    }
  }
  if (typeof slots.handler?.value !== 'function'
    || (slots.description?.value !== undefined && typeof slots.description.value !== 'string')
    || (slots.when?.value !== undefined && typeof slots.when.value !== 'function')) {
    throw new TypeError('Keybinding action fields are invalid.');
  }
  return { handler: slots.handler.value as Action['handler'],
    ...(slots.description?.value !== undefined ? { description: slots.description.value as string } : {}),
    ...(slots.when?.value !== undefined ? { when: slots.when.value as () => boolean } : {}) };
}

export class KeyBindingManager {
  private readonly handlers = new Map<string, KeyBindingHandler[]>();
  private readonly actions = new Map<string, Action>();
  private defaults: KeyBinding[] = [];
  private bindings: KeyBinding[] = [];
  private isStreaming = false;
  private loadGeneration = 0;
  constructor(private readonly redactText: (value: string) => string = value => value) { this.registerDefaults(); }
  registerDefaults(): void { this.defaults = defaultTerminalBindings(); }
  registerAction(id: string, action: Action): void { this.actions.set(id, actionSnapshot(action)); }
  registerHandler(handler: KeyBindingHandler): void {
    const key = this.normalizeKeys(handler.keys);
    const captured = { ...actionSnapshot(handler), keys: normalizedKeyParts(handler.keys) };
    const entries = this.handlers.get(key) ?? [];
    entries.push(captured); this.handlers.set(key, entries);
  }
  registerHandlers(handlers: KeyBindingHandler[]): void { for (const handler of handlers) this.registerHandler(handler); }
  unregister(keys: string[]): boolean {
    this.loadGeneration++;
    const key = this.normalizeKeys(keys), before = this.defaults.length + this.bindings.length;
    this.defaults = this.defaults.filter(entry => this.normalizeKeys(entry.keys) !== key);
    this.bindings = this.bindings.filter(entry => this.normalizeKeys(entry.keys) !== key);
    return this.handlers.delete(key) || before !== this.defaults.length + this.bindings.length;
  }
  clearConfig(): void { this.loadGeneration++; this.bindings = []; }
  clearAll(): void { this.clearConfig(); this.handlers.clear(); this.defaults = []; }
  setStreaming(value: boolean): void { this.isStreaming = value; }
  private resolve(binding: KeyBinding): ResolvedKeyBinding | null {
    const action = this.actions.get(binding.action ?? binding.id);
    if (!action) return null;
    try {
      if (action.when && !action.when()) return null;
      return { ...action, keys: [...binding.keys], description: binding.description ?? action.description,
        ...(binding.preventDefault !== undefined ? { preventDefault: binding.preventDefault } : {}) };
    } catch { return null; }
  }
  matchKey(keys: string[]): ResolvedKeyBinding | null {
    const key = this.normalizeKeys(keys);
    for (const binding of this.bindings) {
      if (this.normalizeKeys(binding.keys) !== key) continue;
      const resolved = this.resolve(binding); if (resolved) return resolved;
    }
    for (const handler of this.handlers.get(key) ?? []) {
      try { if (!handler.when || handler.when()) return handler; } catch { /* Isolate broken predicates. */ }
    }
    for (const binding of this.defaults) {
      if (this.normalizeKeys(binding.keys) !== key) continue;
      const resolved = this.resolve(binding); if (resolved) return resolved;
    }
    return null;
  }
  handleKeypress(key?: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }, context?: Partial<KeyBindingContext>): boolean {
    if (!key) return false;
    const name = key.sequence === '\u001f' ? 'slash' : key.name;
    if (!name) return false;
    const keys = [...(key.ctrl || key.sequence === '\u001f' ? ['ctrl'] : []), ...(key.meta ? ['alt'] : []), ...(key.shift ? ['shift'] : []), name];
    const binding = this.matchKey(keys); if (!binding) return false;
    void this.invoke(binding, keys, { event: key, ...context });
    return binding.preventDefault !== false;
  }
  async processKey(keys: string[], context?: Partial<KeyBindingContext>): Promise<boolean> {
    const binding = this.matchKey(keys); return binding ? this.invoke(binding, keys, context) : false;
  }
  private async invoke(binding: KeyBindingHandler, keys: string[], context?: Partial<KeyBindingContext>): Promise<boolean> {
    try { await binding.handler({ isStreaming: this.isStreaming, ...context }); return true; }
    catch (error) {
      console.error(this.redactText(`[KeyBinding] Error executing handler for ${keys.join('+')}: ${error instanceof Error ? error.message : String(error)}`));
      return false;
    }
  }
  getBindings(): KeyBinding[] {
    const result = new Map<string, KeyBinding>();
    for (const binding of this.defaults) result.set(this.normalizeKeys(binding.keys), { ...binding, keys: [...binding.keys] });
    for (const [key, handlers] of this.handlers) {
      const first = handlers[0];
      if (first) result.set(key, { id: `binding-${key}`, keys: [...first.keys], description: first.description });
    }
    for (const binding of this.bindings) {
      const key = this.normalizeKeys(binding.keys);
      if (!result.has(key) || this.actions.has(binding.action ?? binding.id)) result.set(key, { ...binding, keys: [...binding.keys] });
    }
    return [...result.values()];
  }
  /** Passive metadata only: rendering never invokes callbacks, predicates or serializers. */
  getActionViews(): KeyBindingActionView[] {
    const rows = new Map<string, KeyBindingActionView>();
    const configuredIds = new Set(this.bindings.map(binding => binding.id));
    const ensure = (id: string, description = ''): KeyBindingActionView => {
      let row = rows.get(id);
      if (!row) { row = { id, description, keys: [], registered: false, conditional: false, reserved: false }; rows.set(id, row); }
      return row;
    };
    for (const action of TERMINAL_ACTIONS) ensure(action.id, action.description).reserved = 'reserved' in action && action.reserved;
    for (const [id, action] of this.actions) {
      const row = ensure(id); row.description = action.description ?? row.description;
      row.registered = true; row.conditional = Boolean(action.when);
    }
    for (const binding of this.getBindings()) {
      const row = ensure(binding.action ?? binding.id, binding.description);
      if (configuredIds.has(binding.id) && binding.description !== undefined) row.description = binding.description;
      row.keys.push(this.normalizeKeys(binding.keys));
      if (!binding.action && this.handlers.has(this.normalizeKeys(binding.keys))) {
        row.registered = true; row.conditional = (this.handlers.get(this.normalizeKeys(binding.keys)) ?? []).some(handler => Boolean(handler.when));
      }
    }
    for (const binding of this.bindings) {
      const id = binding.action ?? binding.id;
      if (!this.actions.has(id)) {
        const row = ensure(id, binding.description); const key = this.normalizeKeys(binding.keys);
        if (!row.keys.includes(key)) row.keys.push(key);
      }
    }
    return [...rows.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }
  getHelpText(): string {
    const bindings = this.getBindings(); if (!bindings.length) return 'No keybindings registered.';
    return '\n📋 Keybindings:\n' + '─'.repeat(40) + '\n' + bindings.map(binding => {
      const keys = binding.keys.map(key => this.formatKey(key)).join(' + ');
      return `  ${keys.padEnd(15)}${binding.description || 'No description'}\n`;
    }).join('');
  }
  async loadFromFile(filePath: string): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      const content = await readBoundedResourceText(filePath, MAX_KEYBINDING_CONFIG_BYTES);
      const bindings = parseKeyBindingConfig(content); if (generation !== this.loadGeneration) return;
      this.bindings = bindings; console.log(this.redactText(`[KeyBinding] Loaded ${bindings.length} custom bindings.`));
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      const reason = error instanceof KeyBindingConfigError ? error.reason : 'read';
      console.warn(this.redactText(`[KeyBinding] Failed to load custom bindings (${reason}). Previous bindings remain active.`));
    }
  }
  async saveToFile(filePath: string): Promise<void> {
    try {
      const content = JSON.stringify(this.getBindings(), null, 2); parseKeyBindingConfig(content);
      const fs = await import('node:fs/promises'); await fs.writeFile(filePath, content, { mode: 0o600 });
    } catch { console.error('[KeyBinding] Failed to save bindings.'); }
  }
  private normalizeKeys(keys: string[]): string { return normalizedKeyParts(keys).join('+'); }
  private formatKey(key: string): string {
    const names: Record<string, string> = { ctrl: '^', alt: '⌥', shift: '⇧', cmd: '⌘', meta: '⌘', enter: '↵', space: '␣', tab: '⇥', backspace: '⌫', delete: 'del', escape: 'esc' };
    return Object.hasOwn(names, key) ? names[key]! : key;
  }
}
export default KeyBindingManager;
