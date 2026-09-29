// ============================================================
// Command Handler Tests
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '@ai-harness/core';
import { CommandHandler } from './handler';

describe('CommandHandler', () => {
  let manager: SessionManager;
  let handler: CommandHandler;

  beforeEach(() => {
    manager = new SessionManager();
    handler = new CommandHandler(manager);
  });

  // Test /help command
  describe('/help command', () => {
    it('should not exit on help', async () => {
      await handler.execute('/help', null);
      
      expect(handler.isExiting()).toBe(false);
    });
  });

  // Test /new command
  describe('/new command', () => {
    it('should create a new session', async () => {
      const sessionsBefore = manager.list();
      await handler.execute('/new', null);
      
      expect(manager.list().length).toBe(sessionsBefore.length + 1);
    });

    it('should return creation message', async () => {
      // Capture stdout
      const originalWrite = process.stdout.write;
      let output = '';
      process.stdout.write = (str: string) => {
        output += str;
        return true;
      };

      await handler.execute('/new Test Chat', null);

      process.stdout.write = originalWrite;
      
      expect(output).toContain('Created');
    });
  });

  // Test /list command
  describe('/list command', () => {
    it('should show empty list when no sessions', async () => {
      const originalWrite = process.stdout.write;
      let output = '';
      process.stdout.write = (str: string) => {
        output += str;
        return true;
      };

      await handler.execute('/list', null);

      process.stdout.write = originalWrite;
      
      expect(output).toContain('No conversations yet');
    });

    it('should list all sessions', async () => {
      manager.create({ title: 'Session 1' });
      manager.create({ title: 'Session 2' });

      const originalWrite = process.stdout.write;
      let output = '';
      process.stdout.write = (str: string) => {
        output += str;
        return true;
      };

      await handler.execute('/list', null);

      process.stdout.write = originalWrite;
      
      expect(output).toContain('Session 1');
      expect(output).toContain('Session 2');
    });
  });

  // Test /delete command
  describe('/delete command', () => {
    it('should delete an existing session', async () => {
      const session = manager.create({ title: 'To Delete' });
      
      await handler.execute(`/delete ${session.id}`, null);
      
      expect(manager.get(session.id)).toBeUndefined();
    });

    it('should return error for non-existent session', async () => {
      const originalWrite = process.stdout.write;
      let output = '';
      process.stdout.write = (str: string) => {
        output += str;
        return true;
      };

      await handler.execute('/delete non-existent-id', null);

      process.stdout.write = originalWrite;
      
      expect(output).toContain('not found');
    });
  });

  // Test /quit command
  describe('/quit command', () => {
    it('should set exiting flag to true', async () => {
      await handler.execute('/quit', null);
      
      expect(handler.isExiting()).toBe(true);
    });
  });

  // Test unknown commands
  describe('Unknown commands', () => {
    it('should show error for unknown command', async () => {
      const originalWrite = process.stdout.write;
      let output = '';
      process.stdout.write = (str: string) => {
        output += str;
        return true;
      };

      await handler.execute('/unknowncommand', null);

      process.stdout.write = originalWrite;
      
      expect(output).toContain('Unknown command');
    });
  });

  // Test empty input
  describe('Empty/invalid input', () => {
    it('should handle empty command gracefully', async () => {
      await handler.execute('/', null);
      
      expect(handler.isExiting()).toBe(false);
    });
  });
});
