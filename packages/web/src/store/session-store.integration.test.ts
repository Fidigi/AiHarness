import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from './session-store';

describe('useSessionStore streaming updates', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null });
  });

  it('keeps one assistant message while streaming content is updated', () => {
    useSessionStore.getState().createSession('Streaming');
    const sessionId = useSessionStore.getState().activeSessionId!;

    useSessionStore.getState().upsertAssistantMessage(sessionId, 'stream-1', 'Bon');
    useSessionStore.getState().upsertAssistantMessage(sessionId, 'stream-1', 'Bonjour');

    const session = useSessionStore.getState().sessions.find(item => item.id === sessionId)!;
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({
      id: 'stream-1',
      role: 'assistant',
      content: 'Bonjour',
    });
  });

  it('does not update another session', () => {
    useSessionStore.getState().createSession('First');
    const firstId = useSessionStore.getState().activeSessionId!;
    useSessionStore.getState().createSession('Second');
    const secondId = useSessionStore.getState().activeSessionId!;

    useSessionStore.getState().upsertAssistantMessage(firstId, 'stream-1', 'Réponse');

    const first = useSessionStore.getState().sessions.find(item => item.id === firstId)!;
    const second = useSessionStore.getState().sessions.find(item => item.id === secondId)!;
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(0);
  });
});
