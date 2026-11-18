import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicProvider, type AnthropicChatOptions, type ChatResponse, type Message } from '../../dist/index.js';
const eligible = ['claude-fable-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5'];
const base = { type: 'native-system-label', apiKey: 'synthetic-system-key', baseUrl: 'https://anthropic.synthetic' };
const msg = (id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ id, role, content, timestamp: new Date(0), ...extra });
const transcript = (model: string): Message[] => [msg('s0', 'system', 'initial prompt'), msg('u0', 'user', 'first user'),
  msg('a0', 'assistant', 'old answer', { provider: base.type, api: 'anthropic-messages', model, metadata: { providerThinkingLevel: 'low' }, toolCalls: [{ id: 'tool_1', name: 'lookup', input: {} }] }),
  msg('s1', 'system', 'instruction after tool use'), msg('t0', 'tool', 'result', { toolCallId: 'tool_1' }), msg('s2', 'system', 'instruction after result'), msg('u1', 'user', 'second user'),
  msg('a1', 'assistant', 'second answer', { provider: base.type, api: 'anthropic-messages', model, metadata: { providerThinkingLevel: 'medium' } }), msg('s3', 'system', 'last instruction'), msg('u2', 'user', 'final user')];
function response(stream: boolean) { const data = { type: 'message', role: 'assistant', model: 'arbitrary-response-alias', content: [{ type: 'text', text: 'system-ready' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 2 } };
  return stream ? new Response([{ type: 'message_start', message: data }, { type: 'content_block_start', index: 0, content_block: data.content[0] }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: data.usage }, { type: 'message_stop' }].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(data); }
afterEach(() => { vi.unstubAllGlobals(); });
it('binds the exact seven system-update declarations without promoting other native models', () => {
  const rows = Object.values(JSON.parse(readFileSync(new URL('../../../../tests/fixtures/anthropic-reference.json', import.meta.url), 'utf8'))['anthropic-messages']) as Array<{ id: string; compat?: { supportsMidConvoSystemMessages?: boolean } }>;
  expect(rows.filter(row => row.compat?.supportsMidConvoSystemMessages).map(row => row.id)).toEqual(eligible);
});
it.each(['claude-fable-5', 'claude-opus-5'])('keeps late system updates at native assistant boundaries with tool adjacency/managed effort/cache intact (%s)', async model => {
  const bodies: Array<Record<string, any>> = []; vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); bodies.push(body); return response(body.stream); }));
  const provider = new AnthropicProvider({ ...base, model }), messages = transcript(model), before = structuredClone(messages), options: AnthropicChatOptions = { model, systemPrompt: 'base options prompt', thinking: 'high', tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} } }] };
  await provider.chat(messages, options); let completed: ChatResponse | undefined; await provider.streamChat(messages, () => {}, value => { completed = value; }, error => { throw error; }, options); expect(completed?.content).toBe('system-ready'); expect(messages).toEqual(before);
  for (const body of bodies) {
    expect(body.system).toBe('base options prompt\n\ninitial prompt');
    const rows = body.messages.filter((row: Record<string, any>) => !row.output_config);
    expect(rows.map((row: Record<string, any>) => [row.role, row.content])).toEqual([
      ['user', 'first user'], ['assistant', [{ type: 'text', text: 'old answer' }, { type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} }]],
      ['user', [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'result' }]], ['user', 'second user'],
      ['system', [{ type: 'text', text: 'instruction after tool use' }]], ['system', [{ type: 'text', text: 'instruction after result' }]],
      ['assistant', 'second answer'], ['user', 'final user'], ['system', [{ type: 'text', text: 'last instruction', cache_control: { type: 'ephemeral' } }]],
    ]);
    if (model === 'claude-opus-5') {
      expect(body.messages.filter((row: Record<string, any>) => row.output_config).map((row: Record<string, any>) => row.output_config.effort)).toEqual(['low', 'medium', 'high']);
      for (const [index, row] of body.messages.entries()) if (row.role === 'assistant') expect(body.messages[index - 1].output_config.effort).toBe(row.content === 'second answer' ? 'medium' : 'low');
    } else expect(body.messages.some((row: Record<string, any>) => row.output_config)).toBe(false);
  }
});
it('does not cache an assistant-ending native prefix or an effort-only system control, retaining compatible cache policy', async () => {
  const bodies: Array<Record<string, any>> = []; vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); bodies.push(body); return response(false); }));
  const ending = [msg('u', 'user', 'prompt'), msg('a', 'assistant', 'prefix')];
  for (const model of ['claude-sonnet-4-6', 'claude-opus-5']) await new AnthropicProvider({ ...base, model }).chat(ending, { thinking: 'high', cacheRetention: 'long' });
  for (const body of bodies) expect(JSON.stringify(body.messages)).not.toContain('cache_control');
  class Derived extends AnthropicProvider {} await new Derived({ ...base, model: 'claude-sonnet-4-6' }).chat(ending, { cacheRetention: 'long' }); expect(bodies[2].messages.at(-1).content).toEqual([{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
});
it('retains leading-only/unsupported/derived behavior and does not infer native system authority from mutable fields', async () => {
  const bodies: Array<Record<string, any>> = []; vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); bodies.push(body); return response(false); }));
  await new AnthropicProvider({ ...base, model: 'claude-opus-5' }).chat([msg('s', 'system', 'only initial'), msg('u', 'user', 'user')], { thinking: 'high' }); expect(bodies[0].system).toBe('only initial'); expect(bodies[0].messages.filter((row: Record<string, any>) => !row.output_config).map((row: Record<string, any>) => row.role)).toEqual(['user']);
  await new AnthropicProvider({ ...base, model: 'claude-sonnet-4-6' }).chat(transcript('claude-sonnet-4-6')); expect(bodies[1].system).toContain('last instruction'); expect(bodies[1].messages.some((row: Record<string, any>) => row.role === 'system')).toBe(false);
  class Derived extends AnthropicProvider {} const derived = new Derived({ ...base, model: 'claude-opus-5' }); Reflect.set(derived, 'ownsNativeProfiles', true); await derived.chat(transcript('claude-opus-5'), { systemPrompt: 'legacy' }); expect(bodies[2].system).toBe('legacy'); expect(bodies[2].messages.some((row: Record<string, any>) => row.role === 'system')).toBe(false);
});
