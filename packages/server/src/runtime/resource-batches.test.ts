import { describe, expect, it } from 'vitest';
import type { ResourceEnableOutcome } from '@ai-harness/core';
import { mergeResourceChanges, resourceChanges } from './resource-batches.js';

describe('exact resource batches', () => {
  it('requires unique bounded boolean selectors (never deduplicates conflicting requests)', () => {
    expect(resourceChanges([])).toEqual([]);
    expect(resourceChanges([{ key: 'provider:one', enabled: false }])).toEqual([{ key: 'provider:one', enabled: false }]);
    for (const input of [false, [{ key: 'same', enabled: false }, { key: 'same', enabled: true }],
      [{ key: 'control\n', enabled: true }], [{ key: 'x', enabled: null }]]) expect(() => resourceChanges(input)).toThrow();
  });
  it('does not materialize inherited settings on a no-op and preserves unavailable selectors', () => {
    const resources = [{ key: 'a:shared', alias: 'shared', defaultEnabled: true }, { key: 'b:shared', alias: 'shared', defaultEnabled: true }];
    const outcomes: ResourceEnableOutcome[] = [];
    const target = { thinking: 'low' } as const;
    expect(mergeResourceChanges(target, {}, 'enabledModels', resources, [{ key: 'a:shared', enabled: true }], outcomes)).toBe(target);
    expect(outcomes).toMatchObject([{ status: 'unchanged' }]);
    expect(mergeResourceChanges(target, { enabledModels: ['shared', 'future'] }, 'enabledModels', resources,
      [{ key: 'a:shared', enabled: false }], [])).toEqual({ thinking: 'low', enabledModels: ['future', 'b:shared'] });
  });
  it('preserves qualified keys when another model has an overlapping legacy ID', () => {
    const resources = [{ key: 'a:shared', alias: 'shared', defaultEnabled: true },
      { key: 'b:a:shared', alias: 'a:shared', defaultEnabled: true }];
    const target = {};
    const inherited = { enabledModels: ['a:shared', 'future'] };
    const outcomes: ResourceEnableOutcome[] = [];
    expect(mergeResourceChanges(target, inherited, 'enabledModels', resources,
      [{ key: 'b:a:shared', enabled: false }], outcomes)).toBe(target);
    expect(outcomes).toMatchObject([{ status: 'unchanged' }]);
    expect(mergeResourceChanges(target, inherited, 'enabledModels', resources,
      [{ key: 'b:a:shared', enabled: true }], [])).toEqual({ enabledModels: ['a:shared', 'future', 'b:a:shared'] });
    expect(mergeResourceChanges({ enabledModels: ['a:shared', 'b:a:shared', 'future'] }, {}, 'enabledModels', resources,
      [{ key: 'b:a:shared', enabled: false }], [])).toEqual({ enabledModels: ['a:shared', 'future'] });
  });
});
