// ============================================================
// Session Store - Combined Zustand state for sessions/providers
// ============================================================

import { create } from 'zustand';
import { ProviderType } from '@ai-harness/core';
import type { Message, ProviderConfig } from '@ai-harness/core';
import { createSession as createApiSession, getProviders, listSessions } from '../services/api.js';

export interface StoredSession {
  id: string;
  title?: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionState {
  sessions: StoredSession[];
  activeSessionId: string | null;
  createSession: (title?: string) => void;
  createRemoteSession: (title?: string) => Promise<string | undefined>;
  hydrateSessions: () => Promise<void>;
  addMessage: (sessionId: string, message: { role: 'user' | 'assistant'; content: string }) => void;
  upsertAssistantMessage: (sessionId: string, messageId: string, content: string) => void;
  setActiveSession: (id: string) => void;
}

export interface ProviderState {
  providers: {
    active: ProviderType;
    available: Record<ProviderType, ProviderConfig>;
  };
  setProvider: (type: ProviderType) => void;
  updateApiKey: (type: ProviderType, apiKey: string) => void;
  hydrateProviders: () => Promise<void>;
}

export type AppState = SessionState & ProviderState;

const defaultProviders: Record<ProviderType, ProviderConfig> = {
  [ProviderType.OPENAI]: {
    type: ProviderType.OPENAI,
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
  },
  [ProviderType.ANTHROPIC]: {
    type: ProviderType.ANTHROPIC,
    model: 'claude-3-haiku-20240307',
    baseUrl: 'https://api.anthropic.com',
  },
  [ProviderType.GOOGLE]: {
    type: ProviderType.GOOGLE,
    model: 'gemini-2.0-flash',
  },
  [ProviderType.AZURE]: { type: ProviderType.AZURE, model: 'gpt-4o' },
  [ProviderType.BEDROCK]: { type: ProviderType.BEDROCK, model: 'anthropic.claude-3-haiku-20240307-v1:0' },
  [ProviderType.VERTEX]: { type: ProviderType.VERTEX, model: 'gemini-2.0-flash' },
  [ProviderType.LOCAL]: {
    type: ProviderType.LOCAL,
    model: 'local-model',
    baseUrl: 'http://localhost:11434/v1',
  },
  [ProviderType.MOCK]: {
    type: ProviderType.MOCK,
    apiKey: '',
  },
  [ProviderType.CUSTOM]: {
    type: ProviderType.CUSTOM,
  },
};

export const useSessionStore = create<AppState>((set) => ({
  sessions: [],
  activeSessionId: null,
  providers: {
    active: ProviderType.MOCK,
    available: defaultProviders,
  },

  createSession: (title?: string) => {
    const id = crypto.randomUUID();
    const newSession: StoredSession = {
      id,
      title,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    set(state => ({
      sessions: [newSession, ...state.sessions],
      activeSessionId: id,
    }));
  },

  createRemoteSession: async title => {
    const result = await createApiSession(title);
    if (!result.success || !result.data) return undefined;
    const now = new Date();
    const session: StoredSession = {
      id: result.data.id,
      title: result.data.title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    set(state => ({ sessions: [session, ...state.sessions], activeSessionId: session.id }));
    return session.id;
  },

  hydrateSessions: async () => {
    const result = await listSessions();
    if (!result.success || !result.data) return;
    const sessions = result.data.map(session => ({
      ...session,
      createdAt: new Date(session.createdAt),
      updatedAt: new Date(session.updatedAt),
      messages: session.messages.map(message => ({ ...message, timestamp: new Date(message.timestamp) })),
    }));
    set(state => ({
      sessions,
      activeSessionId: state.activeSessionId && sessions.some(session => session.id === state.activeSessionId)
        ? state.activeSessionId
        : sessions[0]?.id ?? null,
    }));
  },

  addMessage: (sessionId, message) => {
    const fullMessage: Message = {
      ...message,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    set(state => ({
      sessions: state.sessions.map(session => session.id === sessionId
        ? {
            ...session,
            messages: [...session.messages, fullMessage],
            updatedAt: new Date(),
            title: session.title || message.content.slice(0, 50),
          }
        : session),
    }));
  },

  upsertAssistantMessage: (sessionId, messageId, content) => set(state => ({
    sessions: state.sessions.map(session => {
      if (session.id !== sessionId) return session;

      const existingIndex = session.messages.findIndex(message => message.id === messageId);
      const messages = existingIndex >= 0
        ? session.messages.map((message, index) => index === existingIndex ? { ...message, content } : message)
        : [...session.messages, {
            id: messageId,
            role: 'assistant' as const,
            content,
            timestamp: new Date(),
          }];

      return { ...session, messages, updatedAt: new Date() };
    }),
  })),

  setActiveSession: id => set({ activeSessionId: id }),

  setProvider: type => set(state => ({
    providers: { ...state.providers, active: type },
  })),

  hydrateProviders: async () => {
    const result = await getProviders();
    if (!result.success || !result.data) return;
    set(state => {
      const available = { ...state.providers.available };
      for (const provider of result.data!) {
        const type = provider.type as ProviderType;
        if (available[type] && provider.configured) available[type] = { ...available[type], apiKey: 'configured' };
      }
      return { providers: { ...state.providers, available } };
    });
  },

  updateApiKey: (type, apiKey) => set(state => ({
    providers: {
      ...state.providers,
      available: {
        ...state.providers.available,
        [type]: { ...state.providers.available[type], apiKey },
      },
    },
  })),
}));

// Aliases retained for advanced/non-React store access.
export const baseStore = useSessionStore;
export const providerStore = useSessionStore;
