// ============================================================
// KeyBinding Manager Tests - Full coverage for keyboard shortcuts
// Covers: register/unregister, event dispatching, defaults, custom config
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { KeyBindingManager, DEFAULT_KEYBINDINGS } from './keybinding-manager';

describe('KeyBindingManager', () => {
  let manager: KeyBindingManager;

  beforeEach(() => {
    // Create a fresh instance for each test
    manager = new KeyBindingManager();
  });

  afterEach(() => {
    // Clean up after each test
    manager.clearAll();
  });

  describe('Default keybindings', () => {
    it('should register default keybindings on construction', () => {
      const bindings = manager.getBindings();
      
      expect(bindings.length).toBeGreaterThan(0);
      
      // Check for some expected defaults
      const hasCtrlC = bindings.some(b => b.keys.includes('ctrl') && b.keys.includes('c'));
      const hasCtrlD = bindings.some(b => b.keys.includes('ctrl') && b.keys.includes('d'));
      
      expect(hasCtrlC).toBe(true);
      expect(hasCtrlD).toBe(true);
    });

    it('should have all DEFAULT_KEYBINDINGS registered', () => {
      const bindings = manager.getBindings();
      
      for (const defaultBinding of DEFAULT_KEYBINDINGS) {
        const normalizedKeys = defaultBinding.keys.join('+').toLowerCase();
        const found = bindings.some(b => 
          b.keys.join('+') === normalizedKeys || 
          b.description?.includes(defaultBinding.description?.split(' ')[0] || '')
        );
        
        expect(found).toBe(true);
      }
    });

    it('should include interrupt handler for ctrl+c', () => {
      const bindings = manager.getBindings();
      
      const ctrlCBinding = bindings.find(b => 
        b.keys.includes('ctrl') && b.keys.includes('c')
      );
      
      expect(ctrlCBinding).toBeDefined();
      expect(ctrlCBinding?.description).toContain('Interrupt');
    });

    it('should include clear screen handler for ctrl+l', () => {
      const bindings = manager.getBindings();
      
      const ctrlLBinding = bindings.find(b => 
        b.keys.includes('ctrl') && b.keys.includes('l')
      );
      
      expect(ctrlLBinding).toBeDefined();
    });

    it('should include exit handler for ctrl+d', () => {
      const bindings = manager.getBindings();
      
      const ctrlDBinding = bindings.find(b => 
        b.keys.includes('ctrl') && b.keys.includes('d')
      );
      
      expect(ctrlDBinding).toBeDefined();
      expect(ctrlDBinding?.description).toContain('Exit');
    });
  });

  describe('registerHandler()', () => {
    it('should register a custom keybinding', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['ctrl+x'],
        description: 'Custom action',
        handler: () => {
          handlerCalled = true;
        },
      });

      const bindings = manager.getBindings();
      expect(bindings.some(b => b.keys.includes('x'))).toBe(true);
    });

    it('should register multiple handlers for the same keys', async () => {
      let callCount = 0;
      
      // Register two handlers for the same key sequence
      manager.registerHandler({
        keys: ['ctrl+a'],
        handler: () => { callCount++; },
      });
      
      manager.registerHandler({
        keys: ['ctrl+a'],
        handler: () => { callCount++; },
      });

      // Both should be registered (handlers array has 2 items)
      const handlers = manager['handlers'].get('a+ctrl');
      expect(handlers?.length).toBe(2);
    });

    it('should handle when() condition correctly', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['alt+m'],
        description: 'Conditional binding',
        when: () => false, // Always returns false
        handler: () => { handlerCalled = true; },
      });

      const bindings = manager.getBindings();
      expect(bindings.some(b => b.keys.includes('m'))).toBe(true);
    });

    it('should normalize key case for matching', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['CTRL+Z'], // Uppercase
        handler: () => { handlerCalled = true; },
      });

      const binding = manager.matchKey(['ctrl+z']); // Lowercase lookup
      
      expect(binding).not.toBeNull();
    });
  });

  describe('unregister()', () => {
    it('should remove a registered keybinding', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['ctrl+y'],
        handler: () => { handlerCalled = true; },
      });

      // Verify it's registered
      expect(manager.matchKey(['ctrl+y'])).not.toBeNull();
      
      // Unregister it
      const result = manager.unregister(['ctrl', 'y']);
      expect(result).toBe(true);
      
      // Verify it's removed
      expect(manager.matchKey(['ctrl+y'])).toBeNull();
    });

    it('should return false for non-existent binding', () => {
      const result = manager.unregister(['nonexistent', 'key']);
      expect(result).toBe(false);
    });

    it('should handle case-insensitive unregistration', () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['CTRL+X'], // Uppercase registration
        handler: () => { handlerCalled = true; },
      });

      const result = manager.unregister(['ctrl', 'x']); // Lowercase unregistration
      expect(result).toBe(true);
    });
  });

  describe('clearAll()', () => {
    it('should remove all registered keybindings', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['ctrl+a'],
        handler: () => { handlerCalled = true; },
      });

      manager.clearAll();
      
      expect(manager.matchKey(['ctrl+a'])).toBeNull();
    });

    it('should clear bindings from a fresh instance', async () => {
      const initialCount = manager.getBindings().length;
      
      // Add some custom bindings
      for (let i = 0; i < 5; i++) {
        manager.registerHandler({
          keys: [`ctrl+${i}`],
          handler: () => {},
        });
      }

      const beforeClear = manager.getBindings().length;
      
      // Clear all
      manager.clearAll();
      
      expect(manager.getBindings().length).toBe(0);
    });
  });

  describe('matchKey()', () => {
    it('should return null for unregistered keys', async () => {
      const result = manager.matchKey(['nonexistent', 'key']);
      expect(result).toBeNull();
    });

    it('should match registered key sequences exactly', async () => {
      let matched = false;
      
      manager.registerHandler({
        keys: ['ctrl+shift+t'],
        handler: () => { matched = true; },
      });

      const result = manager.matchKey(['ctrl', 'shift', 't']);
      expect(result).not.toBeNull();
    });

    it('should respect when() condition', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['alt+q'],
        description: 'Conditional binding',
        when: () => true, // Always returns true
        handler: () => { handlerCalled = true; },
      });

      const result = manager.matchKey(['alt', 'q']);
      expect(result).not.toBeNull();
    });

    it('should skip handlers that fail their when() condition', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['ctrl+k'],
        description: 'Conditional binding',
        when: () => false, // Always returns false
        handler: () => { handlerCalled = true; },
      });

      const result = manager.matchKey(['ctrl', 'k']);
      
      // Should return null because the only handler fails its condition
      expect(result).toBeNull();
    });

    it('should match first valid handler when multiple are registered for same keys', async () => {
      let callOrder: string[] = [];
      
      manager.registerHandler({
        keys: ['ctrl+m'],
        description: 'First binding',
        handler: () => { callOrder.push('first'); },
      });

      manager.registerHandler({
        keys: ['ctrl+m'],
        description: 'Second binding',
        when: () => false, // This one won't match
        handler: () => { callOrder.push('second'); },
      });

      const result = manager.matchKey(['ctrl', 'm']);
      
      expect(result).not.toBeNull();
      expect(result?.description).toBe('First binding');
    });
  });

  describe('processKey()', () => {
    it('should execute the matching handler and return true', async () => {
      let executed = false;
      
      manager.registerHandler({
        keys: ['ctrl+r'],
        description: 'Test action',
        handler: () => { executed = true; },
      });

      const result = await manager.processKey(['ctrl', 'r']);
      
      expect(result).toBe(true);
      expect(executed).toBe(true);
    });

    it('should return false when no binding matches', async () => {
      const result = await manager.processKey(['nonexistent', 'key']);
      
      expect(result).toBe(false);
    });

    it('should pass context to the handler', async () => {
      let receivedContext: any;
      
      manager.registerHandler({
        keys: ['ctrl+p'],
        description: 'Test action with context',
        handler: (ctx) => {
          receivedContext = ctx;
        },
      });

      await manager.processKey(['ctrl', 'p'], { isStreaming: true });
      
      expect(receivedContext).not.toBeNull();
      expect(receivedContext.isStreaming).toBe(true);
    });

    it('should handle async handlers correctly', async () => {
      let executed = false;
      
      manager.registerHandler({
        keys: ['ctrl+s'],
        handler: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          executed = true;
        },
      });

      const result = await manager.processKey(['ctrl', 's']);
      
      expect(result).toBe(true);
      expect(executed).toBe(true);
    });

    it('should handle errors in handlers gracefully', async () => {
      let errorCaught = false;
      
      // Override console.error to capture the error log
      const originalConsoleError = console.error;
      console.error = (...args: any[]) => {
        if (args[0]?.includes?.('[KeyBinding]')) {
          errorCaught = true;
        }
      };

      manager.registerHandler({
        keys: ['ctrl+e'],
        handler: () => { throw new Error('Test error'); },
      });

      const result = await manager.processKey(['ctrl', 'e']);
      
      expect(result).toBe(false); // Should return false on error
      expect(errorCaught).toBe(true);

      // Restore console.error
      console.error = originalConsoleError;
    });

    it('should respect streaming state for interrupt handler', async () => {
      let receivedStreamingState: boolean | undefined;
      
      manager.registerHandler({
        keys: ['ctrl+interrupt'],
        description: 'Test streaming check',
        handler: (ctx) => {
          receivedStreamingState = ctx.isStreaming;
        },
      });

      // With streaming on, the handler should receive isStreaming=true
      manager.setStreaming(true);
      await manager.processKey(['ctrl', 'interrupt']);
      
      expect(receivedStreamingState).toBe(true);
    });
  });

  describe('setStreaming()', () => {
    it('should update the streaming state', async () => {
      manager.setStreaming(false);
      const bindings = manager.getBindings();
      
      expect(bindings.length).toBeGreaterThan(0); // Manager still has defaults
      
      // The internal state should be updated (checked via processKey behavior)
      manager.setStreaming(true);
    });

    it('should affect interrupt handling', async () => {
      // Test that setStreaming updates internal state correctly
      manager.setStreaming(false);
      const ctx1: any = {};
      
      let handlerCalledWithStreaming = false;
      manager.registerHandler({
        keys: ['ctrl+test'],
        description: 'Test streaming check',
        handler: (ctx) => {
          handlerCalledWithStreaming = (ctx as any).isStreaming;
        },
      });

      // With streaming off, context should have isStreaming=false
      await manager.processKey(['ctrl', 'test'], { isStreaming: false });
      expect(handlerCalledWithStreaming).toBe(false);

      // With streaming on, context should have isStreaming=true  
      handlerCalledWithStreaming = false;
      await manager.processKey(['ctrl', 'test'], { isStreaming: true });
      expect(handlerCalledWithStreaming).toBe(true);
    });
  });

  describe('getBindings()', () => {
    it('should return all registered bindings as an array', async () => {
      const bindings = manager.getBindings();
      
      expect(Array.isArray(bindings)).toBe(true);
      expect(bindings.length).toBeGreaterThan(0); // Has defaults
      
      for (const binding of bindings) {
        expect(binding.id).toBeDefined();
        expect(binding.keys).toBeDefined();
        expect(Array.isArray(binding.keys)).toBe(true);
      }
    });

    it('should include descriptions when available', async () => {
      manager.registerHandler({
        keys: ['ctrl+test'],
        description: 'Test binding for coverage',
        handler: () => {},
      });

      const bindings = manager.getBindings();
      
      const testBinding = bindings.find(b => b.keys.includes('test'));
      expect(testBinding?.description).toBe('Test binding for coverage');
    });
  });

  describe('getHelpText()', () => {
    it('should return formatted help text', async () => {
      const helpText = manager.getHelpText();
      
      expect(typeof helpText).toBe('string');
      expect(helpText.length).toBeGreaterThan(0);
      expect(helpText).toContain('Keybindings:');
    });

    it('should include key sequences in the output', async () => {
      const helpText = manager.getHelpText();
      
      // Check for some default bindings (keys are sorted alphabetically)
      expect(helpText.toLowerCase()).toContain('c + ^');  // ctrl+c becomes c+^
      expect(helpText.toLowerCase()).toContain('^ + d');  // ctrl+d becomes ^+d
    });

    it('should return message when no bindings registered', async () => {
      manager.clearAll();
      
      const helpText = manager.getHelpText();
      
      expect(helpText).toBe('No keybindings registered.');
    });

    it('should format keys with special characters', async () => {
      const helpText = manager.getHelpText();
      
      // Check for formatted keys (^, ⌥, etc.)
      expect(helpText).toContain('^');  // ctrl becomes ^
      expect(helpText).toContain('⌥');  // alt becomes ⌥
    });
  });

  describe('Edge cases and error handling', () => {
    it('should register custom bindings alongside defaults', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['ctrl+custom'],
        description: 'Custom binding test',
        handler: () => { handlerCalled = true; },
      });

      const result = await manager.processKey(['ctrl', 'custom']);
      
      expect(result).toBe(true);
      expect(handlerCalled).toBe(true);
    });

    it('should handle empty key arrays gracefully', async () => {
      manager.registerHandler({
        keys: [],
        handler: () => {},
      });

      const bindings = manager.getBindings();
      
      // Should still register (even if not very useful)
      expect(bindings.length).toBeGreaterThan(0);
    });



    it('should handle null/undefined when() function gracefully', async () => {
      manager.registerHandler({
        keys: ['ctrl+g'],
        handler: () => {},
        // No 'when' property - should default to matching
      });

      const result = manager.matchKey(['ctrl', 'g']);
      
      expect(result).not.toBeNull();
    });

    it('should handle when() function that throws an error', async () => {
      let handlerCalled = false;
      
      manager.registerHandler({
        keys: ['ctrl+f'],
        description: 'Test binding with broken condition',
        when: () => { throw new Error('Condition failed'); },
        handler: () => { handlerCalled = true; },
      });

      const result = manager.matchKey(['ctrl', 'f']);
      
      // Should return null because the when() function threw an error
      expect(result).toBeNull();
    });



    it('should handle case variations in key names', async () => {
      let handlerCalled = false;
      
      // Register with uppercase (will be normalized to lowercase)
      manager.registerHandler({
        keys: ['CTRL', 'ALT', 'SHIFT', 'A'],
        handler: () => { handlerCalled = true; },
      });

      const result = await manager.processKey(['ctrl', 'alt', 'shift', 'a']);
      
      expect(result).toBe(true);
    });

    it('should dispatch Node readline keypress events', () => {
      const handler = vi.fn();
      manager.registerHandler({ keys: ['ctrl+k'], handler });

      const handled = manager.handleKeypress({ name: 'k', ctrl: true });

      expect(handled).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should ignore incomplete or unregistered keypress events', () => {
      expect(manager.handleKeypress(undefined)).toBe(false);
      expect(manager.handleKeypress({ name: 'unknown' })).toBe(false);
    });
  });

  describe('configuration persistence', () => {
    it('resolves configured action identifiers to runtime handlers', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ai-harness-keybinding-actions-'));
      const filePath = join(directory, 'keybindings.json');
      const action = vi.fn();
      try {
        await writeFile(filePath, JSON.stringify([{
          id: 'custom-help', action: 'app.help', keys: ['ctrl', 'h'], description: 'Aide personnalisée',
        }]));
        manager.registerAction('app.help', { description: 'Aide', handler: action });
        await manager.loadFromFile(filePath);

        await expect(manager.processKey(['ctrl', 'h'])).resolves.toBe(true);
        expect(action).toHaveBeenCalledOnce();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('saves registered bindings and loads their configuration', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ai-harness-keybindings-'));
      const filePath = join(directory, 'keybindings.json');

      try {
        manager.registerHandler({
          keys: ['ctrl+x'],
          description: 'Custom persisted action',
          handler: () => {},
        });
        await manager.saveToFile(filePath);

        const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Array<{ keys: string[] }>;
        expect(persisted.some(binding => binding.keys.includes('x'))).toBe(true);

        const loadedManager = new KeyBindingManager();
        await loadedManager.loadFromFile(filePath);
        expect(loadedManager.getBindings().some(binding => binding.description === 'Custom persisted action')).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
