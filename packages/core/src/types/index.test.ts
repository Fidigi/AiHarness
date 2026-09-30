// ============================================================
// Core Types Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import { ProviderType, Role, Message, Session } from './index';

describe('Types', () => {
  describe('ProviderType enum', () => {
    it('should contain all expected provider types', () => {
      expect(ProviderType.OPENAI).toBe('openai');
      expect(ProviderType.ANTHROPIC).toBe('anthropic');
      expect(ProviderType.GOOGLE).toBe('google');
      expect(ProviderType.LOCAL).toBe('local');
      expect(ProviderType.CUSTOM).toBe('custom');
    });
  });

  describe('Role type', () => {
    it('should accept valid roles', () => {
      const roles: Role[] = ['user', 'assistant', 'system', 'tool'];
      roles.forEach((role) => {
        expect(['user', 'assistant', 'system', 'tool']).toContain(role);
      });
    });
  });

  describe('Message interface', () => {
    it('should create a valid message object', () => {
      const message: Message = {
        id: 'test-id-123',
        role: 'user',
        content: 'Hello, world!',
        timestamp: new Date(),
      };

      expect(message.id).toBe('test-id-123');
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello, world!');
      expect(message.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('Session interface', () => {
    it('should create a valid session object', () => {
      const now = new Date();
      const session: Session = {
        id: 'session-123',
        title: 'Test Conversation',
        messages: [],
        createdAt: now,
        updatedAt: now,
      };

      expect(session.id).toBe('session-123');
      expect(session.title).toBe('Test Conversation');
      expect(Array.isArray(session.messages)).toBe(true);
    });
  });
});
