import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, GeminiProvider, VertexGeminiProvider, OpenAiProvider, MockProvider,
  type AiProvider, type ChatOptions, type ThinkingBudgets, type ThinkingLevel } from './index.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { streamProviderTurn } from '../agent/provider-turn.js';

type Body = { thinking?: { budget_tokens?: number }; generationConfig?: { thinkingConfig?: { thinkingBudget?: number } };
  max_tokens?: number; temperature?: number; reasoning_effort?: string };
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
const messages = [{ id: 'user', role: 'user' as const, content: 'probe', timestamp: new Date() }];
async function fixture(kind: 'anthropic' | 'google' | 'vertex' | 'openai', model = 'gemini-2.5-pro') {
  const bodies: Body[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body & { stream?: boolean }; bodies.push(body);
    const stream = body.stream === true || request.url!.includes('streamGenerateContent');
    const data = kind === 'anthropic' ? { content: [{ type: 'text', text: 'ok' }] }
      : kind === 'openai' ? { choices: [{ message: { content: 'ok' } }] }
        : { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };
    const event = kind === 'anthropic' ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
      : kind === 'openai' ? { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } : data;
    response.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
    response.end(stream ? `data: ${JSON.stringify(event)}\n\n` : JSON.stringify(data));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { type: kind, apiKey: 'disposable', model: kind === 'anthropic' ? 'claude-3-7-sonnet-latest' : kind === 'openai' ? 'o3' : model, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  const provider: AiProvider = kind === 'anthropic' ? new AnthropicProvider(config) : kind === 'vertex' ? new VertexGeminiProvider(config)
    : kind === 'openai' ? new OpenAiProvider(config) : new GeminiProvider(config);
  const call = async (stream: boolean, options: ChatOptions) => {
    if (!stream) return provider.chat(messages, options);
    let failure: Error | undefined;
    await provider.streamChat(messages, () => undefined, undefined, error => { failure = error; }, options);
    if (failure) throw failure;
    return undefined;
  };
  return { bodies, call };
}

describe('numeric thinking budgets on real HTTP payloads', () => {
  for (const kind of ['anthropic', 'google', 'vertex'] as const) {
    for (const [level, configured] of [['minimal', undefined], ['low', 3333], ['medium', 0], ['high', Number.MAX_SAFE_INTEGER], ['xhigh', 2222], ['max', 2222], ['off', 2222]] as const) {
      it(`${kind}: ${level}/${configured ?? 'default'} is consistent in chat and stream`, async () => {
        const test = await fixture(kind);
        const budgets: ThinkingBudgets | undefined = configured === undefined ? undefined
          : { [level === 'xhigh' || level === 'max' || level === 'off' ? 'high' : level]: configured };
        const expected = level === 'off' ? (kind === 'anthropic' ? undefined : 0)
          : level === 'minimal' ? (kind === 'anthropic' ? 1024 : 128)
            : level === 'low' ? 3333 : level === 'medium' ? (kind === 'anthropic' ? 1024 : 0)
              : level === 'xhigh' && kind === 'anthropic' ? 16384
                : (level === 'xhigh' || level === 'max') && kind !== 'anthropic' ? 2222 : 32768;
        for (const stream of [false, true]) await test.call(stream, { thinking: level, thinkingBudgets: budgets, maxTokens: kind === 'anthropic' ? 64 : 65536, temperature: 0.3 });
        expect(test.bodies).toHaveLength(2);
        for (const body of test.bodies) {
          expect(kind === 'anthropic' ? body.thinking?.budget_tokens : body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(expected);
          if (kind === 'anthropic' && level !== 'off') {
            expect(body.max_tokens).toBe(expected! + 1024); expect(body.temperature).toBeUndefined();
          }
        }
        if (configured !== undefined) expect(Object.values(budgets!)).toEqual([configured]);
      });
    }
  }
  it.each([['gemini-2.5-flash', 24576], ['gemini-other', 8192]] as const)('clamps %s to its conservative numeric ceiling', async (model, maximum) => {
    const test = await fixture('google', model);
    for (const stream of [false, true]) await test.call(stream, { thinking: 'high', thinkingBudgets: { high: Number.MAX_SAFE_INTEGER } });
    expect(test.bodies.map(body => body.generationConfig?.thinkingConfig?.thinkingBudget)).toEqual([maximum, maximum]);
    await test.call(false, { thinking: 'low', thinkingBudgets: { low: 0 } });
    expect(test.bodies.at(-1)?.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
  });
  it('retains legacy extended-level budget fallback outside the owned Google catalogue', async () => {
    const test = await fixture('google', 'gemini-other');
    for (const thinking of ['xhigh', 'max'] as const) for (const stream of [false, true]) {
      await test.call(stream, { thinking, thinkingBudgets: { high: 2222 } });
      expect(test.bodies.at(-1)?.generationConfig?.thinkingConfig?.thinkingBudget).toBe(8192);
    }
  });
  it('does not enable thinking without a level or send numeric fields to effort-only APIs', async () => {
    const anthropic = await fixture('anthropic'); const openai = await fixture('openai');
    for (const stream of [false, true]) {
      await anthropic.call(stream, { thinkingBudgets: { high: 2000 } });
      await openai.call(stream, { thinking: 'high', thinkingBudgets: { high: 2000 } });
    }
    expect(anthropic.bodies.every(body => body.thinking === undefined)).toBe(true);
    expect(openai.bodies.every(body => body.reasoning_effort === 'high' && !('thinking' in body) && !('thinkingBudgets' in body))).toBe(true);
  });
  it.each([null, [], { low: -1 }, { low: 0.5 }, { low: Infinity }, { low: NaN }, { low: Number.MAX_SAFE_INTEGER + 1 }, { max: 2000 }, { low: '2000' }].map(value => ({ value })))('refuses malformed active budgets before any request (%#)', async ({ value: invalid }) => {
    const test = await fixture('anthropic');
    for (const stream of [false, true]) await expect(test.call(stream, { thinking: 'low', thinkingBudgets: invalid as unknown as ThinkingBudgets })).rejects.toThrow('Thinking budgets');
    expect(test.bodies).toEqual([]);
  });
  it('treats optional undefined and inherited fields as absent', async () => {
    const test = await fixture('anthropic');
    await test.call(false, { thinking: 'low', thinkingBudgets: { low: undefined, high: 2000 } });
    const inherited = Object.create({ low: 9999 }) as ThinkingBudgets;
    await test.call(true, { thinking: 'low', thinkingBudgets: inherited });
    expect(test.bodies.map(body => body.thinking?.budget_tokens)).toEqual([1024, 1024]);
  });
  it('does not invoke a budget getter', async () => {
    const getter = vi.fn(() => 2000); const budgets = Object.defineProperty({}, 'low', { get: getter });
    const test = await fixture('google');
    for (const stream of [false, true]) await expect(test.call(stream, { thinking: 'low', thinkingBudgets: budgets })).rejects.toThrow('Thinking budgets');
    expect(getter).not.toHaveBeenCalled(); expect(test.bodies).toEqual([]);
  });
});

describe('shared provider-turn budget ownership', () => {
  it('copies configuration before hooks and reads a fresh value on the next provider turn', async () => {
    const registry = new ExtensionRegistry(); const provider = new MockProvider({ type: 'mock' });
    const captured: Array<ChatOptions | undefined> = [];
    vi.spyOn(provider, 'streamChat').mockImplementation(async (_messages, _chunk, complete, _error, options) => { captured.push(options); complete?.({ content: 'ok' }); });
    const budgets = { low: 2000 };
    await registry.load('hook', api => api.before('before:provider', data => {
      expect(data.options.thinkingBudgets).toEqual(budgets);
      Reflect.set(data.options.thinkingBudgets!, 'low', data.options.thinkingBudgets!.low! + 100);
    }));
    const call = () => streamProviderTurn({ provider, providerName: 'mock', messages, tools: [], thinking: 'low' as ThinkingLevel, thinkingBudgets: budgets, extensionRegistry: registry });
    await call(); expect(budgets.low).toBe(2000);
    budgets.low = 3000; await call(); expect(budgets.low).toBe(3000);
    expect(captured.map(options => options?.thinkingBudgets)).toEqual([{ low: 2100 }, { low: 3100 }]);
  });
});
