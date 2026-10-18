import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, OpenAiProvider, OpenAiResponsesProvider, type AiProvider, type ChatResponse, type StreamEvent } from './index.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';

const invalid = 'The provider tool arguments were invalid JSON.';
const secret = 'private-malformed-argument';
const messages = [{ id: 'u', role: 'user' as const, content: 'Use the tools.', timestamp: new Date(0) }];
const servers: Server[] = [];
afterEach(async () => {
  await closeProviderNetworkDispatchers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
const sse = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
type Dialect = 'completions' | 'responses' | 'anthropic';
function toolWire(dialect: Dialect, args: string[], text = '', final = false): string {
  if (dialect === 'completions') return sse({ choices: [{ delta: { content: text } }] },
    ...args.flatMap((argument, index) => [
      { choices: [{ delta: { tool_calls: [{ index, id: `call-${index}`, function: { name: index ? 'second_effect' : 'first_effect', arguments: argument.slice(0, 2) } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index, function: { arguments: argument.slice(2) } }] } }] },
    ]), { choices: [{ delta: {}, finish_reason: final ? 'stop' : 'tool_calls' }] }) + 'data: [DONE]\n\n';
  if (dialect === 'responses') return sse({ type: 'response.created', response: { id: 'r' } },
    ...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
    ...args.flatMap((argument, index) => [
      { type: 'response.output_item.added', output_index: index, item: { type: 'function_call', call_id: `call-${index}`, name: index ? 'second_effect' : 'first_effect', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: index, delta: argument.slice(0, 2) },
      { type: 'response.function_call_arguments.delta', output_index: index, delta: argument.slice(2) },
    ]), { type: 'response.completed', response: { id: 'r' } });
  return sse(...(text ? [{ type: 'content_block_delta', index: 10, delta: { type: 'text_delta', text } }] : []),
    ...args.flatMap((argument, index) => [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${index}`, name: index ? 'second_effect' : 'first_effect', input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argument.slice(0, 2) } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argument.slice(2) } },
    ]), { type: 'message_delta', delta: { stop_reason: final ? 'end_turn' : 'tool_use' } }, { type: 'message_stop' });
}
async function fixture(dialect: Dialect, args: string[], text = '') {
  let requests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };
    const next = requests++ > 0;
    if (dialect === 'completions' && body.stream === false) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: text, tool_calls: args.map((argument, index) => ({ id: `call-${index}`, type: 'function', function: { name: index ? 'second_effect' : 'first_effect', arguments: argument } })) } }] }));
    } else {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(toolWire(dialect, next ? [] : args, next ? 'Final' : text, next));
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = { type: 'openai' as const, apiKey: 'disposable', baseUrl, model: 'fixture' };
  const provider: AiProvider = dialect === 'completions' ? new OpenAiProvider(config)
    : dialect === 'responses' ? new OpenAiResponsesProvider({ ...config, transport: 'sse' })
      : new AnthropicProvider({ ...config, type: 'anthropic' });
  return { provider, requests: () => requests };
}

for (const dialect of ['completions', 'responses', 'anthropic'] as const) describe(`${dialect} final tool arguments`, () => {
  for (const argument of [`{"${secret}":`, '{"value":1,}', '{"a":1}{"b":2}', '  \n', '{"value":"\\u12', '{"value":NaN}']) {
    it(`rejects malformed final JSON without publishing any complete tool in the batch (${JSON.stringify(argument)})`, async () => {
      const test = await fixture(dialect, ['{}', argument]);
      const complete = vi.fn(), error = vi.fn();
      const events: StreamEvent[] = [];
      await test.provider.streamChat(messages, (_chunk, event) => { if (event) events.push(event); }, complete, error);
      expect(error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: invalid }));
      expect(complete).not.toHaveBeenCalled();
      expect(events.filter(event => event.type === 'tool_call')).toEqual([]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      expect(test.requests()).toBe(1);
    });
  }
  for (const argument of ['', '{}', '{"value":"字🙂","nested":[null,false,1]}', 'null', '[1,"x"]', 'true', '"text"', '0']) {
    it(`preserves the existing valid JSON/empty-input contract (${JSON.stringify(argument)})`, async () => {
      const test = await fixture(dialect, [argument]);
      let response: ChatResponse | undefined;
      const error = vi.fn();
      await test.provider.streamChat(messages, () => undefined, result => { response = result; }, error);
      expect(error).not.toHaveBeenCalled();
      expect(response?.toolCalls).toEqual([{ id: 'call-0', name: 'first_effect', input: argument ? JSON.parse(argument) as unknown : {} }]);
    });
  }
  for (const text of ['', 'Visible prefix']) for (const valid of [false, true]) {
    it(`has no tool effects/retry on invalid batches, retaining ordinary execution (text=${!!text}, valid=${valid})`, async () => {
      const test = await fixture(dialect, ['{"value":1}', valid ? '{"value":2}' : `{"${secret}":`], text);
      const manager = new SessionManager(), session = await manager.create();
      await manager.addMessage(session.id, { role: 'user', content: 'Use the tools.' });
      const registry = new ExtensionRegistry(), execute = vi.fn(() => ({ content: 'Effect' }));
      const beforeTool = vi.fn(), retry = vi.fn(), errors = vi.fn(), deltas: string[] = [];
      await registry.load('effects', api => {
        for (const name of ['first_effect', 'second_effect']) api.registerTool({ name, description: name, execute });
        api.before('before:tool', beforeTool);
      });
      try {
        const result = runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry,
          toolContext: { sessionManager: manager, currentSessionId: session.id, notify: () => undefined },
          streamTurn: (history, tools) => streamProviderTurn({ provider: test.provider, providerName: dialect,
            messages: history, tools, extensionRegistry: registry, maxRetries: 3, retryDelayMs: 0,
            onTextDelta: delta => { deltas.push(delta); }, onRetryStart: retry, onError: errors }) });
        if (valid) {
          await expect(result).resolves.toBe('Final');
          expect(execute).toHaveBeenCalledTimes(2); expect(beforeTool).toHaveBeenCalledTimes(2);
          expect(test.requests()).toBe(2);
          expect(session.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
        } else {
          await expect(result).rejects.toThrow(invalid);
          expect(execute).not.toHaveBeenCalled(); expect(beforeTool).not.toHaveBeenCalled();
          expect(test.requests()).toBe(1);
          expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: invalid }));
          expect(deltas.join('')).toBe(text);
          expect(session.messages.map(message => message.role)).toEqual(['user']);
        }
        expect(retry).not.toHaveBeenCalled();
      } finally { await registry.shutdown(); }
    });
  }
});

for (const args of ['{"value":1}', `{"${secret}":`]) it(`nonstream Completions rejects invalid final JSON before a response can escape (${args.endsWith('}')})`, async () => {
  const test = await fixture('completions', ['{}', args]);
  if (args.endsWith('}')) await expect(test.provider.chat(messages)).resolves.toMatchObject({ toolCalls: [{ input: {} }, { input: { value: 1 } }] });
  else await expect(test.provider.chat(messages)).rejects.toThrow(invalid);
});
