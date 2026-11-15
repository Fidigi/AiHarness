import type { AiProvider } from './index.js';
import { getPublishedModelMetadata, type PublishedThinkingLevel, type PublishedModelMetadata } from './model-metadata.js';
import type { ModelPricing } from '../types/index.js';

function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }

/** Owned static conversation metadata, never discovery, credentials or an account-access claim. */
export function getProviderPublishedModels(
  provider: Pick<AiProvider, 'getPublishedModels' | 'getModelApi'>,
): PublishedModelMetadata[] | undefined {
  let raw: unknown;
  try { raw = provider.getPublishedModels?.(); } catch { return []; }
  if (raw === undefined) return undefined;
  try { if (!Array.isArray(raw)) return []; } catch { return []; }
  const models: PublishedModelMetadata[] = [], seen = new Set<string>();
  const count = data(raw, 'length');
  if (!positive(count) && count !== 0) return [];
  for (let index = 0; index < Math.min(count as number, 500); index++) {
    const row = data(raw, String(index)), id = data(row, 'id'), name = data(row, 'name'), capabilities = data(row, 'capabilities');
    const reasoning = data(capabilities, 'reasoning'), imageInput = data(capabilities, 'imageInput'), toolCalls = data(capabilities, 'toolCalls');
    if (!text(id) || !text(name) || seen.has(id.trim()) || typeof reasoning !== 'boolean' || typeof imageInput !== 'boolean' || typeof toolCalls !== 'boolean') continue;
    const rawApi = data(row, 'api'), api = typeof rawApi === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(rawApi) ? rawApi : undefined;
    try { const bound = provider.getModelApi?.(id.trim()); if (api && typeof bound === 'string' && api !== bound) continue; } catch { continue; }
    const contextWindow = data(row, 'contextWindow'), maxOutputTokens = data(row, 'maxOutputTokens'), rawPricing = data(row, 'pricing');
    const pricing: ModelPricing = {};
    for (const key of ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const) {
      const value = data(rawPricing, key); if (typeof value === 'number' && Number.isFinite(value) && value >= 0) pricing[key] = value;
    }
    const rawCache = data(row, 'promptCache'), promptCache: { short?: number; long?: number } = {};
    for (const key of ['short', 'long'] as const) {
      const value = data(rawCache, key); if (positive(value) && value <= 86_400) promptCache[key] = value;
    }
    const rawThinking = data(row, 'thinkingLevelMap'), thinkingLevelMap: Partial<Record<PublishedThinkingLevel, string | null>> = {};
    for (const key of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const value = data(rawThinking, key); if (value === null || text(value)) thinkingLevelMap[key] = value;
    }
    const rawResize = data(data(data(row, 'inputLimits'), 'images'), 'resize');
    const maxWidth = data(rawResize, 'maxWidth'), maxHeight = data(rawResize, 'maxHeight'), maxBytes = data(rawResize, 'maxBytes'), jpegQuality = data(rawResize, 'jpegQuality');
    const resize = positive(maxWidth) && maxWidth <= 8192 && positive(maxHeight) && maxHeight <= 8192
      && positive(maxBytes) && maxBytes <= 16 * 1024 * 1024 && positive(jpegQuality) && jpegQuality <= 100
      ? { maxWidth, maxHeight, maxBytes, jpegQuality } : undefined;
    seen.add(id.trim());
    models.push({ id: id.trim(), name: name.trim(), capabilities: { reasoning, imageInput, toolCalls }, ...(api ? { api } : {}),
      ...(resize ? { inputLimits: { images: { resize } } } : {}),
      ...(positive(contextWindow) ? { contextWindow } : {}), ...(positive(maxOutputTokens) ? { maxOutputTokens } : {}),
      ...(Object.keys(pricing).length ? { pricing } : {}),
      ...(Object.keys(promptCache).length ? { promptCache } : {}),
      ...(rawThinking === null ? { thinkingLevelMap: null } : Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}) });
  }
  return models;
}

/** An adapter declaration is authoritative; only an undeclared source uses legacy aliases. */
export function getProviderPublishedModel(
  provider: string, model: string, source?: Pick<AiProvider, 'getPublishedModels' | 'getModelApi'>,
): PublishedModelMetadata | undefined {
  const models = source ? getProviderPublishedModels(source) : undefined;
  return models === undefined ? getPublishedModelMetadata(provider, model) : models.find(row => row.id === model);
}
