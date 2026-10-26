import type { Message } from '../types/index.js';
import type { ChatOptions, ChatResponse, CloudflareWorkersAiConfig } from './index.js';
import { CLOUDFLARE_CHAT_MODELS, type CloudflareChatProfile } from './cloudflare-completions-metadata.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel } from './model-metadata.js';

const profiles = new Map(CLOUDFLARE_CHAT_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function cloudflareChatProfile(model: string): CloudflareChatProfile {
  const profile = profiles.get(model);
  if (!profile) throw new Error('Cloudflare chat model is not supported.');
  return profile;
}

/** Shared explicit account composition; neither C nor S loads ambient authentication. */
export function cloudflareAiBase(config: CloudflareWorkersAiConfig): string {
  if (config.baseUrl) return config.baseUrl;
  const account = config.accountId;
  if (typeof account !== 'string' || !account.trim() || Buffer.byteLength(account) > 500 || /[\u0000-\u0020\u007f]/u.test(account)) throw new Error('Invalid Cloudflare Workers AI endpoint.');
  try { return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai`; }
  catch { throw new Error('Invalid Cloudflare Workers AI endpoint.'); }
}
export function cloudflareChatEndpoint(config: CloudflareWorkersAiConfig): string {
  try {
    const url = new URL(cloudflareAiBase(config));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    const path = url.pathname.replace(/\/+$/u, '');
    if (path.endsWith('/run')) throw new Error();
    url.pathname = path.endsWith('/chat/completions') ? path : /\/v\d+$/u.test(path) ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
    return url.href;
  } catch { throw new Error('Invalid Cloudflare Workers AI endpoint.'); }
}

/** One explicit AI/proxy root, or either full operation endpoint, owns both SDK paths. */
export function cloudflareMixedBases(config: CloudflareWorkersAiConfig): { chat: string; classifier: string } {
  try {
    const source = new URL(cloudflareAiBase(config));
    if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password || source.search || source.hash) throw new Error();
    const path = source.pathname.replace(/\/+$/u, ''), classifier = new URL(source);
    if (path.endsWith('/run')) source.pathname = path.slice(0, -4) || '/';
    const chat = cloudflareChatEndpoint({ ...config, baseUrl: source.href });
    classifier.pathname = path.endsWith('/run') ? path : `${new URL(chat).pathname.replace(/\/(?:v\d+\/)?chat\/completions$/u, '')}/run`;
    return { chat, classifier: classifier.href };
  } catch { throw new Error('Invalid Cloudflare Workers AI endpoint.'); }
}

/** Cloudflare's reviewed C compatibility is independent of operator ID and proxy hostname. */
export function prepareCloudflareChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = []): Record<string, unknown> {
  const profile = cloudflareChatProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Cloudflare thinking level.');
  const levels = PUBLISHED_THINKING_LEVELS.filter(level => !profile.reasoning ? level === 'off'
    : profile.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined));
  const selected = clampPublishedThinkingLevel(requested, levels);
  delete body.reasoning_effort;
  if (profile.reasoning) {
    if (profile.compat.thinkingFormat === 'deepseek') body.thinking = { type: selected === 'off' ? 'disabled' : 'enabled' };
    const effort = profile.thinkingLevelMap?.[selected] ?? (selected === 'off' ? undefined : selected);
    if (effort !== undefined) body.reasoning_effort = effort;
  }
  delete body.store; delete body.prompt_cache_key; delete body.prompt_cache_retention;
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.messages)) {
    const history = messages.filter(message => message.role === 'assistant'); let assistant = 0;
    for (const message of body.messages) {
      if (!record(message)) continue;
      if (message.role === 'assistant') {
        const original = history[assistant++];
        if (profile.compat.requiresReasoningContentOnAssistantMessages) message.reasoning_content = original?.blocks?.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('') ?? '';
      }
      if (!profile.declaredInput.includes('image') && Array.isArray(message.content)
        && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Cloudflare chat model does not support images.');
    }
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  if (options?.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens)) throw new Error('Invalid Cloudflare output limit.');
  return body;
}

export function cloudflareChatUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const counter = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const prompt = counter(value.prompt_tokens), output = counter(value.completion_tokens);
  if (prompt === undefined || output === undefined || !Number.isSafeInteger(prompt + output)) return undefined;
  if (value.prompt_tokens_details !== undefined && !record(value.prompt_tokens_details)) return undefined;
  const details = record(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const readRaw = details.cached_tokens ?? value.prompt_cache_hit_tokens ?? value.cached_tokens, writeRaw = details.cache_write_tokens;
  const read = counter(readRaw), write = counter(writeRaw);
  if ((readRaw !== undefined && read === undefined) || (writeRaw !== undefined && write === undefined) || (read ?? 0) + (write ?? 0) > prompt) return undefined;
  const input = prompt - (read ?? 0) - (write ?? 0), pricing = cloudflareChatProfile(model).pricing;
  return { promptTokens: input, completionTokens: output, totalTokens: prompt + output,
    ...(read === undefined ? {} : { cacheReadTokens: read }), ...(write === undefined ? {} : { cacheWriteTokens: write }),
    costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + (read ?? 0) * pricing.cacheReadPerMillion + (write ?? 0) * pricing.cacheWritePerMillion) / 1_000_000 };
}

export function validateCloudflareChat(value: unknown): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)) throw new Error('Invalid Cloudflare chat response.');
  const message = value.choices[0].message;
  if (message.refusal || (message.content !== undefined && message.content !== null && typeof message.content !== 'string')
    || ['reasoning_content', 'reasoning_summary'].some(field => message[field] !== undefined && message[field] !== null && typeof message[field] !== 'string')
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Cloudflare chat response.');
}
