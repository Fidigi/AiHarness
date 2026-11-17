import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicProvider, type AnthropicChatOptions, type ChatResponse, type Message } from '../../dist/index.js';
const placeholder = { name: '__aih_deferred_placeholder__', description: 'Reserved placeholder. Never available. Never call this.', input_schema: { type: 'object', properties: {}, required: [] }, defer_loading: true };
const beta = 'inline-tools-2026-09-15', model = 'claude-fable-5', config = { type: 'native-deferred-label', apiKey: 'synthetic-deferred-key', baseUrl: 'https://anthropic.synthetic', model };
const input: Message[] = [{ id: 'u', role: 'user', timestamp: new Date(0), content: 'deferred probe' }];
function response(stream: boolean) { const data = { type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'deferred-ready' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 2 } }; return stream ? new Response([{ type: 'message_start', message: data }, { type: 'content_block_start', index: 0, content_block: data.content[0] }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: data.usage }, { type: 'message_stop' }].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(data); }
afterEach(() => { vi.unstubAllGlobals(); });
it('binds the same seven exact declarations to both native system and tool-change capability, with the pinned placeholder', () => {
  const rows = Object.values(JSON.parse(readFileSync(new URL('../../../../tests/fixtures/anthropic-reference.json', import.meta.url), 'utf8'))['anthropic-messages']) as Array<{ id: string; compat?: { supportsMidConvoSystemMessages?: boolean; supportsMidConvoToolChanges?: boolean } }>;
  const toolIds = rows.filter(row => row.compat?.supportsMidConvoSystemMessages && row.compat.supportsMidConvoToolChanges).map(row => row.id);
  expect(toolIds).toEqual(['claude-fable-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/anthropic-tool-schema-reference.json', import.meta.url), 'utf8')); expect(fixture.rows.find((row: { model: string; capturedDeferredDeclarations: unknown[] }) => row.model === model && row.capturedDeferredDeclarations.length).capturedDeferredDeclarations).toEqual([placeholder]);
});
it.each(['api-key', 'oauth'] as const)('adds exact invisible scaffold/beta only with real caller declarations, preserving choice/strictness/input (%s)', async mode => {
  const calls: Array<{ body: Record<string, any>; headers: Headers }> = []; vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); calls.push({ body, headers: new Headers(init.headers) }); return response(body.stream); }));
  const provider = new AnthropicProvider({ ...config, anthropicAuthMode: mode });
  const options: AnthropicChatOptions = { tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: { value: { type: 'string' } } }, constrainedSampling: { type: 'json_schema', strict: 'require' } }], toolChoice: 'none' }, before = structuredClone(options);
  await provider.chat(input, options); let result: ChatResponse | undefined; await provider.streamChat(input, () => {}, value => { result = value; }, error => { throw error; }, options); expect(result?.content).toBe('deferred-ready'); expect(options).toEqual(before);
  for (const { body, headers } of calls) { expect(body.tools).toEqual([{ name: 'lookup', description: 'lookup', eager_input_streaming: true, strict: true, input_schema: { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['value'], additionalProperties: false } }, placeholder]); expect(body.tool_choice).toEqual({ type: 'none' }); expect(headers.get('anthropic-beta')?.split(',')).toContain(beta); }
  await provider.chat(input, { tools: [] }); expect(calls.at(-1)!.body.tools).toBeUndefined(); expect(calls.at(-1)!.headers.get('anthropic-beta')?.split(',') ?? []).not.toContain(beta);
});
it('does not grant scaffold/beta to unsupported or forged derived instances and refuses reserved-name collisions before transport', async () => {
  const calls: Array<{ body: Record<string, any>; headers: Headers }> = []; vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { calls.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) }); return response(false); })); const options = { tools: [{ name: 'lookup', description: '', parameters: { type: 'object' } }] };
  class Derived extends AnthropicProvider {} const forged = new Derived(config); Reflect.set(forged, 'ownsNativeProfiles', true);
  for (const provider of [new AnthropicProvider({ ...config, model: 'claude-sonnet-4-6' }), forged]) await provider.chat(input, options);
  for (const call of calls) { expect(call.body.tools).toHaveLength(1); expect(call.headers.get('anthropic-beta')?.split(',') ?? []).not.toContain(beta); }
  await expect(new AnthropicProvider(config).chat(input, { tools: [{ ...options.tools[0], name: placeholder.name }] })).rejects.toThrow('Invalid Anthropic tool policy.'); expect(calls).toHaveLength(2);
});
