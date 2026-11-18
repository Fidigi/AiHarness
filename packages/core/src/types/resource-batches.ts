import type { ModelCatalog, SkillCatalog } from './index.js';

/** Exact displayed selectors; a request never replaces the entire enabled list. */
export interface ResourceEnableChange {
  key: string;
  enabled: boolean;
}

export interface ResourceEnableOutcome extends ResourceEnableChange {
  status: 'changed' | 'unchanged' | 'failed';
  code?: string;
}

export interface ModelEnableBatchResult {
  outcomes: ResourceEnableOutcome[];
  catalog: ModelCatalog;
}

export interface SkillEnableBatchResult {
  outcomes: ResourceEnableOutcome[];
  catalog: SkillCatalog;
}
