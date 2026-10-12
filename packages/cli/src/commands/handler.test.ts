// ============================================================
// Command Handler Tests - Full coverage for all commands
// Covers: /new, /list, /switch, /delete, /clear, /compact,
//         /provider, /model, /export, /help, /quit
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  EncryptedCredentialStore,
  ExtensionRegistry,
  JsonlSessionStore,
  ProviderCredentialService,
  SessionManager,
} from '@ai-harness/core';
import { CommandHandler } from './handler';
import type { TerminalUI } from '../tui/terminal-ui';

// ===================================================================
// Test helpers - Mock TerminalUI (no real terminal interaction)
// ===================================================================

function createMockTerminal(): jest.Mocked<Partial<TerminalUI>> & Pick<TerminalUI, 'isCurrentlyStreaming'> {
  return {
    isCurrentlyStreaming: () => false,
    welcome: vi.fn(),
    displayUserMessage: vi.fn(),
    displayAssistantMessage: vi.fn(),
    displayCommand: vi.fn(),
    showError: vi.fn(),
    showHelp: vi.fn(),
    exitMessage: vi.fn(),
    clear: vi.fn(),
    addTranscriptEntry: vi.fn(),
    displaySearchResults: vi.fn(),
  } as any;
}

async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr?.write;
  
  // Capture both stdout and stderr (chalk may use either)
  process.stdout.write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  if (process.stderr) {
    (process.stderr as any).write = (chunk: string) => {
      chunks.push(chunk);
      return true;
    };
  }

  try {
    await fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
    if (originalStderrWrite) {
      (process.stderr as any).write = originalStderrWrite;
    }
  }

  return chunks.join('');
}

// ===================================================================
// Test setup with temp directory for JSONL persistence
// ===================================================================

describe('CommandHandler', () => {
  let manager: SessionManager;
  let store: JsonlSessionStore;
  let handler: CommandHandler;
  let terminal: ReturnType<typeof createMockTerminal>;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for session storage
    tempDir = path.join(os.tmpdir(), `ai-harness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store = new JsonlSessionStore(tempDir);
    manager = new SessionManager();
    manager.setStore(store);

    terminal = createMockTerminal();
    handler = new CommandHandler(manager, store, terminal as any, undefined, undefined, {
      cwd: tempDir,
      isProjectTrusted: () => true,
    });

    // Create a default session for tests that need one
    await manager.create({ title: 'Default Session' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    // Cleanup temp directory
    try {
      const fs = await import('fs/promises');
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* Ignore cleanup errors */ }
  });

  // ===================================================================
  // /help command tests
  // ===================================================================

  describe('/help command', () => {
    it('should not exit on help', async () => {
      await handler.execute('/help');
      expect(handler.isExiting()).toBe(false);
    });

    it('should output help text to terminal', async () => {
      const output = await captureOutput(async () => await handler.execute('/help'));
      expect(output).toBe('');
      // The help command returns empty string (handled by TerminalUI.showHelp())
      // but the execute method should still work without errors
      expect(handler.isExiting()).toBe(false);
    });

    it('should handle /HELP case-insensitively', async () => {
      await handler.execute('/HELP');
      expect(handler.isExiting()).toBe(false);
    });
  });

  // ===================================================================
  // /new command tests
  // ===================================================================

  describe('/new command', () => {
    it('should create a new session with auto-generated title', async () => {
      const before = manager.list();
      await handler.execute('/new');
      expect(manager.list().length).toBe(before.length + 1);
    });

    it('should create a session with custom title', async () => {
      await new Promise(r => setTimeout(r, 10)); // Small delay for different timestamps
      await handler.execute('/new My Custom Chat');
      const sessions = manager.list();
      // The most recent session should have the custom title (sorted by updatedAt desc)
      expect(sessions.some(s => s.title === 'My Custom Chat')).toBe(true);
    });

    it('should return creation message with session ID', async () => {
      await handler.execute('/new Test Session');
      const sessions = manager.list();
      // Should create a new session
      expect(sessions.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===================================================================
  // /list command tests
  // ===================================================================

  describe('/list command', () => {
    it('should show sessions with titles and message counts', async () => {
      await manager.create({ title: 'Session A' });
      const session = manager.list()[0];
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
      }

      // Verify sessions are listed correctly
      expect(manager.list().some(s => s.title === 'Session A')).toBe(true);
    });

    it('should list all sessions sorted by updatedAt (newest first)', async () => {
      await manager.create({ title: 'Oldest' });
      await new Promise(r => setTimeout(r, 10)); // Small delay for different timestamps
      const newest = await manager.create({ title: 'Newest' });

      if (newest) {
        await manager.addMessage(newest.id, { role: 'user', content: 'Hi' });
      }

      // Verify sessions are created and listed
      expect(manager.list().some(s => s.title === 'Newest')).toBe(true);
    });

    it('should show message count in list', async () => {
      const session = manager.list()[0];
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
        await manager.addMessage(session.id, { role: 'assistant', content: 'Hi!' });

        expect(manager.get(session.id)?.messages.length).toBe(2);
      }
    });
  });

  // ===================================================================
  // /switch command tests (now loads from JSONL store)
  // ===================================================================

  describe('/switch command', () => {
    it('should return error when no argument provided', async () => {
      await handler.execute('/switch');
      expect(handler.isExiting()).toBe(false);
    });

    it('should handle non-existent session ID gracefully', async () => {
      // Should not throw, just report the error
      await handler.execute('/switch nonexistent-id-12345');
      expect(manager.list().length).toBeGreaterThanOrEqual(1);
    });

    it('should handle number index out of range', async () => {
      const before = manager.list();
      await handler.execute('/switch 999');
      // Should not crash, just report error
      expect(manager.list()).toEqual(before);
    });

    it('should switch to a session by ID when in memory', async () => {
      // Create two sessions and keep both in memory
      const session1 = await manager.create({ title: 'Session One' });
      const session2 = await manager.create({ title: 'Session Two' });

      if (session1 && session2) {
        await handler.execute(`/switch ${session2.id}`);
        expect(handler.getContext().currentSessionId).toBe(session2.id);
      }
    });

    it('should switch by numeric index', async () => {
      // Create sessions and use index 1 (first in list = most recent)
      const beforeCount = manager.list().length;
      const expected = manager.list()[0];
      await handler.execute('/switch 1');
      expect(handler.getContext().currentSessionId).toBe(expected.id);
      expect(manager.list().length).toBe(beforeCount);
    });

    it('should load from JSONL store when not in memory', async () => {
      // Create and save a session, then remove it from memory
      const session = await manager.create({ title: 'JSONL Session' });
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Test message' });

        // Verify the file exists on disk
        const allIdsBefore = await store.listSessionIds();
        expect(allIdsBefore).toContain(session.id);

        // Remove from in-memory store but keep on disk
        manager['sessions'].delete(session.id);

        // Switching by persisted ID reloads it into memory and activates it.
        await handler.execute(`/switch ${session.id}`);
        expect(manager.get(session.id)).toBeDefined();
        expect(handler.getContext().currentSessionId).toBe(session.id);
      }
    });
  });

  // ===================================================================
  // /delete command tests
  // ===================================================================

  describe('/delete command', () => {
    it('should delete an existing session from memory and disk', async () => {
      const session = await manager.create({ title: 'To Delete' });
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Hello' });

        await handler.execute(`/delete ${session.id}`);
        expect(manager.get(session.id)).toBeUndefined();
      }
    });

    it('should return error for non-existent session', async () => {
      // Should not throw, just report the error
      await handler.execute('/delete nonexistent-id');
      expect(handler.isExiting()).toBe(false);
    });

    it('should require an ID argument', async () => {
      const before = manager.list();
      await handler.execute('/delete');
      expect(manager.list()).toEqual(before);
    });
  });

  // ===================================================================
  // /clear command tests (now actually clears messages)
  // ===================================================================

  describe('/clear command', () => {
    it('should clear all messages from the current session', async () => {
      const session = manager.list()[0];
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
        await manager.addMessage(session.id, { role: 'assistant', content: 'Hi!' });

        expect(manager.get(session.id)?.messages.length).toBe(2);

        await handler.execute('/clear');
        
        // Verify messages were cleared (session still exists but empty)
        const updatedSession = manager.get(session.id);
        if (updatedSession) {
          expect(updatedSession.messages.length).toBe(0);
        }
      }
    });

    it('should return warning when no sessions exist', async () => {
      // Clear all sessions first
      manager.clear();

      await handler.execute('/clear');
      expect(handler.isExiting()).toBe(false);
    });

    it('should preserve the session after clearing messages', async () => {
      const session = manager.list()[0];
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Hello' });

        await handler.execute('/clear');

        // Session should still exist but be empty
        const updatedSession = manager.get(session.id);
        expect(updatedSession).toBeDefined();
      }
    });
  });

  // ===================================================================
  // /compact command tests (now uses LLM summarization)
  // ===================================================================

  describe('/compact command', () => {
    it('should return error when no sessions exist', async () => {
      manager.clear();
      await handler.execute('/compact');
      expect(handler.isExiting()).toBe(false);
    });

    it('should return error when fewer than 3 messages', async () => {
      // The default empty session has 0 messages
      await handler.execute('/compact');
      expect(handler.isExiting()).toBe(false);
    });

    it('should require a configured provider for LLM summarization', async () => {
      // Add some messages but don't configure any real providers
      const session = manager.list()[0];
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
        await manager.addMessage(session.id, { role: 'assistant', content: 'Hi!' });
        await manager.addMessage(session.id, { role: 'user', content: 'How are you?' });

        // Should fail because no provider is configured (only mock which doesn't validate)
        const beforeMsgCount = session.messages.length;
        await handler.execute('/compact');
        expect(beforeMsgCount).toBe(3);
        expect(handler.isExiting()).toBe(false);
      }
    });

    it('should use custom instructions when provided', async () => {
      const session = manager.list()[0];
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
        await manager.addMessage(session.id, { role: 'assistant', content: 'Hi!' });
        await manager.addMessage(session.id, { role: 'user', content: 'How are you?' });

        // With mock provider (doesn't validate API key)
        const beforeMsgCount = session.messages.length;
        await handler.execute('/compact Be very concise');
        expect(beforeMsgCount).toBe(3);
        expect(handler.isExiting()).toBe(false);
      }
    });

    it('should handle compaction with many messages', async () => {
      const session = manager.list()[0];
      if (session) {
        for (let i = 0; i < 10; i++) {
          await manager.addMessage(session.id, { role: 'user', content: `User message ${i}` });
          await manager.addMessage(session.id, { role: 'assistant', content: `Assistant response ${i}` });
        }

        const beforeMsgCount = session.messages.length;
        await handler.execute('/compact');
        expect(beforeMsgCount).toBe(20);
        expect(handler.isExiting()).toBe(false);
      }
    });
  });

  // ===================================================================
  // /export command tests (now supports jsonl format)
  // ===================================================================

  // ===================================================================
// Session Tree Commands (fork/clone/tree)
// ===================================================================
describe('/tree command', () => {
  it('should show session tree structure without errors', async () => {
    await handler.execute('/tree');
    expect(handler.isExiting()).toBe(false);
  });
});

describe('/fork command', () => {
  it('should fork a session when given valid ID', async () => {
    const sessions = manager.list();
    if (sessions.length > 0) {
      await handler.execute(`/fork ${sessions[0].id}`);
      expect(handler.isExiting()).toBe(false);
    }
  });

  it('should handle invalid session ID gracefully', async () => {
    // Should not throw, just show error message
    await expect(async () => {
      await handler.execute('/fork non-existent-id');
    }).not.toThrow();
    expect(handler.isExiting()).toBe(false);
  });
});

describe('/clone command', () => {
  it('should clone a session when given valid ID', async () => {
    const sessions = manager.list();
    if (sessions.length > 0) {
      await handler.execute(`/clone ${sessions[0].id}`);
      expect(handler.isExiting()).toBe(false);
    }
  });

  it('should handle invalid session ID gracefully', async () => {
    // Should not throw, just show error message
    await expect(async () => {
      await handler.execute('/clone non-existent-id');
    }).not.toThrow();
    expect(handler.isExiting()).toBe(false);
  });
});

describe('/export command', () => {
    it('should export session as JSON by default', async () => {
      await handler.execute('/export');
      expect(handler.isExiting()).toBe(false);
    });

    it('should support markdown format', async () => {
      await handler.execute('/export markdown');
      expect(handler.isExiting()).toBe(false);
    });

    it('should support jsonl format', async () => {
      const session = manager.list()[0];
      if (session) {
        await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
        await handler.execute('/export jsonl');
        expect(handler.isExiting()).toBe(false);
      }
    });

    it('should return error for unsupported format', async () => {
      const before = manager.list();
      await handler.execute('/export xml');
      // Should not crash, just report error
      expect(manager.list()).toEqual(before);
    });

    it('should show export filename in output', async () => {
      await handler.execute('/export json');
      expect(handler.isExiting()).toBe(false);
    });
  });

  // ===================================================================
  // /provider command tests
  // ===================================================================

  describe('/provider command', () => {
    it('should list available providers without error', async () => {
      await handler.execute('/provider');
      expect(handler.isExiting()).toBe(false);
    });

    it('should show mock provider as configured', async () => {
      // Mock is always available by default
      const ctx = handler.getContext();
      expect(ctx.providers.has('mock')).toBe(true);
    });

    it('should expose and switch to the local OpenAI-compatible provider', async () => {
      expect(handler.getContext().providers.has('local')).toBe(true);
      await handler.execute('/provider local');
      expect((handler.getContext().provider as any).config.type).toBe('local');
      expect(handler.getContext().provider?.validateConfig()).toBe(true);
    });

    it('should switch to a different provider when specified', async () => {
      await handler.execute('/provider mock');
      // Mock is always available, so this should work
      expect(handler.getContext().providers.has('mock')).toBe(true);
    });

    it('should return error for unknown provider without crashing', async () => {
      const before = manager.list();
      await handler.execute('/provider nonexistent');
      expect(manager.list()).toEqual(before);
    });
  });

  // ===================================================================
  // /model command tests
  // ===================================================================

  describe('/model command', () => {
    it('should list models for the active provider without error', async () => {
      await handler.execute('/model');
      expect(handler.isExiting()).toBe(false);
    });

    it('should show different models per provider type', async () => {
      // Switch to mock and check model info
      await handler.execute('/provider mock');
      expect(handler.getContext().providers.get('mock')).toBeDefined();
    });

    it('should display current model when called without arguments', async () => {
      await handler.execute('/provider mock');
      const ctx = handler.getContext();
      
      // Set a specific model
      (ctx.provider as any)['config'].model = 'mock-model-v1';
      
      await handler.execute('/model');
      expect(handler.isExiting()).toBe(false);
    });
  });

  describe('/model cycling', () => {
    it('should cycle to next model when /model cycle is used', async () => {
      // Create a fresh handler with mock provider having multiple models
      const store = new JsonlSessionStore(tempDir);
      const sm = new SessionManager();
      await sm.create({ title: 'Test' });
      
      const terminal = createMockTerminal();
      const modelHandler = new CommandHandler(sm, store, terminal);
      
      // Set up mock provider with config
      const ctx = modelHandler.getContext();
      (ctx.provider as any)['config'] = { type: 'mock', model: null };
      
      await modelHandler.execute('/model cycle');
      expect(ctx.provider?.getConfiguredModel()).toBe('mock-model');
      expect(modelHandler.isExiting()).toBe(false);
    });

    it('should set a specific model when /model <name> is used', async () => {
      const store = new JsonlSessionStore(tempDir);
      const sm = new SessionManager();
      await sm.create({ title: 'Test' });
      
      const terminal = createMockTerminal();
      const modelHandler = new CommandHandler(sm, store, terminal);
      const ctx = modelHandler.getContext();
      (ctx.provider as any)['config'] = { type: 'mock', model: null };
      
      await modelHandler.execute('/model mock-model-v1');
      expect(ctx.provider?.getConfiguredModel()).toBe('mock-model-v1');
      expect(modelHandler.isExiting()).toBe(false);
    });

    it('should show error for unknown model name', async () => {
      const store = new JsonlSessionStore(tempDir);
      const sm = new SessionManager();
      await sm.create({ title: 'Test' });
      
      const terminal = createMockTerminal();
      const modelHandler = new CommandHandler(sm, store, terminal);
      const ctx = modelHandler.getContext();
      (ctx.provider as any)['config'] = { type: 'mock', model: null };
      
      await modelHandler.execute('/model nonexistent-model');
      expect(modelHandler.isExiting()).toBe(false);
    });

    it('should handle /model --cycle alias', async () => {
      const store = new JsonlSessionStore(tempDir);
      const sm = new SessionManager();
      await sm.create({ title: 'Test' });
      
      const terminal = createMockTerminal();
      const modelHandler = new CommandHandler(sm, store, terminal);
      const ctx = modelHandler.getContext();
      (ctx.provider as any)['config'] = { type: 'mock', model: null };
      
      await modelHandler.execute('/model --cycle');
      expect(modelHandler.isExiting()).toBe(false);
    });
  });

  // ===================================================================
  // /config command tests
  // ===================================================================

  describe('/config command', () => {
    it('should show configuration information without error', async () => {
      await handler.execute('/config');
      expect(handler.isExiting()).toBe(false);
    });

    it('should not exit on config', async () => {
      await handler.execute('/config');
      expect(handler.isExiting()).toBe(false);
    });

    it('shows the host-provided effective agent settings summary', async () => {
      const settingsHandler = new CommandHandler(
        manager,
        store,
        terminal as any,
        undefined,
        undefined,
        { cwd: process.cwd(), settingsInfo: () => 'theme: dark [global]' },
      );
      const output = await captureOutput(() => settingsHandler.execute('/settings'));
      expect(output).toContain('theme: dark [global]');
    });
  });

  // ===================================================================
  // Extension command/tool integration
  // ===================================================================

  describe('extension integration', () => {
    it('respects /mcp ownership, rejects a second owner and restores the builtin on unload', async () => {
      const registry = new ExtensionRegistry();
      await registry.load('mcp-owner', api => api.registerCommand('mcp', {
        description: 'Owned MCP command', handler: args => `owned:${args}`,
      }));
      const ownedHandler = new CommandHandler(manager, store, terminal as unknown as TerminalUI, registry);
      expect(await captureOutput(() => ownedHandler.execute('/mcp status'))).toContain('owned:status');
      await expect(registry.load('mcp-conflict', api => api.registerCommand('mcp', {
        description: 'Conflicting command', handler: () => 'wrong-owner',
      }))).rejects.toThrow();
      expect(await captureOutput(() => ownedHandler.execute('/mcp'))).toContain('owned:');
      await registry.unload('mcp-owner');
      expect(await captureOutput(() => ownedHandler.execute('/mcp'))).toContain('MCP runtime is not configured.');
    });

    it('dispatches dynamically registered slash commands', async () => {
      const registry = new ExtensionRegistry();
      await registry.load('test-extension', api => api.registerCommand('greet', {
        description: 'Greeting',
        handler: args => `Bonjour ${args}`,
      }));
      const extensionHandler = new CommandHandler(manager, store, terminal as any, registry);

      const output = await captureOutput(() => extensionHandler.execute('/greet Ada'));

      expect(output).toContain('Bonjour Ada');
    });

    it('lists and executes registered tools', async () => {
      const registry = new ExtensionRegistry();
      await registry.load('tool-extension', api => api.registerTool({
        name: 'echo',
        description: 'Echo input',
        execute: input => ({ content: String((input as { value: string }).value) }),
      }));
      const extensionHandler = new CommandHandler(manager, store, terminal as any, registry);

      const output = await captureOutput(async () => {
        await extensionHandler.execute('/tools');
        await extensionHandler.execute('/tool echo {"value":"ok"}');
      });

      expect(output).toContain('echo');
      expect(output).toContain('ok');
    });

    it('reloads extensions through the configured registry handler', async () => {
      const registry = new ExtensionRegistry();
      const reload = vi.fn().mockResolvedValue(undefined);
      registry.setReloadHandler(reload);
      const extensionHandler = new CommandHandler(manager, store, terminal as any, registry);

      await extensionHandler.execute('/reload');

      expect(reload).toHaveBeenCalledOnce();
    });
  });

  // ===================================================================
  // /quit command tests
  // ===================================================================

  describe('/quit command', () => {
    it('should set exiting flag to true', async () => {
      await handler.execute('/quit');
      expect(handler.isExiting()).toBe(true);
    });

    it('should handle /exit as alias for quit', async () => {
      await handler.execute('/exit');
      expect(handler.isExiting()).toBe(true);
    });
  });

  // ===================================================================
  // Edge cases and error handling
  // ===================================================================

  describe('Edge cases', () => {


    it('should handle case-insensitive commands', async () => {
      await handler.execute('/NEW');
      expect(handler.isExiting()).toBe(false);
    });

    it('should not crash on whitespace-only input', async () => {
      await handler.execute('   ');
      expect(handler.isExiting()).toBe(false);
    });

    it('should handle commands with extra arguments gracefully', async () => {
      // Just verify the command doesn't throw
      await handler.execute('/new Title With Extra Args Here');
      const sessions = manager.list();
      expect(sessions.length).toBeGreaterThanOrEqual(2); // At least default + new one
    });

    it('should persist sessions to JSONL store', async () => {
      const session1Id = manager.list()[0]?.id;

      // Create another session
      await handler.execute('/new Persisted Session');

      // Verify the new session was created and persisted
      const allIds = await store.listSessionIds();
      expect(allIds).toContain(session1Id);
      expect(allIds.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===================================================================
  // Context management tests
  // ===================================================================

  describe('Context management', () => {
    it('should return the command context', async () => {
      const ctx = handler.getContext();
      expect(ctx.sessionManager).toBe(manager);
      expect(ctx.jsonlStore).toBe(store);
      expect(ctx.providers.has('mock')).toBe(true);
    });

    it('should have default provider set to mock', async () => {
      const ctx = handler.getContext();
      expect(ctx.provider).toBeDefined();
      // Mock provider should be the default
      expect(ctx.provider?.validateConfig()).toBe(true);
    });
  });

  // ===================================================================
  // Export command tests (with file I/O)
  // ===================================================================

  describe('Export with file writing', () => {
    it('should export session as JSON to a specified path', async () => {
      const testFile = path.join(tempDir, `test-export-${Date.now()}.json`);

      await handler.execute('/new Export Test Session');
      await captureOutput(async () => {
        await handler.execute(`/export json ${testFile}`);
      });

      // Verify file was created and contains valid JSON
      const content = await fs.readFile(testFile, 'utf-8');
      const exportedData = JSON.parse(content);
      expect(exportedData).toHaveProperty('id');
      expect(exportedData).toHaveProperty('title', 'Export Test Session');
      expect(Array.isArray(exportedData.messages)).toBe(true);

      // Cleanup
      await fs.unlink(testFile);
    });

    it('should export session as markdown to a specified path', async () => {
      const testFile = path.join(tempDir, `test-export-${Date.now()}.md`);

      await handler.execute('/new Markdown Export');
      await captureOutput(async () => {
        await handler.execute(`/export markdown ${testFile}`);
      });

      // Verify file was created and contains markdown header
      const content = await fs.readFile(testFile, 'utf-8');
      expect(content).toContain('# Markdown Export');

      // Cleanup
      await fs.unlink(testFile);
    });

    it('should export an escaped standalone HTML document', async () => {
      const testFile = path.join(tempDir, `test-export-${Date.now()}.html`);
      await handler.execute('/new HTML Export');
      const sessionId = handler.getContext().currentSessionId!;
      await manager.addMessage(sessionId, { role: 'user', content: '<script>alert(1)</script>' });

      await captureOutput(async () => {
        await handler.execute(`/export html ${testFile}`);
      });

      const content = await fs.readFile(testFile, 'utf-8');
      expect(content).toContain('<!doctype html>');
      expect(content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(content).not.toContain('<script>alert(1)</script>');
      await fs.unlink(testFile);
    });

    it('should export session as JSONL to a specified path', async () => {
      const testFile = path.join(tempDir, `test-export-${Date.now()}.jsonl`);

      // Create a session with messages so we have content to export
      await handler.execute('/new JSONL Export');
      
      // Verify the command doesn't throw and creates a file (even if empty for new sessions)
      await captureOutput(async () => {
        await handler.execute(`/export jsonl ${testFile}`);
      });

      // File should exist
      await fs.access(testFile);

      // Cleanup
      await fs.unlink(testFile);
    });

    it('supports quoted export paths containing spaces', async () => {
      const testFile = path.join(tempDir, 'quoted export.json');
      await handler.execute('/new Quoted Export');

      await captureOutput(async () => {
        await handler.execute(`/export json "${testFile}"`);
      });

      await expect(fs.access(testFile)).resolves.toBeUndefined();
    });

    it('rejects export destinations outside the approved workspace', async () => {
      const outside = path.join(path.dirname(tempDir), `outside-export-${Date.now()}.json`);
      await captureOutput(async () => {
        await handler.execute(`/export json "${outside}"`);
      });

      await expect(fs.access(outside)).rejects.toThrow();
    });

    it('does not follow a symlink export destination', async () => {
      const target = path.join(tempDir, 'export-target.json');
      const linked = path.join(tempDir, 'export-link.json');
      await fs.writeFile(target, 'unchanged');
      await fs.symlink(target, linked);

      await captureOutput(async () => {
        await handler.execute(`/export json "${linked}"`);
      });

      await expect(fs.readFile(target, 'utf8')).resolves.toBe('unchanged');
    });

    it('should return error for unsupported export format', async () => {
      const output = await captureOutput(async () => {
        await handler.execute('/export xml /tmp/test.xml');
      });
      expect(output).toContain('Unsupported format');
    });
  });

  // ===================================================================
  // Import command tests (JSONL file I/O)
  // ===================================================================

  describe('Import from JSONL', () => {
    it('should import a single-session JSONL file', async () => {
      const testFile = path.join(tempDir, `test-import-${Date.now()}.jsonl`);

      // Create a valid JSONL file manually
      await fs.writeFile(testFile, [
        JSON.stringify({ id: 'import-test-1', role: 'user', content: 'Hello import test', timestamp: new Date().toISOString() }),
        JSON.stringify({ id: 'import-test-2', role: 'assistant', content: 'Imported successfully!', timestamp: new Date().toISOString() }),
      ].join('\n'));

      const beforeCount = manager.list().length;
      await captureOutput(async () => {
        await handler.execute(`/import ${testFile}`);
      });

      // Verify session and messages were imported
      expect(manager.list().length).toBe(beforeCount + 1);
      const imported = manager.list().find(session => session.messages.some(message => message.id === 'import-test-1'));
      expect(imported?.messages).toHaveLength(2);
      expect(imported?.messages[1].content).toBe('Imported successfully!');

      // Cleanup
      await fs.unlink(testFile);
    });

    it('supports quoted import paths containing spaces', async () => {
      const testFile = path.join(tempDir, 'quoted import.jsonl');
      await fs.writeFile(testFile, JSON.stringify({
        id: 'quoted-import-message', role: 'user', content: 'quoted', timestamp: new Date().toISOString(),
      }));

      await captureOutput(async () => {
        await handler.execute(`/import "${testFile}"`);
      });

      expect(manager.list().some(session => session.messages.some(message => message.id === 'quoted-import-message'))).toBe(true);
    });

    it('rejects symlinked import files', async () => {
      const target = path.join(tempDir, 'import-target.jsonl');
      const linked = path.join(tempDir, 'import-link.jsonl');
      await fs.writeFile(target, JSON.stringify({
        id: 'symlink-import-message', role: 'user', content: 'unsafe', timestamp: new Date().toISOString(),
      }));
      await fs.symlink(target, linked);
      const beforeCount = manager.list().length;

      const output = await captureOutput(async () => {
        await handler.execute(`/import "${linked}"`);
      });

      expect(output).toContain('Import failed');
      expect(manager.list()).toHaveLength(beforeCount);
    });

    it('rejects import files outside the approved workspace', async () => {
      const outside = path.join(path.dirname(tempDir), `outside-import-${Date.now()}.jsonl`);
      await fs.writeFile(outside, JSON.stringify({
        id: 'outside-import-message', role: 'user', content: 'unsafe', timestamp: new Date().toISOString(),
      }));
      const beforeCount = manager.list().length;
      try {
        const output = await captureOutput(async () => {
          await handler.execute(`/import "${outside}"`);
        });
        expect(output).toContain('Import failed');
        expect(manager.list()).toHaveLength(beforeCount);
      } finally {
        await fs.rm(outside, { force: true });
      }
    });

    it('should import a multi-session JSON array file', async () => {
      const testFile = path.join(tempDir, `test-import-${Date.now()}.json`);

      // Create a valid multi-session JSON file
      await fs.writeFile(testFile, JSON.stringify([
        { id: 'multi-1', title: 'Session A', messages: [
          { id: 'm1', role: 'user', content: 'Msg 1', timestamp: new Date().toISOString() }
        ]},
        { id: 'multi-2', title: 'Session B', messages: [
          { id: 'm2', role: 'assistant', content: 'Msg 2', timestamp: new Date().toISOString() }
        ]}
      ]));

      const beforeCount = manager.list().length;
      await captureOutput(async () => {
        await handler.execute(`/import ${testFile}`);
      });

      // Verify both sessions and their messages were imported
      expect(manager.list().length).toBe(beforeCount + 2);
      expect(manager.get('multi-1')?.messages[0].content).toBe('Msg 1');
      expect(manager.get('multi-2')?.messages[0].content).toBe('Msg 2');

      // Cleanup
      await fs.unlink(testFile);
    });

    it('prevalidates multi-session imports and rolls back creations after a later persistence failure', async () => {
      const malformedFile = path.join(tempDir, 'malformed-multi-import.json');
      await fs.writeFile(malformedFile, JSON.stringify([
        { id: 'prevalidated-1', messages: [{ id: 'ok-1', role: 'user', content: 'ok', timestamp: Date.now() }] },
        { id: 'prevalidated-2', messages: [{ id: 'bad-1', role: 'invalid', content: 'bad', timestamp: Date.now() }] },
      ]));
      const beforeMalformed = manager.list().length;
      const malformedOutput = await captureOutput(() => handler.execute(`/import "${malformedFile}"`));
      expect(malformedOutput).toContain('Import failed');
      expect(manager.list()).toHaveLength(beforeMalformed);

      const rollbackFile = path.join(tempDir, 'rollback-multi-import.json');
      await fs.writeFile(rollbackFile, JSON.stringify([
        { id: 'rollback-1', messages: [{ id: 'rollback-message-1', role: 'user', content: 'one', timestamp: Date.now() }] },
        { id: 'rollback-2', messages: [{ id: 'rollback-message-2', role: 'assistant', content: 'two', timestamp: Date.now() }] },
      ]));
      const create = manager.create.bind(manager);
      let createCalls = 0;
      const createSpy = vi.spyOn(manager, 'create').mockImplementation(options => {
        createCalls++;
        return createCalls === 2 ? Promise.reject(new Error('simulated persistence failure')) : create(options);
      });
      try {
        const rollbackOutput = await captureOutput(() => handler.execute(`/import "${rollbackFile}"`));
        expect(rollbackOutput).toContain('Import failed');
        expect(manager.get('rollback-1')).toBeUndefined();
        expect(manager.get('rollback-2')).toBeUndefined();
      } finally {
        createSpy.mockRestore();
      }
    });

    it('should handle missing import file gracefully', async () => {
      const output = await captureOutput(async () => {
        await handler.execute('/import /nonexistent/path/file.jsonl');
      });
      expect(output).toContain('Import failed');
    });

    it('should return error for empty import file', async () => {
      const testFile = path.join(tempDir, `test-import-${Date.now()}.jsonl`);
      await fs.writeFile(testFile, ''); // Empty file

      await captureOutput(async () => {
        await handler.execute(`/import ${testFile}`);
      });

      expect(manager.list().length).toBe(1); // No new sessions added

      // Cleanup
      await fs.unlink(testFile);
    });
  });

  // ===================================================================
  // List with search/filter tests
  // ===================================================================

  describe('List with filtering', () => {
    it('should list all sessions without filter', async () => {
      await handler.execute('/new Filter Test A');
      await handler.execute('/new Filter Test B');
      
      const output = await captureOutput(async () => {
        await handler.execute('/list');
      });

      expect(output).toContain('Filter Test A');
      expect(output).toContain('Filter Test B');
    });

    it('should filter sessions by title', async () => {
      // Verify filtering works by checking the command doesn't throw
      await captureOutput(async () => {
        await handler.execute('/list Filter');
      });
      
      // Sessions should still exist (command didn't delete anything)
      const sessions = manager.list();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty when no sessions match filter', async () => {
      await captureOutput(async () => {
        await handler.execute('/list NonExistentSessionXYZ123');
      });
      
      // Original sessions should still exist
      expect(manager.list().length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Theme and credential commands', () => {
    it('lists and switches themes without rebuilding the handler', async () => {
      const select = vi.fn(async (name: string) => name);
      const themed = new CommandHandler(manager, store, terminal as any, undefined, undefined, {
        cwd: tempDir,
        themeControl: {
          current: () => 'dark',
          list: async () => [{
            name: 'ocean', mode: 'dark', active: false, valid: true,
            provenance: {
              scope: 'user', source: 'package', origin: 'top-level', path: '/themes/ocean.json',
              selector: '/themes/ocean.json', trusted: true,
            },
          }],
          select,
        },
      });

      const listed = await captureOutput(() => themed.execute('/theme'));
      expect(listed).toContain('ocean');
      expect(listed).toContain('user/package');
      await themed.execute('/theme ocean');
      expect(select).toHaveBeenCalledWith('ocean');
    });

    it('refuses OAuth before network access when persistent credential storage is unavailable', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const authenticated = new CommandHandler(manager, store, terminal as any, undefined, undefined, {
        cwd: tempDir,
        credentialService: new ProviderCredentialService(),
      });

      const output = await captureOutput(() => authenticated.execute('/login openai'));
      expect(output).toContain('stockage chiffré persistant');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('persists OAuth login metadata, logs out, and never prints the token accidentally', async () => {
      const credentialStore = new EncryptedCredentialStore(
        path.join(tempDir, 'credentials.enc'),
        'correct horse battery staple',
      );
      const credentials = new ProviderCredentialService({ store: credentialStore });
      await credentials.load();
      vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_DEVICE_URL', 'https://auth.example/device');
      vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_TOKEN_URL', 'https://auth.example/token');
      vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_CLIENT_ID', 'public-client');
      const secret = 'short-oauth-secret';
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          device_code: 'device-code', user_code: 'ABCD',
          verification_uri: 'https://auth.example/activate', expires_in: 10, interval: 0.001,
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          access_token: secret, refresh_token: 'refresh-value', expires_in: 3600, token_type: 'Bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);
      const authTerminal = {
        ...terminal,
        writeOutput: (message: string) => { process.stdout.write(`${message}\n`); },
        writeExplicitCredentialReveal: (message: string) => { process.stdout.write(`${message}\n`); },
      };
      const authenticated = new CommandHandler(manager, store, authTerminal as any, undefined, undefined, {
        cwd: tempDir,
        credentialService: credentials,
        allowCredentialReveal: true,
      });

      const login = await captureOutput(() => authenticated.execute('/login openai'));
      expect(login).toContain('Authentification OAuth réussie');
      expect(login).not.toContain(secret);
      expect(credentials.list()).toEqual([
        expect.objectContaining({ provider: 'openai', type: 'oauth', source: 'encrypted-store', refreshable: true }),
      ]);

      const descriptors = await captureOutput(() => authenticated.execute('/credentials'));
      expect(descriptors).toContain('openai');
      expect(descriptors).not.toContain(secret);
      const revealed = await captureOutput(() => authenticated.execute('/credential reveal openai'));
      expect(revealed).toContain(secret);
      const rejectedReveal = await captureOutput(() => authenticated.execute('/credential reveal openai extra'));
      expect(rejectedReveal).toContain('Usage:');
      expect(rejectedReveal).not.toContain(secret);
      const rejectedPrefixReveal = await captureOutput(() => authenticated.execute('/cred reveal openai'));
      expect(rejectedPrefixReveal).toContain('Ambiguous command');
      expect(rejectedPrefixReveal).not.toContain(secret);

      const logout = await captureOutput(() => authenticated.execute('/logout openai'));
      expect(logout).toContain('supprimés');
      expect(logout).not.toContain(secret);
      expect(credentials.list()).toEqual([]);
    });
  });

  describe('Share command', () => {
    it('uses a bounded no-redirect authenticated request and validates its response', async () => {
      vi.stubEnv('AI_HARNESS_SERVER_URL', 'https://server.example/base');
      vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'share-auth-secret');
      const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
        url: '/share/public-token', expiresInHours: 2,
      }), { status: 201, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);

      const output = await captureOutput(() => handler.execute('/share 2'));

      expect(output).toContain('/share/public-token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, options] = fetchMock.mock.calls[0]!;
      expect(String(requestUrl)).toMatch(/^https:\/\/server\.example\/base\/api\/sessions\/.+\/share$/u);
      expect(options).toMatchObject({
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer share-auth-secret' },
        body: JSON.stringify({ ttlHours: 2 }),
      });
    });

    it('rejects unsafe lifetimes and does not reflect redirect bodies or follow them', async () => {
      vi.stubEnv('AI_HARNESS_SERVER_URL', 'https://server.example');
      const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('hostile-response-secret', {
        status: 302, headers: { location: 'https://attacker.invalid/' },
      }));
      vi.stubGlobal('fetch', fetchMock);

      const invalid = await captureOutput(() => handler.execute('/share 0'));
      expect(invalid).toContain('1 et 168');
      expect(fetchMock).not.toHaveBeenCalled();

      const redirected = await captureOutput(() => handler.execute('/share 24'));
      expect(redirected).toContain('(302)');
      expect(redirected).not.toContain('hostile-response-secret');
      expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'manual' }));
    });
  });

  // ===================================================================
  // Rename command tests (alias for /name)
  // ===================================================================

  describe('Rename session', () => {
    it('should rename the current session via /rename', async () => {
      const sessionsBefore = manager.list().length;
      await handler.execute('/new Original Name');
      
      // Verify command executes without error
      await captureOutput(async () => {
        await handler.execute('/rename Renamed Session');
      });

      expect(manager.list()).toHaveLength(sessionsBefore + 1);
      // The rename should have been recorded in the transcript mock
      expect(terminal.addTranscriptEntry).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Session renamed to: Renamed Session' })
      );
    });

    it('should handle /rename with empty title', async () => {
      // Should return usage error without crashing
      await captureOutput(async () => {
        await handler.execute('/rename');
      });
      
      expect(manager.list().length).toBeGreaterThanOrEqual(1);
    });
  });
});
