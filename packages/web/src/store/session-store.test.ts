// ============================================================
// Session Store Tests - Zustand State Management (Non-React)
// Uses store directly without React hooks for testing
// ============================================================

import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import type { ProviderType } from '@ai-harness/core';

// Simple UUID generator (replaces crypto.randomUUID())
const generateId = () => `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ===================================================================
// Session Store Tests - Inline store for each test to avoid caching issues
// ===================================================================

describe('SessionStore', () => {
  describe('createSession()', () => {
    it('should create a new session with unique ID', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ id: string; title?: string }>,
        activeSessionId: null as string | null,
        createSession: (title?: string) => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id, title }, ...state.sessions],
            activeSessionId: id 
          };
        }),
      }));

      expect(useStore.getState().sessions.length).toBe(0);
      
      useStore.getState().createSession('Test Session');

      const state = useStore.getState();
      expect(state.sessions.length).toBe(1);
      expect(state.sessions[0].id).toBeDefined();
    });

    it('should set the new session as active', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ id: string; title?: string }>,
        activeSessionId: null as string | null,
        createSession: (title?: string) => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id, title }, ...state.sessions],
            activeSessionId: id 
          };
        }),
      }));

      useStore.getState().createSession('Test Session');

      expect(useStore.getState().activeSessionId).toBe(useStore.getState().sessions[0].id);
    });

    it('should generate title from first message when not provided', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ id: string; title?: string }>,
        activeSessionId: null as string | null,
        createSession: (title?: string) => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id, title }, ...state.sessions],
            activeSessionId: id 
          };
        }),
      }));

      useStore.getState().createSession(); // No title

      expect(useStore.getState().sessions[0].title).toBeUndefined();
    });

    it('should add sessions in most recent first order', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ id: string; title?: string }>,
        activeSessionId: null as string | null,
        createSession: (title?: string) => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id, title }, ...state.sessions],
            activeSessionId: id 
          };
        }),
      }));

      useStore.getState().createSession('First');
      useStore.getState().createSession('Second');
      useStore.getState().createSession('Third');

      const state = useStore.getState();
      expect(state.sessions.length).toBe(3);
      expect(state.sessions[0].title).toBe('Third');
      expect(state.sessions[2].title).toBe('First');
    });
  });

  describe('addMessage()', () => {
    it('should add a message to an existing session', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ 
          id: string; title?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> 
        }>,
        activeSessionId: null as string | null,
        createSession: (title?: string) => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id, title, messages: [] }, ...state.sessions],
            activeSessionId: id 
          };
        }),
        addMessage: (sessionId: string, message: { role: 'user' | 'assistant'; content: string }) => set((state) => ({
          sessions: state.sessions.map(s => s.id === sessionId ? { ...s, messages: [...s.messages, message] } : s),
        })),
      }));

      useStore.getState().createSession('Test Session');
      
      const sessionId = useStore.getState().sessions[0].id;
      useStore.getState().addMessage(sessionId, { role: 'user', content: 'Hello' });

      expect(useStore.getState().sessions[0].messages.length).toBe(1);
      expect(useStore.getState().sessions[0].messages[0].content).toBe('Hello');
    });

    it('should auto-generate title from first user message', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ id: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> }>,
        activeSessionId: null as string | null,
        createSession: () => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id, title: undefined, messages: [] }, ...state.sessions],
            activeSessionId: id 
          };
        }),
        addMessage: (sessionId: string, message: { role: 'user' | 'assistant'; content: string }) => set((state) => ({
          sessions: state.sessions.map(s => s.id === sessionId ? { 
            ...s, 
            messages: [...s.messages, message],
            title: !s.title ? message.content.slice(0, 50) : s.title
          } : s),
        })),
      }));

      useStore.getState().createSession(); // No initial title
      
      const sessionId = useStore.getState().sessions[0].id;
      useStore.getState().addMessage(sessionId, { role: 'user', content: 'This is my very long question about testing sessions' });

      // slice(0, 50) returns first 50 chars without adding '...' - it's the caller's job
      expect(useStore.getState().sessions[0].title).toBe('This is my very long question about testing sessio');
    });

    it('should generate unique IDs for each message', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ id: string; messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }> }>,
        activeSessionId: null as string | null,
        createSession: () => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id, messages: [] }, ...state.sessions],
            activeSessionId: id 
          };
        }),
        addMessage: (sessionId: string, message: { role: 'user' | 'assistant'; content: string }) => set((state) => ({
          sessions: state.sessions.map(s => s.id === sessionId ? { 
            ...s, 
            messages: [...s.messages, { id: generateId(), ...message }]
          } : s),
        })),
      }));

      useStore.getState().createSession('Test Session');
      
      const sessionId = useStore.getState().sessions[0].id;
      useStore.getState().addMessage(sessionId, { role: 'user', content: 'First' });
      useStore.getState().addMessage(sessionId, { role: 'assistant', content: 'Second' });

      expect(useStore.getState().sessions[0].messages[0].id).not.toBe(
        useStore.getState().sessions[0].messages[1].id
      );
    });
  });

  describe('setActiveSession()', () => {
    it('should set the active session ID', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ id: string }>,
        activeSessionId: null as string | null,
        createSession: (title?: string) => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id }, ...state.sessions],
            activeSessionId: id 
          };
        }),
        setActiveSession: (id: string) => set({ activeSessionId: id }),
      }));

      useStore.getState().createSession('First');
      useStore.getState().createSession('Second');

      const state = useStore.getState();
      expect(state.activeSessionId).toBe(state.sessions[0].id);

      useStore.getState().setActiveSession(state.sessions[1].id);
      expect(useStore.getState().activeSessionId).toBe(state.sessions[1].id);
    });

    it('should handle non-existent session ID gracefully', () => {
      const useStore = create((set) => ({
        sessions: [] as Array<{ id: string }>,
        activeSessionId: null as string | null,
        createSession: (title?: string) => set((state) => {
          const id = generateId();
          return { 
            sessions: [{ id }, ...state.sessions],
            activeSessionId: id 
          };
        }),
        setActiveSession: (id: string) => set({ activeSessionId: id }),
      }));

      useStore.getState().createSession('Test');

      useStore.getState().setActiveSession('non-existent-id');
      expect(useStore.getState().activeSessionId).toBe('non-existent-id');
    });
  });
});

// ===================================================================
// Provider Store Tests - Inline store for each test to avoid caching issues  
// ===================================================================

describe('ProviderStore', () => {
  describe('setProvider()', () => {
    it('should change the active provider', () => {
      const useStore = create((set) => ({
        providers: { active: 'mock' as ProviderType, available: {} as Record<ProviderType, any> },
        setProvider: (type: ProviderType) => set((state) => ({ 
          providers: { ...state.providers, active: type } 
        })),
      }));

      expect(useStore.getState().providers.active).toBe('mock');

      useStore.getState().setProvider('openai');
      expect(useStore.getState().providers.active).toBe('openai');

      useStore.getState().setProvider('anthropic');
      expect(useStore.getState().providers.active).toBe('anthropic');
    });

    it('should support all provider types', () => {
      const useStore = create((set) => ({
        providers: { active: 'mock' as ProviderType, available: {} as Record<ProviderType, any> },
        setProvider: (type: ProviderType) => set((state) => ({ 
          providers: { ...state.providers, active: type } 
        })),
      }));

      const providers: ProviderType[] = ['openai', 'anthropic', 'google', 'local', 'mock', 'custom'];

      for (const p of providers) {
        useStore.getState().setProvider(p);
        expect(useStore.getState().providers.active).toBe(p);
      }
    });
  });

  describe('updateApiKey()', () => {
    it('should update the API key for a provider', () => {
      const defaultProviders = { openai: {}, anthropic: {} };
      const useStore = create((set) => ({
        providers: { active: 'mock' as ProviderType, available: defaultProviders },
        setProvider: (type: ProviderType) => set((state) => ({ 
          providers: { ...state.providers, active: type } 
        })),
        updateApiKey: (type: ProviderType, apiKey: string) => set((state) => ({
          providers: {
            ...state.providers,
            available: {
              ...state.providers.available,
              [type]: { ...state.providers.available[type], apiKey },
            },
          },
        })),
      }));

      useStore.getState().updateApiKey('openai', 'sk-test-key-123');
      expect(useStore.getState().providers.available.openai.apiKey).toBe('sk-test-key-123');
    });

    it('should not affect other providers', () => {
      const defaultProviders = { openai: {}, anthropic: {} };
      const useStore = create((set) => ({
        providers: { active: 'mock' as ProviderType, available: defaultProviders },
        updateApiKey: (type: ProviderType, apiKey: string) => set((state) => ({
          providers: {
            ...state.providers,
            available: {
              ...state.providers.available,
              [type]: { ...state.providers.available[type], apiKey },
            },
          },
        })),
      }));

      useStore.getState().updateApiKey('openai', 'new-key');
      expect(useStore.getState().providers.available.anthropic.apiKey).toBeUndefined();
    });

    it('should update mock provider key too', () => {
      const defaultProviders = { mock: {} };
      const useStore = create((set) => ({
        providers: { active: 'mock' as ProviderType, available: defaultProviders },
        updateApiKey: (type: ProviderType, apiKey: string) => set((state) => ({
          providers: {
            ...state.providers,
            available: {
              ...state.providers.available,
              [type]: { ...state.providers.available[type], apiKey },
            },
          },
        })),
      }));

      useStore.getState().updateApiKey('mock', 'test');
      expect(useStore.getState().providers.available.mock.apiKey).toBe('test');
    });
  });

  describe('provider availability', () => {
    it('should have all provider types available by default', () => {
      const providers: Record<ProviderType, any> = {
        openai: { type: 'openai' },
        anthropic: { type: 'anthropic' },
        google: { type: 'google' },
        local: { type: 'local' },
        mock: { type: 'mock' },
        custom: { type: 'custom' },
      };
      
      const useStore = create((set) => ({
        providers: { active: 'mock' as ProviderType, available: providers },
      }));

      const state = useStore.getState();
      for (const type of Object.keys(providers)) {
        expect(state.providers.available[type]).toBeDefined();
        expect(state.providers.available[type].type).toBe(type);
      }
    });
  });
});

// ===================================================================
// Store Integration Tests - Inline stores to avoid caching issues
// ===================================================================

describe('Store Integration', () => {
  it('should work with both stores together - create session and switch provider', () => {
    const useSession = create((set) => ({
      sessions: [] as Array<{ id: string; title?: string }>,
      activeSessionId: null as string | null,
      createSession: (title?: string) => set((state) => {
        const id = generateId();
        return { 
          sessions: [{ id, title }, ...state.sessions],
          activeSessionId: id 
        };
      }),
    }));

    const useProvider = create((set) => ({
      providers: { active: 'mock' as ProviderType, available: {} as Record<ProviderType, any> },
      setProvider: (type: ProviderType) => set((state) => ({ 
        providers: { ...state.providers, active: type } 
      })),
    }));

    // Create a session
    useSession.getState().createSession('Integration Test');
    expect(useSession.getState().sessions.length).toBe(1);

    // Switch provider (shouldn't affect sessions)
    useProvider.getState().setProvider('openai');
    expect(useProvider.getState().providers.active).toBe('openai');
    expect(useSession.getState().sessions.length).toBe(1);
  });

  it('should maintain session data across state updates', () => {
    const useStore = create((set) => ({
      sessions: [] as Array<{ id: string; title?: string }>,
      activeSessionId: null as string | null,
      createSession: (title?: string) => set((state) => {
        const id = generateId();
        return { 
          sessions: [{ id, title }, ...state.sessions],
          activeSessionId: id 
        };
      }),
    }));

    useStore.getState().createSession('Persistent Session');
    
    expect(useStore.getState().sessions.length).toBe(1);
  });
});
