import type { ModelEnableBatchResult, ResourceEnableChange, SkillEnableBatchResult } from '@ai-harness/core';
import { apiFetch } from './api';

async function batch<T>(resource: 'models' | 'skills', body: unknown): Promise<T> {
  const response = await apiFetch(`/api/${resource}/enabled/batch`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result as T;
}

export function updateModelBatch(changes: ResourceEnableChange[], projectId?: string): Promise<ModelEnableBatchResult> {
  return batch('models', { changes, ...(projectId ? { projectId } : {}) });
}

export function updateSkillBatch(changes: ResourceEnableChange[], cwd?: string, projectId?: string): Promise<SkillEnableBatchResult> {
  return batch('skills', { changes, ...(cwd ? { cwd } : {}), ...(projectId ? { projectId } : {}) });
}
