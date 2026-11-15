import { afterEach, expect, it, vi } from 'vitest';
import { GeminiProvider, VertexGeminiProvider, BedrockProvider, AzureCompletionsProvider, AzureProvider, type AiProvider, type ChatResponse, type GoogleChatOptions, type BedrockChatOptions, type Message } from '../../dist/index.js';
import { bedrockFrame } from '../../../../tests/fixtures/bedrock-event-stream.js';
const messages: Message[] = [{ id: 'intent-user', role: 'user', content: 'intent probe', timestamp: new Date(0) }], tool = { name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function googleResponse(stream: boolean) { const body = { candidates: [{ content: { role: 'model', parts: [{ text: 'intent-ready' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 } }; return stream ? new Response('data: ' + JSON.stringify(body) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }) : Response.json(body); }
async function call(provider: AiProvider, options: GoogleChatOptions | BedrockChatOptions, stream: boolean): Promise<ChatResponse> { if (!stream) return provider.chat(messages, options); let result: ChatResponse | undefined; await provider.streamChat(messages, () => {}, value => { result = value; }, error => { throw error; }, options); return result!; }
it.each(['google', 'vertex'] as const)('keeps %s construction intent private against forged scope promotion and native-owner downgrade on JSON/SSE', async scope => {
  class DerivedGoogle extends GeminiProvider {} class DerivedVertex extends VertexGeminiProvider {}
  const model = 'gemini-3-flash-preview', config = { type: scope, model, apiKey: 'synthetic-google-intent-key', project: 'synthetic-project', location: 'us-central1', baseUrl: 'https://google.synthetic/v1' }, options: GoogleChatOptions = { maxTokens: 64, thinking: 'off', tools: [tool] }, before = structuredClone({ messages, options });
  for (const genuine of [false, true]) {
    const provider = scope === 'google' ? genuine ? new GeminiProvider(config) : new DerivedGoogle(config) : genuine ? new VertexGeminiProvider(config) : new DerivedVertex(config), getter = vi.fn(() => genuine ? undefined : scope === 'google' ? 'google' : 'google-vertex'), requests: Array<{ url: URL; headers: Headers; body: Record<string, any> }> = [];
    Object.defineProperty(provider, 'nativeScope', { configurable: true, get: getter });
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => { const target = new URL(String(url)); requests.push({ url: target, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }); return googleResponse(target.searchParams.get('alt') === 'sse'); });
    for (const stream of [false, true]) { expect((await call(provider, options, stream)).usage?.totalTokens).toBe(10); const request = requests.at(-1)!, declaration = request.body.tools[0].functionDeclarations[0];
      expect(declaration).toEqual({ name: tool.name, description: tool.description, [genuine ? 'parametersJsonSchema' : 'parameters']: tool.parameters });
      if (scope === 'google') { expect(request.url.searchParams.has('key')).toBe(!genuine); expect(request.headers.get('x-goog-api-key')).toBe(genuine ? config.apiKey : null); } else expect(request.headers.get('authorization')).toBe('Bearer ' + config.apiKey);
    }
    expect(getter).not.toHaveBeenCalled(); expect({ messages, options }).toEqual(before);
  }
});
it('keeps Bedrock native tool/budget/region intent private rather than reading a forged own field on JSON/binary calls', async () => {
  class Derived extends BedrockProvider {}
  const model = 'anthropic.claude-opus-4-6-v1', config = { type: 'bedrock', model, apiKey: 'synthetic-bedrock-intent-token', region: 'us-east-1', baseUrl: 'https://bedrock.synthetic/prefix' }, options: BedrockChatOptions = { maxTokens: 64, thinking: 'off', tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'require' } }], toolChoice: 'any' }, before = structuredClone(options), fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + config.apiKey); const body = JSON.parse(String(init?.body)); expect(body.toolConfig.tools[0].toolSpec.strict).toBe(true); expect(body.toolConfig.toolChoice).toEqual({ any: {} });
    if (!String(url).endsWith('/converse-stream')) return Response.json({ output: { message: { role: 'assistant', content: [{ text: 'intent-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
    return new Response(Buffer.concat([bedrockFrame('messageStart', { role: 'assistant' }), bedrockFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'intent-ready' } }), bedrockFrame('contentBlockStop', { contentBlockIndex: 0 }), bedrockFrame('messageStop', { stopReason: 'end_turn' }), bedrockFrame('metadata', { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } })]), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
  }); vi.stubGlobal('fetch', fetch);
  const derived = new Derived(config), forged = vi.fn(() => true); Object.defineProperty(derived, 'ownsNativeProfiles', { configurable: true, get: forged });
  for (const stream of [false, true]) await expect(call(derived, options, stream)).rejects.toThrow('Invalid Bedrock tool policy.'); expect(fetch).not.toHaveBeenCalled(); expect(forged).not.toHaveBeenCalled();
  const original = new BedrockProvider(config), downgrade = vi.fn(() => false); Object.defineProperty(original, 'ownsNativeProfiles', { configurable: true, get: downgrade });
  for (const stream of [false, true]) expect((await call(original, options, stream)).usage?.totalTokens).toBe(10); expect(downgrade).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2); expect(options).toEqual(before);
});
it('keeps Azure C prepared defaults and catalogue intent independent of a forged own getter on both methods', async () => {
  class Derived extends AzureCompletionsProvider {}
  const model = 'deepseek-v4-pro', config = { type: 'azure-intent', model, apiKey: 'synthetic-azure-intent', baseUrl: 'https://azure.synthetic/openai/v1', azureDeploymentMap: { [model]: 'deployment' } }, options = { maxTokens: 64, thinking: 'off' as const }, before = structuredClone(options);
  for (const genuine of [false, true]) {
    const provider = genuine ? new AzureCompletionsProvider(config) : new Derived(config), getter = vi.fn(() => !genuine), bodies: Array<Record<string, any>> = []; Object.defineProperty(provider, 'ownsNativeProfiles', { configurable: true, get: getter });
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); bodies.push(body); const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }, choice = { index: 0, finish_reason: 'stop' }; return body.stream ? new Response('data: ' + JSON.stringify({ choices: [{ ...choice, delta: { content: 'intent-ready' } }], usage }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) : Response.json({ choices: [{ ...choice, message: { role: 'assistant', content: 'intent-ready' } }], usage }); });
    for (const stream of [false, true]) { expect((await call(provider, options, stream)).usage?.totalTokens).toBe(10); const body = bodies.at(-1)!; expect(body.max_completion_tokens).toBe(genuine ? 64 : undefined); expect(body.max_tokens).toBe(genuine ? undefined : 64); expect(body.model).toBe('deployment'); }
    expect(provider.getPublishedModels()?.map(row => row.id)).toEqual(genuine ? [model] : undefined); expect(getter).not.toHaveBeenCalled(); expect(options).toEqual(before);
  }
});
it('keeps mixed Azure catalogue construction intent private without changing its separate delegate/runtime authority', () => {
  class Derived extends AzureProvider {}
  for (const genuine of [false, true]) {
    const provider = genuine ? new AzureProvider({ type: 'azure', apiKey: 'synthetic-key', model: 'gpt-4o', baseUrl: 'https://azure.synthetic/openai/v1' }) : new Derived({ type: 'azure', apiKey: 'synthetic-key', model: 'gpt-4o', baseUrl: 'https://azure.synthetic/openai/v1' }), getter = vi.fn(() => !genuine); Object.defineProperty(provider, 'ownsNativeProfiles', { configurable: true, get: getter }); expect(provider.getPublishedModels()?.length).toBe(genuine ? 45 : undefined); expect(getter).not.toHaveBeenCalled();
  }
});
