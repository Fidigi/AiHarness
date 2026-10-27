import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createProviderCoverage } from './provider-coverage.mjs';
import { validateReference, ROWS_SHA256, sha256 } from './provider-reference.mjs';

const reference = JSON.parse(readFileSync(new URL('../fixtures/provider-reference.json', import.meta.url)));

describe('pinned MOD-01 typed catalogue coverage', () => {
  it('retains all 42 providers and 1,649 API/type identities under the approved hashes', () => {
    expect(validateReference(reference)).toEqual({ chat: 1554, classifier: 34, image: 61 });
    expect(reference.rowsSha256).toBe(ROWS_SHA256);
    expect(new Set(reference.rows.map(row => row[0])).size).toBe(42);
  });

  it('refuses missing rows, substituted identities and factory/catalogue provenance changes', () => {
    for (const change of [
      value => value.rows.pop(),
      value => { value.rows[0][1] = 'substituted-model'; value.rowsSha256 = sha256(JSON.stringify(value.rows)); },
      value => { value.files.openai.factory = '0'.repeat(64); },
      value => { value.files.openai.catalogue = '0'.repeat(64); },
      value => { value.manifestJson += ' '; },
    ]) {
      const changed = structuredClone(reference); change(changed);
      expect(() => validateReference(changed)).toThrow();
    }
  });

  it('maps every typed identity to real native declarations and independent passive host projections', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected census network request'));
    try {
      const report = await createProviderCoverage(reference);
      expect(report.rows.map(({ provider, model, api, type, declaredImages }) =>
        [provider, model, api, type, declaredImages])).toEqual(reference.rows);
      expect(Object.values(report.summary).slice(2).reduce((sum, count) => sum + count, 0)).toBe(1649);
      expect(report.summary.providers).toBe(42);
      const row = (provider, model, type) => report.rows.find(item => item.provider === provider && item.model === model && item.type === type);
      const chat = row('openai', 'gpt-6-luna', 'chat'), classifier = row('openai', 'gpt-6-luna', 'classifier');
      expect(chat.metadata).toMatchObject({ api: 'openai-responses', contextWindow: 272000 });
      expect(classifier.metadata).toMatchObject({ api: 'openai-decisions', contextWindow: 922000 });
      expect(classifier.operations).toMatchObject({ chat: false, classify: true, classifyQuestions: true, classifyNativeQuestions: true });
      expect(classifier.hosts.factory.apiMatch).toBe(false);
      expect(classifier.hosts.custom.nativeSpecializedDescriptor).toBe(true);
      expect(classifier.hosts.custom.modelAdmitted).toBe(false);
      const cloudflare = report.rows.find(item => item.provider === 'cloudflare-workers-ai' && item.type === 'classifier');
      expect(cloudflare.sdk).toMatchObject({ constructor: 'CloudflareWorkersAiProvider', nativeScalarQuestions: true });
      expect(cloudflare.hosts.custom.nativeScalarQuestions).toBe(false);
      const mistral = report.rows.find(item => item.provider === 'mistral');
      expect(mistral.hosts.factory.apiMatch).toBe(true); expect(mistral.hosts.automaticCli).toBeNull();
      expect(mistral.hosts.builtinChatRecord).toEqual({ slot: 'mistral-conversations', modelAdmitted: false });
      const cerebras = report.rows.find(item => item.provider === 'cerebras');
      expect(cerebras.hosts.automaticCli.apiMatch).toBe(true); expect(cerebras.hosts.custom.modelAdmitted).toBe(true);
      expect(cerebras.hosts.builtinChatRecord).toEqual({ slot: 'cerebras', modelAdmitted: false });
      expect(chat.hosts.builtinChatRecord).toEqual({ slot: 'openai', modelAdmitted: true });
      expect(report.rows.filter(item => item.provider === 'qwen-token-plan').every(item => item.coverage === 'missing' && item.sdk === null)).toBe(true);
      const refusedVision = report.rows.filter(item => item.provider === 'openrouter' && item.type === 'classifier' && item.declaredImages);
      expect(refusedVision).toHaveLength(6);
      expect(refusedVision.every(item => item.metadata.imageInput === false
        && item.coverage === 'transport-only-or-partial-profile' && item.operations.classify
        && item.operations.classifyNativeQuestions && !item.hosts.custom.nativeScalarQuestions)).toBe(true);
      expect(report.rows.filter(item => item.provider === 'nvidia' && item.metadata.pricing === null)).toHaveLength(19);
      const overlaps = report.rows.filter(item => item.provider === 'openrouter' && item.type === 'image');
      expect(overlaps.every(image => image.operations.generateNativeImages && !image.hosts.custom.nativeImageRequest)).toBe(true);
      expect(overlaps.some(image => report.rows.some(item => item.provider === image.provider && item.model === image.model
        && item.type === 'chat' && item.api !== image.api && item.sdk.apiMatch && image.sdk.apiMatch))).toBe(true);
      expect(network).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain('disposable-provider-coverage');
    } finally { network.mockRestore(); }
  }, 30_000);
});
