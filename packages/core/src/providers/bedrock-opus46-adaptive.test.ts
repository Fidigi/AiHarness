import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { BedrockProvider, type ChatOptions, type ChatResponse, type ThinkingLevel } from './index.js';
import { prepareBedrockOutputBudget } from './bedrock-profiles.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';
import type { Message } from '../types/index.js';

const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/bedrock-opus46-adaptive-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; model: { id: string }; rows: Array<{ thinking: ThinkingLevel; options: ChatOptions; expectedBody: Record<string, unknown> }>;
};
const context = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/bedrock-simple-context-reference.json', import.meta.url), 'utf8')) as { replyFramesBase64: string };
const model = 'anthropic.claude-opus-4-6-v1';
const messages: Message[] = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
const servers: Server[] = [];
const create = (extra = {}) => new BedrockProvider({ type: 'bedrock', apiKey: 'disposable-opus46', model, region: 'us-east-1', ...extra });
const reply = (binary: boolean) => binary
  ? new Response(Buffer.from(context.replyFramesBase64, 'base64'), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
  : new Response(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }), { headers: { 'content-type': 'application/json' } });
afterEach(async () => {
  vi.unstubAllGlobals(); await closeProviderNetworkDispatchers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe('selected Bedrock Opus 4.6 adaptive request composition', () => {
  it('binds the exact historical seven-level request slice, not a signed-response certificate', () => {
    expect(reference.pinnedCommit).toBe('06a466935536f8c9bcacb2d5efc0fc021be1bdff');
    expect(reference.model.id).toBe(model);
    expect(reference.rows.map(row => row.thinking)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it.each(reference.rows)('simple $thinking at output64 matches the captured request through JSON and binary loopback', async row => {
    const captured: Array<{ path: string; authorization: string | undefined; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      captured.push({ path: request.url!, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const binary = request.url!.endsWith('/converse-stream'), source = reply(binary);
      response.writeHead(200, { 'content-type': source.headers.get('content-type')! }); response.end(Buffer.from(await source.arrayBuffer()));
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = create({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy` });
    const input = structuredClone(messages), options = structuredClone(row.options), before = structuredClone({ input, options });
    for (const binary of [false, true]) {
      let result: ChatResponse | undefined; const failed = vi.fn(), completed = vi.fn();
      if (binary) { await provider.streamChat(input, () => {}, completed, failed, options); result = completed.mock.calls[0]?.[0]; }
      else result = await provider.chat(input, options);
      expect(failed).not.toHaveBeenCalled();
      expect(result).toMatchObject({ content: 'ok', model, api: 'bedrock-converse-stream', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
      expect(result?.reasoning).toBeUndefined(); // The retained reply fixture is text-only; no signature lifecycle is credited.
      expect(captured.at(-1)).toEqual({ path: `/proxy/model/${model}/converse${binary ? '-stream' : ''}`,
        authorization: 'Bearer disposable-opus46', body: row.expectedBody });
      expect({ input, options }).toEqual(before);
    }
    expect(captured).toHaveLength(2);
  });

  it('rejects malformed active levels before transport and preserves the fixed host-budget refusal', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const thinking of ['private-level', '__proto__', null, 1]) {
      const options = { thinking: thinking as ThinkingLevel, maxTokens: 64 }, failed = vi.fn(), complete = vi.fn(), chunk = vi.fn();
      await expect(create().chat(messages, options)).rejects.toThrow('Invalid Bedrock reasoning level.');
      await create().streamChat(messages, chunk, complete, failed, options);
      expect(failed).toHaveBeenCalledTimes(1); expect(failed.mock.calls[0][0].message).toBe('Invalid Bedrock reasoning level.');
      expect(complete).not.toHaveBeenCalled(); expect(chunk).not.toHaveBeenCalled();
      expect(() => prepareBedrockOutputBudget(options, model, messages)).toThrow('Provider native output policy is invalid.');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps numeric maps opaque for adaptive levels and confines selection to the direct owner and exact requested model', async () => {
    const get = vi.fn(() => { throw new Error('PRIVATE_UNUSED_BUDGET'); });
    const thinkingBudgets = Object.defineProperty({}, 'high', { enumerable: true, get });
    class Compatible extends BedrockProvider {}
    for (const binary of [false, true]) for (const [provider, options, effort] of [
      [create(), { thinking: 'high', thinkingBudgets, maxTokens: 64 }, 'high'],
      [create(), { thinking: 'off', thinkingBudgets, maxTokens: 64 }, undefined],
      [create(), { thinkingBudgets, maxTokens: 64 }, undefined],
      [create(), { model: 'anthropic.claude-sonnet-4-6', thinking: 'high', thinkingBudgets, maxTokens: 64 }, undefined],
      [create({ model: 'unknown' }), { model, thinking: 'max', thinkingBudgets, maxTokens: 64 }, 'max'],
      [create({ model: model + '-unreviewed' }), { thinking: 'high', thinkingBudgets, maxTokens: 64 }, undefined],
      [new Compatible({ type: 'bedrock', apiKey: 'disposable', model }), { thinking: 'high', thinkingBudgets, maxTokens: 64 }, undefined],
    ] as const) {
      const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => reply(binary)); vi.stubGlobal('fetch', fetch);
      const failed = vi.fn();
      if (binary) await provider.streamChat(messages, () => {}, undefined, failed, options); else await provider.chat(messages, options);
      expect(failed).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce(); expect(get).not.toHaveBeenCalled();
      const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
      expect(body.inferenceConfig.maxTokens).toBe(64);
      expect(body.additionalModelRequestFields).toEqual(effort ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } } : undefined);
    }
  });
});
