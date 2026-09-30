import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendSessionMessage,
  cloneSession,
  createSession,
  deleteSession,
  forkSession,
  getChatTransport,
  getProviders,
  getSession,
  getSessionTree,
  healthCheck,
  listSessions,
  sendChat,
  setAuthToken,
  setChatTransport,
  setProviderApiKey,
  streamChat,
} from './api';

function sseResponse(chunks: string[], ok = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: ok ? 200 : 500 });
}

describe('Web API service', () => {
  afterEach(() => {
    setAuthToken('');
    vi.unstubAllGlobals();
  });

  it('associates SSE event names with their data payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: message_start\ndata: {"provider":"mock"}\n\n',
      'event: text_delta\ndata: {"content":"Bon"}\n\n',
      'event: text_delta\ndata: {"content":"jour"}\n\n',
      'event: message_end\ndata: {"content":"Bonjour"}\n\n',
    ])));

    const events = [];
    for await (const event of streamChat('mock', [{ role: 'user', content: 'Salut' }])) {
      events.push(event);
    }

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'text_delta',
      'text_delta',
      'message_end',
    ]);
    expect(events[3].content).toBe('Bonjour');
  });

  it('handles SSE records split across network chunks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: text_',
      'delta\ndata: {"content":"chunk"}\n\n',
    ])));

    const events = [];
    for await (const event of streamChat('mock', [])) events.push(event);

    expect(events).toEqual([{ type: 'text_delta', content: 'chunk' }]);
  });

  it('parses the final SSE record even when the stream has no trailing newline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: message_end\r\ndata: {"content":"Terminé"}',
    ])));

    const events = [];
    for await (const event of streamChat('mock', [])) events.push(event);

    expect(events).toEqual([{ type: 'message_end', content: 'Terminé' }]);
  });

  it('yields an error event for HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Provider unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )));

    const events = [];
    for await (const event of streamChat('openai', [])) events.push(event);

    expect(events).toEqual([{ type: 'error', content: 'Provider unavailable' }]);
  });

  it('checks the public server health route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(healthCheck()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/health', { headers: {} });
  });

  it('covers successful JSON API operations and authentication headers', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      id: 'session-1',
      content: 'response',
      success: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    setAuthToken(' secret-token ');

    const results = await Promise.all([
      sendChat('openai', [{ role: 'user', content: 'Hello' }]),
      listSessions(),
      createSession('New'),
      getSession('session-1'),
      appendSessionMessage('session-1', { role: 'assistant', content: 'Done' }),
      deleteSession('session-1'),
      forkSession('session-1', { messageIndex: 0, title: 'Fork' }),
      cloneSession('session-1', 'Clone'),
      getSessionTree('branch/with spaces'),
      getProviders(),
      setProviderApiKey('openai', 'key', 'https://example.test/v1'),
    ]);

    expect(results.every(result => result.success)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/tree?branchId=branch%2Fwith%20spaces',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-token' } }),
    );
    expect(fetchMock.mock.calls.every(([, init]) => (
      (init as RequestInit | undefined)?.headers as Record<string, string> | undefined
    )?.Authorization === 'Bearer secret-token')).toBe(true);
  });

  it('normalizes failures from JSON API operations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const results = await Promise.all([
      sendChat('openai', []),
      listSessions(),
      createSession(),
      getSession('missing'),
      appendSessionMessage('missing', { role: 'user', content: 'test' }),
      deleteSession('missing'),
      forkSession('missing'),
      cloneSession('missing'),
      getSessionTree(),
      getProviders(),
      setProviderApiKey('openai', 'key'),
    ]);

    expect(results.every(result => !result.success && result.error === 'network down')).toBe(true);
    await expect(healthCheck()).resolves.toBe(false);
  });

  it('streams chat over WebSocket and persists the selected transport', async () => {
    const storage = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('location', { protocol: 'https:', host: 'chat.example.test' });

    class MockWebSocket {
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      onclose?: () => void;
      readonly sent: string[] = [];

      constructor(readonly url: string) {
        queueMicrotask(() => {
          this.onopen?.();
          this.onmessage?.({ data: 'event: text_delta\ndata: {"content":"Salut"}\n' });
          this.onmessage?.({ data: 'event: message_end\ndata: {"content":"Salut"}\n' });
          this.onclose?.();
        });
      }

      send(payload: string): void {
        this.sent.push(payload);
      }
    }
    vi.stubGlobal('WebSocket', MockWebSocket);
    setChatTransport('websocket');

    const events = [];
    for await (const event of streamChat('openai', [{ role: 'user', content: 'Bonjour' }])) {
      events.push(event);
    }

    expect(getChatTransport()).toBe('websocket');
    expect(storage.setItem).toHaveBeenCalledWith('ai-harness-transport', 'websocket');
    expect(events).toEqual([
      { type: 'text_delta', content: 'Salut' },
      { type: 'message_end', content: 'Salut' },
    ]);
    setChatTransport('sse');
  });
});
