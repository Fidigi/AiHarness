import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from './session-store';

describe('useSessionStore streaming updates', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, runs: {}, drafts: {}, attachments: {} });
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

  it('does not let a stale reconnect snapshot erase a newer queue state', () => {
    const queued = {
      id: 'run-1', sessionId: 'session-1', cwd: '/workspace', provider: 'mock',
      phase: 'streaming' as const, lastSequence: 4,
      steerQueue: [{ id: 'queue-1', kind: 'steer' as const, content: 'guide it', createdAt: new Date().toISOString() }],
      followUpQueue: [],
    };
    useSessionStore.getState().setRun('session-1', queued);
    useSessionStore.getState().setRun('session-1', { ...queued, lastSequence: 3, steerQueue: [] });

    expect(useSessionStore.getState().runs['session-1']).toMatchObject({
      lastSequence: 4,
      steerQueue: [{ content: 'guide it' }],
    });
  });

  it('merges tail, exact-target, and older pages by their server indexes', () => {
    const serialized = (start: number, end: number) => Array.from({ length: end - start }, (_, offset) => ({
      id: `message-${start + offset}`,
      role: (start + offset) % 2 ? 'assistant' as const : 'user' as const,
      content: `Message ${start + offset}`,
      timestamp: '2025-01-01T00:00:00.000Z',
    }));
    useSessionStore.getState().syncSession({
      id: 'paged', title: 'Paged', messages: serialized(80, 100),
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
      messagePage: {
        start: 80, end: 100, total: 100, hasMoreBefore: true, hasMoreAfter: false,
        nextBefore: 'message-80', revision: 1,
      },
    });
    useSessionStore.getState().mergeMessagePage('paged', {
      messages: serialized(18, 28), start: 18, end: 28, total: 100,
      hasMoreBefore: true, hasMoreAfter: true, nextBefore: 'message-18', nextAfter: 'message-27',
      targetIndex: 21, revision: 1,
    });

    let session = useSessionStore.getState().sessions.find(item => item.id === 'paged')!;
    expect(session.messages.map(message => message.id)).toEqual([
      ...serialized(18, 28).map(message => message.id),
      ...serialized(80, 100).map(message => message.id),
    ]);
    expect(session.messagePage?.loadedRanges).toEqual([{ start: 18, end: 28 }, { start: 80, end: 100 }]);

    useSessionStore.getState().mergeMessagePage('paged', {
      messages: serialized(28, 80), start: 28, end: 80, total: 100,
      hasMoreBefore: true, hasMoreAfter: true, nextBefore: 'message-28', nextAfter: 'message-79', revision: 1,
    });
    session = useSessionStore.getState().sessions.find(item => item.id === 'paged')!;
    expect(session.messages).toHaveLength(82);
    expect(session.messagePage?.loadedRanges).toEqual([{ start: 18, end: 100 }]);
    expect(session.messagePage).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false, nextBefore: 'message-18' });
  });

  it('invalidates cached message windows when the server revision changes', () => {
    useSessionStore.getState().syncSession({
      id: 'revisioned', messages: [{
        id: 'old-message', role: 'assistant', content: 'stale', timestamp: '2025-01-01T00:00:00.000Z',
      }],
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
      messagePage: { start: 0, end: 1, total: 1, hasMoreBefore: false, hasMoreAfter: false, revision: 1 },
    });
    useSessionStore.getState().syncSession({
      id: 'revisioned', messages: [],
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z',
      messagePage: { start: 0, end: 0, total: 2, hasMoreBefore: false, hasMoreAfter: true, revision: 2 },
    });

    const session = useSessionStore.getState().sessions.find(item => item.id === 'revisioned')!;
    expect(session.messages).toEqual([]);
    expect(session.messagePage).toMatchObject({ revision: 2, total: 2, loadedRanges: [] });
  });

  it('marks a background failure unread until that session is opened', () => {
    useSessionStore.getState().createSession('Background');
    const backgroundId = useSessionStore.getState().activeSessionId!;
    const running = {
      id: 'run-background', sessionId: backgroundId, cwd: '/workspace', provider: 'mock',
      phase: 'streaming' as const, lastSequence: 1, steerQueue: [], followUpQueue: [],
    };
    useSessionStore.getState().setRun(backgroundId, running);
    useSessionStore.getState().createSession('Foreground');
    useSessionStore.getState().setRun(backgroundId, { ...running, phase: 'failed', lastSequence: 2, error: 'Provider failed' });

    expect(useSessionStore.getState().sessions.find(session => session.id === backgroundId)).toMatchObject({
      unread: true,
      attention: true,
    });
    useSessionStore.getState().setActiveSession(backgroundId);
    expect(useSessionStore.getState().sessions.find(session => session.id === backgroundId)).toMatchObject({
      unread: false,
      attention: false,
    });
  });

  it('removes the draft payload, attachments, and run when abandoning a local session', () => {
    useSessionStore.getState().createSession('Disposable');
    const sessionId = useSessionStore.getState().activeSessionId!;
    useSessionStore.getState().setDraft(sessionId, 'sensitive draft');
    useSessionStore.getState().addAttachments(sessionId, [{
      id: 'attachment', name: 'draft.png', mediaType: 'image/png', size: 4, url: 'data:image/png;base64,AAAA',
    }]);
    useSessionStore.getState().setRun(sessionId, {
      id: 'run-disposable', sessionId, cwd: '/workspace', provider: 'mock', phase: 'streaming',
      lastSequence: 1, steerQueue: [], followUpQueue: [],
    });

    useSessionStore.getState().removeSession(sessionId);
    expect(useSessionStore.getState().sessions).toHaveLength(0);
    expect(useSessionStore.getState().drafts[sessionId]).toBeUndefined();
    expect(useSessionStore.getState().attachments[sessionId]).toBeUndefined();
    expect(useSessionStore.getState().runs[sessionId]).toBeUndefined();
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
