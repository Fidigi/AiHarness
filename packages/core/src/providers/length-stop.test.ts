import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { type AiProvider, AnthropicProvider, BedrockProvider, GeminiProvider, OpenAiProvider, OpenAiResponsesProvider, type ChatResponse } from './index.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
const sse = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const cases = [
  { name: 'OpenAI-compatible', make: (baseUrl: string): AiProvider => new OpenAiProvider({ type: 'openai', apiKey: 'disposable', baseUrl }),
    body: (stream: boolean, length: boolean) => stream ? sse({ choices: [{ delta: { content: 'fragment' }, finish_reason: length ? 'length' : 'stop' }] }) + 'data: [DONE]\n\n'
      : JSON.stringify({ choices: [{ message: { content: 'fragment' }, finish_reason: length ? 'length' : 'stop' }] }) },
  { name: 'Responses SSE and chat facade', make: (baseUrl: string): AiProvider => new OpenAiResponsesProvider({ type: 'openai', apiKey: 'disposable', baseUrl, transport: 'sse' }),
    body: (_stream: boolean, length: boolean) => sse({ type: 'response.output_text.delta', delta: 'fragment' }, {
      type: length ? 'response.incomplete' : 'response.completed', response: { id: 'response', status: length ? 'incomplete' : 'completed',
        ...(length ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), output: [] },
    }) },
  { name: 'Anthropic', make: (baseUrl: string): AiProvider => new AnthropicProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl }),
    body: (stream: boolean, length: boolean) => stream ? sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fragment' } },
      { type: 'message_delta', delta: { stop_reason: length ? 'max_tokens' : 'end_turn' } })
      : JSON.stringify({ content: [{ type: 'text', text: 'fragment' }], stop_reason: length ? 'max_tokens' : 'end_turn' }) },
  { name: 'Gemini', make: (baseUrl: string): AiProvider => new GeminiProvider({ type: 'google', apiKey: 'disposable', baseUrl, model: 'gemini-test' }),
    body: (stream: boolean, length: boolean) => { const data = { candidates: [{ content: { parts: [{ text: 'fragment' }] }, finishReason: length ? 'MAX_TOKENS' : 'STOP' }] }; return stream ? sse(data) : JSON.stringify(data); } },
  { name: 'Bedrock Converse and streaming facade', make: (baseUrl: string): AiProvider => new BedrockProvider({ type: 'bedrock', baseUrl,
    accessKeyId: 'DISPOSABLE', secretAccessKey: 'disposable-secret', model: 'bedrock-test' }),
    body: (_stream: boolean, length: boolean) => JSON.stringify({ output: { message: { content: [{ text: 'fragment' }] } }, stopReason: length ? 'max_tokens' : 'end_turn' }) },
];

for (const scenario of cases) describe(scenario.name, () => {
  for (const length of [true, false]) it(`normalizes explicit length=${length} through real HTTP chat and stream callbacks`, async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };
      const stream = body.stream === true || request.url!.includes('streamGenerateContent');
      const text = scenario.body(stream, length);
      response.writeHead(200, { 'Content-Type': text.startsWith('data:') ? 'text/event-stream' : 'application/json' });
      response.end(text);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = scenario.make(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const messages = [{ id: 'user', role: 'user' as const, content: 'length is a word, not a stop reason', timestamp: new Date() }];
    const chat = await provider.chat(messages);
    expect(chat.content).toBe('fragment');
    expect(chat.stopReason).toBe(length ? 'length' : undefined);
    let streamed: ChatResponse | undefined;
    let chunks = '';
    let error: Error | undefined;
    await provider.streamChat(messages, chunk => { chunks += chunk; }, response => { streamed = response; }, failure => { error = failure; });
    expect(error).toBeUndefined(); expect(chunks).toBe('fragment');
    expect(streamed!.stopReason).toBe(length ? 'length' : undefined);
  });
});
