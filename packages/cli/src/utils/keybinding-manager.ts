// ============================================================
// KeyBinding Manager - CLI Keyboard Shortcut System
// Features: register/unregister bindings, event dispatching,
//           default keybindings, custom config loading
// ============================================================

import type { KeyBinding, KeyBindingHandler } from '@ai-harness/core';

/** Context passed to keybinding handlers */
export interface KeyBindingContext {
  /** The original keyboard event (if available) */
  event?: unknown;
  /** Current command being typed (for input-mode bindings) */
  currentInput?: string;
  /** Whether we're currently in streaming mode */
  isStreaming: boolean;
}

/** Default keybindings for the AiHarness CLI */
export const DEFAULT_KEYBINDINGS: KeyBindingHandler[] = [
  {
    keys: ['ctrl', 'c'],
    description: 'Interrupt current operation or exit',
    handler: (ctx) => {
      if (ctx.isStreaming) {
        // Interrupt streaming
        process.stdout.write('\n');
        console.log('[Interrupted]');
      }
      // Return to prompt for non-streaming ctrl+c
    },
  },
  {
    keys: ['ctrl', 'd'],
    description: 'Exit the application',
    handler: () => {
      process.exit(0);
    },
  },
  {
    keys: ['alt', 'up'],
    description: 'Scroll up in transcript',
    when: () => true, // Would need terminal scroll support for real effect
    handler: () => {
      console.log('[Scroll up - requires TUI mode]');
    },
  },
  {
    keys: ['alt', 'down'],
    description: 'Scroll down in transcript',
    when: () => true,
    handler: () => {
      console.log('[Scroll down - requires TUI mode]');
    },
  },
  {
    keys: ['ctrl', 'l'],
    description: 'Clear the terminal screen',
    handler: () => {
      process.stdout.write('\x1Bc');
    },
  },
  {
    keys: ['alt', 'h'],
    description: 'Show help menu',
    when: () => true,
    handler: () => {
      console.log('[Help - use /help command]');
    },
  },
];

/** KeyBindingManager manages all registered keyboard shortcuts */
export class KeyBindingManager {
  private handlers: Map<string, KeyBindingHandler[]> = new Map(); // keyed by normalized key string
  private bindings: KeyBinding[] = [];
  private readonly actions = new Map<string, Omit<KeyBindingHandler, 'keys'>>();
  private isStreaming = false;

  /** Create a new KeyBindingManager with default bindings */
  constructor() {
    this.registerDefaults();
  }

  /** Register all default keybindings */
  registerDefaults(): void {
    for (const binding of DEFAULT_KEYBINDINGS) {
      this.registerHandler(binding);
    }
  }

  registerAction(id: string, handler: Omit<KeyBindingHandler, 'keys'>): void {
    this.actions.set(id, handler);
  }

  /** Register a single keybinding handler */
  registerHandler(handler: KeyBindingHandler): void {
    const normalizedKeys = this.normalizeKeys(handler.keys);
    
    if (!this.handlers.has(normalizedKeys)) {
      this.handlers.set(normalizedKeys, []);
    }
    
    this.handlers.get(normalizedKeys)!.push(handler);
  }

  /** Register multiple keybindings at once */
  registerHandlers(handlers: KeyBindingHandler[]): void {
    for (const handler of handlers) {
      this.registerHandler(handler);
    }
  }

  /** Unregister a specific binding by its keys */
  unregister(keys: string[]): boolean {
    const normalizedKeys = this.normalizeKeys(keys);
    return this.handlers.delete(normalizedKeys);
  }

  /** Clear all registered keybindings */
  clearAll(): void {
    this.handlers.clear();
    this.bindings = [];
  }

  /** Set streaming state (for interrupt handling) */
  setStreaming(isStreaming: boolean): void {
    this.isStreaming = isStreaming;
  }

  /** Check if a key sequence matches any registered binding */
  matchKey(keys: string[]): KeyBindingHandler | null {
    const normalizedKeys = this.normalizeKeys(keys);
    
    // Direct match first
    const directHandlers = this.handlers.get(normalizedKeys);
    if (directHandlers && directHandlers.length > 0) {
      // Return the first handler that passes its 'when' condition, or any if no conditions
      for (const handler of directHandlers) {
        try {
          if (!handler.when || handler.when()) {
            return handler;
          }
        } catch {
          // Skip handlers whose when() function throws an error
          continue;
        }
      }
    }

    // No match found
    return null;
  }

  /** Convert a Node readline keypress event and dispatch it. */
  handleKeypress(key?: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): boolean {
    if (!key?.name) return false;

    const keys: string[] = [];
    if (key.ctrl) keys.push('ctrl');
    if (key.meta) keys.push('alt');
    if (key.shift) keys.push('shift');
    keys.push(key.name);

    if (!this.matchKey(keys)) return false;
    void this.processKey(keys);
    return true;
  }

  /** Process a key event and execute the matching handler */
  async processKey(keys: string[], context?: Partial<KeyBindingContext>): Promise<boolean> {
    const binding = this.matchKey(keys);
    
    if (!binding) {
      return false; // No binding matched, let input pass through
    }

    const ctx: KeyBindingContext = {
      event: undefined,
      isStreaming: this.isStreaming,
      ...context,
    };

    try {
      await binding.handler(ctx);
      return true; // Binding was handled
    } catch (error) {
      console.error(`[KeyBinding] Error executing handler for ${keys.join('+')}:`, error);
      return false;
    }
  }

  /** Get all registered bindings as a list */
  getBindings(): KeyBinding[] {
    const result: KeyBinding[] = [];
    
    for (const [normalizedKeys, handlers] of this.handlers) {
      for (const handler of handlers) {
        if (!result.find(b => b.keys.join('+') === normalizedKeys)) {
          // Split the normalized keys back into individual parts
          const keyParts = normalizedKeys.split('+');
          result.push({
            id: `binding-${normalizedKeys}`,
            keys: keyParts,
            description: handler.description,
          });
        }
      }
    }

    for (const binding of this.bindings) {
      const normalizedKeys = this.normalizeKeys(binding.keys);
      if (!result.some(item => this.normalizeKeys(item.keys) === normalizedKeys)) {
        result.push(binding);
      }
    }

    return result;
  }

  /** Get a formatted help string for all bindings */
  getHelpText(): string {
    const bindings = this.getBindings();
    
    if (bindings.length === 0) {
      return 'No keybindings registered.';
    }

    let text = '\n📋 Keybindings:\n';
    text += `${'─'.repeat(40)}\n`;
    
    for (const binding of bindings) {
      const keysStr = binding.keys.map(k => this.formatKey(k)).join(' + ');
      const desc = binding.description || 'No description';
      
      // Pad the key string for alignment
      text += `  ${keysStr.padEnd(15)}${desc}\n`;
    }

    return text;
  }

  /** Load custom bindings from a JSON file */
  async loadFromFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const bindings = JSON.parse(content) as KeyBinding[];
      this.bindings = bindings;
      for (const binding of bindings) {
        const action = this.actions.get(binding.action || binding.id);
        if (!action) continue;
        this.registerHandler({ keys: binding.keys, ...action });
      }
      console.log(`[KeyBinding] Loaded ${bindings.length} custom bindings from ${filePath}`);
    } catch (error) {
      console.warn('[KeyBinding] Failed to load custom bindings:', error);
    }
  }

  /** Save current bindings to a JSON file */
  async saveToFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const content = JSON.stringify(this.getBindings(), null, 2);
      await fs.writeFile(filePath, content);
    } catch (error) {
      console.error('[KeyBinding] Failed to save bindings:', error);
    }
  }

  // Private helpers

  /** Normalize key sequence for consistent matching */
  private normalizeKeys(keys: string[]): string {
    // First, split any '+'-separated keys into individual components
    const allParts = keys.flatMap(k => k.split('+').map(s => s.trim().toLowerCase()));
    
    // Sort alphabetically for canonical representation (e.g., 'ctrl+c' === 'c+ctrl')
    return allParts.sort().join('+');
  }

  /** Format a single key for display */
  private formatKey(key: string): string {
    // Convert special names to readable form
    const keyMap: Record<string, string> = {
      'ctrl': '^',
      'alt': '⌥',
      'shift': '⇧',
      'cmd': '⌘',
      'meta': '⌘',
      'enter': '↵',
      'space': '␣',
      'tab': '⇥',
      'backspace': '⌫',
      'delete': 'del',
      'escape': 'esc',
    };

    return keyMap[key] || key;
  }
}

export default KeyBindingManager;
