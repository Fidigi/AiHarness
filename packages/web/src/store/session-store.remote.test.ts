import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderType } from '@ai-harness/core';
import { createSession, getProviders, listSessions } from '../services/api.js';
import { useSessionStore } from './session-store.js';

vi.mock('../services/api.js', () => ({
  createSession: vi.fn(),
  getProviders: vi.fn(),
  listSessions: vi.fn(),
}));

const initialProviders = useSessionStore.getState().providers.available;

function resetStore(): void {
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    providers: {
      active: ProviderType.MOCK,
      available: Object.fromEntries(
        Object.entries(initialProviders).map(([type, config]) => [type, { ...config }]),
      ) as typeof initialProviders,
    },
  });
}

describe('useSessionStore remote behavior', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetStore();
  });

  it('creates and updates local sessions with real store actions', () => {
    useSessionStore.getState().createSession();
    const firstId = useSessionStore.getState().activeSessionId!;
    useSessionStore.getState().createSession('Second');
    const secondId = useSessionStore.getState().activeSessionId!;

    useSessionStore.getState().addMessage(firstId, { role: 'user', content: 'A'.repeat(60) });
    useSessionStore.getState().setActiveSession(firstId);

    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe(firstId);
    expect(state.sessions.find(session => session.id === firstId)).toMatchObject({
      title: 'A'.repeat(50),
      messages: [expect.objectContaining({ role: 'user', content: 'A'.repeat(60) })],
    });
    expect(state.sessions.find(session => session.id === secondId)?.title).toBe('Second');
  });

  it('creates a remote session and handles API failures', async () => {
    vi.mocked(createSession)
      .mockResolvedValueOnce({ success: true, data: { id: 'remote-1', title: 'Remote' } })
      .mockResolvedValueOnce({ success: false, error: 'offline' });

    await expect(useSessionStore.getState().createRemoteSession('Remote')).resolves.toBe('remote-1');
    expect(useSessionStore.getState()).toMatchObject({
      activeSessionId: 'remote-1',
      sessions: [expect.objectContaining({ id: 'remote-1', title: 'Remote', messages: [] })],
    });
    await expect(useSessionStore.getState().createRemoteSession('Failure')).resolves.toBeUndefined();
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  it('hydrates sessions, converts dates, and preserves a valid active session', async () => {
    useSessionStore.setState({ activeSessionId: 'remote-2' });
    vi.mocked(listSessions).mockResolvedValue({
      success: true,
      data: [
        {
          id: 'remote-1',
          title: 'First',
          messages: [],
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-02'),
        },
        {
          id: 'remote-2',
          title: 'Second',
          messages: [{
            id: 'message-1',
            role: 'assistant',
            content: 'Hello',
            timestamp: new Date('2024-01-03'),
          }],
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-03'),
        },
      ],
    });

    await useSessionStore.getState().hydrateSessions();

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe('remote-2');
    expect(state.sessions[1].createdAt).toBeInstanceOf(Date);
    expect(state.sessions[1].messages[0].timestamp).toBeInstanceOf(Date);
  });

  it('selects the first hydrated session and ignores failed hydration', async () => {
    vi.mocked(listSessions)
      .mockResolvedValueOnce({
        success: true,
        data: [{
          id: 'first',
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
      })
      .mockResolvedValueOnce({ success: false, error: 'offline' });

    await useSessionStore.getState().hydrateSessions();
    expect(useSessionStore.getState().activeSessionId).toBe('first');
    await useSessionStore.getState().hydrateSessions();
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  it('hydrates configured providers and supports provider updates', async () => {
    vi.mocked(getProviders).mockResolvedValue({
      success: true,
      data: [
        { type: ProviderType.OPENAI, configured: true },
        { type: ProviderType.ANTHROPIC, configured: false },
        { type: 'unknown', configured: true },
      ],
    });

    await useSessionStore.getState().hydrateProviders();
    useSessionStore.getState().setProvider(ProviderType.OPENAI);
    useSessionStore.getState().updateApiKey(ProviderType.ANTHROPIC, 'new-key');

    const providers = useSessionStore.getState().providers;
    expect(providers.active).toBe(ProviderType.OPENAI);
    expect(providers.available[ProviderType.OPENAI].apiKey).toBe('configured');
    expect(providers.available[ProviderType.ANTHROPIC].apiKey).toBe('new-key');
  });

  it('leaves providers unchanged when hydration fails', async () => {
    vi.mocked(getProviders).mockResolvedValue({ success: false, error: 'offline' });

    await useSessionStore.getState().hydrateProviders();

    expect(useSessionStore.getState().providers.active).toBe(ProviderType.MOCK);
    expect(useSessionStore.getState().providers.available[ProviderType.OPENAI].apiKey).toBeUndefined();
  });
});
