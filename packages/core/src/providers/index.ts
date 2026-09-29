// ============================================================
// AI Provider Interface & Base Implementation
// ============================================================

import { Message, ProviderConfig } from '../types';

/** Abstract interface for all AI providers */
export abstract class AiProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /** Send messages and get a response */
  abstract chat(messages: Message[]): Promise<string>;

  /** Stream a response (for real-time output) - default implementation */
  async streamChat(
    _messages: Message[],
    _onChunk: (chunk: string) => void,
    _onComplete?: () => void,
  ): Promise<void> {
    // Default non-streaming fallback
    const response = await this.chat(_messages);
    _onChunk(response);
    _onComplete?.();
  }

  /** Validate provider configuration */
  abstract validateConfig(): boolean;

  /** Get the list of available models (if supported) */
  async getAvailableModels?(): Promise<string[]> {
    return undefined as unknown as string[];
  }
}

/** Provider factory to create instances by type */
export class ProviderFactory {
  static create(config: ProviderConfig): AiProvider {
    switch (config.type) {
      case 'openai':
        return new OpenAiProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      default:
        throw new Error(`Unsupported provider type: ${config.type}`);
    }
  }
}

// ============================================================
// OpenAI Provider (stub)
// ============================================================

export class OpenAiProvider extends AiProvider {
  validateConfig(): boolean {
    return !!this.config.apiKey;
  }

  async chat(messages: Message[]): Promise<string> {
    // TODO: Implement actual API call
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      throw new Error('No messages provided');
    }
    return `[OpenAI Response to]: ${lastMessage.content}`;
  }

  async streamChat(
    messages: Message[],
    onChunk: (chunk: string) => void,
    onComplete?: () => void,
  ): Promise<void> {
    const response = await this.chat(messages);
    // Simulate streaming by splitting into chunks
    const chunkSize = 10;
    for (let i = 0; i < response.length; i += chunkSize) {
      onChunk(response.slice(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    onComplete?.();
  }
}

// ============================================================
// Anthropic Provider (stub)
// ============================================================

export class AnthropicProvider extends AiProvider {
  validateConfig(): boolean {
    return !!this.config.apiKey;
  }

  async chat(messages: Message[]): Promise<string> {
    // TODO: Implement actual API call
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      throw new Error('No messages provided');
    }
    return `[Anthropic Response to]: ${lastMessage.content}`;
  }

  async streamChat(
    messages: Message[],
    onChunk: (chunk: string) => void,
    onComplete?: () => void,
  ): Promise<void> {
    const response = await this.chat(messages);
    const chunkSize = 10;
    for (let i = 0; i < response.length; i += chunkSize) {
      onChunk(response.slice(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    onComplete?.();
  }
}
