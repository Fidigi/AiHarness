// ============================================================
// Session Manager Tests
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from './session-manager';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  // Create tests
  describe('create()', () => {
    it('should create a session with default values', () => {
      const session = manager.create();

      expect(session.id).toBeDefined();
      expect(Array.isArray(session.messages)).toBe(true);
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.updatedAt).toBeInstanceOf(Date);
    });

    it('should create a session with custom title', () => {
      const session = manager.create({ title: 'My Chat' });

      expect(session.title).toBe('My Chat');
    });

    it('should create a session with custom ID', () => {
      const session = manager.create({ id: 'custom-id-123' });

      expect(session.id).toBe('custom-id-123');
    });

    it('should auto-generate unique IDs for each session', () => {
      const s1 = manager.create();
      const s2 = manager.create();

      expect(s1.id).not.toBe(s2.id);
    });
  });

  // Get tests
  describe('get()', () => {
    it('should return a session by ID', () => {
      const session = manager.create({ title: 'Test' });
      const found = manager.get(session.id);

      expect(found).toEqual(session);
    });

    it('should return undefined for non-existent session', () => {
      const found = manager.get('non-existent-id');

      expect(found).toBeUndefined();
    });
  });

  // List tests
  describe('list()', () => {
    it('should return empty array when no sessions exist', () => {
      const sessions = manager.list();

      expect(sessions).toEqual([]);
    });

    it('should return all created sessions', () => {
      manager.create({ title: 'Session 1' });
      manager.create({ title: 'Session 2' });
      manager.create({ title: 'Session 3' });

      const sessions = manager.list();

      expect(sessions).toHaveLength(3);
    });

    it('should return sessions sorted by updatedAt descending', async () => {
      const s1 = manager.create({ title: 'First' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const s2 = manager.create({ title: 'Second' });

      const sessions = manager.list();
      // First item should be most recent (s2)
      expect(sessions[0].id).toBe(s2.id);
      expect(sessions[1].id).toBe(s1.id);
    });
  });

  // AddMessage tests
  describe('addMessage()', () => {
    it('should add a user message to session', () => {
      const session = manager.create();
      
      const result = manager.addMessage(session.id, {
        role: 'user',
        content: 'Hello!',
      });

      expect(result).not.toBeNull();
      expect(result?.messages.length).toBe(1);
      expect(result?.messages[0].role).toBe('user');
      expect(result?.messages[0].content).toBe('Hello!');
    });

    it('should add an assistant message to session', () => {
      const session = manager.create();
      
      manager.addMessage(session.id, {
        role: 'assistant',
        content: 'Hi there!',
      });

      // Session is modified in place (Map stores references)
      expect(session.messages.length).toBe(1);
    });

    it('should auto-generate title from first user message', () => {
      const session = manager.create(); // No initial title
      
      manager.addMessage(session.id, {
        role: 'user',
        content: 'This is my very long conversation that should be truncated in the title...',
      });

      // Title gets updated to first user message (truncated)
      expect(session.title).toContain('This is my very long');
    });

    it('should return null for non-existent session', () => {
      const result = manager.addMessage('non-existent', {
        role: 'user',
        content: 'Hello!',
      });

      expect(result).toBeNull();
    });

    it('should generate unique IDs for each message', () => {
      const session = manager.create();
      
      manager.addMessage(session.id, { role: 'user', content: 'Msg 1' });
      manager.addMessage(session.id, { role: 'assistant', content: 'Reply 1' });

      // Need to retrieve the updated session
      const updatedSession = manager.get(session.id);
      
      expect(updatedSession?.messages[0].id).not.toBe(
        updatedSession?.messages[1].id,
      );
    });
  });

  // Delete tests
  describe('delete()', () => {
    it('should delete an existing session', () => {
      const session = manager.create({ title: 'To Delete' });
      
      const result = manager.delete(session.id);

      expect(result).toBe(true);
      expect(manager.get(session.id)).toBeUndefined();
    });

    it('should return false for non-existent session', () => {
      const result = manager.delete('non-existent-id');

      expect(result).toBe(false);
    });

    it('should not affect other sessions when deleting one', () => {
      const s1 = manager.create({ title: 'Keep 1' });
      const s2 = manager.create({ title: 'Delete Me' });
      const s3 = manager.create({ title: 'Keep 2' });

      manager.delete(s2.id);

      expect(manager.list()).toHaveLength(2);
      expect(manager.get(s1.id)).toBeDefined();
      expect(manager.get(s3.id)).toBeDefined();
    });
  });

  // Clear tests
  describe('clear()', () => {
    it('should remove all sessions', () => {
      manager.create({ title: 'Session 1' });
      manager.create({ title: 'Session 2' });

      manager.clear();

      expect(manager.list()).toHaveLength(0);
      expect(manager.get('any-id')).toBeUndefined();
    });
  });

  // Listener tests
  describe('setListener()', () => {
    it('should call listener when session is created', () => {
      const callback = vi.fn();
      manager.setListener(callback);

      manager.create({ title: 'Test' });

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0]).toBeDefined();
    });

    it('should call listener when message is added', () => {
      const callback = vi.fn();
      manager.setListener(callback);

      const session = manager.create();
      callback.mockClear(); // Clear create event

      manager.addMessage(session.id, { role: 'user', content: 'Hello' });

      expect(callback).toHaveBeenCalled();
    });

    it('should call listener when session is deleted', () => {
      const callback = vi.fn();
      manager.setListener(callback);

      const session = manager.create();
      callback.mockClear(); // Clear create event

      manager.delete(session.id);

      expect(callback).toHaveBeenCalledWith(session.id);
    });
  });
});
