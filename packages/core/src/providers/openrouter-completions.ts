import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { OPENROUTER_COMPLETION_MODELS, type OpenRouterCompletionProfile } from './openrouter-completions-metadata.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

const profiles = new Map(OPENROUTER_COMPLETION_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function openRouterCompletionProfile(model: string): OpenRouterCompletionProfile {
  const profile = profiles.get(model);
  if (!profile) throw new Error('OpenRouter chat model is not supported.');
  return profile;
}

/** Prepare only the owned OpenAI envelope; operator IDs never select compatibility policy. */
export function prepareOpenRouterCompletion(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = [], nativeReplay = false): Record<string, unknown> {
  const profile = openRouterCompletionProfile(String(body.model));
  const requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid OpenRouter thinking level.');
  const levels = PUBLISHED_THINKING_LEVELS.filter(level => !profile.reasoning ? level === 'off'
    : profile.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined));
  const selected = clampPublishedThinkingLevel(requested, levels);
  delete body.reasoning_effort;
  if (profile.reasoning) body.reasoning = { effort: profile.thinkingLevelMap?.[selected] ?? (selected === 'off' ? 'none' : selected) };
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.messages)) {
    const history = messages.filter(message => message.role === 'assistant'); let assistant = 0;
    const developer = profile.reasoning && (profile.compat?.supportsDeveloperRole ?? /^(?:anthropic|openai)\//u.test(profile.id));
    for (const message of body.messages) {
      if (!record(message)) continue;
      if (message.role === 'system' && developer) message.role = 'developer';
      if (message.role === 'assistant') {
        const original = history[assistant++];
        if (!nativeReplay && profile.compat?.requiresReasoningContentOnAssistantMessages) message.reasoning_content = original?.blocks?.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('') ?? '';
      }
      if (!profile.declaredInput.includes('image') && Array.isArray(message.content)
        && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('OpenRouter chat model does not support images.');
    }
    const cache = options?.cacheRetention !== 'none' && (profile.compat?.cacheControlFormat === 'anthropic' || profile.id.startsWith('anthropic/'));
    if (cache) {
      const mark = (message: Record<string, unknown>): void => {
        if (typeof message.content === 'string' && message.content) message.content = [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }];
        else if (Array.isArray(message.content)) {
          const part = message.content.slice().reverse().find(part => record(part) && part.type === 'text');
          if (record(part)) part.cache_control = { type: 'ephemeral' };
        }
      };
      for (const message of body.messages) if (record(message) && ['system', 'developer'].includes(String(message.role))) mark(message);
      const user = body.messages.slice().reverse().find(message => record(message) && message.role === 'user'); if (record(user)) mark(user);
      if (Array.isArray(body.tools)) { const tool = body.tools.at(-1); if (record(tool)) tool.cache_control = { type: 'ephemeral' }; }
    }
  }
  if (options?.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens)) {
    throw new Error('Invalid OpenRouter output limit.');
  }
  if (nativeReplay) {
    body.store = false;
    if (body.max_tokens !== undefined) body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  }
  return body;
}

export function openRouterCompletionReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined;
  if (nativeReplay) {
    const fields = ['reasoning_content', 'reasoning', 'reasoning_text'];
    if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string')
      || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid OpenRouter chat response.');
    return fields.map(field => value[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (value.reasoning_details !== undefined) {
    if (!Array.isArray(value.reasoning_details)) throw new Error('Invalid OpenRouter chat response.');
    const text: string[] = [];
    for (const detail of value.reasoning_details) {
      if (!record(detail)) throw new Error('Invalid OpenRouter chat response.');
      const part = detail.type === 'reasoning.text' ? detail.text : detail.type === 'reasoning.summary' ? detail.summary : undefined;
      // Opaque replay/signatures are not silently downgraded to visible text.
      if (typeof part !== 'string' || detail.signature !== undefined) throw new Error('Unsupported OpenRouter reasoning replay.');
      text.push(part);
    }
    if (text.length) return text.join('');
  }
  const text = value.reasoning ?? value.reasoning_content ?? value.reasoning_summary;
  if (text !== undefined && text !== null && typeof text !== 'string') throw new Error('Invalid OpenRouter chat response.');
  return typeof text === 'string' ? text : undefined;
}

export function openRouterCompletionUsage(value: unknown, model: string): ChatResponse['usage'] {
  const profile = openRouterCompletionProfile(model);
  let pricing: Readonly<Required<ModelPricing>> | undefined = profile.pricing;
  if (pricing && record(value) && typeof value.prompt_tokens === 'number') {
    let threshold = -1;
    for (const tier of profile.declaredPricing.tiers ?? []) {
      if (value.prompt_tokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) { pricing = tier; threshold = tier.inputTokensAbove; }
    }
  }
  const usage = openRouterUsage(value, pricing, 'openai-completions');
  // ChatResponse requires the primary pair; partial/invalid pairs must not acquire invented zeros.
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  };
}

const validFinish = (value: unknown): boolean => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateOpenRouterCompletion(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)) {
    throw new Error('Invalid OpenRouter chat response.');
  }
  const message = value.choices[0].message;
  if (message.refusal || (message.content !== undefined && message.content !== null && typeof message.content !== 'string')
    || (nativeReplay && !validFinish(value.choices[0].finish_reason))
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid OpenRouter chat response.');
  if (nativeReplay) openRouterCompletionReasoning(message, true);
}
export function openRouterCompletionStreamValidator(nativeReplay = false): (value?: unknown) => void {
  if (!nativeReplay) return () => {};
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid OpenRouter chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid OpenRouter chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid OpenRouter chat response.');
    openRouterCompletionReasoning(choice.delta, true); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid OpenRouter chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid OpenRouter chat response.'); finished = true; }
  };
}
