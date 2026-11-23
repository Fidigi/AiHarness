import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicProvider, type ChatResponse, type Message } from '../../dist/index.js';
const messages: Message[] = [{ id: 'u', timestamp: new Date(0), role: 'user', content: 'synthetic policy check' }];
const usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('does not invent native fallback targets/beta or fallback pricing from a different known response model', async () => {
  const bodies: Array<Record<string, unknown>> = [], headers: Headers[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body); headers.push(new Headers(init.headers));
    const response = { type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn', usage };
    if (!body.stream) return Response.json(response);
    const events = [{ type: 'message_start', message: { ...response, content: [] } },
      { type: 'content_block_start', index: 0, content_block: response.content[0] }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }, { type: 'message_stop' }];
    return new Response(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  }));
  const config = { type: 'operator-anthropic', apiKey: 'synthetic-no-fallback-key', baseUrl: 'https://anthropic.synthetic' };
  for (const model of ['claude-haiku-5-5', 'claude-sonnet-4-6']) {
    const provider = new AnthropicProvider({ ...config, model });
    const first = await provider.chat(messages);
    let second: ChatResponse | undefined;
    await provider.streamChat(messages, () => {}, value => { second = value; }, error => { throw error; });
    for (const result of [first, second]) {
      expect(result).toMatchObject({ model, api: 'anthropic-messages', provider: config.type, content: 'ready', usage: { totalTokens: 14 } });
      const price = model === 'claude-haiku-5-5' ? 0.1 : 3;
      expect(result?.usage?.costUsd).toBeCloseTo((5 * price + 2 * price * 5 + 4 * price / 10 + 3 * price * 1.25) / 1e6, 12);
    }
  }
  expect(bodies).toHaveLength(4);
  for (const body of bodies) expect(body).not.toHaveProperty('fallbacks');
  for (const header of headers) expect(header.get('anthropic-beta')?.split(',') ?? []).not.toContain('server-side-fallback-2026-07-01');
});
