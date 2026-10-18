import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderFactory, type ChatResponse } from './index.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { streamProviderTurn } from '../agent/provider-turn.js';

const messages = [{ id: 'u', role: 'user' as const, content: 'Question', timestamp: new Date(0) }];
const secret = 'synthetic-private-upstream-details';
const failure = 'The provider reported a streaming error.';
const servers: Server[] = [];
const tool = { index: 0, id: 'effect-call', type: 'function', function: { name: 'effect', arguments: '{"value":1}' } };
const success = { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] };
const encode = (events: unknown[]): string => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
afterEach(async () => {
  await closeProviderNetworkDispatchers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
async function fixture(type: 'openai' | 'azure' | 'local', events: (attempt: number) => unknown[]) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the local request. */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(encode(events(++requests)));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { provider: ProviderFactory.create({ type, baseUrl, apiKey: 'disposable', model: 'fixture' }), requests: () => requests };
}
const errors = [
  { name: 'busy', value: { type: 'server_error', code: 'busy', message: secret } },
  { name: 'capacity', value: { type: 'capacity_error', code: 'capacity_exceeded', message: secret } },
  { name: 'upstream', value: { type: 'upstream_error', code: 'upstream_failure', message: secret } },
];
const phases = [
  { name: 'before output', prefix: [], expected: [], mixed: false },
  { name: 'after text', prefix: [{ choices: [{ delta: { content: 'Prefix' } }] }], expected: ['t:Prefix'], mixed: false },
  { name: 'after reasoning', prefix: [{ choices: [{ delta: { reasoning_content: 'Plan' } }] }], expected: ['r:Plan'], mixed: false },
  { name: 'after valid tool fragments', prefix: [{ choices: [{ delta: { tool_calls: [tool] } }] }], expected: [], mixed: false },
  { name: 'mixed error and otherwise valid output', prefix: [], expected: [], mixed: true },
];
for (const type of ['openai', 'azure', 'local'] as const) describe(`${type} explicit SSE error frames`, () => {
  for (const phase of phases) for (const error of errors) it(`${error.name} ${phase.name} refuses completion and pending tools without body leakage`, async () => {
    const { provider, requests } = await fixture(type, () => [...phase.prefix, { error: error.value,
      ...(phase.mixed ? { choices: [{ delta: { content: secret, reasoning_content: secret, tool_calls: [tool] } }] } : {}) }]);
    const complete = vi.fn(), onError = vi.fn(), observed: string[] = [];
    await provider.streamChat(messages, (chunk, event) => {
      observed.push(event?.type === 'reasoning_delta' ? `r:${(event.data as { content: string }).content}`
        : event?.type === 'tool_call' ? 'tool:effect' : `t:${chunk}`);
    }, complete, onError);
    expect(complete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[0].message).toBe(failure);
    expect(observed).toEqual(phase.expected); expect(requests()).toBe(1);
  });

  it.each(['absent', 'null', 'false'] as const)('preserves successful text, tools and usage with %s error metadata', async marker => {
    const { provider, requests } = await fixture(type, () => [{ choices: [{ delta: { content: 'OK', tool_calls: [tool] }, finish_reason: 'tool_calls' }],
      ...(marker === 'absent' ? {} : { error: marker === 'null' ? null : false }) },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }]);
    let result: ChatResponse | undefined;
    const complete = vi.fn((value?: ChatResponse) => { result = value; }), onError = vi.fn(), observed: string[] = [];
    await provider.streamChat(messages, (chunk, event) => { observed.push(event?.type === 'tool_call' ? 'tool:effect' : chunk); }, complete, onError);
    expect(complete).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled();
    expect(observed).toEqual(['OK', 'tool:effect']); expect(requests()).toBe(1);
    expect(result).toMatchObject({ content: 'OK', model: 'fixture', toolCalls: [{ id: 'effect-call', name: 'effect', input: { value: 1 } }],
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } });
  });

  it('refuses a nonempty string error with the same private diagnostic', async () => {
    const { provider } = await fixture(type, () => [{ error: secret }]);
    const complete = vi.fn(), onError = vi.fn();
    await provider.streamChat(messages, vi.fn(), complete, onError);
    expect(complete).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].message).toBe(failure);
  });

  for (const recover of [true, false]) it(`shared turn uses its existing pre-output retry bound (recover=${recover})`, async () => {
    const { provider, requests } = await fixture(type, attempt => recover && attempt > 1 ? [success] : [{ error: errors[1]!.value }]);
    const registry = new ExtensionRegistry(), retry = vi.fn(), settled = vi.fn(), text = vi.fn();
    try {
      const result = streamProviderTurn({ provider, providerName: type, messages, tools: [], extensionRegistry: registry,
        retryDelayMs: 0, onRetryStart: retry, onRetryEnd: settled, onTextDelta: text });
      if (recover) {
        await expect(result).resolves.toMatchObject({ content: 'OK' });
        expect(requests()).toBe(2); expect(retry).toHaveBeenCalledTimes(1);
        expect(settled).toHaveBeenCalledWith({ success: true, attempt: 2 });
        expect(text).toHaveBeenCalledExactlyOnceWith('OK');
      } else {
        await expect(result).rejects.toThrow(failure);
        expect(requests()).toBe(3); expect(retry).toHaveBeenCalledTimes(2);
        expect(settled).toHaveBeenCalledWith({ success: false, attempt: 3, finalError: expect.objectContaining({ message: failure }) });
        expect(text).not.toHaveBeenCalled();
      }
      for (const [details] of retry.mock.calls) {
        expect(details.maxAttempts).toBe(3); expect(details.error.message).toBe(failure);
      }
    } finally { await registry.shutdown(); }
  });

  for (const reasoning of [false, true]) it(`shared visible prefix prevents retry (reasoning=${reasoning})`, async () => {
    const { provider, requests } = await fixture(type, () => [{ choices: [{ delta: reasoning ? { reasoning_content: 'Prefix' } : { content: 'Prefix' } }] },
      { error: errors[2]!.value }]);
    const registry = new ExtensionRegistry(), retry = vi.fn(), text = vi.fn(), thought = vi.fn();
    try {
      await expect(streamProviderTurn({ provider, providerName: type, messages, tools: [], extensionRegistry: registry,
        retryDelayMs: 0, onRetryStart: retry, onTextDelta: text, onReasoningDelta: thought })).rejects.toThrow(failure);
      expect(requests()).toBe(1); expect(retry).not.toHaveBeenCalled();
      expect(reasoning ? thought : text).toHaveBeenCalledExactlyOnceWith('Prefix');
      expect(reasoning ? text : thought).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
});
