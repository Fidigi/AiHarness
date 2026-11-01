import type { ChatOptions, ChatResponse, GoogleChatOptions } from './index.js';
import type { Message } from '../types/index.js';
import { clampPublishedThinkingLevel, PUBLISHED_THINKING_LEVELS, type PublishedModelMetadata, type PublishedThinkingLevel } from './model-metadata.js';
import { copyThinkingBudgets, resolveThinkingBudget } from './thinking-budgets.js';
import { makeStrictToolSchema, UnsupportedStrictToolSchema } from './strict-tool-schema.js';

// Pi 1.2.0 / 06a466935536f8c9bcacb2d5efc0fc021be1bdff approved package catalogues.
// Owned declarations, native controls and observed tariffs; independent fixtures bind both complete byte hashes.
export type GoogleNativeScope = 'google' | 'google-vertex';
type Price = Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
type Row = readonly [scope: GoogleNativeScope, id: string, name: string, context: number, output: number,
  reasoning: boolean, image: boolean, price: Price, tiers: readonly (Price & { readonly inputTokensAbove: number })[]];
const rows: readonly Row[] = [
  ["google","deep-research-max-preview-04-2026","Deep Research Max Preview (Apr-21-2026)",131072,65536,true,true,{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":0},[{"inputTokensAbove":200000,"input":4,"output":18,"cacheRead":0.4,"cacheWrite":0}]],
  ["google","deep-research-preview-04-2026","Deep Research Preview (Apr-21-2026)",131072,65536,true,true,{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":0},[{"inputTokensAbove":200000,"input":4,"output":18,"cacheRead":0.4,"cacheWrite":0}]],
  ["google","gemini-2.5-computer-use-preview-10-2025","Gemini 2.5 Computer Use Preview 10-2025",128000,64000,true,true,{"input":1.25,"output":10,"cacheRead":0,"cacheWrite":0},[{"inputTokensAbove":200000,"input":2.5,"output":15,"cacheRead":0,"cacheWrite":0}]],
  ["google","gemini-2.5-flash","Gemini 2.5 Flash",1048576,65536,true,true,{"input":0.3,"output":2.5,"cacheRead":0.03,"cacheWrite":0},[]],
  ["google","gemini-2.5-flash-lite","Gemini 2.5 Flash-Lite",1048576,65536,true,true,{"input":0.1,"output":0.4,"cacheRead":0.01,"cacheWrite":0},[]],
  ["google","gemini-2.5-pro","Gemini 2.5 Pro",1048576,65536,true,true,{"input":1.25,"output":10,"cacheRead":0.125,"cacheWrite":0},[{"inputTokensAbove":200000,"input":2.5,"output":15,"cacheRead":0.25,"cacheWrite":0}]],
  ["google","gemini-3-flash-preview","Gemini 3 Flash Preview",1048576,65536,true,true,{"input":0.5,"output":3,"cacheRead":0.05,"cacheWrite":0},[]],
  ["google","gemini-3.1-flash-lite","Gemini 3.1 Flash Lite",1048576,65536,true,true,{"input":0.25,"output":1.5,"cacheRead":0.025,"cacheWrite":0},[]],
  ["google","gemini-3.1-flash-lite-image","Nano Banana 2 Lite",65536,4096,true,true,{"input":0.25,"output":30,"cacheRead":0,"cacheWrite":0},[]],
  ["google","gemini-3.1-flash-lite-preview","Gemini 3.1 Flash Lite Preview",1048576,65536,true,true,{"input":0.25,"output":1.5,"cacheRead":0.025,"cacheWrite":0},[]],
  ["google","gemini-3.1-flash-live-preview","Gemini 3.1 Flash Live Preview",131072,65536,true,true,{"input":0.75,"output":4.5,"cacheRead":0,"cacheWrite":0},[]],
  ["google","gemini-3.1-pro-preview","Gemini 3.1 Pro Preview",1048576,65536,true,true,{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":0},[{"inputTokensAbove":200000,"input":4,"output":18,"cacheRead":0.4,"cacheWrite":0}]],
  ["google","gemini-3.1-pro-preview-customtools","Gemini 3.1 Pro Preview Custom Tools",1048576,65536,true,true,{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":0},[{"inputTokensAbove":200000,"input":4,"output":18,"cacheRead":0.4,"cacheWrite":0}]],
  ["google","gemini-3.5-flash","Gemini 3.5 Flash",1048576,65536,true,true,{"input":1.5,"output":9,"cacheRead":0.15,"cacheWrite":0},[]],
  ["google","gemini-3.5-flash-lite","Gemini 3.5 Flash Lite",1048576,65536,true,true,{"input":0.3,"output":2.5,"cacheRead":0.03,"cacheWrite":0},[]],
  ["google","gemini-3.6-flash","Gemini 3.6 Flash",1048576,65536,true,true,{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},[]],
  ["google","gemini-3.7-flash","Gemini 3.7 Flash",1048576,65536,true,true,{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},[]],
  ["google","gemini-3.8-flash","Gemini 3.8 Flash",1048576,65536,true,true,{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},[]],
  ["google","gemini-flash-latest","Gemini Flash Latest",1048576,65536,true,true,{"input":1.5,"output":9,"cacheRead":0.15,"cacheWrite":0},[]],
  ["google","gemini-flash-lite-latest","Gemini Flash-Lite Latest",1048576,65536,true,true,{"input":0.25,"output":1.5,"cacheRead":0.025,"cacheWrite":0},[]],
  ["google","gemma-4-26b-a4b-it","Gemma 4 26B A4B IT",262144,32768,true,true,{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},[]],
  ["google","gemma-4-31b-it","Gemma 4 31B IT",262144,32768,true,true,{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},[]],
  ["google-vertex","gemini-2.5-flash","Gemini 2.5 Flash",1048576,65536,true,true,{"input":0.3,"output":2.5,"cacheRead":0.03,"cacheWrite":0},[]],
  ["google-vertex","gemini-2.5-flash-lite","Gemini 2.5 Flash-Lite",1048576,65536,true,true,{"input":0.1,"output":0.4,"cacheRead":0.01,"cacheWrite":0},[]],
  ["google-vertex","gemini-2.5-pro","Gemini 2.5 Pro",1048576,65536,true,true,{"input":1.25,"output":10,"cacheRead":0.125,"cacheWrite":0},[]],
  ["google-vertex","gemini-3-flash-preview","Gemini 3 Flash Preview",1048576,65536,true,true,{"input":0.5,"output":3,"cacheRead":0.05,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.1-flash-lite","Gemini 3.1 Flash Lite",1048576,65536,true,true,{"input":0.25,"output":1.5,"cacheRead":0.025,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.1-flash-lite-image","Nano Banana 2 Lite",65536,4096,true,true,{"input":0.25,"output":30,"cacheRead":0.025,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.1-pro-preview","Gemini 3.1 Pro Preview",1048576,65536,true,true,{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.1-pro-preview-customtools","Gemini 3.1 Pro Preview Custom Tools",1048576,65536,true,true,{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.5-flash","Gemini 3.5 Flash",1048576,65536,true,true,{"input":1.5,"output":9,"cacheRead":0.15,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.5-flash-lite","Gemini 3.5 Flash Lite",1048576,65536,true,true,{"input":0.3,"output":2.5,"cacheRead":0.03,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.6-flash","Gemini 3.6 Flash",1048576,65536,true,true,{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.7-flash","Gemini 3.7 Flash",1048576,65536,true,true,{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},[]],
  ["google-vertex","gemini-3.8-flash","Gemini 3.8 Flash",1048576,65536,true,true,{"input":0.75,"output":3.75,"cacheRead":0.075,"cacheWrite":0},[]],
];
const profiles = new Map(rows.map(([scope, id, name, contextWindow, maxOutputTokens, reasoning, imageInput, price, tiers]) =>
  [`${scope}\0${id}`, { scope, id, name, contextWindow, maxOutputTokens, reasoning, imageInput, price, tiers }]));
const known = (price: Price): boolean => price.input > 0 || price.output > 0 || price.cacheRead > 0 || price.cacheWrite > 0;
export function hasGoogleProfile(scope: GoogleNativeScope, model: string): boolean { return profiles.has(`${scope}\0${model}`); }
export function googlePublishedProfiles(scope: GoogleNativeScope): PublishedModelMetadata[] {
  return [...profiles.values()].filter(profile => profile.scope === scope).map(profile => ({
    id: profile.id, name: profile.name, api: scope === 'google' ? 'google-generative-ai' : 'google-vertex',
    contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens,
    capabilities: { reasoning: profile.reasoning, imageInput: profile.imageInput, toolCalls: true },
    ...(known(profile.price) ? { pricing: { inputPerMillion: profile.price.input, outputPerMillion: profile.price.output,
      cacheReadPerMillion: profile.price.cacheRead, cacheWritePerMillion: profile.price.cacheWrite } } : {}),
    thinkingLevelMap: { ...googleThinkingMap(profile.id) },
  }));
}
function usesDiscreteThinking(id: string): boolean {
  return /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) || id === 'gemini-flash-latest'
    || id === 'gemini-flash-lite-latest' || /gemma-?4/.test(id);
}
/** Called only after exact scope/ID admission; names never grant an unknown model native policy. */
function googleThinkingMap(id: string): Readonly<Record<PublishedThinkingLevel, string | null>> {
  const map: Record<PublishedThinkingLevel, string | null> = { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null };
  if (usesDiscreteThinking(id)) map.off = null;
  if (id.includes('gemma')) { map.minimal = 'MINIMAL'; map.high = 'HIGH'; map.low = null; map.medium = null; }
  else if (id === 'gemini-3.1-flash-lite-image') { map.low = null; map.medium = null; }
  else if (id.startsWith('gemini-3.1-pro-') || id === 'gemini-3.7-flash' || id === 'gemini-3.8-flash') map.minimal = null;
  return Object.freeze(map);
}
/** Native SDK ceilings/default maxima and pinned numeric/discrete controls; not a context-reserve calculation. */
export function applyGoogleNativeGenerationConfig(scope: GoogleNativeScope, model: string, config: Record<string, unknown>, options?: ChatOptions): void {
  const profile = profiles.get(`${scope}\0${model}`);
  if (!profile) return;
  const maximum = options?.maxTokens === undefined ? profile.maxOutputTokens : options.maxTokens;
  if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > profile.maxOutputTokens) throw new Error('Invalid Google output limit.');
  config.maxOutputTokens = maximum;
  const level = options?.thinking;
  if (level !== undefined && !PUBLISHED_THINKING_LEVELS.includes(level)) throw new Error('Invalid Google thinking level.');
  const map = googleThinkingMap(model);
  const selected = clampPublishedThinkingLevel(level ?? 'off', PUBLISHED_THINKING_LEVELS.filter(candidate => map[candidate] !== null));
  if (usesDiscreteThinking(model)) {
    config.thinkingConfig = { thinkingLevel: String(map[selected]).toUpperCase(), ...(level !== undefined ? { includeThoughts: true } : {}) };
    return;
  }
  if (selected === 'off') { config.thinkingConfig = { thinkingBudget: 0 }; return; }
  const numericLevel = selected === 'xhigh' || selected === 'max' ? 'high' : selected;
  const defaults = model === 'gemini-2.5-pro' ? { minimal: 128, low: 2048, medium: 8192, high: 32768 }
    : model === 'gemini-2.5-flash-lite' ? { minimal: scope === 'google' ? 512 : 128, low: 2048, medium: 8192, high: 24576 }
      : model === 'gemini-2.5-flash' ? { minimal: 128, low: 2048, medium: 8192, high: 24576 }
        : { minimal: -1, low: -1, medium: -1, high: -1 };
  const overrides = copyThinkingBudgets(options?.thinkingBudgets), fallback = defaults[numericLevel];
  const budget = overrides?.[numericLevel] === undefined && fallback === -1 ? -1 : resolveThinkingBudget(numericLevel, overrides, fallback,
    0, model.includes('2.5-pro') ? 32768 : model.includes('2.5-flash') ? 24576 : 8192);
  config.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
}

/** Scope and exact private profile are supplied by the owning adapter, never public metadata or labels. */
export function applyGoogleToolPolicy(scope: GoogleNativeScope | undefined, model: string, body: Record<string, unknown>, options?: GoogleChatOptions): void {
  const tools = options?.tools;
  if (!tools?.length) return;
  const profile = scope ? profiles.get(`${scope}\0${model}`) : undefined, choice = options?.toolChoice;
  const invalid = (): never => { throw new Error('Invalid Google tool policy.'); };
  const unsupported = (): never => { throw new Error('Google tool requires unsupported constrained sampling.'); };
  if (choice !== undefined && (!profile || !['auto', 'none', 'any'].includes(choice))) invalid();
  // Admission precedes the major-version rule; latest aliases and unknown/derived models gain no strict authority.
  const supportsStrict = !!profile && Number(/^gemini-(\d+)(?:[.-]|$)/.exec(profile.id)?.[1] ?? 0) >= 3;
  let validated = false;
  const declarations = tools.map(tool => {
    let parameters = tool.parameters;
    const sampling = tool.constrainedSampling;
    if (sampling !== undefined && sampling !== false) {
      if (!sampling || sampling.type !== 'json_schema' || !['prefer', 'require'].includes(sampling.strict)) return invalid();
      if (!supportsStrict) { if (sampling.strict === 'require') unsupported(); }
      else {
        try { parameters = makeStrictToolSchema(parameters); validated = true; }
        catch (error) {
          if (!(error instanceof UnsupportedStrictToolSchema)) return invalid();
          if (sampling.strict === 'require') unsupported();
        }
      }
    }
    return { name: tool.name, description: tool.description, [profile ? 'parametersJsonSchema' : 'parameters']: parameters };
  });
  body.tools = [{ functionDeclarations: declarations }];
  const mode = choice === 'none' ? 'NONE' : choice === 'any' ? 'ANY' : validated ? 'VALIDATED' : choice === 'auto' ? 'AUTO' : undefined;
  if (profile && mode) body.toolConfig = { functionCallingConfig: { mode } };
}

/** Patch only owned unsigned tool history; contents are the adapter's fresh, one-per-message conversion. */
export function applyGoogleToolHistory(scope: GoogleNativeScope, model: string, body: Record<string, unknown>, messages: Message[],
  toolImageParts: (message: Message) => Array<Record<string, unknown>>): void {
  const profile = profiles.get(`${scope}\0${model}`); if (!profile) return;
  const major = /^gemini(?:-live)?-(\d+)/i.exec(profile.id)?.[1], requiresIds = Number(major ?? 0) >= 3;
  const nestedImages = major === undefined || requiresIds;
  const provider = scope === 'google' ? 'google' : 'vertex', api = scope === 'google' ? 'google-generative-ai' : 'google-vertex';
  const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  const grouped: typeof contents = [], ids = new Map<string, string>();
  for (const [index, message] of messages.filter(message => message.role !== 'system').entries()) {
    const content = contents[index];
    if (requiresIds && message.role === 'assistant') {
      const same = message.provider === provider && message.model === model && message.api === api;
      const parts = content.parts.filter(part => part.functionCall);
      for (const [offset, call] of (message.toolCalls ?? []).entries()) {
        const id = same ? call.id : call.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        (parts[offset].functionCall as Record<string, unknown>).id = id;
        ids.set(call.id, id);
      }
    }
    if (message.role === 'tool') {
      const images = profile.imageInput ? toolImageParts(message) : [];
      content.parts = [{ functionResponse: { name: message.name || 'tool',
        response: { [message.isError ? 'error' : 'output']: message.content || (images.length ? '(see attached image)' : '') },
        ...(images.length && nestedImages ? { parts: images } : {}),
        ...(requiresIds && message.toolCallId !== undefined ? { id: ids.get(message.toolCallId) ?? message.toolCallId } : {}) } }];
      const previous = grouped.at(-1);
      if (previous?.parts.some(part => part.functionResponse)) previous.parts.push(...content.parts);
      else grouped.push(content);
      if (images.length && !nestedImages) grouped.push({ role: 'user', parts: [{ text: 'Tool result image:' }, ...images] });
      continue;
    }
    grouped.push(content);
  }
  body.contents = grouped;
}

/** Gross prompt selects a scoped tariff; thoughts are output, cache reads are a prompt subset. */
export function googleProfileUsage(scope: GoogleNativeScope, model: string, value: unknown): ChatResponse['usage'] {
  const profile = profiles.get(`${scope}\0${model}`);
  if (!profile || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const prompt = token(raw.promptTokenCount), output = token(raw.candidatesTokenCount);
  const thoughts = raw.thoughtsTokenCount === undefined ? 0 : token(raw.thoughtsTokenCount);
  const read = raw.cachedContentTokenCount === undefined ? 0 : token(raw.cachedContentTokenCount);
  if (prompt === undefined || output === undefined || thoughts === undefined || read === undefined || read > prompt) return undefined;
  const completion = output + thoughts, sum = prompt + completion;
  if (!Number.isSafeInteger(sum)) return undefined;
  const total = raw.totalTokenCount === undefined ? sum : token(raw.totalTokenCount);
  if (total === undefined || total < sum) return undefined;
  let price: Price = profile.price;
  for (const tier of profile.tiers) if (prompt > tier.inputTokensAbove) price = tier;
  // Extra reported tokens have no attributed tariff; zero-only declarations are not known free service.
  return { promptTokens: prompt - read, completionTokens: completion, totalTokens: total,
    ...(raw.cachedContentTokenCount === undefined ? {} : { cacheReadTokens: read }),
    ...(known(price) && total === sum ? { costUsd: ((prompt - read) * price.input + completion * price.output + read * price.cacheRead) / 1000000 } : {}),
  };
}
