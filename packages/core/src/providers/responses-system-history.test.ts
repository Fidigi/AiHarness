import { afterEach, expect, it, vi } from 'vitest';
import { AzureProvider, AzureResponsesProvider, OpenAiMixedProvider, OpenAiResponsesProvider, OPENAI_RESPONSE_MODELS, type AiProvider, type ChatOptions, type ChatResponse, type Message } from '../../dist/index.js';
const inline = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'];
const config = (model: string) => ({ type: 'operator-response-history', model, apiKey: 'synthetic-response-history-key', baseUrl: 'https://responses.synthetic/v1', azureDeploymentMap: { [model]: 'physical-deployment' } });
const message = (id: string, role: Message['role'], content: string): Message => ({ id, role, content, timestamp: new Date(0) });
function history(scope: 'openai' | 'azure', model: string): Message[] {
  return [message('leading', 'system', 'leading'), message('question', 'user', 'question'), { ...message('a', 'assistant', 'prior'), provider: scope, model, api: scope === 'openai' ? 'openai-responses' : 'azure-openai-responses', toolCalls: [{ id: 'call_history|fc_history', name: 'echo', input: { x: 1 } }] },
    message('between', 'system', 'late between'), { ...message('result', 'tool', 'result'), toolCallId: 'call_history|fc_history' }, message('blank', 'system', ''), message('last', 'system', 'last instruction'), message('follow', 'user', 'follow')];
}
function reply() { return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'owned-history-response', status: 'completed', model: 'untrusted-alias', output: [{ type: 'message', id: 'msg_history', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
async function call(provider: AiProvider, messages: Message[], options: ChatOptions, stream: boolean): Promise<ChatResponse> {
  if (!stream) return provider.chat(messages, options);
  let response: ChatResponse | undefined; await provider.streamChat(messages, () => {}, value => { response = value; }, error => { throw error; }, options); return response!;
}
afterEach(() => vi.unstubAllGlobals());
it('binds the eleven independently pinned inline system declarations without granting mutable metadata authority', () => {
  expect(OPENAI_RESPONSE_MODELS.filter(row => row.compat.supportsMidConvoSystemMessages).map(row => row.id)).toEqual(inline);
  for (const row of OPENAI_RESPONSE_MODELS) expect(Object.isFrozen(row.compat)).toBe(true);
});
it.each([
  ['openai', 'gpt-4o', 'system'], ['openai', 'gpt-5.4-nano', 'developer'], ['azure', 'gpt-5.4', 'developer'],
] as const)('folds plain late systems for %s/%s independently of same-ID foreign capability and deployment (%s)', async (scope, model, role) => {
  const provider = scope === 'openai' ? new OpenAiMixedProvider(config(model)) : new AzureProvider(config(model)), input = history(scope, model), options = { systemPrompt: 'guard', maxTokens: 64, temperature: 0.25, tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }] }, before = structuredClone({ input, options }), requests: Array<Record<string, any>> = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return reply(); });
  for (const stream of [false, true]) {
    const response = await call(provider, input, options, stream), body = requests.at(-1)!;
    expect(body.input).toEqual([{ role, content: 'guard\n\nleading\n\nlate between\n\nlast instruction' }, { role: 'user', content: 'question' }, { role: 'assistant', content: 'prior' }, { type: 'function_call', call_id: 'call_history', id: 'fc_history', name: 'echo', arguments: '{"x":1}' }, { type: 'function_call_output', call_id: 'call_history', output: 'result' }, { role: 'user', content: 'follow' }]);
    expect(body.instructions).toBeUndefined(); expect(body.temperature).toBe(0.25); expect(body.max_output_tokens).toBe(64); expect(body.model).toBe(scope === 'azure' ? 'physical-deployment' : model); expect(response.usage?.totalTokens).toBe(10); expect(response.model).toBe(model); expect({ input, options }).toEqual(before);
    await call(provider, [message('empty', 'system', '')], { model, maxTokens: 64 }, stream); expect(requests.at(-1)!.input).toEqual([]);
    await call(provider, [message('only-user', 'user', 'untouched')], { model, maxTokens: 64 }, stream); expect(requests.at(-1)!.input).toEqual([{ role: 'user', content: 'untouched' }]);
  }
});
it('preserves inline system chronology for an eligible prepared OpenAI model but folds an explicit non-inline override on the same instance', async () => {
  const provider = new OpenAiMixedProvider(config('gpt-5.4-nano')), input = [message('u', 'user', 'start'), message('s', 'system', 'future instruction'), message('a', 'assistant', 'prior'), message('blank', 'system', ''), message('s2', 'system', 'last instruction')], before = structuredClone(input), bodies: Array<Record<string, any>> = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return reply(); });
  for (const stream of [false, true]) {
    await call(provider, input, { model: 'gpt-5.4', systemPrompt: 'guard', maxTokens: 64 }, stream);
    expect(bodies.at(-1)!.input).toEqual([{ role: 'developer', content: 'guard' }, { role: 'user', content: 'start' }, { role: 'developer', content: 'future instruction' }, { role: 'assistant', content: 'prior' }, { role: 'developer', content: 'last instruction' }]);
    await call(provider, input, { model: 'gpt-5.4-nano', systemPrompt: 'guard', maxTokens: 64 }, stream);
    expect(bodies.at(-1)!.input).toEqual([{ role: 'developer', content: 'guard\n\nfuture instruction\n\nlast instruction' }, { role: 'user', content: 'start' }, { role: 'assistant', content: 'prior' }]);
  }
  expect(input).toEqual(before);
});
it('leaves generic and forged-derived Azure transports legacy rather than admitting native policy from public fields', async () => {
  class Derived extends AzureResponsesProvider {}
  for (const provider of [new OpenAiResponsesProvider(config('gpt-5.4-nano')), new Derived(config('gpt-5.4'))]) {
    Reflect.set(provider, 'ownsNativeProfiles', true); Reflect.set(provider, 'supportsMidConvoSystemMessages', true);
    const input = [message('u', 'user', 'start'), message('s', 'system', 'later')], bodies: Array<Record<string, any>> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return reply(); });
    for (const stream of [false, true]) {
      await call(provider, input, { systemPrompt: 'guard', maxTokens: 64, tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }] }, stream);
      expect(bodies.at(-1)!.instructions).toBe('guard'); expect(bodies.at(-1)!.input).toEqual([{ role: 'user', content: 'start' }, { role: 'system', content: 'later' }]); expect(bodies.at(-1)!.tools).toEqual([{ type: 'function', name: 'echo', description: 'Echo', parameters: { type: 'object' } }]);
    }
  }
});
