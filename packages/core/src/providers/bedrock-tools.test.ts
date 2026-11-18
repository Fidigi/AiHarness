import { afterEach, expect, it, vi } from 'vitest';
import { BedrockProvider, type BedrockChatOptions, type ChatResponse, type Message } from '../../dist/index.js';
import { bedrockFrame } from '../../../../tests/fixtures/bedrock-event-stream.js';
const model = 'anthropic.claude-opus-4-6-v1', unsupportedModel = 'amazon.nova-lite-v1:0';
const messages: Message[] = [{ id: 'u', timestamp: new Date(0), role: 'user', content: 'tool policy probe' }];
const tool = { name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', title: 'Root annotation', properties: {
  required: { type: 'string', minLength: 2 }, optional: { type: 'integer', minimum: 0 }, nested: { type: 'object', properties: { value: { type: 'string' } } },
}, required: ['required'] } };
const json = () => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'policy-ready' }] } }, stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
const binary = () => new Response(Buffer.concat([
  bedrockFrame('messageStart', { role: 'assistant' }), bedrockFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'policy-ready' } }),
  bedrockFrame('contentBlockStop', { contentBlockIndex: 0 }), bedrockFrame('messageStop', { stopReason: 'end_turn' }),
  bedrockFrame('metadata', { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } }),
]), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
const create = (selected = model) => new BedrockProvider({ type: 'bedrock', model: selected, apiKey: 'synthetic-tool-key' });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('clones strict schemas only for native exact supported profiles, preserving numeric constraints/annotations, JSON/binary usage and caller objects', async () => {
  const bodies: Array<Record<string, unknown>> = [], fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body))); return String(url).endsWith('/converse-stream') ? binary() : json();
  }); vi.stubGlobal('fetch', fetch);
  for (const selected of [model, 'deepseek.v3-v1:0']) {
    const provider = create(selected), options: BedrockChatOptions = { tools: [{ ...structuredClone(tool), constrainedSampling: { type: 'json_schema', strict: 'require' } }], toolChoice: 'any', thinking: 'off' }, before = structuredClone(options);
    expect((await provider.chat(messages, options)).usage?.totalTokens).toBe(10);
    let streamed: ChatResponse | undefined;
    await provider.streamChat(messages, () => {}, value => { streamed = value; }, undefined, options);
    expect(streamed).toMatchObject({ content: 'policy-ready', usage: { totalTokens: 10 } }); expect(options).toEqual(before);
  }
  for (const body of bodies) expect(body.toolConfig).toEqual({ tools: [{ toolSpec: { name: 'lookup', description: 'Synthetic lookup', strict: true, inputSchema: { json: {
    type: 'object', title: 'Root annotation', properties: {
      required: { type: 'string', minLength: 2 }, optional: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
      nested: { anyOf: [{ type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['value'], additionalProperties: false }, { type: 'null' }] },
    }, required: ['required', 'optional', 'nested'], additionalProperties: false,
  } } } }], toolChoice: { any: {} } });
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('leaves omitted/false tools non-strict and falls back for prefer unsupported models or schemas while require rejects before dispatch', async () => {
  const bodies: Array<Record<string, unknown>> = [], fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body))); return json();
  }); vi.stubGlobal('fetch', fetch);
  const provider = create();
  for (const constrainedSampling of [undefined, false] as const) await provider.chat(messages, { tools: [{ ...structuredClone(tool), ...(constrainedSampling === undefined ? {} : { constrainedSampling }) }] });
  await create(unsupportedModel).chat(messages, { tools: [{ ...structuredClone(tool), constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] });
  const bad = { ...structuredClone(tool), parameters: { type: 'object', properties: { value: { $ref: '#/must-not-resolve' } } } };
  await provider.chat(messages, { tools: [{ ...bad, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] });
  for (const body of bodies) expect((body.toolConfig as { tools: Array<{ toolSpec: Record<string, unknown> }> }).tools[0].toolSpec.strict).toBeUndefined();
  expect((bodies[0].toolConfig as { tools: unknown[] }).tools).toEqual([{ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } }]);
  expect((bodies[3].toolConfig as { tools: Array<{ toolSpec: { inputSchema: { json: unknown } } }> }).tools[0].toolSpec.inputSchema.json).toEqual(bad.parameters);
  await expect(create(unsupportedModel).chat(messages, { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'require' } }] })).rejects.toThrow('Bedrock tool requires unsupported constrained sampling.');
  await expect(provider.chat(messages, { tools: [{ ...bad, constrainedSampling: { type: 'json_schema', strict: 'require' } }] })).rejects.toThrow('Bedrock tool requires unsupported constrained sampling.');
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('maps auto/any/named choices and none suppresses even required unsupported schemas without mutating messages or validating unused tools', async () => {
  const bodies: Array<Record<string, unknown>> = [], fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body))); return json();
  }); vi.stubGlobal('fetch', fetch);
  const provider = create();
  for (const toolChoice of ['auto', 'any', { type: 'tool', name: 'lookup' }] as const) await provider.chat(messages, { tools: [structuredClone(tool)], toolChoice });
  expect(bodies.map(body => (body.toolConfig as { toolChoice: unknown }).toolChoice)).toEqual([{ auto: {} }, { any: {} }, { tool: { name: 'lookup' } }]);
  const before = structuredClone(messages);
  await create(unsupportedModel).chat(messages, { tools: [{ ...tool, parameters: { type: 'object', $ref: '#/unused' }, constrainedSampling: { type: 'json_schema', strict: 'require' } }], toolChoice: 'none' });
  expect(bodies[3].toolConfig).toBeUndefined(); expect(messages).toEqual(before);
  await provider.chat(messages, { toolChoice: { type: 'tool', name: 'unused-without-tools' } });
  expect(bodies[4].toolConfig).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(5);
});
it('refuses invalid scoped controls and does not grant strict privileges to unknown/derived/spoofed models', async () => {
  const bodies: Array<Record<string, unknown>> = [], fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body))); return json();
  }); vi.stubGlobal('fetch', fetch);
  const provider = create();
  for (const options of [{ toolChoice: 'required' }, { toolChoice: { type: 'tool', name: 'missing' } },
    { tools: [{ ...tool, constrainedSampling: { type: 'grammar', strict: 'require' } }] }, { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'invalid' } }] },
  ]) await expect(provider.chat(messages, { tools: [tool], ...options } as unknown as BedrockChatOptions)).rejects.toThrow('Invalid Bedrock tool policy.');
  class Liar extends BedrockProvider {
    override getPublishedModels() { return [{ id: model, name: 'Cannot grant strict', capabilities: { reasoning: true, imageInput: true, toolCalls: true }, compat: { supportsStrictMode: true } }]; }
  }
  const require: BedrockChatOptions = { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'require' } }] };
  const derived = new Liar({ type: 'bedrock', model, apiKey: 'synthetic-tool-key' }), unknown = create('future-unknown'), spoofed = create(unsupportedModel);
  Object.assign(spoofed.getPublishedModels()!.find(row => row.id === unsupportedModel)!, { compat: { supportsStrictMode: true } });
  for (const candidate of [derived, unknown, spoofed]) await expect(candidate.chat(messages, require)).rejects.toThrow('Bedrock tool requires unsupported constrained sampling.');
  expect(fetch).not.toHaveBeenCalled();
  for (const candidate of [derived, unknown]) await candidate.chat(messages, { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] });
  for (const body of bodies) expect(body.toolConfig).toEqual({ tools: [{ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } }] });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('rejects unsupported strict requests before any profile-file or STS credential I/O, with one streamed error and no completion/chunks', async () => {
  const fetch = vi.fn(), enroll = vi.fn(); vi.stubGlobal('fetch', fetch);
  const provider = new BedrockProvider({ type: 'bedrock', model: unsupportedModel, bedrockProfile: { profile: 'chosen', credentialsFile: '/must-not-read', redactor: { add: enroll } } });
  const options: BedrockChatOptions = { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'require' } }] };
  await expect(provider.chat(messages, options)).rejects.toThrow('Bedrock tool requires unsupported constrained sampling.');
  const chunks = vi.fn(), complete = vi.fn(), error = vi.fn();
  await provider.streamChat(messages, chunks, complete, error, options);
  expect(error).toHaveBeenCalledTimes(1); expect(error.mock.calls[0][0].message).toBe('Bedrock tool requires unsupported constrained sampling.');
  expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(enroll).not.toHaveBeenCalled();
});
