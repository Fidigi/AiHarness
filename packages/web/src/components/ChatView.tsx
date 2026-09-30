// ============================================================
// Chat View Component - Real AI Integration with Streaming
// ============================================================

import { Fragment, useState, useRef, useEffect } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ProviderType } from '@ai-harness/core';
import { useParams } from 'react-router-dom';
import { useI18n } from '../hooks/useI18n';
import { useSessionStore } from '../store/session-store';
import { appendSessionMessage, streamChat } from '../services/api';

interface ChatViewProps {
  onStreamingUpdate?: (content: string) => void;
}

function ChatView({ onStreamingUpdate }: ChatViewProps) {
  const { id } = useParams<{ id: string }>();
  const currentSession = useSessionStore((state) =>
    state.sessions.find((s) => s.id === (id || '')),
  );
  const addMessage = useSessionStore((state) => state.addMessage);
  const upsertAssistantMessage = useSessionStore((state) => state.upsertAssistantMessage);
  const { t } = useI18n();

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages]);

  // Get provider configuration from store
  const activeProviderType = useSessionStore((state) => state.providers.active);

  /** Send a message and get AI response (with streaming support) */
  const sendMessage = async () => {
    if (!input.trim() || !id) return;

    const userMessage = input.trim();
    setInput('');

    // Add user message to store
    addMessage(id, { role: 'user', content: userMessage });
    await appendSessionMessage(id, { role: 'user', content: userMessage });
    setIsLoading(true);

    try {
      // Try to use the real API via fetch (would be proxied in production)
      const providerConfig = useSessionStore.getState().providers.available[activeProviderType];

      const requiresApiKey = !['mock', 'local'].includes(activeProviderType);
      if (!providerConfig?.apiKey && requiresApiKey) {
        // Fall back to mock response for unconfigured hosted providers
        await new Promise((resolve) => setTimeout(resolve, 500));
        const content = t('chat.demoResponse');
        addMessage(id, { role: 'assistant', content });
        await appendSessionMessage(id, { role: 'assistant', content });
      } else if (activeProviderType === 'mock') {
        const content = await simulateMockStreaming(userMessage);
        await appendSessionMessage(id, { role: 'assistant', content });
      } else {
        const content = await fetchAIResponse(id, userMessage, activeProviderType);
        if (content) await appendSessionMessage(id, { role: 'assistant', content });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('chat.unexpectedError');
      const content = t('chat.error', { message: errorMessage });
      addMessage(id, { role: 'assistant', content });
      await appendSessionMessage(id, { role: 'assistant', content });
    } finally {
      setIsLoading(false);
    }
  };

  /** Simulate mock streaming response for testing */
  const simulateMockStreaming = async (userMessage: string): Promise<string> => {
    // Mock responses based on input patterns
    let mockResponse = t('chat.mock.generic', { provider: activeProviderType });
    const normalizedMessage = userMessage.toLocaleLowerCase();

    if (['hello', 'hi', 'bonjour', 'salut'].some(greeting => normalizedMessage.includes(greeting))) {
      mockResponse = t('chat.mock.hello');
    } else if (['help', 'aide'].some(keyword => normalizedMessage.includes(keyword))) {
      mockResponse = t('chat.mock.help');
    } else if (normalizedMessage.includes('test')) {
      mockResponse = t('chat.mock.test');
    }

    // Keep one stable assistant message while chunks arrive.
    const messageId = crypto.randomUUID();
    let streamedContent = '';
    const chunkSize = 3;

    for (let i = 0; i < mockResponse.length; i += chunkSize) {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 + 10));
      streamedContent += mockResponse.slice(i, i + chunkSize);
      upsertAssistantMessage(id!, messageId, streamedContent);
      onStreamingUpdate?.(streamedContent);
    }
    return streamedContent;
  };

  /** Fetch a real AI response through the backend SSE service. */
  const fetchAIResponse = async (sessionId: string, userMessage: string, providerType: string): Promise<string> => {
    const messageId = crypto.randomUUID();
    let streamedContent = '';
    const messages = [
      ...(currentSession?.messages ?? []).map(message => ({
        role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: message.content,
      })),
      { role: 'user' as const, content: userMessage },
    ];

    const providerConfig = useSessionStore.getState().providers.available[providerType as ProviderType];
    const options = providerConfig?.model ? { model: providerConfig.model } : undefined;

    for await (const event of streamChat(providerType, messages, options)) {
      if (event.type === 'text_delta' && event.content) {
        streamedContent += event.content;
        upsertAssistantMessage(sessionId, messageId, streamedContent);
        onStreamingUpdate?.(streamedContent);
      } else if (event.type === 'message_end') {
        const finalContent = event.content || streamedContent;
        streamedContent = finalContent;
        if (finalContent) upsertAssistantMessage(sessionId, messageId, finalContent);
      } else if (event.type === 'error') {
        throw new Error(event.content || t('chat.unknownStreamingError'));
      }
    }
    return streamedContent;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await sendMessage();
  };

  if (!currentSession) {
    return (
      <div className="chat-empty">
        <h2>{t('chat.welcome')}</h2>
        <p>{t('chat.selectOrCreate')}</p>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <div className="messages-container">
        {currentSession.messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-role">
              {msg.role === 'user' ? `👤 ${t('chat.role.user')}` : `🤖 ${t('chat.role.assistant')}`}
            </div>
            <div className="message-content">
              {/* Support basic markdown-like rendering */}
              {renderMessageContent(msg.content)}
            </div>
          </div>
        ))}

        {/* Loading indicator for streaming responses */}
        {isLoading && (
          <div className="message assistant loading" role="status" aria-label={t('chat.loading')}>
            <div className="message-role">🤖 {t('chat.role.assistant')}</div>
            <div className="typing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="input-container">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('chat.inputPlaceholder', { provider: activeProviderType })}
          autoFocus
          disabled={isLoading}
        />
        <button type="submit" disabled={!input.trim() || isLoading}>
          {isLoading ? '⏳' : t('chat.send')}
        </button>
      </form>

      {/* Provider status indicator */}
      {!currentSession.messages.some(m => m.role === 'assistant') && (
        <div className="provider-status">
          {t('chat.usingProvider')} <strong>{activeProviderType}</strong>
          {activeProviderType !== 'mock' && !useSessionStore.getState().providers.available[activeProviderType]?.apiKey && (
            <span className="warning">{t('chat.demoModeWarning')}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Render message content with basic formatting */
function renderMessageContent(content: string): ReactNode {
  // Simple markdown-like rendering for code blocks and inline code
  const parts = content.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          // Code block
          const code = part.slice(3, -3).replace(/^[^\n]*\n/, '');
          return (
            <pre key={index} className="code-block">
              <code>{code}</code>
            </pre>
          );
        } else if (part.startsWith('`') && part.endsWith('`')) {
          // Inline code
          return <code key={index} className="inline-code">{part.slice(1, -1)}</code>;
        }

        // Regular text with line breaks preserved
        return <span key={index}>{part.split('\n').map((line, i) => (
          <Fragment key={`${index}-${i}`}>
            {i > 0 && <br />}
            {line}
          </Fragment>
        ))}</span>;
      })}
    </>
  );
}

export default ChatView;
