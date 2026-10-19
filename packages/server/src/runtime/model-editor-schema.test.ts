import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCustomModelEditorSchema } from '@ai-harness/core';
import { AiProxyServer } from '../api/proxy.js';
import { ProviderRegistryService } from './provider-registry.js';

const sdkRequire = createRequire(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'));
const Ajv2020 = sdkRequire('ajv/dist/2020.js').default;
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addKeyword({ keyword: 'x-maxUtf16CodeUnits', schemaType: 'number', valid: true });
const validate = ajv.compile(getCustomModelEditorSchema());
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-model-editor-')); roots.push(root);
  const proxy = new AiProxyServer(), file = path.join(root, 'providers.json');
  const service = new ProviderRegistryService(file, proxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
  await service.load(); return { root, file, service, proxy };
}

describe('public model editor metadata and existing native registry authority', () => {
  it('declares exactly nonsecret editable metadata, with versioned identity and no private-store format', () => {
    const schema = getCustomModelEditorSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema'); expect(schema.$id).toBe('urn:ai-harness:schemas:custom-model:1');
    expect(Object.keys(schema.properties as object).sort()).toEqual(['provider', 'id', 'name', 'capabilities', 'contextWindow', 'maxOutputTokens', 'pricing', 'compatibility'].sort());
    expect(schema.required).toEqual(['provider', 'id']); expect(schema.additionalProperties).toBe(false);
    expect(validate({ provider: 'mock', id: 'native-model' })).toBe(true);
    expect(validate({ version: 1, providers: [], models: [] })).toBe(false);
    for (const field of ['key', 'createdAt', 'updatedAt', 'apiKey', 'headers', 'credentialId', 'baseUrl', 'dialect']) {
      expect(validate({ provider: 'mock', id: 'native-model', [field]: 'NOT_MODEL_EDITOR_DATA' })).toBe(false);
    }
  });
  it('round-trips actual registration/persistence/reload without network/provider/tool work', async () => {
    const { service, proxy, file } = await fixture();
    const provider = vi.spyOn(proxy, 'getAgentProvider');
    const input = { provider: 'mock', id: 'native:model/percent% space é', name: 'Native editor example',
      capabilities: { reasoning: true, imageInput: false, toolCalls: false }, contextWindow: 100000000, maxOutputTokens: 1,
      pricing: { inputPerMillion: 0, outputPerMillion: 1.5, cacheReadPerMillion: 0.25, cacheWritePerMillion: 1000000 },
      compatibility: { text: 'literal', flag: false, count: 2.5 } };
    expect(validate(input)).toBe(true); const saved = await service.upsertModel(input);
    expect(saved).toMatchObject(input); expect(saved.key).toBe('mock:' + input.id); expect(provider).not.toHaveBeenCalled();
    const bytes = await readFile(file, 'utf8'); expect(JSON.parse(bytes).models).toEqual([JSON.parse(JSON.stringify(saved))]);
    const restored = new ProviderRegistryService(file, new AiProxyServer(), file + '.secrets', 'test-master-key-with-32-characters');
    await restored.load(); expect(restored.getModels()).toEqual([saved]);
  });
  it.each([
    { contextWindow: 1 }, { maxOutputTokens: 100000000 }, { pricing: { inputPerMillion: 0, outputPerMillion: 1000000 } },
    { contextWindow: null, maxOutputTokens: '', pricing: { inputPerMillion: null, outputPerMillion: '' } },
  ])('retains native positive numeric boundaries/default sentinels %#', async fields => {
    const { service } = await fixture(); const input = { provider: 'mock', id: 'numeric-boundary', ...fields };
    expect(validate(input)).toBe(true); await expect(service.upsertModel(input)).resolves.toMatchObject({ provider: 'mock', id: input.id });
  });
  it.each([
    { id: '' }, { id: '   ' }, { id: 'x\u0000y' }, { id: 'x'.repeat(501) }, { name: 'x\ny' },
    { contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: 1.5 }, { contextWindow: 100000001 },
    { maxOutputTokens: 0 }, { pricing: { inputPerMillion: -1 } }, { pricing: { outputPerMillion: 1000001 } }, { pricing: { cacheReadPerMillion: '1' } },
  ])('editor refuses and native registration rejects before persistence %#', async fields => {
    const { service } = await fixture(); const input = { provider: 'mock', id: 'invalid-boundary', ...fields };
    expect(validate(input)).toBe(false); await expect(service.upsertModel(input)).rejects.toMatchObject({ status: 400 });
    expect(service.getModels()).toEqual([]);
  });
  it('keeps provider membership stateful, including valid-shape unknown-provider refusal', async () => {
    const { service } = await fixture(); const input = { provider: 'not_registered', id: 'native-model' };
    expect(validate(input)).toBe(true); await expect(service.upsertModel(input)).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(service.getModels()).toEqual([]);
  });
  it.each([
    { capabilities: { toolCalls: 'false' } }, { capabilities: { unknown: true } },
    { compatibility: { nested: {} } }, { compatibility: { 'bad key': true } },
    { compatibility: { text: 'x'.repeat(1001) } }, { compatibility: Object.fromEntries(Array.from({ length: 51 }, (_, i) => ['key' + i, true])) },
  ])('flags noncanonical/coerced/ignored metadata without changing native compatibility %#', fields => {
    expect(validate({ provider: 'mock', id: 'native-model', ...fields })).toBe(false);
  });
  it('returns independently owned documents and discloses native UTF-16/normalization boundaries', async () => {
    const schema = getCustomModelEditorSchema();
    (schema.properties as Record<string, any>).capabilities.properties.toolCalls.type = 'string';
    (schema.required as string[]).length = 0;
    expect(ajv.compile({ ...getCustomModelEditorSchema(), $id: 'urn:ai-harness:schemas:custom-model:owned-test' })({ provider: 'mock', id: 'fresh', capabilities: { toolCalls: true } })).toBe(true);
    const unicode = { provider: 'mock', id: '😀'.repeat(251) }; expect(validate(unicode)).toBe(true);
    const { service } = await fixture(); await expect(service.upsertModel(unicode)).rejects.toMatchObject({ status: 400 });
    const canonical = { provider: 'mock', id: ' native-trim ' }; expect(validate(canonical)).toBe(true);
    expect((await service.upsertModel(canonical)).id).toBe('native-trim');
  });
});
