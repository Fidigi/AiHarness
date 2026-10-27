import type { ChatOptions, ChatResponse } from './index.js';
import type { Message } from '../types/index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, getPublishedModelMetadata, getSupportedThinkingLevels } from './model-metadata.js';
import { copyThinkingBudgets, resolveThinkingBudget } from './thinking-budgets.js';
import { anthropicAdaptivePolicy, anthropicNumericPolicy, validateAnthropicProfileOutput } from './anthropic-profiles.js';
import { ProviderOutputBudgetError, type PreparedNativeOutputBudget } from './provider-output-budget.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-3-haiku-20240307';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

// Legacy compatible-transport policy; new native dialects never extend this set.
// Similar-looking custom IDs and unknown future models retain the legacy path.
const ADAPTIVE_MODELS = new Set(['claude-sonnet-4-6']);
const ADAPTIVE_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const NUMERIC_BUDGETS = { minimal: 1024, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 } as const;

/**
 * Prepare the already-owned request after awaited observers. Numeric maps are
 * copied only when the selected native dialect consumes them; off/effort-only
 * modes keep unused maps opaque. Caller-owned maps/arrays are never frozen.
 */
export function prepareAnthropicOutputBudget(ownedOptions: ChatOptions, configuredModel: string): Readonly<PreparedNativeOutputBudget> {
  const options: ChatOptions = { ...ownedOptions, model: ownedOptions.model || configuredModel };
  if (options.thinking && options.thinking !== 'off' && !anthropicAdaptivePolicy(options.model!)) {
    try { options.thinkingBudgets = copyThinkingBudgets(options.thinkingBudgets); }
    catch { throw new ProviderOutputBudgetError('thinking'); }
  }
  const body: Record<string, unknown> = { model: options.model, max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS };
  try { applyNativeAnthropicOutputPolicy(body, options); }
  catch { throw new ProviderOutputBudgetError(); }
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new ProviderOutputBudgetError();
  return Object.freeze({ options, maxTokens });
}

/** Constrain direct-owner requests before and after their profile-owned thinking allocation. */
export function applyNativeAnthropicOutputPolicy(body: Record<string, unknown>, options?: ChatOptions): void {
  validateAnthropicProfileOutput(body, options?.maxTokens);
  const model = typeof body.model === 'string' ? body.model : '', policy = anthropicAdaptivePolicy(model);
  if (anthropicNumericPolicy(model)) applyNumericAnthropicThinking(body, options, model);
  else if (!policy) applyAnthropicThinking(body, options);
  else {
    if (!policy.supportsTemperature || policy.managed) delete body.temperature;
    const level = options?.thinking;
    // Preserve the native SDK's omitted-thinking contract; explicit off is clamped
    // to the physical map (Fable cannot disable thinking). No numeric maps are read.
    if (policy.managed) {
      anthropicManagedEffort(model, options); // Validate even while the top-level effort is fixed.
      body.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
      body.output_config = { effort: 'high' };
    } else if (level !== undefined) {
      if (!PUBLISHED_THINKING_LEVELS.includes(level)) throw new Error('Invalid Anthropic thinking level.');
      const available = PUBLISHED_THINKING_LEVELS.filter(candidate => policy.thinkingLevelMap[candidate] !== null);
      const selected = clampPublishedThinkingLevel(level, available);
      if (selected === 'off') body.thinking = { type: 'disabled' };
      else {
        body.thinking = { type: 'adaptive', display: 'summarized' };
        body.output_config = { effort: policy.thinkingLevelMap[selected] };
        delete body.temperature;
        if (options?.maxTokens === undefined && level !== 'off') body.max_tokens = Math.max(Number(body.max_tokens), NUMERIC_BUDGETS[level] + 1024);
      }
    }
  }
  validateAnthropicProfileOutput(body, options?.maxTokens);
}

const NATIVE_NUMERIC_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 } as const;
/** Pi simple-options adds reasoning to the answer cap; reserve 1024 only when reasoning reaches the total ceiling. */
function applyNumericAnthropicThinking(body: Record<string, unknown>, options: ChatOptions | undefined, model: string): void {
  const policy = anthropicNumericPolicy(model)!;
  body.max_tokens = options?.maxTokens ?? policy.maxTokens;
  const level = options?.thinking;
  if (level === undefined) return;
  if (!PUBLISHED_THINKING_LEVELS.includes(level)) throw new Error('Invalid Anthropic thinking level.');
  if (level === 'off') { body.thinking = { type: 'disabled' }; return; }
  const selected = level === 'xhigh' || level === 'max' ? 'high' : level;
  const requested = copyThinkingBudgets(options?.thinkingBudgets)?.[selected] ?? NATIVE_NUMERIC_BUDGETS[selected];
  const base = Number(body.max_tokens);
  const maximum = options?.maxTokens === undefined ? policy.maxTokens
    : requested >= policy.maxTokens - base ? policy.maxTokens : base + requested;
  const budget = (maximum <= requested ? Math.min(requested, Math.max(0, maximum - 1024)) : requested) || 1024;
  // Do not reproduce invalid sub-1024 thinking blocks or consume the whole output ceiling.
  if (budget < 1024 || budget >= maximum) throw new Error('Invalid Anthropic thinking allocation.');
  body.max_tokens = maximum;
  body.thinking = { type: 'enabled', budget_tokens: budget, display: 'summarized' };
  delete body.temperature;
}

/** Managed models always think; the active wire effort is independent of the fixed top-level high. */
export function anthropicManagedEffort(model: string, options?: ChatOptions): ChatResponse['providerThinkingLevel'] {
  const policy = anthropicAdaptivePolicy(model);
  if (!policy?.managed) return undefined;
  const level = options?.thinking === undefined ? 'high' : options.thinking;
  if (!PUBLISHED_THINKING_LEVELS.includes(level)) throw new Error('Invalid Anthropic thinking level.');
  const selected = clampPublishedThinkingLevel(level, PUBLISHED_THINKING_LEVELS.filter(candidate => policy.thinkingLevelMap[candidate] !== null));
  const effort = policy.thinkingLevelMap[selected];
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') return effort;
  throw new Error('Invalid Anthropic thinking level.');
}
export function anthropicThinkingBetas(model: string, options?: ChatOptions): string[] {
  if (anthropicAdaptivePolicy(model)?.managed) return ['mid-conversation-output-config-2026-07-01', 'thinking-binding-controls-2026-08-01'];
  return anthropicNumericPolicy(model) && options?.thinking !== undefined && options.thinking !== 'off'
    ? ['interleaved-thinking-2025-05-14'] : [];
}
/** Insert controls before the corresponding assistant, never between a tool use/result pair. */
export function applyAnthropicManagedHistory(body: Record<string, unknown>, options: ChatOptions | undefined, messages: readonly Message[], owner: string): void {
  const effort = anthropicManagedEffort(String(body.model), options);
  if (effort === undefined || !Array.isArray(body.messages)) return;
  const converted = body.messages;
  body.messages = converted.flatMap((message: unknown, index: number) => {
    const original = messages[index], level = original?.metadata?.providerThinkingLevel;
    const historical = original?.role === 'assistant' && original.api === 'anthropic-messages' && original.provider === owner
      && (level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh' || level === 'max') ? level : undefined;
    return [...(historical ? [{ role: 'system', content: [], output_config: { effort: historical } }] : []), message];
  });
  (body.messages as unknown[]).push({ role: 'system', content: [], output_config: { effort } });
}

/** Apply per-call reasoning policy to the already selected request model. */
export function applyAnthropicThinking(body: Record<string, unknown>, options?: ChatOptions): void {
  const level = options?.thinking;
  if (level === undefined) return;
  if (!PUBLISHED_THINKING_LEVELS.includes(level)) throw new Error('Invalid Anthropic thinking level.');
  const model = typeof body.model === 'string' ? body.model : '';
  const adaptive = ADAPTIVE_MODELS.has(model);
  if (level === 'off') {
    if (adaptive) body.thinking = { type: 'disabled' };
    return;
  }
  if (adaptive) {
    const selected = clampPublishedThinkingLevel(level, getSupportedThinkingLevels('anthropic', model));
    if (selected === 'off') { body.thinking = { type: 'disabled' }; return; }
    const mapped = getPublishedModelMetadata('anthropic', model)?.thinkingLevelMap?.[selected];
    const effort = typeof mapped === 'string' ? mapped : selected === 'minimal' ? 'low' : selected;
    if (!ADAPTIVE_EFFORTS.has(effort)) throw new Error('Unsupported Anthropic adaptive thinking effort.');
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort };
    // Do not collapse the old per-level output defaults to the constructor's
    // 1024 tokens. Explicit output caps remain exact; numeric overrides are ignored.
    if (options?.maxTokens === undefined) body.max_tokens = Math.max(Number(body.max_tokens), NUMERIC_BUDGETS[level] + 1024);
    return;
  }
  const budget = resolveThinkingBudget(level, options?.thinkingBudgets, NUMERIC_BUDGETS[level], 1024, 32768);
  body.thinking = { type: 'enabled', budget_tokens: budget };
  body.max_tokens = Math.max(Number(body.max_tokens), budget + 1024);
}
