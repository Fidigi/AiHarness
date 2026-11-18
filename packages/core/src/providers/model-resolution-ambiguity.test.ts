import { describe, expect, it } from 'vitest';
import { resolveModelReference, resolveModelScope, type ModelIdentity } from './model-catalog.js';

const permutations = <T>(items: T[]): T[][] => items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(tail => [item, ...tail])) : [[]];
const base: ModelIdentity[] = [
  { provider: 'alpha', id: 'shared-model', name: 'Shared Model', available: true },
  { provider: 'beta', id: 'shared-model', name: 'Shared Model', available: true },
  { provider: 'gamma', id: 'shared-model', name: 'Shared Model', available: false },
];
describe('A3-CLI-09 model selection is not catalogue-order authority', () => {
  for (const models of permutations(base)) for (const reference of ['shared-model', 'Shared Model', 'shared']) {
    it(`${models.map(item => item.provider).join(',')}/${reference}: refuses multiple authenticated matches`, () => {
      expect(resolveModelReference(reference, models)).toMatchObject({ code: 'ambiguous' });
      expect(resolveModelReference(reference, models).model).toBeUndefined();
    });
  }
  for (const reference of ['shared-model', 'Shared Model', 'shared']) {
    it(`${reference}: chooses the sole configured provider, or refuses when none is configured`, () => {
      expect(resolveModelReference(reference, base.map(item => ({ ...item, available: item.provider === 'beta' }))).model?.provider).toBe('beta');
      expect(resolveModelReference(reference, base.map(item => ({ ...item, available: false })))).toMatchObject({ code: 'ambiguous' });
    });
  }
  it('preserves provider qualification, native colons, complete IDs and thinking suffixes', () => {
    const models = [...base, { provider: 'beta', id: 'shared:high', available: true }, { provider: 'router', id: 'alpha/shared-model', available: true }];
    expect(resolveModelReference('alpha/shared-model', models).model).toMatchObject({ provider: 'alpha', id: 'shared-model' });
    expect(resolveModelReference('shared:high', models)).toMatchObject({ model: { provider: 'beta', id: 'shared:high' } });
    expect(resolveModelReference('shared:high', models).thinkingLevel).toBeUndefined();
    expect(resolveModelReference('beta/shared-model:low', models)).toMatchObject({ model: { provider: 'beta', id: 'shared-model' }, thinkingLevel: 'low' });
    expect(resolveModelReference('shared', models, { provider: 'alpha' }).model?.provider).toBe('alpha');
  });
  it('expands a non-glob scope independently across all providers without losing first thinking pins', () => {
    const result = resolveModelScope(['shared-model:high', 'beta/shared-model:low', 'missing', '', 'shared'], base);
    expect(result.models.map(item => [item.model.provider, item.model.id, item.thinkingLevel])).toEqual([
      ['alpha', 'shared-model', 'high'], ['beta', 'shared-model', 'high'], ['gamma', 'shared-model', 'high'],
    ]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'no-match', pattern: 'missing' })]);
  });
  it('chooses each provider alias independently for a fuzzy scope and keeps explicit references constrained', () => {
    const models = ['alpha', 'beta'].flatMap(provider => [
      { provider, id: 'shared-model-20260101', available: true }, { provider, id: 'shared-model', available: true },
    ]);
    expect(resolveModelScope(['shared:low'], models).models.map(item => [item.model.provider, item.model.id, item.thinkingLevel])).toEqual([
      ['alpha', 'shared-model', 'low'], ['beta', 'shared-model', 'low'],
    ]);
    expect(resolveModelScope(['alpha/shared:low'], models).models.map(item => [item.model.provider, item.model.id])).toEqual([['alpha', 'shared-model']]);
    expect(resolveModelScope(['*/shared-model'], models).models).toHaveLength(2);
  });
});
