import type { ChatOptions } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, getPublishedModelMetadata, getSupportedThinkingLevels } from './model-metadata.js';
import { copyThinkingBudgets, resolveThinkingBudget } from './thinking-budgets.js';
import { ProviderOutputBudgetError, type PreparedNativeOutputBudget } from './provider-output-budget.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-3-haiku-20240307';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

// Only a published, explicitly qualified profile selects a different wire dialect.
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
  if (options.thinking && options.thinking !== 'off' && !ADAPTIVE_MODELS.has(options.model!)) {
    try { options.thinkingBudgets = copyThinkingBudgets(options.thinkingBudgets); }
    catch { throw new ProviderOutputBudgetError('thinking'); }
  }
  const body: Record<string, unknown> = { model: options.model, max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS };
  try { applyAnthropicThinking(body, options); }
  catch { throw new ProviderOutputBudgetError(); }
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new ProviderOutputBudgetError();
  return Object.freeze({ options, maxTokens });
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
