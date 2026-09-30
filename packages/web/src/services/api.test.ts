import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from './api';

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

describe('streamChat', () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it('yields an error event for HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Provider unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )));

    const events = [];
    for await (const event of streamChat('openai', [])) events.push(event);

    expect(events).toEqual([{ type: 'error', content: 'Provider unavailable' }]);
  });
});
