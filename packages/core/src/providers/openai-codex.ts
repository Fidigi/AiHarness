import type { Message } from '../types/index.js';
import type { ChatOptions, ResponsesChatOptions } from './index.js';
import type { ProviderOAuthCredential } from './credentials.js';
import { openAICodexAccountId } from './openai-codex-oauth.js';

export const OPENAI_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
// Models endpoint contract reviewed separately against official Codex rust-v0.167.2.
export const OPENAI_CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.167.2';
export interface OpenAICodexModel {
  readonly id: string; readonly name: string;
  readonly api: 'openai-codex-responses'; readonly provider: 'openai-codex';
  readonly contextWindow: number; readonly maxTokens: number;
  readonly input: readonly ('text' | 'image')[];
  readonly thinkingLevelMap: Readonly<Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>>;
}
export interface OpenAICodexChatOptions extends ChatOptions {
  tools?: ResponsesChatOptions['tools'];
  toolChoice?: 'auto' | 'none' | 'required';
  textVerbosity?: 'low' | 'medium' | 'high';
  reasoningSummary?: 'auto' | 'concise' | 'detailed';
}
// Pinned nine-model CX declarations; they are not account entitlement or subscription prices.
const models: OpenAICodexModel[] = [
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', api: 'openai-codex-responses', provider: 'openai-codex', contextWindow: 128000, maxTokens: 128000, input: ['text'], thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' } },
  { id: 'gpt-5.5', name: 'GPT-5.5', api: 'openai-codex-responses', provider: 'openai-codex', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' } },
  ...(['luna', 'sol', 'terra'] as const).map(suffix => ({ id: `gpt-5.6-${suffix}`, name: `GPT-5.6 ${suffix.charAt(0).toUpperCase() + suffix.slice(1)}`, api: 'openai-codex-responses' as const, provider: 'openai-codex' as const, contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'] as const, thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' } })),
  ...(['astra', 'luna', 'sol'] as const).map(suffix => ({ id: `gpt-6-${suffix}`, name: `GPT-6 ${suffix.charAt(0).toUpperCase() + suffix.slice(1)}`, api: 'openai-codex-responses' as const, provider: 'openai-codex' as const, contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'] as const, thinkingLevelMap: { off: suffix === 'astra' ? null : 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } })),
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', api: 'openai-codex-responses', provider: 'openai-codex', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
];
for (const model of models) { Object.freeze(model.input); Object.freeze(model.thinkingLevelMap); Object.freeze(model); }
export const OPENAI_CODEX_MODELS: readonly OpenAICodexModel[] = Object.freeze(models);
export function openAICodexModel(id: string): OpenAICodexModel {
  const model = models.find(model => model.id === id);
  if (!model) throw new Error('OpenAI Codex model is not supported.');
  return model;
}
export function openAICodexCredential(credential: ProviderOAuthCredential | undefined): ProviderOAuthCredential & { subscription: { provider: 'openai-codex'; accountId: string } } {
  if (!credential || credential.version !== 1 || credential.type !== 'oauth' || credential.subscription?.provider !== 'openai-codex'
    || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt! <= Date.now()
    || openAICodexAccountId(credential.accessToken) !== credential.subscription.accountId) throw new Error('OpenAI Codex subscription is unavailable.');
  return { ...credential, subscription: { ...credential.subscription } };
}
export function openAICodexHeaders(credential: ProviderOAuthCredential): Record<string, string> {
  const current = openAICodexCredential(credential);
  return { Authorization: `Bearer ${current.accessToken}`, 'chatgpt-account-id': current.subscription.accountId,
    'OpenAI-Beta': 'responses=experimental', originator: 'ai-harness', 'User-Agent': 'AiHarness/0.1.0' };
}

/** CX request policy. Never posts API-key OpenAI output/store fields or infers a different owner. */
export function openAICodexBody(model: OpenAICodexModel, messages: readonly Message[], options: OpenAICodexChatOptions = {}) {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (options.thinking !== undefined && (!levels.includes(options.thinking)
    || model.thinkingLevelMap[options.thinking] === null || ['xhigh', 'max'].includes(options.thinking) && model.thinkingLevelMap[options.thinking] === undefined)) {
    // Off/null means omit reasoning, not request an unsupported physical effort.
    if (options.thinking !== 'off') throw new Error('OpenAI Codex thinking level is unavailable.');
  }
  if (options.toolChoice !== undefined && !['auto', 'none', 'required'].includes(options.toolChoice)) throw new Error('Invalid OpenAI Codex tool choice.');
  if (options.textVerbosity !== undefined && !['low', 'medium', 'high'].includes(options.textVerbosity)) throw new Error('Invalid OpenAI Codex verbosity.');
  if (options.reasoningSummary !== undefined && !['auto', 'concise', 'detailed'].includes(options.reasoningSummary)) throw new Error('Invalid OpenAI Codex reasoning summary.');
  const initial = messages[0]?.role === 'system' ? messages[0] : undefined;
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message === initial) continue;
    if (message.role === 'system') throw new Error('OpenAI Codex mid-conversation instructions are not qualified.');
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: (message.toolCallId ?? message.id).split('|')[0], output: message.content || '(no tool output)' }); continue;
    }
    const images = message.blocks?.filter(block => block.type === 'image') ?? [];
    if (images.length && !model.input.includes('image')) throw new Error('OpenAI Codex model does not accept images.');
    const text = message.blocks?.flatMap(block => block.type === 'text' || block.type === 'reasoning' && !block.redacted ? [block.text] : []).join('') || message.content;
    if (text || images.length) input.push({ role: message.role, content: [
      ...(text ? [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text }] : []),
      ...images.map(image => ({ type: 'input_image', image_url: image.url, detail: 'auto' })),
    ] });
    for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id.split('|')[0], name: call.name, arguments: JSON.stringify(call.input) });
  }
  if (options.tools?.some(tool => tool.constrainedSampling)) throw new Error('OpenAI Codex constrained tools are not qualified.');
  const requested = options.thinking;
  const effort = requested === undefined || requested === 'off' ? model.thinkingLevelMap.off ?? (model.thinkingLevelMap.off === null ? null : 'none') : model.thinkingLevelMap[requested] ?? requested;
  return { model: model.id, store: false, stream: true as const,
    instructions: options.systemPrompt || initial?.content || 'You are a helpful assistant.', input,
    text: { verbosity: options.textVerbosity ?? 'low' }, include: ['reasoning.encrypted_content'], tool_choice: options.toolChoice ?? 'auto', parallel_tool_calls: true,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(effort === null ? {} : { reasoning: { effort, ...(requested !== undefined ? { summary: options.reasoningSummary ?? 'auto' } : {}) } }),
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), strict: null })) } : {}),
    ...(options.sessionId ? { prompt_cache_key: options.sessionId } : {}),
  };
}

/** Read only account-listed pinned models; no instructions/policy from the remote catalogue become configuration. */
export async function openAICodexAccountModels(response: Response): Promise<string[]> {
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('OpenAI Codex catalogue is unavailable.'); }
  const limit = 4 * 1024 * 1024, length = response.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9]\d*)$/u.test(length) || Number(length) > limit)) { void response.body?.cancel().catch(() => undefined); throw new Error('Invalid OpenAI Codex catalogue.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid OpenAI Codex catalogue.');
  const chunks: Uint8Array[] = []; let bytes = 0, complete = false;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) { complete = true; break; }
      bytes += item.value.byteLength; if (bytes > limit) throw new Error(); chunks.push(item.value);
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as { models?: unknown };
    if (!Array.isArray(body.models) || body.models.length > 2048) throw new Error();
    const ids = new Set(body.models.flatMap(row => row && typeof row === 'object' && row.visibility === 'list' && typeof row.slug === 'string' ? [row.slug] : []));
    return models.filter(model => ids.has(model.id)).map(model => model.id);
  } catch { throw new Error('Invalid OpenAI Codex catalogue.'); }
  finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A hostile reader may retain its lock after cancellation. */ }
  }
}
