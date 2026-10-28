import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiMixedProvider, OpenAiResponsesProvider, AzureProvider, AzureResponsesProvider, type AiProvider, type ChatOptions, type ChatResponse } from './index.js';
import type { Message, ProviderConfig } from '../types/index.js';

type Scope = 'openai' | 'azure';
const pin = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/provider-reference.json', import.meta.url), 'utf8'));
const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/responses-tool-results-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; cases: number; requests: number;
  rows: Array<{ scope: Scope; model: string; api: string; case: string; responseItems: Array<Record<string, unknown>>;
    calls: NonNullable<ChatResponse['toolCalls']>; messages: Array<Omit<Message, 'timestamp'>>; tools: NonNullable<ChatOptions['tools']>; items: unknown[] }>;
};
const user: Message[] = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
afterEach(() => vi.restoreAllMocks());
function reply(items?: Array<Record<string, unknown>>) {
  const output: Array<Record<string, unknown>> = items ?? [{ type: 'message', id: 'msg_owned', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }];
  const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { id: 'resp_owned', status: 'in_progress', output: [] } }];
  for (const [index, item] of output.entries()) {
    events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', ...(items ? { arguments: '' } : { content: [] }) } });
    events.push(items ? { type: 'response.function_call_arguments.delta', output_index: index, delta: item.arguments }
      : { type: 'response.output_text.delta', output_index: index, content_index: 0, delta: 'ok' });
    events.push({ type: 'response.output_item.done', output_index: index, item });
  }
  events.push({ type: 'response.completed', response: { id: 'resp_owned', model: 'untrusted-response-alias', status: 'completed', output,
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(scope: Scope, model: string, legacy?: 'generic' | 'derived-azure' | 'unknown-azure') {
  const config: ProviderConfig = { type: `operator-${scope}`, model, apiKey: 'sk-disposable-reference', baseUrl: 'http://127.0.0.1:1/owned/v1',
    transport: 'sse', azureApi: 'native', azureDeploymentMap: { [model]: 'owned-deployment', 'gpt-5': 'owned-deployment' }, providerMaxRetries: 0 };
  class DerivedAzure extends AzureResponsesProvider {}
  const provider: AiProvider = legacy === 'generic' ? new OpenAiResponsesProvider(config)
    : legacy === 'derived-azure' ? new DerivedAzure(config) : legacy === 'unknown-azure' ? new AzureResponsesProvider(config)
      : scope === 'openai' ? new OpenAiMixedProvider(config) : new AzureProvider(config);
  let items: Array<Record<string, unknown>> | undefined;
  const chunks: unknown[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(items));
  const call = async (stream: boolean, messages: Message[] = user, options: ChatOptions = {}) => {
    if (!stream) return provider.chat(messages, options);
    let result: ChatResponse | undefined, failure: Error | undefined;
    await provider.streamChat(messages, (_text, event) => { if (event?.type === 'tool_call') chunks.push(event.data); }, value => { result = value; }, error => { failure = error; }, options);
    if (failure) throw failure; return result!;
  };
  return { provider, fetch, call, chunks, items: (value?: Array<Record<string, unknown>>) => { items = value; } };
}
const toolItems = (body: { input: Array<Record<string, unknown>> }) => body.input.filter(item => ['function_call', 'function_call_output'].includes(String(item.type)));

describe('original OpenAI/Azure Responses unsigned call/item IDs and paired tool output projection', () => {
  for (const scope of ['openai', 'azure'] as const) {
    const vectors = reference.rows.filter(row => row.scope === scope), models = [...new Set(vectors.map(row => row.model))];
    it(`${scope}: binds the independent catalogue and executed SDK unsigned tool-item capture`, () => {
      expect(reference.pinnedCommit).toBe('06a466935536f8c9bcacb2d5efc0fc021be1bdff');
      expect(reference.captureSha256).toBe('bd2ecd7d1f31612c828ce3a486352f4e501fa46a42e52a24012ab4498412e4bd');
      expect(reference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      const identities = pin.rows.filter((row: string[]) => row[0] === scope && row[3] === 'chat'
        && row[2] === (scope === 'openai' ? 'openai-responses' : 'azure-openai-responses')).map((row: string[]) => row[1]);
      expect([...models].sort()).toEqual(identities.sort());
      expect(reference.modelProjections).toBe(88); expect(reference.cases).toBe(704); expect(reference.requests).toBe(1408); expect(reference.rows).toHaveLength(704);
      expect(models).toHaveLength(44); expect(vectors).toHaveLength(352);
      const f = fixture(scope, models[0]);
      const published = f.provider.getPublishedModels!()!.filter(row => row.api === (scope === 'openai' ? 'openai-responses' : 'azure-openai-responses'));
      expect(published.map(row => row.id).sort()).toEqual([...models].sort()); expect(f.fetch).not.toHaveBeenCalled();
    });
    for (const model of models) it(`${scope}/${model}: binds provided response IDs and same/cross-identity replay tool items on both facades`, async () => {
      const rows = vectors.filter(row => row.model === model), f = fixture(scope, model);
      expect(rows.map(row => row.case)).toEqual(['success', 'error', 'empty', 'adjacent-two-results', 'cross-provider', 'cross-api', 'cross-model', 'legacy-missing-identity']);
      for (const vector of rows) for (const stream of [false, true]) {
        const options = { model, maxTokens: 64, systemPrompt: 'owned guard', tools: structuredClone(vector.tools) }, chunks = f.chunks.length;
        f.items(vector.responseItems);
        const first = await f.call(stream, user, options);
        expect(first).toMatchObject({ content: '', model, api: vector.api }); expect(first.toolCalls).toEqual(vector.calls);
        if (stream) expect(f.chunks.slice(chunks)).toEqual(vector.calls);
        f.items();
        const messages: Message[] = structuredClone(vector.messages).map(message => ({ ...message, timestamp: new Date(0) })), before = structuredClone(messages);
        const second = await f.call(stream, messages, options);
        expect(second).toMatchObject({ content: 'ok', model, api: vector.api });
        const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
        expect(toolItems(body)).toEqual(vector.items); expect(body.model).toBe(scope === 'azure' ? 'owned-deployment' : model);
        expect(messages).toEqual(before); expect(options.tools).toEqual(vector.tools);
      }
    });
    it(`${scope}: keeps generic/derived/unknown tool IDs and outputs legacy despite public API labels`, async () => {
      const vector = vectors.find(row => row.model === 'gpt-5' && row.case === 'adjacent-two-results')!;
      const controls = scope === 'openai' ? [['gpt-5', 'generic'], ['gpt-5-unreviewed', 'generic']] as const
        : [['gpt-5', 'derived-azure'], ['gpt-5-unreviewed', 'unknown-azure']] as const;
      for (const [model, legacy] of controls) {
        const f = fixture(scope, model, legacy); f.provider.getModelApi = () => vector.api;
        for (const stream of [false, true]) {
          f.items(vector.responseItems);
          expect((await f.call(stream, user, { maxTokens: 64 })).toolCalls?.map(call => call.id)).toEqual(vector.responseItems.map(item => item.call_id));
          f.items();
          const messages: Message[] = structuredClone(vector.messages).map(message => ({ ...message, timestamp: new Date(0) }));
          await f.call(stream, messages, { maxTokens: 64 });
          expect(toolItems(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string))).toEqual([
            ...vector.calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) })),
            ...messages.filter(message => message.role === 'tool').map(message => ({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })),
          ]);
        }
      }
      const f = fixture(scope, scope === 'azure' ? 'gpt-5-unreviewed' : 'gpt-4o'); f.items(vector.responseItems);
      for (const stream of [false, true]) expect((await f.call(stream, user, { model: 'gpt-5', maxTokens: 64 })).toolCalls).toEqual(vector.calls);
    });
  }
});
