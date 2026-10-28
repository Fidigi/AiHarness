import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiMixedProvider, OpenAiResponsesProvider, AzureProvider, AzureResponsesProvider, type AiProvider, type ChatOptions, type ChatResponse, type ResponsesChatOptions } from './index.js';
import type { Message, ProviderConfig } from '../types/index.js';

type Scope = 'openai' | 'azure';
const pin = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/provider-reference.json', import.meta.url), 'utf8'));
const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/responses-tool-results-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; cases: number; requests: number;
  rows: Array<{ scope: Scope; model: string; api: string; case: string; responseItems: Array<Record<string, unknown>>;
    calls: NonNullable<ChatResponse['toolCalls']>; messages: Array<Omit<Message, 'timestamp'>>; tools: NonNullable<ChatOptions['tools']>; items: unknown[] }>;
};
type PolicyVector = { scope: Scope; model: string; api: string; case: string; options: ResponsesChatOptions; refusal?: true; fields?: Record<string, unknown> };
type PolicyReference = { pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; cases: number; requests: number; refusals: number; rows: PolicyVector[] };
const policy = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/responses-tool-policy-reference.json', import.meta.url), 'utf8')) as PolicyReference;
const boundaries = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/responses-tool-schema-boundaries-reference.json', import.meta.url), 'utf8')) as PolicyReference;
const generation = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/responses-scalar-generation-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; cases: number; reusedCaptureRequests: number;
  rows: Array<{ scope: Scope; model: string; api: string; sourceCase: string; options: ChatOptions; fields: Record<string, unknown> }>;
};
const outputBytes = readFileSync(new URL('../../../../tests/fixtures/responses-output-boundaries-reference.json', import.meta.url));
const outputReference = JSON.parse(outputBytes.toString()) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; cases: number; freshSdkRequests: number;
  rows: Array<{ scope: Scope; model: string; api: string; maxOutputTokens: number; case: string; options: ChatOptions; fields: Record<string, unknown> }>;
};
type GrammarVector = PolicyVector & { supportsGrammar: boolean };
type GrammarReference = Omit<PolicyReference, 'rows'> & { grammarCapableProjections: number; fallbackProjections: number; rows: GrammarVector[] };
const grammar = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/responses-grammar-reference.json', import.meta.url), 'utf8')) as GrammarReference;
const grammarReplay = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/responses-grammar-tool-results-reference.json', import.meta.url), 'utf8')) as Omit<GrammarReference, 'rows'> & {
  rows: Array<GrammarVector & { responseItems: Array<Record<string, unknown>>; calls: NonNullable<ChatResponse['toolCalls']>;
    messages: Array<Omit<Message, 'timestamp'>>; items: unknown[] }>;
};
const imageReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/responses-tool-images-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; grammarCapableProjections: number;
  fallbackGrammarProjections: number; imageCapableProjections: number; textOnlyProjections: number; cases: number; requests: number;
  rows: Array<(typeof grammarReplay.rows)[number] & { mode: 'function' | 'grammar'; supportsImages: boolean; usesGrammar: boolean }>;
};
const user: Message[] = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
afterEach(() => vi.restoreAllMocks());
function reply(items?: Array<Record<string, unknown>>) {
  const output: Array<Record<string, unknown>> = items ?? [{ type: 'message', id: 'msg_owned', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }];
  const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { id: 'resp_owned', status: 'in_progress', output: [] } }];
  for (const [index, item] of output.entries()) {
    events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', ...(items ? item.type === 'custom_tool_call' ? { input: '' } : { arguments: '' } : { content: [] }) } });
    if (items && item.type === 'custom_tool_call') {
      const input = String(item.input);
      for (const delta of [input.slice(0, 3), input.slice(3)]) events.push({ type: 'response.custom_tool_call_input.delta', output_index: index, delta });
      events.push({ type: 'response.custom_tool_call_input.done', output_index: index, input });
    } else events.push(items ? { type: 'response.function_call_arguments.delta', output_index: index, delta: item.arguments }
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
      for (const fixture of [policy, boundaries, generation, imageReference, outputReference]) {
        expect(fixture.pinnedCommit).toBe(reference.pinnedCommit); expect(fixture.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      }
      expect(createHash('sha256').update(outputBytes).digest('hex')).toBe('c23c5d2a68486f451e21f32ba5d9e721ba621b38a8302ee8d905dd96530822cd');
      expect(outputReference.captureSha256).toBe('1711a9c726114bc8490f2c790e372c1f061a73c9845e3f93290908243a876b10');
      expect([outputReference.modelProjections, outputReference.cases, outputReference.freshSdkRequests, outputReference.rows.length]).toEqual([88, 616, 616, 616]);
      expect([...new Set(outputReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(models);
      expect(generation.captureSha256).toBe('637862c5e5ae2ae6c9729d4d8bdf7fc13130f15320fcaacaa680a8c93f782a8a');
      expect([generation.modelProjections, generation.cases, generation.rows.length, generation.reusedCaptureRequests]).toEqual([88, 176, 176, 445]);
      expect([...new Set(generation.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(models);
      expect(policy.captureSha256).toBe('c40d852cc39e1cf0e82cf32a7a2ebd8debd2d4a63b54ff73f43a337a98b4bb52');
      expect(boundaries.captureSha256).toBe('b86ff4a861db39d97aed796e77c7305bdfdb23ccbf74d3b54b56a32c2d9de566');
      expect([policy.modelProjections, policy.cases, policy.requests, policy.refusals, policy.rows.length]).toEqual([88, 1232, 1144, 88, 1232]);
      expect([boundaries.modelProjections, boundaries.cases, boundaries.requests, boundaries.refusals, boundaries.rows.length]).toEqual([2, 136, 76, 60, 136]);
      expect([...new Set(policy.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(models);
      const identities = pin.rows.filter((row: string[]) => row[0] === scope && row[3] === 'chat'
        && row[2] === (scope === 'openai' ? 'openai-responses' : 'azure-openai-responses')).map((row: string[]) => row[1]);
      expect([...models].sort()).toEqual(identities.sort());
      expect(reference.modelProjections).toBe(88); expect(reference.cases).toBe(704); expect(reference.requests).toBe(1408); expect(reference.rows).toHaveLength(704);
      expect(models).toHaveLength(44); expect(vectors).toHaveLength(352);
      expect(imageReference.captureSha256).toBe('ebd660cdf58457b4af0821b29701105e7a42623bbaabc82e3262aafd7d472ba0');
      expect([imageReference.modelProjections, imageReference.grammarCapableProjections, imageReference.fallbackGrammarProjections,
        imageReference.imageCapableProjections, imageReference.textOnlyProjections, imageReference.cases, imageReference.requests, imageReference.rows.length]).toEqual([88, 50, 38, 84, 4, 704, 1408, 704]);
      expect([...new Set(imageReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(models);
      expect([...new Set(imageReference.rows.filter(row => row.scope === scope && !row.supportsImages).map(row => row.model))]).toEqual(['gpt-4', 'o3-mini']);
      const f = fixture(scope, models[0]);
      const published = f.provider.getPublishedModels!()!.filter(row => row.api === (scope === 'openai' ? 'openai-responses' : 'azure-openai-responses'));
      expect(published.map(row => row.id).sort()).toEqual([...models].sort()); expect(f.fetch).not.toHaveBeenCalled();
    });
    for (const model of models) it(`${scope}/${model}: binds provided IDs, identity replay and one-image function outputs on both facades`, async () => {
      const rows = vectors.filter(row => row.model === model), f = fixture(scope, model);
      const images = imageReference.rows.filter(row => row.scope === scope && row.model === model && row.mode === 'function').map(row => ({ ...row, tools: row.options.tools! }));
      expect(rows.map(row => row.case)).toEqual(['success', 'error', 'empty', 'adjacent-two-results', 'cross-provider', 'cross-api', 'cross-model', 'legacy-missing-identity']);
      expect(images.map(row => row.case)).toEqual(['image-success', 'image-error', 'image-only-success', 'image-only-error']);
      for (const vector of [...rows, ...images]) for (const stream of [false, true]) {
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
        if (vector.case.startsWith('image')) expect(body.input.slice(2)).toEqual(vector.items);
        if ('fields' in vector) expect(toolFields(body)).toEqual(vector.fields);
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
          const image = imageReference.rows.find(row => row.scope === scope && row.model === 'gpt-5' && row.mode === 'function' && row.case === 'image-success')!;
          const imageMessages: Message[] = structuredClone(image.messages).map(message => ({ ...message, timestamp: new Date(0) })), before = structuredClone(imageMessages);
          await f.call(stream, imageMessages, { maxTokens: 64 });
          const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
          expect(body.input.at(-1)).toEqual({ role: 'user', content: [{ type: 'input_text', text: `Tool images for ${image.calls[0]!.id}` },
            { type: 'input_image', image_url: imageMessages.at(-1)!.blocks!.find(block => block.type === 'image')!.url }] });
          expect(toolItems(body).at(-1)).toEqual({ type: 'function_call_output', call_id: image.calls[0]!.id, output: 'first' }); expect(imageMessages).toEqual(before);
        }
      }
      const f = fixture(scope, scope === 'azure' ? 'gpt-5-unreviewed' : 'gpt-4o'); f.items(vector.responseItems);
      for (const stream of [false, true]) {
        expect((await f.call(stream, user, { model: 'gpt-5', maxTokens: 64 })).toolCalls).toEqual(vector.calls);
        const image = imageReference.rows.find(row => row.scope === scope && row.model === 'gpt-5' && row.mode === 'function' && row.case === 'image-success')!;
        const options = { ...structuredClone(image.options), model: 'gpt-5' };
        f.items(image.responseItems); expect((await f.call(stream, user, options)).toolCalls).toEqual(image.calls); f.items();
        const messages: Message[] = structuredClone(image.messages).map(message => ({ ...message, timestamp: new Date(0) }));
        await f.call(stream, messages, options); expect(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string).input.slice(2)).toEqual(image.items);
        f.items(vector.responseItems);
      }
    });
  }
});

const toolFields = (body: Record<string, unknown>) => Object.fromEntries(['tools', 'tool_choice'].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
describe('original Responses scoped JSON-schema and tool-choice construction', () => {
  for (const scope of ['openai', 'azure'] as const) {
    const models = [...new Set(policy.rows.filter(row => row.scope === scope).map(row => row.model))];
    const compare = async (f: ReturnType<typeof fixture>, vector: PolicyVector, stream: boolean) => {
      const options: ResponsesChatOptions = { ...structuredClone(vector.options), model: vector.model, maxTokens: 64, systemPrompt: 'owned guard' };
      const before = structuredClone(options), requests = f.fetch.mock.calls.length;
      if (vector.refusal) {
        await expect(f.call(stream, user, options)).rejects.toThrow('Responses tool requires unsupported constrained sampling.');
        expect(f.fetch.mock.calls).toHaveLength(requests);
      } else {
        const response = await f.call(stream, user, options);
        expect(response).toMatchObject({ content: 'ok', model: vector.model, api: vector.api });
        expect(f.fetch.mock.calls).toHaveLength(requests + 1);
        const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
        expect(toolFields(body)).toEqual(vector.fields);
        expect(body.model).toBe(scope === 'azure' ? 'owned-deployment' : vector.model);
      }
      expect(options).toEqual(before);
    };
    for (const model of models) it(`${scope}/${model}: binds executed strict/default/choice, scalar generation and output boundaries on both facades`, async () => {
      const rows = policy.rows.filter(row => row.scope === scope && row.model === model), f = fixture(scope, model);
      const scalars = generation.rows.filter(row => row.scope === scope && row.model === model);
      expect(scalars.map(row => row.sourceCase)).toEqual(['raw-default', 'typed-tools-high-temperature']);
      for (const vector of scalars) for (const stream of [false, true]) {
        const messages = structuredClone(user), options = { ...structuredClone(vector.options), model }, before = structuredClone({ messages, options });
        const count = f.fetch.mock.calls.length, response = await f.call(stream, messages, options);
        expect(response).toMatchObject({ content: 'ok', model, api: vector.api }); expect(f.fetch.mock.calls).toHaveLength(count + 1);
        const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
        expect(Object.fromEntries(['max_output_tokens', 'temperature'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]))).toEqual(vector.fields);
        expect(body.model).toBe(scope === 'azure' ? 'owned-deployment' : model); expect({ messages, options }).toEqual(before);
      }
      const outputs = outputReference.rows.filter(row => row.scope === scope && row.model === model), outputStart = f.fetch.mock.calls.length;
      expect(outputs.map(row => row.case)).toEqual(['raw-default', 'raw-answer1', 'raw-answer15', 'raw-answer16', 'raw-maximum', 'raw-temperature-zero', 'raw-temperature-one']);
      for (const vector of outputs) for (const stream of [false, true]) {
        const messages = structuredClone(user), options = { ...structuredClone(vector.options), model }, before = structuredClone({ messages, options });
        const response = await f.call(stream, messages, options), body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
        expect(response).toMatchObject({ content: 'ok', model, api: vector.api });
        expect(Object.fromEntries(['max_output_tokens', 'temperature'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]))).toEqual(vector.fields);
        expect(body.model).toBe(scope === 'azure' ? 'owned-deployment' : model); expect(body.stream).toBe(true); expect(body.tools).toBeUndefined();
        expect({ messages, options }).toEqual(before);
      }
      expect(f.fetch.mock.calls).toHaveLength(outputStart + 14);
      // Core-only safety controls: the valid raw SDK matrix does not establish invalid-input equivalence.
      const maximum = outputs[0]!.maxOutputTokens, exposed = f.provider.getPublishedModels!()!.find(row => row.id === model)!;
      expect(exposed.maxOutputTokens).toBe(maximum); exposed.maxOutputTokens = Number.MAX_SAFE_INTEGER;
      const refusalStart = f.fetch.mock.calls.length, chunkStart = f.chunks.length;
      for (const maxTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, maximum + 1]) for (const stream of [false, true]) {
        await expect(f.call(stream, user, { model, maxTokens })).rejects.toThrow(`Invalid ${scope === 'azure' ? 'Azure' : 'OpenAI'} output limit.`);
      }
      expect(f.fetch.mock.calls).toHaveLength(refusalStart); expect(f.chunks).toHaveLength(chunkStart);
      expect(rows.map(row => row.case)).toEqual(['default', 'false', 'strict-prefer', 'strict-require', 'auto', 'none', 'required', 'named', 'strict-prefer-none', 'strict-require-required', 'mixed', 'no-tools-required', 'structured-prefer', 'structured-require']);
      for (const vector of rows) for (const stream of [false, true]) await compare(f, vector, stream);
    });
    it(`${scope}: binds runtime strict schema boundaries independently of the TypeBox activation cases`, async () => {
      const f = fixture(scope, 'gpt-5'), rows = boundaries.rows.filter(row => row.scope === scope);
      expect(rows).toHaveLength(68);
      for (const vector of rows) for (const stream of [false, true]) await compare(f, vector, stream);
    });
    it(`${scope}: rejects malformed defined scoped controls before transport`, async () => {
      const tool = policy.rows.find(row => row.scope === scope && row.case === 'default')!.options.tools![0]!, f = fixture(scope, 'gpt-5');
      const controls = [{ toolChoice: 'any' }, { toolChoice: { type: 'function', name: 1 } },
        { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'forced' } }] },
        { tools: [{ ...tool, constrainedSampling: { type: 'grammar' } }] }];
      for (const control of controls) for (const stream of [false, true]) {
        const options = structuredClone(control) as unknown as ResponsesChatOptions, before = structuredClone(options);
        await expect(f.call(stream, user, options)).rejects.toThrow('Invalid Responses tool policy.');
        expect(f.fetch).not.toHaveBeenCalled(); expect(options).toEqual(before);
      }
    });
    it(`${scope}: keeps legacy prefer schemas off-profile despite public API labels and admits reviewed per-call policy privately`, async () => {
      const vector = policy.rows.find(row => row.scope === scope && row.model === 'gpt-5' && row.case === 'strict-prefer')!;
      const controls = scope === 'openai' ? [['gpt-5', 'generic'], ['gpt-5-unreviewed', 'generic']] as const
        : [['gpt-5', 'derived-azure'], ['gpt-5-unreviewed', 'unknown-azure']] as const;
      for (const [model, legacy] of controls) {
        const f = fixture(scope, model, legacy); f.provider.getModelApi = () => vector.api;
        for (const stream of [false, true]) {
          await f.call(stream, user, structuredClone(vector.options));
          expect(toolFields(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string))).toEqual({
            tools: vector.options.tools!.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })), tool_choice: 'auto',
          });
        }
      }
      const f = fixture(scope, scope === 'azure' ? 'gpt-5-unreviewed' : 'gpt-4o');
      for (const stream of [false, true]) await compare(f, vector, stream);
    });
  }
});

describe('original Responses grammar declarations and supplied custom/function tool replay', () => {
  const compare = async (f: ReturnType<typeof fixture>, vector: GrammarVector, stream: boolean) => {
    const options = { ...structuredClone(vector.options), model: vector.model }, before = structuredClone(options), count = f.fetch.mock.calls.length;
    if (vector.refusal) {
      await expect(f.call(stream, user, options)).rejects.toThrow('Responses tool requires unsupported grammar sampling.');
      expect(f.fetch.mock.calls).toHaveLength(count);
    } else {
      expect(await f.call(stream, user, options)).toMatchObject({ content: 'ok', model: vector.model, api: vector.api });
      expect(f.fetch.mock.calls).toHaveLength(count + 1);
      const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
      expect(toolFields(body)).toEqual(vector.fields); expect(body.model).toBe(vector.scope === 'azure' ? 'owned-deployment' : vector.model);
    }
    expect(options).toEqual(before);
  };
  for (const scope of ['openai', 'azure'] as const) {
    const models = [...new Set(grammar.rows.filter(row => row.scope === scope).map(row => row.model))];
    it(`${scope}: binds grammar capability and both executed SDK captures independently`, () => {
      for (const fixture of [grammar, grammarReplay]) {
        expect(fixture.pinnedCommit).toBe(reference.pinnedCommit); expect(fixture.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
        expect([fixture.modelProjections, fixture.grammarCapableProjections, fixture.fallbackProjections]).toEqual([88, 50, 38]);
        expect([...new Set(fixture.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(models);
        expect(new Set(fixture.rows.filter(row => row.scope === scope && row.supportsGrammar).map(row => row.model)).size).toBe(25);
      }
      expect(grammar.captureSha256).toBe('2de313ea2f2cfffd8ce24b410ce092a10c1b4c03933e551744d01bb6edfa3e9d');
      expect(grammarReplay.captureSha256).toBe('a0bf1db4a1a0bfe6983cc90178f5aec48377ab54e3fb7ea2e9f90528fb465f3d');
      expect([grammar.cases, grammar.requests, grammar.refusals, grammar.rows.length]).toEqual([880, 680, 200, 880]);
      expect([grammarReplay.cases, grammarReplay.requests, grammarReplay.refusals, grammarReplay.rows.length]).toEqual([704, 1408, 0, 704]);
      const identities = pin.rows.filter((row: string[]) => row[0] === scope && row[3] === 'chat' && row[2] === (scope === 'openai' ? 'openai-responses' : 'azure-openai-responses')).map((row: string[]) => row[1]);
      expect([...models].sort()).toEqual(identities.sort()); expect(models).toHaveLength(44);
    });
    for (const model of models) it(`${scope}/${model}: binds grammar/fallback construction, raw input and text/image paired replay on both facades`, async () => {
      const f = fixture(scope, model), rows = grammar.rows.filter(row => row.scope === scope && row.model === model);
      expect(rows.map(row => row.case)).toEqual(['lark', 'regex', 'both', 'blank-lark-regex', 'blank-variants', 'no-required', 'two-required', 'wrong-type', 'optional-extra', 'renamed-property']);
      for (const vector of rows) for (const stream of [false, true]) await compare(f, vector, stream);
      const replays = grammarReplay.rows.filter(row => row.scope === scope && row.model === model);
      expect(replays.map(row => row.case)).toEqual(['success', 'error', 'empty', 'adjacent-two-results', 'cross-provider', 'cross-api', 'cross-model', 'legacy-missing-identity']);
      const images = imageReference.rows.filter(row => row.scope === scope && row.model === model && row.mode === 'grammar');
      expect(images.map(row => row.case)).toEqual(['image-success', 'image-error', 'image-only-success', 'image-only-error']);
      for (const vector of [...replays, ...images]) for (const stream of [false, true]) {
        const options = { ...structuredClone(vector.options), model }, originalOptions = structuredClone(options), count = f.fetch.mock.calls.length, chunks = f.chunks.length;
        f.items(vector.responseItems);
        const first = await f.call(stream, user, options);
        expect(first).toMatchObject({ content: '', model, api: vector.api }); expect(first.toolCalls).toEqual(vector.calls);
        if (stream) expect(f.chunks.slice(chunks)).toEqual(vector.calls);
        expect(f.fetch.mock.calls).toHaveLength(count + 1);
        expect(toolFields(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string))).toEqual(vector.fields);
        f.items();
        const messages: Message[] = structuredClone(vector.messages).map(message => ({ ...message, timestamp: new Date(0) })), before = structuredClone(messages);
        expect(await f.call(stream, messages, options)).toMatchObject({ content: 'ok', model, api: vector.api });
        expect(f.fetch.mock.calls).toHaveLength(count + 2);
        const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
        expect(body.input.filter((item: Record<string, unknown>) => ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(String(item.type)))).toEqual(vector.items);
        expect(toolFields(body)).toEqual(vector.fields); expect(body.model).toBe(scope === 'azure' ? 'owned-deployment' : model);
        if (vector.case.startsWith('image')) expect(body.input.slice(2)).toEqual(vector.items);
        expect(messages).toEqual(before); expect(options).toEqual(originalOptions);
      }
    });
    it(`${scope}: refuses malformed custom input and counts its mapped JSON against the existing output limit before publishing tools`, async () => {
      const vector = grammarReplay.rows.find(row => row.scope === scope && row.model === 'gpt-5' && row.case === 'success')!;
      const f = fixture(scope, 'gpt-5'), options = structuredClone(vector.options), originalOptions = structuredClone(options);
      for (const input of [null, 1, {}]) for (const stream of [false, true]) {
        f.items([{ ...structuredClone(vector.responseItems[0]!), input }]);
        await expect(f.call(stream, user, options)).rejects.toThrow('The provider response was invalid.');
        expect(f.chunks).toEqual([]);
      }
      const messages: Message[] = structuredClone(vector.messages).map(message => ({ ...message, timestamp: new Date(0) }));
      messages.find(message => message.role === 'assistant')!.toolCalls![0]!.input = { source_code: 1 };
      const before = structuredClone(messages), count = f.fetch.mock.calls.length;
      for (const stream of [false, true]) await expect(f.call(stream, messages, options)).rejects.toThrow('Invalid Responses grammar tool input.');
      expect(f.fetch.mock.calls).toHaveLength(count); expect(messages).toEqual(before);
      f.fetch.mockImplementation(async () => {
        const item = { ...vector.responseItems[0]!, input: '' }, encoder = new TextEncoder();
        const events = [{ type: 'response.output_item.added', output_index: 0, item },
          ...Array.from({ length: 30 }, () => ({ type: 'response.custom_tool_call_input.delta', output_index: 0, delta: '\u0000'.repeat(100_000) })),
          { type: 'response.completed', response: { status: 'completed', output: [] } }];
        let next = 0;
        return new Response(new ReadableStream({ pull(controller) {
          if (next === events.length) controller.close();
          else controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[next++])}\n\n`));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      });
      for (const stream of [false, true]) await expect(f.call(stream, user, options)).rejects.toThrow('The provider response exceeded the output limit.');
      expect(f.fetch.mock.calls).toHaveLength(8); expect(f.chunks).toEqual([]); expect(options).toEqual(originalOptions);
    });
    it(`${scope}: keeps grammar off generic/derived/unknown profiles despite public API labels and admits reviewed per-call policy`, async () => {
      const vector = grammar.rows.find(row => row.scope === scope && row.model === 'gpt-5' && row.case === 'lark')!;
      const controls = scope === 'openai' ? [['gpt-5', 'generic'], ['gpt-5-unreviewed', 'generic']] as const
        : [['gpt-5', 'derived-azure'], ['gpt-5-unreviewed', 'unknown-azure']] as const;
      for (const [model, legacy] of controls) {
        const f = fixture(scope, model, legacy); f.provider.getModelApi = () => vector.api;
        for (const stream of [false, true]) {
          await f.call(stream, user, structuredClone(vector.options));
          expect(toolFields(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string))).toEqual({
            tools: vector.options.tools!.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })), tool_choice: 'auto',
          });
        }
      }
      const f = fixture(scope, scope === 'azure' ? 'gpt-5-unreviewed' : 'gpt-4o');
      for (const stream of [false, true]) await compare(f, vector, stream);
    });
  }
});
