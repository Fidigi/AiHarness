import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, type ChatOptions, type ChatResponse, type ThinkingLevel } from './index.js';
import { getPublishedModels } from './model-metadata.js';

const adaptive = 'claude-sonnet-4-6';
const classic = 'claude-3-7-sonnet-latest';
type Body = { model: string; stream: boolean; thinking?: { type: string; budget_tokens?: number };
  output_config?: { effort: string }; max_tokens: number; temperature?: number; system?: string; tools?: unknown[];
  messages: Array<{ role: string; content: unknown }> };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function fixture(model = adaptive) {
  const bodies: Body[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; bodies.push(body);
    const enabled = body.thinking?.type === 'adaptive' || body.thinking?.type === 'enabled';
    response.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
    if (body.stream) {
      const events = [
        ...(enabled ? [{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }] : []),
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
      ];
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } else response.end(JSON.stringify({ model: body.model, content: [
      ...(enabled ? [{ type: 'thinking', thinking: 'reason', signature: 'fixture-signature' }] : []),
      { type: 'text', text: 'ok' },
    ] }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new AnthropicProvider({ type: 'anthropic', model, apiKey: 'disposable', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  const messages = [{ id: 'user', role: 'user' as const, content: 'probe', timestamp: new Date() }];
  const call = async (stream: boolean, options: ChatOptions): Promise<ChatResponse | undefined> => {
    if (!stream) return provider.chat(messages, options);
    let result: ChatResponse | undefined; let failure: Error | undefined;
    await provider.streamChat(messages, () => undefined, response => { result = response; }, error => { failure = error; }, options);
    if (failure) throw failure;
    return result;
  };
  return { bodies, provider, call };
}

describe('published Anthropic adaptive request dialect', () => {
  for (const [level, effort] of [['off', undefined], ['minimal', 'low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'max'], ['max', 'max']] as const) {
    it(`${level}: uses native effort in chat and stream without numeric headroom`, async () => {
      const test = await fixture();
      for (const stream of [false, true]) {
        const result = await test.call(stream, { thinking: level, thinkingBudgets: { high: Number.MAX_SAFE_INTEGER, low: 8000 },
          maxTokens: 64, temperature: 0.25, systemPrompt: 'system probe', tools: [{ name: 'echo', description: 'Probe', parameters: { type: 'object' } }] });
        expect(result?.content).toBe('ok'); expect(result?.reasoning).toBe(effort ? 'reason' : undefined);
      }
      expect(test.bodies).toHaveLength(2);
      for (const body of test.bodies) {
        expect(body.thinking).toEqual(effort ? { type: 'adaptive', display: 'summarized' } : { type: 'disabled' });
        expect(body.output_config).toEqual(effort ? { effort } : undefined);
        expect(body.max_tokens).toBe(64); expect(body.temperature).toBe(effort ? undefined : 0.25);
        expect(body.system).toBe('system probe');
        expect(body.tools).toEqual([{ name: 'echo', description: 'Probe', input_schema: { type: 'object' } }]);
      }
    });
  }
  it.each([undefined, 'none', 'short', 'long'] as const)('projects %s cache retention on the actual chat and stream wire', async retention => {
    const test = await fixture();
    for (const stream of [false, true]) await test.call(stream, { cacheRetention: retention, maxTokens: 1, thinking: 'off' });
    for (const body of test.bodies) expect(body.messages.at(-1)?.content).toEqual(retention === 'none' ? 'probe' : [{
      type: 'text', text: 'probe', cache_control: { type: 'ephemeral', ...(retention === 'long' ? { ttl: '1h' } : {}) },
    }]);
  });

  it('retains legacy per-level output defaults instead of reducing adaptive output to 1024', async () => {
    const test = await fixture();
    for (const [thinking, maximum] of [['minimal', 2048], ['low', 2048], ['medium', 5120], ['high', 9216], ['xhigh', 17408], ['max', 33792]] as const) {
      for (const stream of [false, true]) {
        await test.call(stream, { thinking, thinkingBudgets: { low: 1, medium: 1, high: Number.MAX_SAFE_INTEGER } });
        expect(test.bodies.at(-1)?.max_tokens).toBe(maximum);
        expect(test.bodies.at(-1)?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      }
    }
  });
  it('does not invent an adaptive preference when thinking is absent', async () => {
    const test = await fixture();
    for (const stream of [false, true]) await test.call(stream, { thinkingBudgets: { high: 3000 }, maxTokens: 64, temperature: 0.25 });
    for (const body of test.bodies) {
      expect(body.thinking).toBeUndefined(); expect(body.output_config).toBeUndefined(); expect(body.max_tokens).toBe(64); expect(body.temperature).toBe(0.25);
    }
  });
  it('recomputes dialect and effort after configured-model changes and per-call overrides', async () => {
    const test = await fixture();
    await test.call(false, { thinking: 'max', maxTokens: 64 });
    test.provider.setConfiguredModel(classic);
    await test.call(false, { thinking: 'low', thinkingBudgets: { low: 4000 }, maxTokens: 64 });
    await test.call(true, { model: adaptive, thinking: 'high', thinkingBudgets: { high: 4000 }, maxTokens: 64 });
    await test.call(false, { model: adaptive, thinking: 'off', maxTokens: 64 });
    expect(test.bodies.map(body => [body.model, body.thinking, body.output_config, body.max_tokens])).toEqual([
      [adaptive, { type: 'adaptive', display: 'summarized' }, { effort: 'max' }, 64],
      [classic, { type: 'enabled', budget_tokens: 4000 }, undefined, 5024],
      [adaptive, { type: 'adaptive', display: 'summarized' }, { effort: 'high' }, 64],
      [adaptive, { type: 'disabled' }, undefined, 64],
    ]);
    expect(test.provider.getConfiguredModel()).toBe(classic);
  });
  it.each([classic, `${adaptive}-unverified`])('preserves the numeric path for %s', async model => {
    const test = await fixture(model);
    for (const stream of [false, true]) await test.call(stream, { thinking: 'low', thinkingBudgets: { low: 4000 }, maxTokens: 64 });
    expect(test.bodies.map(body => [body.thinking, body.output_config, body.max_tokens])).toEqual([
      [{ type: 'enabled', budget_tokens: 4000 }, undefined, 5024], [{ type: 'enabled', budget_tokens: 4000 }, undefined, 5024],
    ]);
  });
  it.each([null, 'HIGH', 'fake', 1, {}].map(level => ({ level })))('rejects invalid thinking before HTTP (%#)', async ({ level }) => {
    const test = await fixture();
    for (const model of [adaptive, classic]) for (const stream of [false, true]) {
      await expect(test.call(stream, { model, thinking: level as unknown as ThinkingLevel })).rejects.toThrow('Invalid Anthropic thinking level.');
    }
    expect(test.bodies).toEqual([]);
  });
  it('does not consume numeric budget accessors on direct adaptive calls', async () => {
    const getter = vi.fn(() => 9999); const budgets = Object.defineProperty({}, 'high', { get: getter });
    const test = await fixture();
    for (const stream of [false, true]) await test.call(stream, { thinking: 'high', thinkingBudgets: budgets, maxTokens: 64 });
    expect(getter).not.toHaveBeenCalled();
    expect(test.bodies.map(body => body.output_config)).toEqual([{ effort: 'high' }, { effort: 'high' }]);
  });
  it('makes the published native-max claim operational rather than only a menu capability', async () => {
    const models = getPublishedModels('anthropic').filter(model => model.thinkingLevelMap?.max === 'max');
    expect(models.map(model => model.id)).toEqual([adaptive]);
    const test = await fixture();
    for (const model of models) await test.call(false, { model: model.id, thinking: 'max' });
    expect(test.bodies.map(body => body.output_config?.effort)).toEqual(models.map(() => 'max'));
  });
});
