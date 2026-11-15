import type { Message } from '../types/index.js';
import type { AzureCompletionsChatOptions, ChatOptions, ChatResponse } from './index.js';
import { makeStrictToolSchema, UnsupportedStrictToolSchema } from './strict-tool-schema.js';
import { clampPublishedThinkingLevel, PUBLISHED_THINKING_LEVELS, type PublishedModelMetadata, type PublishedThinkingLevel } from './model-metadata.js';
import { nativeResponsesUsage, prepareNativeResponses, type NativeResponsesProfile } from './openai-responses.js';

// Independent approved Azure data, Pi 1.2.0 / 06a4669 / 46c4e25b84463c6475e706c581196d2735c35feb9612d2efca0ab932c917d727.
// Sparse maps and C tariffs belong to Azure, not same-ID OpenAI/DeepSeek declarations.
type Api = 'azure-openai-responses' | 'openai-completions';
interface Rates { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
interface Cost extends Rates { readonly tiers?: readonly (Rates & { readonly inputTokensAbove: number })[] }
type Row = readonly [string, string, Api, number, number, boolean, boolean, Cost, Partial<Record<PublishedThinkingLevel, string | null>>];
const rows: readonly Row[] = [
  ["gpt-4","GPT-4","azure-openai-responses",8192,8192,false,false,{"input":30,"output":60,"cacheRead":0,"cacheWrite":0},{}],
  ["gpt-4-turbo","GPT-4 Turbo","azure-openai-responses",128000,4096,false,true,{"input":10,"output":30,"cacheRead":0,"cacheWrite":0},{}],
  ["gpt-4.1","GPT-4.1","azure-openai-responses",1047576,32768,false,true,{"input":2,"output":8,"cacheRead":0.5,"cacheWrite":0},{}],
  ["gpt-4.1-mini","GPT-4.1 mini","azure-openai-responses",1047576,32768,false,true,{"input":0.4,"output":1.6,"cacheRead":0.1,"cacheWrite":0},{}],
  ["gpt-4.1-nano","GPT-4.1 nano","azure-openai-responses",1047576,32768,false,true,{"input":0.1,"output":0.4,"cacheRead":0.025,"cacheWrite":0},{}],
  ["gpt-4o","GPT-4o","azure-openai-responses",128000,16384,false,true,{"input":2.5,"output":10,"cacheRead":1.25,"cacheWrite":0},{}],
  ["gpt-4o-2024-05-13","GPT-4o (2024-05-13)","azure-openai-responses",128000,4096,false,true,{"input":5,"output":15,"cacheRead":0,"cacheWrite":0},{}],
  ["gpt-4o-2024-08-06","GPT-4o (2024-08-06)","azure-openai-responses",128000,16384,false,true,{"input":2.5,"output":10,"cacheRead":1.25,"cacheWrite":0},{}],
  ["gpt-4o-2024-11-20","GPT-4o (2024-11-20)","azure-openai-responses",128000,16384,false,true,{"input":2.5,"output":10,"cacheRead":1.25,"cacheWrite":0},{}],
  ["gpt-4o-mini","GPT-4o mini","azure-openai-responses",128000,16384,false,true,{"input":0.15,"output":0.6,"cacheRead":0.075,"cacheWrite":0},{}],
  ["gpt-5","GPT-5","azure-openai-responses",400000,128000,true,true,{"input":1.25,"output":10,"cacheRead":0.125,"cacheWrite":0},{"off":null}],
  ["gpt-5-chat-latest","GPT-5 Chat Latest","azure-openai-responses",128000,16384,false,true,{"input":1.25,"output":10,"cacheRead":0.125,"cacheWrite":0},{"off":null}],
  ["gpt-5-mini","GPT-5 Mini","azure-openai-responses",400000,128000,true,true,{"input":0.25,"output":2,"cacheRead":0.025,"cacheWrite":0},{"off":null}],
  ["gpt-5-nano","GPT-5 Nano","azure-openai-responses",400000,128000,true,true,{"input":0.05,"output":0.4,"cacheRead":0.005,"cacheWrite":0},{"off":null}],
  ["gpt-5-pro","GPT-5 Pro","azure-openai-responses",400000,128000,true,true,{"input":15,"output":120,"cacheRead":0,"cacheWrite":0},{"off":null}],
  ["gpt-5.1","GPT-5.1","azure-openai-responses",400000,128000,true,true,{"input":1.25,"output":10,"cacheRead":0.125,"cacheWrite":0},{"off":null}],
  ["gpt-5.2","GPT-5.2","azure-openai-responses",400000,128000,true,true,{"input":1.75,"output":14,"cacheRead":0.175,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.2-chat-latest","GPT-5.2 Chat","azure-openai-responses",128000,16384,true,true,{"input":1.75,"output":14,"cacheRead":0.175,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.2-pro","GPT-5.2 Pro","azure-openai-responses",400000,128000,true,true,{"input":21,"output":168,"cacheRead":0,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.3-chat-latest","GPT-5.3 Chat (latest)","azure-openai-responses",128000,16384,false,true,{"input":1.75,"output":14,"cacheRead":0.175,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.3-codex","GPT-5.3 Codex","azure-openai-responses",400000,128000,true,true,{"input":1.75,"output":14,"cacheRead":0.175,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.3-codex-spark","GPT-5.3 Codex Spark","azure-openai-responses",128000,32000,true,true,{"input":1.75,"output":14,"cacheRead":0.175,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.4","GPT-5.4","azure-openai-responses",1050000,128000,true,true,{"input":2.5,"output":15,"cacheRead":0.25,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.4-mini","GPT-5.4 mini","azure-openai-responses",400000,128000,true,true,{"input":0.75,"output":4.5,"cacheRead":0.075,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.4-nano","GPT-5.4 nano","azure-openai-responses",400000,128000,true,true,{"input":0.2,"output":1.25,"cacheRead":0.02,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.4-pro","GPT-5.4 Pro","azure-openai-responses",1050000,128000,true,true,{"input":30,"output":180,"cacheRead":0,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.5","GPT-5.5","azure-openai-responses",1050000,128000,true,true,{"input":5,"output":30,"cacheRead":0.5,"cacheWrite":0},{"off":null,"xhigh":"xhigh"}],
  ["gpt-5.5-pro","GPT-5.5 Pro","azure-openai-responses",1050000,128000,true,true,{"input":30,"output":180,"cacheRead":0,"cacheWrite":0},{"off":null,"xhigh":"xhigh","minimal":null,"low":null}],
  ["gpt-5.6-luna","GPT-5.6 Luna","azure-openai-responses",1050000,128000,true,true,{"input":0.2,"output":1.2,"cacheRead":0.02,"cacheWrite":0.25},{"off":null,"xhigh":"xhigh","max":"max"}],
  ["gpt-5.6-sol","GPT-5.6 Sol","azure-openai-responses",1050000,128000,true,true,{"input":4,"output":20,"cacheRead":0.4,"cacheWrite":5},{"off":null,"xhigh":"xhigh","max":"max"}],
  ["gpt-5.6-terra","GPT-5.6 Terra","azure-openai-responses",1050000,128000,true,true,{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":2.5},{"off":null,"xhigh":"xhigh","max":"max"}],
  ["gpt-6-astra","GPT-6 Astra","azure-openai-responses",272000,128000,true,true,{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5},{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-6-luna","GPT-6 Luna","azure-openai-responses",272000,128000,true,true,{"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-6-sol","GPT-6 Sol","azure-openai-responses",272000,128000,true,true,{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5},{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-6.1-sol","GPT-6.1 Sol","azure-openai-responses",272000,128000,true,true,{"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2.5},{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}],
  ["gpt-daybreak-blue-latest","Daybreak Blue","azure-openai-responses",1050000,128000,true,true,{"input":4,"output":20,"cacheRead":0.4,"cacheWrite":5},{}],
  ["gpt-daybreak-red-latest","Daybreak Red","azure-openai-responses",400000,128000,true,true,{"input":12.5,"output":75,"cacheRead":1.25,"cacheWrite":15.625},{}],
  ["gpt-realtime-2.1","GPT-Realtime-2.1","azure-openai-responses",128000,32000,true,true,{"input":4,"output":24,"cacheRead":0.4,"cacheWrite":0},{}],
  ["o1","o1","azure-openai-responses",200000,100000,true,true,{"input":15,"output":60,"cacheRead":7.5,"cacheWrite":0},{}],
  ["o1-pro","o1-pro","azure-openai-responses",200000,100000,true,true,{"input":150,"output":600,"cacheRead":0,"cacheWrite":0},{}],
  ["o3","o3","azure-openai-responses",200000,100000,true,true,{"input":2,"output":8,"cacheRead":0.5,"cacheWrite":0},{}],
  ["o3-mini","o3-mini","azure-openai-responses",200000,100000,true,false,{"input":1.1,"output":4.4,"cacheRead":0.55,"cacheWrite":0},{}],
  ["o3-pro","o3-pro","azure-openai-responses",200000,100000,true,true,{"input":20,"output":80,"cacheRead":0,"cacheWrite":0},{}],
  ["o4-mini","o4-mini","azure-openai-responses",200000,100000,true,true,{"input":1.1,"output":4.4,"cacheRead":0.275,"cacheWrite":0},{}],
  ["deepseek-v4-pro","DeepSeek V4 Pro","openai-completions",1000000,384000,true,false,{"input":1.925,"output":3.828,"cacheRead":0.165,"cacheWrite":0},{"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null}],
];
// Independent pinned Azure grammar declarations; do not infer them from same-ID OpenAI policy.
const grammarModels = new Set([
  'gpt-5', 'gpt-5-chat-latest', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro', 'gpt-5.1', 'gpt-5.2', 'gpt-5.2-chat-latest', 'gpt-5.2-pro',
  'gpt-5.3-chat-latest', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4-pro', 'gpt-5.5',
  'gpt-5.5-pro', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol',
]);
const pricing = (cost: Rates) => ({ inputPerMillion: cost.input, outputPerMillion: cost.output,
  cacheReadPerMillion: cost.cacheRead, cacheWritePerMillion: cost.cacheWrite });
const profiles = new Map(rows.map(([id, name, api, contextWindow, maxOutputTokens, reasoning, image, cost, thinkingLevelMap]) => {
  const profile: NativeResponsesProfile = { reasoning, declaredInput: image ? ['text', 'image'] : ['text'], maxOutputTokens,
    thinkingLevelMap, pricing: pricing(cost), ...(cost.tiers ? { pricingTiers: cost.tiers.map(tier => ({ ...pricing(tier), inputTokensAbove: tier.inputTokensAbove })) } : {}) };
  return [id, { ...profile, id, name, api, contextWindow }] as const;
}));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function azureProfileApi(model: string): Api | undefined { return profiles.get(model)?.api; }
export function azurePublishedProfiles(api?: Api): PublishedModelMetadata[] {
  return [...profiles.values()].filter(profile => api === undefined || profile.api === api).map(profile => ({
    id: profile.id, name: profile.name, api: profile.api, contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens,
    capabilities: { reasoning: profile.reasoning, imageInput: profile.declaredInput.includes('image'), toolCalls: true },
    thinkingLevelMap: profile.reasoning ? { ...profile.thinkingLevelMap } : null, pricing: { ...profile.pricing },
  }));
}
export function prepareAzureResponses(body: Record<string, unknown>, options?: ChatOptions): void {
  const profile = profiles.get(String(body.model)); if (profile?.api !== 'azure-openai-responses') return;
  prepareNativeResponses(body, options, profile, 'Azure', grammarModels.has(profile.id), false);
  // Azure's SDK uses affinity independently of retention. This does not observe a cache hit or make a warming request.
  if (options?.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
}
/** Called only after exact original Azure C admission; not shared C/model-name authority. */
function prepareAzureCompletionTools(body: Record<string, unknown>, options?: AzureCompletionsChatOptions): void {
  const choice = options?.toolChoice, tools = options?.tools;
  const invalid = (): never => { throw new Error('Invalid Azure completion tool policy.'); };
  const unsupported = (): never => { throw new Error('Azure completion tool requires unsupported constrained sampling.'); };
  const named = choice && typeof choice === 'object' && choice.type === 'function' && typeof choice.function?.name === 'string'
    && choice.function.name.length > 0 && tools?.some(tool => tool.name === choice.function.name);
  if (choice !== undefined && choice !== 'auto' && choice !== 'none' && choice !== 'required' && !named) invalid();
  if (tools?.length) body.tools = tools.map(tool => {
    let parameters = tool.parameters, strict = false; const sampling = tool.constrainedSampling;
    if (sampling !== undefined && sampling !== false) {
      if (!sampling || sampling.type !== 'json_schema' || !['prefer', 'require'].includes(sampling.strict)) return invalid();
      try { parameters = makeStrictToolSchema(parameters); strict = true; }
      catch (error) { if (!(error instanceof UnsupportedStrictToolSchema)) return invalid(); if (sampling.strict === 'require') unsupported(); }
    }
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters, strict } };
  });
  if (choice !== undefined) body.tool_choice = typeof choice === 'object' ? { type: 'function', function: { name: choice.function.name } } : choice;
}
export function prepareAzureCompletion(body: Record<string, unknown>, options: ChatOptions | undefined, messages: Message[], provider: string, nativeReplay = false): void {
  const profile = profiles.get(String(body.model)); if (profile?.api !== 'openai-completions') return;
  const requested = options?.thinking;
  if (requested !== undefined && !PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Azure thinking level.');
  const selected = clampPublishedThinkingLevel(requested ?? 'off', PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined)));
  delete body.reasoning_effort;
  if (selected !== 'off') body.reasoning_effort = profile.thinkingLevelMap?.[selected] ?? selected;
  delete body.max_tokens;
  if (options?.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid Azure output limit.');
    body.max_completion_tokens = options.maxTokens;
  }
  body.store = false;
  if (body.stream) body.stream_options = { include_usage: true };
  if (nativeReplay) prepareAzureCompletionTools(body, options);
  else if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  const history = messages.filter(message => message.role === 'assistant'); let assistant = 0;
  if (Array.isArray(body.messages)) for (const message of body.messages) {
    if (!record(message)) continue;
    if (message.role === 'developer') message.role = 'system';
    if (message.role === 'assistant' && !nativeReplay) {
      const previous = history[assistant++], metadata = previous?.metadata;
      message.reasoning_content = metadata?.provider === provider && metadata.model === profile.id && metadata.api === profile.api
        ? previous.blocks?.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('\n') ?? '' : '';
    }
    if (Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Azure completion model does not support images.');
  }
}
export function azureProfileUsage(value: unknown, model: string, nativeReplay = false): ChatResponse['usage'] {
  const profile = profiles.get(model); if (!profile) return undefined;
  if (profile.api === 'azure-openai-responses') return nativeResponsesUsage(value, profile);
  if (!record(value) || (value.prompt_tokens_details !== undefined && !record(value.prompt_tokens_details))) return undefined;
  return nativeResponsesUsage({ input_tokens: value.prompt_tokens, output_tokens: value.completion_tokens, total_tokens: value.total_tokens,
    input_tokens_details: { cached_tokens: record(value.prompt_tokens_details) ? value.prompt_tokens_details.cached_tokens : undefined,
      cache_write_tokens: nativeReplay && record(value.prompt_tokens_details) ? value.prompt_tokens_details.cache_write_tokens ?? 0 : 0 } }, profile);
}

export function azureCompletionReasoning(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const fields = ['reasoning_content', 'reasoning', 'reasoning_text'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string')
    || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Azure chat response.');
  return fields.map(field => value[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
}
const validCompletionFinish = (value: unknown): boolean => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateAzureCompletion(value: unknown): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)
    || value.choices[0].message.refusal || !validCompletionFinish(value.choices[0].finish_reason)) throw new Error('Invalid Azure chat response.');
  azureCompletionReasoning(value.choices[0].message);
}
export function azureCompletionStreamValidator(): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Azure chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Azure chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Azure chat response.');
    azureCompletionReasoning(choice.delta); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Azure chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validCompletionFinish(choice.finish_reason)) throw new Error('Invalid Azure chat response.'); finished = true; }
  };
}
