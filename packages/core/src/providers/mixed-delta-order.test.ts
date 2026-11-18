import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProvider, ProviderFactory, type ChatResponse, type StreamChunkCallback } from './index.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import type { Message } from '../types/index.js';

const messages = [{ id: 'u', role: 'user' as const, content: 'Question', timestamp: new Date(0) }];
const servers: Server[] = [];
afterEach(async () => {
  await closeProviderNetworkDispatchers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
const scenarios = [
  { name: 'content key first', deltas: [{ content: 'Answer', reasoning_content: 'Plan' }], expected: ['r:Plan', 't:Answer'] },
  { name: 'reasoning key first', deltas: [{ reasoning_content: 'Plan', content: 'Answer' }], expected: ['r:Plan', 't:Answer'] },
  { name: 'ordered separate deltas in one HTTP body', deltas: [{ content: 'Answer' }, { reasoning_content: 'Plan' }], expected: ['t:Answer', 'r:Plan'] },
  { name: 'empty reasoning', deltas: [{ content: 'Answer', reasoning_content: '' }], expected: ['t:Answer'] },
  { name: 'empty text', deltas: [{ content: '', reasoning_content: 'Plan' }], expected: ['r:Plan'] },
  { name: 'empty pair', deltas: [{ content: '', reasoning_content: '' }], expected: [] },
  { name: 'repeated mixed deltas', deltas: [{ content: 'A', reasoning_content: 'P' }, { content: '字🙂', reasoning_content: 'R' }], expected: ['r:P', 't:A', 'r:R', 't:字🙂'] },
];
for (const type of ['openai', 'azure', 'local'] as const) describe(`${type} mixed final delta ordering`, () => {
  for (const scenario of scenarios) for (const tools of [false, true]) {
    it(`${scenario.name}; tools=${tools}`, async () => {
      let requests = 0;
      const calls = tools ? [{ index: 0, id: 'c', type: 'function', function: { name: 'effect', arguments: '{}' } }] : [];
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) { /* Consume the complete local request. */ }
        requests++;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const events = scenario.deltas.map((delta, index) => ({ choices: [{ delta: { ...delta,
          ...(index === scenario.deltas.length - 1 && tools ? { tool_calls: calls } : {}) } }] }));
        response.end([...events, { choices: [{ delta: {}, finish_reason: tools ? 'tool_calls' : 'length' }] },
          { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 } } }]
          .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const provider = ProviderFactory.create({ type, baseUrl, apiKey: 'disposable', model: 'fixture' });
      const observed: string[] = [], callbackLifetime: string[] = [];
      let result: ChatResponse | undefined;
      const complete = vi.fn((value?: ChatResponse) => { result = value; }), error = vi.fn();
      await provider.streamChat(messages, async (chunk, event) => {
        const label = event?.type === 'reasoning_delta' ? `r:${(event.data as { content: string }).content}`
          : event?.type === 'tool_call' ? 'tool:effect' : `t:${chunk}`;
        callbackLifetime.push(`start:${label}`);
        await new Promise<void>(resolve => setImmediate(resolve));
        observed.push(label); callbackLifetime.push(`end:${label}`);
      }, complete, error);
      const expected = [...scenario.expected, ...(tools ? ['tool:effect'] : [])];
      expect(observed).toEqual(expected);
      expect(callbackLifetime).toEqual(expected.flatMap(label => [`start:${label}`, `end:${label}`]));
      expect(complete).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled(); expect(requests).toBe(1);
      const text = scenario.deltas.map(delta => delta.content ?? '').join('');
      const reasoning = scenario.deltas.map(delta => delta.reasoning_content ?? '').join('');
      expect(result).toMatchObject({ content: text, ...(reasoning ? { reasoning } : {}), model: 'fixture',
        usage: { promptTokens: 3, completionTokens: 2, cacheReadTokens: 1, totalTokens: 6 },
        ...(tools ? { toolCalls: [{ id: 'c', name: 'effect', input: {} }] } : { stopReason: 'length' }) });
    });
  }
});

class CallbackProvider extends AiProvider {
  attempts = 0;
  constructor(private readonly deltas: Array<{ text: string; reasoning?: string }>) { super({ type: 'mock' }); }
  validateConfig(): boolean { return true; }
  async chat(): Promise<ChatResponse> { return { content: 'unused' }; }
  async streamChat(_messages: Message[], chunk: StreamChunkCallback, complete?: (response?: ChatResponse) => void): Promise<void> {
    this.attempts++;
    for (const delta of this.deltas) await chunk(delta.text, delta.reasoning === undefined
      ? { type: 'text_delta' } : { type: 'reasoning_delta', data: { content: delta.reasoning } });
    complete?.({ content: this.deltas.map(delta => delta.text).join('') });
  }
}
for (const mixed of [true, false]) it(`shared turn preserves callback order and immediate redaction (mixed=${mixed})`, async () => {
  const provider = new CallbackProvider(mixed ? [{ text: 'Answer secret', reasoning: 'Plan secret' }]
    : [{ text: 'Answer secret' }, { text: '', reasoning: 'Plan secret' }]);
  const registry = new ExtensionRegistry(), observed: string[] = [], lifetime: string[] = [];
  const deliver = async (kind: string, value: string): Promise<void> => {
    lifetime.push(`start:${kind}`); await new Promise<void>(resolve => setImmediate(resolve));
    observed.push(`${kind}:${value}`); lifetime.push(`end:${kind}`);
  };
  try {
    const result = await streamProviderTurn({ provider, providerName: 'mock', messages, tools: [], extensionRegistry: registry,
      redactText: value => value.replaceAll('secret', '[REDACTED]'),
      onReasoningDelta: value => deliver('r', value), onTextDelta: value => deliver('t', value) });
    const kinds = mixed ? ['r', 't'] : ['t', 'r'];
    expect(observed).toEqual(kinds.map(kind => `${kind}:${kind === 'r' ? 'Plan' : 'Answer'} [REDACTED]`));
    expect(lifetime).toEqual(kinds.flatMap(kind => [`start:${kind}`, `end:${kind}`]));
    expect(result).toMatchObject({ content: 'Answer [REDACTED]', reasoning: 'Plan [REDACTED]' });
    expect(provider.attempts).toBe(1);
  } finally { await registry.shutdown(); }
});
it('shared mixed-callback reasoning observer failure is terminal before text delivery', async () => {
  const provider = new CallbackProvider([{ text: 'Must not be delivered', reasoning: 'Plan' }]);
  const registry = new ExtensionRegistry(), text = vi.fn(), retry = vi.fn(), error = new Error('observer-failed');
  try {
    await expect(streamProviderTurn({ provider, providerName: 'mock', messages, tools: [], extensionRegistry: registry,
      maxRetries: 3, retryDelayMs: 0, onReasoningDelta: () => { throw error; }, onTextDelta: text, onRetryStart: retry }))
      .rejects.toBe(error);
    expect(text).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled(); expect(provider.attempts).toBe(1);
  } finally { await registry.shutdown(); }
});
