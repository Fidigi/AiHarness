import { describe, expect, it } from 'vitest';
import { MockProvider, type AiProvider } from '@ai-harness/core';
import { resolveStartupProvider } from './configured-providers.js';

const providers = () => new Map<string, AiProvider>(['alpha', 'beta'].map(name => [name, new MockProvider({ type: 'mock', model: 'shared-model' })]));
describe('A3-CLI-09 startup ambiguity and nonfatal scope diagnostics', () => {
  it.each(['shared-model', 'shared', 'shared:low'])('%s cannot be silently selected by a default provider', async reference => {
    await expect(resolveStartupProvider(providers(), { model: reference }, { AI_HARNESS_DEFAULT_PROVIDER: 'alpha' })).rejects.toThrow(/ambiguous/);
  });
  it('retains a nonfatal missing scope diagnostic alongside an admitted model', async () => {
    const selected = await resolveStartupProvider(providers(), { models: ['alpha/shared-model', 'missing'] }, {});
    expect(selected).toMatchObject({ providerName: 'alpha', model: 'shared-model', scopeDiagnostics: [{ code: 'no-match', pattern: 'missing' }] });
  });
  it('retains scope warnings when an explicit model overrides startup scope selection', async () => {
    const selected = await resolveStartupProvider(providers(), { model: 'alpha/shared-model', models: ['beta/shared-model', 'missing'] }, {});
    expect(selected).toMatchObject({ providerName: 'alpha', model: 'shared-model', scopeDiagnostics: [{ code: 'no-match', pattern: 'missing' }] });
  });
  it('expands a bare scope before applying the saved provider/model preference', async () => {
    const selected = await resolveStartupProvider(providers(), { models: ['shared:low'], preferredProvider: 'beta', preferredModel: 'shared-model' }, {});
    expect(selected).toMatchObject({ providerName: 'beta', model: 'shared-model', thinkingLevel: 'low' });
    expect(selected.scopeDiagnostics).toBeUndefined();
  });
  it('retains explicit qualification and a failed whole scope stays a failure', async () => {
    expect(await resolveStartupProvider(providers(), { model: 'beta/shared-model:high' }, {})).toMatchObject({ providerName: 'beta', model: 'shared-model', thinkingLevel: 'high' });
    await expect(resolveStartupProvider(providers(), { models: ['missing'] }, {})).rejects.toThrow(/not found/);
  });
});
