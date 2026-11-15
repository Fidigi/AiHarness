import { afterEach, expect, it, vi } from 'vitest';
import { BedrockProvider, type BedrockChatOptions, type ChatResponse, type Message } from '../../dist/index.js';
import { bedrockFrame } from '../../../../tests/fixtures/bedrock-event-stream.js';
const model = 'anthropic.claude-opus-4-6-v1';
const user: Message = { id: 'u', role: 'user', content: 'cache probe', timestamp: new Date(0) };
const create = (selected = model) => new BedrockProvider({ type: 'bedrock', model: selected, apiKey: 'synthetic-cache-key' });
const point = (long: boolean) => ({ cachePoint: { type: 'default', ...(long ? { ttl: '1h' } : {}) } });
function transport() {
  const bodies: Array<Record<string, any>> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const usage = { inputTokens: 8, outputTokens: 2, totalTokens: 10 };
    return String(url).endsWith('/converse-stream') ? new Response(Buffer.concat([
      bedrockFrame('messageStart', { role: 'assistant' }), bedrockFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'cache-ready' } }),
      bedrockFrame('contentBlockStop', { contentBlockIndex: 0 }), bedrockFrame('messageStop', { stopReason: 'end_turn' }), bedrockFrame('metadata', { usage }),
    ]), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } }) : Response.json({ output: { message: { role: 'assistant', content: [{ text: 'cache-ready' }] } }, stopReason: 'end_turn', usage });
  });
  vi.stubGlobal('fetch', fetch); return { bodies, fetch };
}
async function call(provider: BedrockProvider, messages: Message[], options: BedrockChatOptions, stream: boolean) {
  if (!stream) return provider.chat(messages, options);
  let result: ChatResponse | undefined; const failed = vi.fn();
  await provider.streamChat(messages, () => {}, value => { result = value; }, failed, options);
  expect(failed).not.toHaveBeenCalled(); expect(result).toBeDefined(); return result!;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('applies native Bedrock cache defaults and explicit short/long/none to fresh system and final-user blocks on JSON/binary requests', async () => {
  const { bodies, fetch } = transport(); vi.stubEnv('PI_CACHE_RETENTION', 'long');
  for (const selected of [model, 'global.anthropic.claude-fable-5']) for (const cacheRetention of [undefined, 'short', 'long', 'none'] as const) for (const stream of [false, true]) {
    const messages = [structuredClone(user), { ...structuredClone(user), id: 's', role: 'system' as const, content: 'plain instruction' }], options: BedrockChatOptions = { systemPrompt: 'leading instruction', ...(cacheRetention === undefined ? {} : { cacheRetention }), maxTokens: 64 }, before = structuredClone({ messages, options });
    expect((await call(create(selected), messages, options, stream)).usage?.totalTokens).toBe(10);
    const body = bodies.at(-1)!, hints = cacheRetention === 'none' ? [] : [point(cacheRetention === 'long')];
    expect(body.system).toEqual([{ text: 'leading instruction' }, { text: 'plain instruction' }, ...hints]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ text: user.content }, ...hints] }]);
    expect(body.inferenceConfig.maxTokens).toBe(64); expect({ messages, options }).toEqual(before);
  }
  expect(fetch).toHaveBeenCalledTimes(16);
});
it('places Bedrock cache points only after the terminal user/tool-result prefix and never on assistant/tool-use blocks or tool declarations', async () => {
  const { bodies } = transport(), provider = create();
  const assistant: Message = { id: 'a', role: 'assistant', content: '', timestamp: new Date(1), provider: 'bedrock', model, api: 'bedrock-converse-stream', toolCalls: [{ id: 'call', name: 'lookup', input: {} }] };
  const result: Message = { id: 't', role: 'tool', content: 'result', toolCallId: 'call', name: 'lookup', timestamp: new Date(2) };
  const options: BedrockChatOptions = { systemPrompt: 'system', cacheRetention: 'long', tools: [{ name: 'lookup', description: 'Synthetic', parameters: { type: 'object', properties: {} } }] }, before = structuredClone(options);
  for (const stream of [false, true]) {
    await call(provider, [user, assistant], options, stream);
    expect(bodies.at(-1)!.system).toEqual([{ text: 'system' }, point(true)]);
    expect(bodies.at(-1)!.messages).toEqual([{ role: 'user', content: [{ text: user.content }] }, { role: 'assistant', content: [{ toolUse: { toolUseId: 'call', name: 'lookup', input: {} } }] }]);
    const messages = [user, assistant, result], saved = structuredClone(messages); await call(provider, messages, options, stream);
    expect(bodies.at(-1)!.messages).toEqual([{ role: 'user', content: [{ text: user.content }] }, { role: 'assistant', content: [{ toolUse: { toolUseId: 'call', name: 'lookup', input: {} } }] }, { role: 'user', content: [{ toolResult: { toolUseId: 'call', content: [{ text: 'result' }], status: 'success' } }, point(true)] }]);
    expect(bodies.at(-1)!.toolConfig).toEqual({ tools: [{ toolSpec: { name: 'lookup', description: 'Synthetic', inputSchema: { json: options.tools![0]!.parameters } } }] });
    expect(messages).toEqual(saved);
  }
  await provider.chat([user]); expect(bodies.at(-1)!.system).toBeUndefined(); expect(bodies.at(-1)!.messages).toEqual([{ role: 'user', content: [{ text: user.content }, point(false)] }]); expect(options).toEqual(before);
});
it('does not lend Bedrock cache controls to Nova, unknown Claude aliases, ARN routing, derived metadata or force-cache environment labels', async () => {
  const { bodies, fetch } = transport(); vi.stubEnv('AWS_BEDROCK_FORCE_CACHE', '1');
  class Derived extends BedrockProvider { override getPublishedModels() { return [{ id: model, name: 'Claude cache claim', capabilities: { reasoning: true, imageInput: true, toolCalls: true } }]; } }
  const derived = new Derived({ type: 'bedrock', model, apiKey: 'synthetic-derived-key' }); Object.defineProperty(derived, 'ownsNativeProfiles', { get: () => true });
  for (const provider of [create('amazon.nova-lite-v1:0'), create('operator-claude-opus-4-6'), create('arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/operator-claude-opus-4-6'), derived]) {
    for (const stream of [false, true]) {
      await call(provider, [user], { systemPrompt: 'system', cacheRetention: 'long' }, stream);
      expect(bodies.at(-1)!.system).toEqual([{ text: 'system' }]); expect(bodies.at(-1)!.messages).toEqual([{ role: 'user', content: [{ text: user.content }] }]);
    }
  }
  expect(fetch).toHaveBeenCalledTimes(8);
});
