// ============================================================
// Provider Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  AiProvider,
  ProviderFactory,
  OpenAiProvider,
  AnthropicProvider,
} from './index';
import { Message, ProviderConfig } from '../types';

describe('Providers', () => {
  // Test abstract class behavior
  describe('AiProvider (abstract)', () => {
    it('requires concrete implementation for chat method', async () => {
      // AiProvider is abstract in TypeScript but compiles to a regular class at runtime.
      // The key point is that subclasses must implement the abstract methods.
      const config: any = { type: 'openai' as const, apiKey: 'test-key' };
      
      // OpenAiProvider extends AiProvider and implements chat
      const provider = new OpenAiProvider(config);
      expect(provider.chat).toBeDefined();
      expect(typeof provider.chat).toBe('function');
    });
  });

  // OpenAI Provider tests
  describe('OpenAiProvider', () => {
    const config: ProviderConfig = { type: 'openai', apiKey: 'test-key' };
    let provider: OpenAiProvider;

    beforeEach(() => {
      provider = new OpenAiProvider(config);
    });

    it('should validate config with API key', () => {
      expect(provider.validateConfig()).toBe(true);
    });

    it('should fail validation without API key', () => {
      const noKeyProvider = new OpenAiProvider({ type: 'openai' });
      expect(noKeyProvider.validateConfig()).toBe(false);
    });

    it('should return a response for chat', async () => {
      const messages: Message[] = [
        { id: '1', role: 'user', content: 'Hello!', timestamp: new Date() },
      ];
      const response = await provider.chat(messages);
      expect(response).toContain('OpenAI Response');
    });

    it('should throw error for empty messages', async () => {
      await expect(provider.chat([])).rejects.toThrow('No messages provided');
    });

    it('should stream chat with chunks', async () => {
      const chunks: string[] = [];
      let completed = false;

      await provider.streamChat(
        [{ id: '1', role: 'user', content: 'Hi', timestamp: new Date() }],
        (chunk) => chunks.push(chunk),
        () => { completed = true; },
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(completed).toBe(true);
    });
  });

  // Anthropic Provider tests
  describe('AnthropicProvider', () => {
    const config: ProviderConfig = { type: 'anthropic', apiKey: 'test-key' };
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = new AnthropicProvider(config);
    });

    it('should validate config with API key', () => {
      expect(provider.validateConfig()).toBe(true);
    });

    it('should return a response for chat', async () => {
      const messages: Message[] = [
        { id: '1', role: 'user', content: 'Hello!', timestamp: new Date() },
      ];
      const response = await provider.chat(messages);
      expect(response).toContain('Anthropic Response');
    });

    it('should throw error for empty messages', async () => {
      await expect(provider.chat([])).rejects.toThrow('No messages provided');
    });
  });

  // Provider Factory tests
  describe('ProviderFactory', () => {
    it('should create OpenAI provider', () => {
      const provider = ProviderFactory.create({ type: 'openai' });
      expect(provider).toBeInstanceOf(OpenAiProvider);
    });

    it('should create Anthropic provider', () => {
      const provider = ProviderFactory.create({ type: 'anthropic' });
      expect(provider).toBeInstanceOf(AnthropicProvider);
    });

    it('should throw error for unsupported provider type', () => {
      expect(() =>
        ProviderFactory.create({ type: 'unsupported' as any }),
      ).toThrow('Unsupported provider type');
    });
  });
});
