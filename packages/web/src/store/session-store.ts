// ============================================================
// Session Store - Zustand State Management
// ============================================================

import { create } from 'zustand';
import { Message, ProviderConfig } from '@ai-harness/core';

export interface SessionState {
  sessions: Array<{
    id: string;
    title?: string;
    messages: Message[];
    createdAt: Date;
    updatedAt: Date;
  }>;
  activeSessionId: string | null;

  // Actions
  createSession: (title?: string) => void;
  addMessage: (sessionId: string, message: { role: 'user' | 'assistant'; content: string }) => void;
  setActiveSession: (id: string) => void;
}

export interface ProviderState {
  providers: {
    active: string;
    available: Record<string, ProviderConfig>;
  };
  setProvider: (type: string) => void;
}

// Combine stores for simplicity (can be split in production)
const useBaseStore = create<SessionState>((set) => ({
  sessions: [],
  activeSessionId: null,

  createSession: (title?: string) => {
    const id = crypto.randomUUID();
    const newSession = {
      id,
      title,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    set((state) => ({
      sessions: [newSession, ...state.sessions],
      activeSessionId: id,
    }));
  },

  addMessage: (sessionId: string, message: { role: 'user' | 'assistant'; content: string }) => {
    const fullMessage = {
      ...message,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id === sessionId) {
          return {
            ...session,
            messages: [...session.messages, fullMessage],
            updatedAt: new Date(),
            title: session.title || message.content.slice(0, 50),
          };
        }
        return session;
      }),
    }));
  },

  setActiveSession: (id: string) => {
    set({ activeSessionId: id });
  },
}));

const useProviderStore = create<ProviderState>((set) => ({
  providers: {
    active: 'openai',
    available: {
      openai: { type: 'openai' as const, model: 'gpt-4' },
      anthropic: { type: 'anthropic' as const, model: 'claude-3-opus' },
    },
  },

  setProvider: (type: string) => {
    set((state) => ({
      providers: { ...state.providers, active: type },
    }));
  },
}));

// Export combined store for convenience
export const useSessionStore = {
  sessions: useBaseStore((s) => s.sessions),
  activeSessionId: useBaseStore((s) => s.activeSessionId),
  createSession: useBaseStore((s) => s.createSession),
  addMessage: useBaseStore((s) => s.addMessage),
  setActiveSession: useBaseStore((s) => s.setActiveSession),
};

export const useProviderStore = {
  providers: useProviderStore((s) => s.providers),
  setProvider: useProviderStore((s) => s.setProvider),
};
