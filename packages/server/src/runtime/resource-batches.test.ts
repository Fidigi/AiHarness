import { describe, expect, it } from 'vitest';
import type { ResourceEnableOutcome } from '@ai-harness/core';
import { mergeResourceChanges, resourceChanges } from './resource-batches.js';
import { skillInvocationMarkdown } from './skill-markdown.js';

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

describe('skill Markdown mutations', () => {
  for (const newline of ['\n', '\r\n']) it(`retains body, BOM, comments and unrelated frontmatter (${JSON.stringify(newline)})`, () => {
    const source = '\uFEFF' + ['---', 'name: valid', 'description: "A useful skill"', '# keep', 'version: 1', '---', '', '# Body', 'disable-model-invocation: body text', ''].join(newline);
    const disabled = skillInvocationMarkdown(source, 'valid', false);
    expect(disabled).toBe(source.replace(`version: 1${newline}`, `version: 1${newline}disable-model-invocation: true${newline}`));
    expect(skillInvocationMarkdown(disabled, 'valid', false)).toBe(disabled);
    expect(skillInvocationMarkdown(disabled, 'valid', true)).toBe(disabled.replace('disable-model-invocation: true', 'disable-model-invocation: false'));
    expect(skillInvocationMarkdown(source, 'valid', true)).toBe(source);
  });
  it('rejects absent, duplicate, malformed or incomplete metadata and never changes body-only flags', () => {
    for (const source of ['# no metadata', '---\nname: valid\n---\nbody', '---\nname: valid\nname: valid\ndescription: x\n---\nbody',
      '---\nname: other\ndescription: x\n---\nbody', '---\nname: valid\ndescription: x\ndisable-model-invocation: yes\n---\nbody',
      '---\nname: valid\ndescription: x\n---\n']) expect(() => skillInvocationMarkdown(source, 'valid', false)).toThrow();
  });
});
