import { afterEach, expect, it, vi } from 'vitest';
import { AzureCompletionsProvider, AzureProvider, type AzureCompletionsChatOptions, type ChatResponse, type Message } from '../../dist/index.js';
const model = 'deepseek-v4-pro', config = { type: 'azure-c-tools', apiKey: 'synthetic-azure-tool-key', model, baseUrl: 'https://azure.synthetic/openai/v1', azureDeploymentMap: { [model]: 'operator-deployment' } };
const messages: Message[] = [{ id: 'u', timestamp: new Date(0), role: 'user', content: 'synthetic tool policy' }];
const tool = { name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: { value: { type: 'string', minLength: 2 } } } };
const answer = (stream = false) => stream ? new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'tool-policy-ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'tool-policy-ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('uses exact native Azure C strict schema and nested named choice before deployment rewrite through direct/mixed JSON/SSE facades', async () => {
  const bodies: Array<Record<string, unknown>> = [], fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(config.baseUrl + '/chat/completions'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + config.apiKey);
    const body = JSON.parse(String(init?.body)); bodies.push(body); return answer(body.stream === true);
  }); vi.stubGlobal('fetch', fetch);
  const options: AzureCompletionsChatOptions = { tools: [{ ...structuredClone(tool), constrainedSampling: { type: 'json_schema', strict: 'require' } }], toolChoice: { type: 'function', function: { name: 'lookup' } } }, before = structuredClone(options);
  for (const provider of [new AzureCompletionsProvider(config), new AzureProvider({ ...config, model: 'gpt-4o' })]) {
    expect(await provider.chat(messages, { ...options, model })).toMatchObject({ model, api: 'openai-completions', usage: { totalTokens: 10 } });
    let complete: ChatResponse | undefined;
    await provider.streamChat(messages, () => {}, value => { complete = value; }, undefined, { ...options, model });
    expect(complete).toMatchObject({ model, api: 'openai-completions', content: 'tool-policy-ready', usage: { totalTokens: 10 } });
  }
  expect(options).toEqual(before); expect(fetch).toHaveBeenCalledTimes(4);
  for (const body of bodies) expect(body).toMatchObject({ model: 'operator-deployment', tools: [{ type: 'function', function: {
    name: 'lookup', description: 'Synthetic lookup', strict: true, parameters: { type: 'object', properties: { value: { anyOf: [{ type: 'string', minLength: 2 }, { type: 'null' }] } }, required: ['value'], additionalProperties: false },
  } }], tool_choice: { type: 'function', function: { name: 'lookup' } } });
});
it('preserves default/false and prefer fallback, maps C choices without dropping none tools and refuses required unsupported schemas before transport', async () => {
  const bodies: Array<Record<string, unknown>> = [], fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body); return answer();
  }); vi.stubGlobal('fetch', fetch); const provider = new AzureCompletionsProvider(config);
  for (const constrainedSampling of [undefined, false] as const) await provider.chat(messages, { tools: [{ ...tool, ...(constrainedSampling === undefined ? {} : { constrainedSampling }) }] });
  const bad = { ...tool, parameters: { type: 'object', $ref: '#/must-not-resolve' } };
  await provider.chat(messages, { tools: [{ ...bad, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] });
  for (const body of bodies) expect((body.tools as Array<{ function: { strict: boolean } }>)[0].function.strict).toBe(false);
  expect((bodies[2].tools as Array<{ function: { parameters: unknown } }>)[0].function.parameters).toEqual(bad.parameters);
  for (const toolChoice of ['auto', 'none', 'required'] as const) await provider.chat(messages, { tools: [tool], toolChoice });
  expect(bodies.slice(3).map(body => body.tool_choice)).toEqual(['auto', 'none', 'required']); expect(bodies[4].tools).toBeDefined();
  await provider.chat(messages, { toolChoice: 'none' }); expect(bodies[6].tool_choice).toBe('none'); expect(bodies[6].tools).toBeUndefined();
  await expect(provider.chat(messages, { tools: [{ ...bad, constrainedSampling: { type: 'json_schema', strict: 'require' } }] })).rejects.toThrow('Azure completion tool requires unsupported constrained sampling.');
  expect(fetch).toHaveBeenCalledTimes(7);
});
it('keeps malformed controls pretransport/single-error and does not grant strict tools to derived, unknown or misleading public metadata', async () => {
  const bodies: Array<Record<string, unknown>> = [], fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body); return answer();
  }); vi.stubGlobal('fetch', fetch); const provider = new AzureCompletionsProvider(config);
  for (const options of [{ toolChoice: 'any' }, { toolChoice: { type: 'function', name: 'lookup' } }, { toolChoice: { type: 'function', function: { name: 'undeclared' } } },
    { tools: [{ ...tool, constrainedSampling: { type: 'grammar', strict: 'require' } }] },
  ]) await expect(provider.chat(messages, { tools: [tool], ...options } as unknown as AzureCompletionsChatOptions)).rejects.toThrow('Invalid Azure completion tool policy.');
  const chunks = vi.fn(), complete = vi.fn(), error = vi.fn();
  await provider.streamChat(messages, chunks, complete, error, { tools: [{ ...tool, parameters: { type: 'object', $ref: '#/rejected' }, constrainedSampling: { type: 'json_schema', strict: 'require' } }] });
  expect(error).toHaveBeenCalledTimes(1); expect(error.mock.calls[0][0].message).toBe('Azure completion tool requires unsupported constrained sampling.');
  expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  class DerivedC extends AzureCompletionsProvider { override getPublishedModels() { return [{ id: model, name: 'Not authority', capabilities: { reasoning: true, imageInput: false, toolCalls: true }, compat: { supportsStrictMode: true } }]; } }
  class DerivedMixed extends AzureProvider {}
  for (const candidate of [new DerivedC(config), new DerivedMixed(config), new AzureCompletionsProvider({ ...config, model: 'unknown-profile' })])
    await candidate.chat(messages, { tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] });
  for (const body of bodies) expect((body.tools as Array<{ function: { strict?: boolean } }>)[0].function.strict).not.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
});
