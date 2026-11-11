import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import type { Message, MessageContentBlock, ProviderConfig } from '../types/index.js';
import type { ProviderOAuthCredential } from './credentials.js';
import { GITHUB_COPILOT_MODELS, type GitHubCopilotChatOptions } from './github-copilot.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
  rows: { model: string; api: string; case: string; expectedPath: string; expectedBody: Record<string, unknown>; expectedHeaders: Record<string, string>; responseEvents: unknown[] }[];
};
type ContinuationRequest = { messages: Message[]; body: Record<string, unknown>; path: string; headers: Record<string, string> };
const continuation = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/github-copilot-continuation-reference.json', import.meta.url), 'utf8')) as {
  tools: NonNullable<GitHubCopilotChatOptions['tools']>;
  rows: { model: string; api: string; lane: string; seed: ContinuationRequest & { events: unknown[]; blocks: MessageContentBlock[] }; cases: Array<ContinuationRequest & { name: string }> }[];
};
const models = GITHUB_COPILOT_MODELS;
function credential(): ProviderOAuthCredential {
  return { version: 1, type: 'oauth', accessToken: 'disposable-copilot-routing-reference', refreshToken: 'disposable-github-grant', expiresAt: Date.now() + 60_000,
    subscription: { provider: 'github-copilot', availableModelIds: models.map(model => model.id) } };
}
function candidate(model: string, source: (signal?: AbortSignal) => Promise<ProviderOAuthCredential | undefined> = async () => credential()) {
  const Constructor = (providers as unknown as { GitHubCopilotProvider?: new (config: ProviderConfig,
    credentialSource: (signal?: AbortSignal) => Promise<ProviderOAuthCredential | undefined>) => providers.AiProvider }).GitHubCopilotProvider;
  expect(Constructor).toBeTypeOf('function');
  if (!Constructor) throw new Error('Copilot provider is not implemented.');
  return new Constructor({ type: 'github-copilot', model }, source);
}
const image = { type: 'image' as const, mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=' };
function history(variant: string, model: string): Message[] {
  const messages: Message[] = [{ id: 'user', role: 'user', content: 'probe', timestamp: new Date(1), ...(variant === 'user-image' ? { blocks: [image] } : {}) }];
  if (variant === 'agent' || variant === 'tool-image') messages.push(
    { id: 'assistant', role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'echo', input: { x: 1 } }], provider: 'github-copilot', api: GITHUB_COPILOT_MODELS.find(row => row.id === model)!.api, model, timestamp: new Date(2) },
    { id: 'tool', role: 'tool', toolCallId: 'call_1', name: 'echo', content: 'result', timestamp: new Date(3), ...(variant === 'tool-image' ? { blocks: [image] } : {}) });
  return messages;
}
const tools = [{ name: 'echo', description: 'Echo input', parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } }];
function response(events: unknown[]): Response {
  const responses = typeof (events[0] as { type?: string } | undefined)?.type === 'string';
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (responses ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.restoreAllMocks());

describe('Copilot A/C/R transport', () => {
  it.each(continuation.rows)('captures and replays owned $api/$model/$lane without leaking foreign private content', async row => {
    const provider = candidate(row.model), transport = vi.spyOn(globalThis, 'fetch');
    const options: GitHubCopilotChatOptions = { systemPrompt: 'Copilot continuation system', tools: continuation.tools, maxTokens: 4096, cacheRetention: 'none' };
    let calls = 0;
    for (const streaming of [false, true]) {
      let produced: providers.ChatResponse | undefined;
      for (const request of [row.seed, ...row.cases]) {
        const messages = structuredClone(request.messages).map(message => ({ ...message, timestamp: new Date(message.timestamp) }));
        if ('name' in request && request.name === 'same') {
          expect(produced).toBeDefined();
          messages[1] = { ...messages[1], content: produced!.content, blocks: produced!.blocks, toolCalls: produced!.toolCalls,
            provider: produced!.provider, api: produced!.api, model: produced!.model };
        }
        const before = structuredClone({ messages, options });
        let posted: { url: string; body: unknown; headers: Headers } | undefined;
        transport.mockImplementationOnce(async (url, init) => {
          calls++;
          posted = { url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) };
          return response(row.seed.events);
        });
        let result: providers.ChatResponse | undefined;
        if (streaming) await provider.streamChat(messages, () => {}, async value => { await Promise.resolve(); result = value; }, undefined, options);
        else result = await provider.chat(messages, options);
        expect(result).toMatchObject({ provider: 'github-copilot', api: row.api, model: row.model, blocks: row.seed.blocks });
        expect(result!.blocks).toEqual(row.seed.blocks);
        expect(posted?.url).toBe('https://api.individual.githubcopilot.com' + request.path);
        const expected = structuredClone(request.body);
        if (row.api === 'anthropic-messages' && 'name' in request && request.name === 'expurgated') {
          // Deliberate privacy divergence: the SDK emits a redacted block with no data after expurgation.
          // Never repair/replay that missing opaque payload. Preserve the unmodified capture in the fixture.
          const assistant = (expected.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find(message => message.role === 'assistant')!;
          expect(assistant.content.filter(block => block.type === 'redacted_thinking')).toEqual([{ type: 'redacted_thinking' }]);
          assistant.content = assistant.content.filter(block => block.type !== 'redacted_thinking');
        }
        expect(posted?.body, 'name' in request ? request.name : 'seed').toEqual(expected);
        for (const [key, value] of Object.entries(request.headers)) expect(posted?.headers.get(key)).toBe(value);
        expect(posted?.headers.get('x-api-key')).toBeNull();
        expect({ messages, options }).toEqual(before);
        produced ??= result;
      }
    }
    expect(calls).toBe(18);
  });
  it.each(continuation.rows.filter((row, index, rows) => rows.findIndex(other => other.api === row.api && other.lane === row.lane) === index))(
    'does not grant $api/$lane replay to subclasses or writable ownership fields', async row => {
      class Derived extends providers.GitHubCopilotProvider {}
      const forged = new Derived({ type: 'github-copilot', model: row.model }, async () => credential());
      Object.assign(forged, { constructor: providers.GitHubCopilotProvider, ownsReplay: true, ownsNativeProfiles: true, ownsGitHubCopilotReplay: true });
      const request = row.cases.find(item => item.name === 'same')!;
      const messages = request.messages.map(message => ({ ...structuredClone(message), timestamp: new Date(message.timestamp) }));
      const transport = vi.spyOn(globalThis, 'fetch');
      for (const streaming of [false, true]) {
        let posted = '', result: providers.ChatResponse | undefined;
        transport.mockImplementationOnce(async (_url, init) => { posted = String(init?.body); return response(row.seed.events); });
        const run = streaming ? forged.streamChat(messages, () => {}, value => { result = value; }) : forged.chat(messages).then(value => { result = value; });
        if (row.lane === 'details') await expect(run).rejects.toThrow(); else await run;
        expect(posted).not.toMatch(/opaque-copilot|encrypted_content|redacted_thinking|reasoning_details/u);
        expect(JSON.stringify(result) ?? '').not.toMatch(/opaque-copilot|thinkingSignature|textSignature/u);
      }
      expect(transport).toHaveBeenCalledTimes(2);
    });

  it.each(continuation.rows.filter((row, index, rows) => rows.findIndex(other => other.api === row.api) === index))(
    'keeps private $api streams incomplete until terminal success and awaits the final consumer', async row => {
      const provider = candidate(row.model), completed = vi.fn(), chunks: unknown[] = [];
      const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(row.seed.events.slice(0, -1)));
      await expect(provider.streamChat([], (_text, event) => { chunks.push(event); }, completed)).rejects.toThrow();
      expect(completed).not.toHaveBeenCalled();
      expect(JSON.stringify(chunks)).not.toContain('opaque-copilot');
      transport.mockResolvedValueOnce(response(row.seed.events));
      let settled = false;
      await expect(provider.streamChat([], () => {}, async () => { await Promise.resolve(); settled = true; throw new Error('consumer rejection'); })).rejects.toThrow();
      expect(settled).toBe(true);
      expect(transport).toHaveBeenCalledTimes(2);
    });

  it.each([
    { api: 'anthropic-messages', kind: 'redacted' }, { api: 'anthropic-messages', kind: 'signature' },
    { api: 'openai-completions', kind: 'details' }, { api: 'openai-responses', kind: 'encrypted' },
  ])('does not publish private-only $api/$kind producers', async ({ api, kind }) => {
    const row = continuation.rows.find(row => row.api === api)!, provider = candidate(row.model);
    let frames: unknown[];
    if (api === 'anthropic-messages') frames = [row.seed.events[0],
      { type: 'content_block_start', index: 0, content_block: kind === 'signature'
        ? { type: 'thinking', thinking: '', signature: 'opaque-copilot-only' } : { type: 'redacted_thinking', data: 'opaque-copilot-only' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
    else if (api === 'openai-completions') frames = [
      { choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-copilot-only' }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    else {
      const item = { type: 'reasoning', id: 'rs_private', summary: [], encrypted_content: 'opaque-copilot-only' };
      frames = [{ type: 'response.created', response: { id: 'resp_private', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_private', status: 'completed', output: [item] } }];
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(frames));
    const completed = vi.fn();
    await expect(provider.streamChat([], () => {}, completed)).rejects.toThrow();
    expect(completed).not.toHaveBeenCalled();
    await expect(provider.chat([])).rejects.toThrow();
  });

  it.each(models)('posts whole independently captured bodies and awaits both facades for $id', async model => {
    const provider = candidate(model.id);
    const transport = vi.spyOn(globalThis, 'fetch');
    let calls = 0;
    for (const row of fixture.rows.filter(row => row.model === model.id)) for (const stream of [false, true]) {
      const messages = history(row.case, model.id), options: GitHubCopilotChatOptions = { systemPrompt: 'Follow instructions', tools,
        ...(row.case === 'default' ? {} : { maxTokens: row.case === 'thinking' ? 4096 : 64, cacheRetention: 'none', toolChoice: 'auto' }),
        ...(row.case === 'thinking' ? { thinking: 'high', ...(model.api === 'anthropic-messages' ? { thinkingBudgets: { high: 1024 } } : {}) } : {}) };
      const before = structuredClone({ messages, options });
      transport.mockImplementationOnce(async (url, init) => {
        calls++;
        expect(String(url)).toBe('https://api.individual.githubcopilot.com' + row.expectedPath);
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual(row.expectedBody);
        const headers = new Headers(init?.headers);
        for (const [key, value] of Object.entries(row.expectedHeaders)) expect(headers.get(key)).toBe(value);
        expect(headers.get('x-api-key')).toBeNull();
        return response(row.responseEvents);
      });
      let result: providers.ChatResponse | undefined;
      if (!stream) result = await provider.chat(messages, options);
      else await provider.streamChat(messages, () => {}, async value => { await Promise.resolve(); result = value; }, undefined, options);
      expect(result).toMatchObject({ content: 'ok', provider: 'github-copilot', api: model.api, model: model.id,
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } });
      expect({ messages, options }).toEqual(before);
    }
    expect(calls).toBe(12);
  });

  it('resolves the current credential for each turn and refuses withdrawn model access before transport', async () => {
    const access = credential(); let current: ProviderOAuthCredential | undefined = access;
    const source = vi.fn(async () => current), provider = candidate(models[0].id, source);
    const transport = vi.spyOn(globalThis, 'fetch');
    const row = fixture.rows.find(row => row.model === models[0].id && row.case === 'user')!;
    transport.mockResolvedValueOnce(response(row.responseEvents));
    await provider.chat(history('user', models[0].id));
    current = { ...access, subscription: { provider: 'github-copilot', availableModelIds: [] } };
    await expect(provider.chat(history('user', models[0].id))).rejects.toThrow('GitHub Copilot');
    current = undefined;
    await expect(provider.chat(history('user', models[0].id))).rejects.toThrow('GitHub Copilot');
    expect(source).toHaveBeenCalledTimes(3); expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['anthropic-messages', 'openai-completions', 'openai-responses'])('does not expose arbitrary response-frame fields as %s diagnostics', async api => {
    const model = models.find(model => model.api === api)!;
    const provider = candidate(model.id), row = fixture.rows.find(row => row.model === model.id)!;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(row.responseEvents.map(event => ({ ...(event as object), private_carrier: 'opaque-private-value' }))));
    const events: unknown[] = [];
    await provider.streamChat(history('user', model.id), (text, event) => { events.push({ text, event }); });
    const expected: Array<{ text: string; event: { type: string; data?: string } }> = [{ text: 'ok', event: { type: 'text_delta', data: 'ok' } }];
    if (api === 'anthropic-messages') expected.unshift({ text: '', event: { type: 'message_start' } });
    expect(events).toEqual(expected);
  });

  it('refuses pre-aborted calls and stops publication when a chunk consumer cancels', async () => {
    const source = vi.fn(async () => credential()), provider = candidate(models[0].id, source);
    const transport = vi.spyOn(globalThis, 'fetch');
    await expect(provider.chat([], { signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(source).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    const row = fixture.rows.find(row => row.model === models[0].id)!;
    transport.mockResolvedValueOnce(response(row.responseEvents));
    const controller = new AbortController(), complete = vi.fn();
    await expect(provider.streamChat(history('user', models[0].id), () => { controller.abort(); }, complete, undefined, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(complete).not.toHaveBeenCalled();
  });

  it('awaits completion rejection and refuses incomplete streams without success', async () => {
    const provider = candidate(models[0].id), row = fixture.rows.find(row => row.model === models[0].id)!;
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(row.responseEvents));
    await expect(provider.streamChat(history('user', models[0].id), () => {}, async () => { await Promise.resolve(); throw new Error('consumer failure'); }))
      .rejects.toThrow();
    transport.mockResolvedValueOnce(response(row.responseEvents.slice(0, 1)));
    const completed = vi.fn();
    await expect(provider.streamChat(history('user', models[0].id), () => {}, completed)).rejects.toThrow();
    expect(completed).not.toHaveBeenCalled();
  });
});
