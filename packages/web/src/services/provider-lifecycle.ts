import type { CustomProviderDefinition, ProviderType } from '@ai-harness/core';
import { apiFetch } from './api';
import { useSessionStore } from '../store/session-store';

const BUILTIN_IDS = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock']);

export type RenameableProvider = CustomProviderDefinition & { revision: string };
export function isRenameableProvider(provider: CustomProviderDefinition & { revision?: unknown }): provider is RenameableProvider {
  return !BUILTIN_IDS.has(provider.id)
    && /^[a-z][a-z0-9_-]{1,63}$/.test(provider.id)
    && typeof provider.revision === 'string' && /^[a-f0-9]{64}$/.test(provider.revision);
}
/** Update only ephemeral selection/model cache after canonical successful rename.
 * Never rewrite session history or copy old private authentication into a new ID.
 */
export function rebindProviderSelection(oldId: string, newId: string, configured: boolean): void {
  if (oldId === newId || BUILTIN_IDS.has(oldId) || BUILTIN_IDS.has(newId) || !/^[a-z][a-z0-9_-]{1,63}$/.test(oldId) || !/^[a-z][a-z0-9_-]{1,63}$/.test(newId)) return;
  useSessionStore.setState(state => {
    const oldType = oldId as ProviderType;
    const newType = newId as ProviderType;
    const available = { ...state.providers.available };
    // Never transfer a model/cache across identities or endpoint sources.
    // The destination must already have been loaded from canonical state.
    if (!available[newType]) return state;
    const model = available[newType]?.model || '';
    available[newType] = { type: newId, model, ...(configured ? { apiKey: 'configured' } : {}) };
    delete available[oldType];
    return { providers: { ...state.providers, available,
      active: state.providers.active === oldType ? newType : state.providers.active } };
  });
}

export interface ProviderRenameResult {
  success: boolean;
  data?: RenameableProvider;
  code?: string;
  uncertain: boolean;
}

/** Submit identity only; credentials and provider descriptors never enter rename bodies. */
export async function renameCustomProvider(provider: Pick<RenameableProvider, 'id' | 'revision'>,
  newId: string, reconcile: (result?: ProviderRenameResult) => Promise<void>, signal?: AbortSignal): Promise<ProviderRenameResult> {
  let result: ProviderRenameResult;
  try {
    const response = await apiFetch(`/api/provider-registry/custom/${encodeURIComponent(provider.id)}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ id: newId, revision: provider.revision }),
    });
    const data = await response.json() as RenameableProvider & { code?: string; uncertain?: boolean };
    result = response.ok ? isRenameableProvider(data) && data.id === newId.trim().toLowerCase()
      ? { success: true, data, uncertain: false } : { success: false, uncertain: true }
      : { success: false, code: data.code, uncertain: data.uncertain === true || response.status >= 500 };
  } catch { result = { success: false, uncertain: true }; }
  // Success, refusal, timeout and network loss all require canonical readback.
  // Never optimistically alter defaults, enabled-model references or credentials.
  try { await reconcile(result); } catch { return { success: false, uncertain: true }; }
  return result;
}
