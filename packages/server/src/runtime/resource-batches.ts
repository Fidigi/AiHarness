import type { ScopedConfigurationValues } from '@ai-harness/core';
import type { ResourceEnableChange, ResourceEnableOutcome } from '@ai-harness/core';

export function resourceBatchBody(input: unknown, fields: string[]): ResourceEnableChange[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'changes' && !fields.includes(key))) invalid();
  return resourceChanges((input as Record<string, unknown>).changes);
}

export function resourceChanges(input: unknown): ResourceEnableChange[] {
  if (!Array.isArray(input) || input.length > 500) invalid();
  const keys = new Set<string>();
  return input.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some(key => key !== 'key' && key !== 'enabled')
      || typeof entry.key !== 'string' || !entry.key.length || entry.key.length > 500
      || /[\u0000-\u001f\u007f]/.test(entry.key) || typeof entry.enabled !== 'boolean'
      || keys.has(entry.key)) invalid();
    keys.add(entry.key);
    return { key: entry.key, enabled: entry.enabled };
  });
}

function invalid(): never {
  throw Object.assign(new Error('Batch must contain at most 500 unique resource selectors and boolean states.'),
    { status: 400, code: 'INVALID_RESOURCE_BATCH' });
}

/** Merge against the fresh inherited list, retaining unavailable/filtered selectors.
 * Expand legacy name/id aliases before changing one qualified selector so siblings
 * with the same id/name do not accidentally change too. For models, a known
 * qualified key wins over an overlapping legacy ID, matching catalogue reads.
 */
export function mergeResourceChanges(
  target: ScopedConfigurationValues,
  inherited: ScopedConfigurationValues,
  field: 'enabledModels' | 'enabledSkills',
  resources: { key: string; alias: string; defaultEnabled: boolean }[],
  changes: ResourceEnableChange[],
  outcomes: ResourceEnableOutcome[],
): ScopedConfigurationValues {
  const known = new Map(resources.map(resource => [resource.key, resource]));
  const configured = target[field] ?? inherited[field];
  const before = new Set(configured ?? resources.filter(resource => resource.defaultEnabled).map(resource => resource.key));
  const enabled = new Set(before);
  const changed: ResourceEnableChange[] = [];
  for (const change of changes) {
    const resource = known.get(change.key);
    if (!resource) {
      outcomes.push({ ...change, status: 'failed', code: 'UNKNOWN_RESOURCE' });
      continue;
    }
    const aliasApplies = field !== 'enabledModels' || !known.has(resource.alias);
    const current = before.has(change.key) || (aliasApplies && before.has(resource.alias));
    outcomes.push({ ...change, status: current === change.enabled ? 'unchanged' : 'changed' });
    if (current !== change.enabled) changed.push(change);
  }
  if (!changed.length) return target;
  for (const change of changed) {
    const alias = known.get(change.key)!.alias;
    if ((field !== 'enabledModels' || !known.has(alias)) && enabled.delete(alias)) {
      for (const resource of resources) if (resource.alias === alias) enabled.add(resource.key);
    }
    if (change.enabled) enabled.add(change.key);
    else enabled.delete(change.key);
  }
  return { ...target, [field]: [...enabled] };
}
