import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CerebrasProvider, DeepSeekProvider, GroqProvider, ZaiProvider, MoonshotProvider, NvidiaProvider, EncryptedCredentialStore,
  AntLingProvider, BasetenProvider, FireworksProvider, HuggingFaceProvider, KimiCodingProvider, MetaProvider,
  MiniMaxProvider, MiniMaxCnProvider, OpenCodeGoProvider, OpenCodeProvider, TogetherProvider, XaiProvider, XiaomiProvider, MoonshotCnProvider,
  QwenTokenPlanProvider, QwenTokenPlanCnProvider, QwenTokenPlanIndividualProvider,
  XiaomiTokenPlanAmsProvider, XiaomiTokenPlanCnProvider, XiaomiTokenPlanSgpProvider, ZaiCodingCnProvider } from '@ai-harness/core';
import { AiProxyServer } from '../api/proxy.js';
import { ProviderRegistryService } from './provider-registry.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-registry-'));
  roots.push(root);
  const proxy = new AiProxyServer();
  const service = new ProviderRegistryService(
    path.join(root, 'providers.json'), proxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters',
  );
  await service.load();
  return { root, proxy, service };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('ProviderRegistryService', () => {
  it.each([
    ['ant-ling', AntLingProvider, 3], ['baseten', BasetenProvider, 22], ['fireworks', FireworksProvider, 22],
    ['huggingface', HuggingFaceProvider, 78], ['kimi-coding', KimiCodingProvider, 4], ['meta', MetaProvider, 6],
    ['minimax', MiniMaxProvider, 3], ['minimax-cn', MiniMaxCnProvider, 3], ['opencode-go', OpenCodeGoProvider, 31],
    ['opencode', OpenCodeProvider, 83], ['together', TogetherProvider, 17], ['xai', XaiProvider, 4],
    ['xiaomi', XiaomiProvider, 6], ['moonshot-cn', MoonshotCnProvider, 4],
    ['qwen-token-plan', QwenTokenPlanProvider, 20], ['qwen-token-plan-cn', QwenTokenPlanCnProvider, 20],
    ['qwen-token-plan-individual', QwenTokenPlanIndividualProvider, 9], ['xiaomi-token-plan-ams', XiaomiTokenPlanAmsProvider, 4],
    ['xiaomi-token-plan-cn', XiaomiTokenPlanCnProvider, 4], ['xiaomi-token-plan-sgp', XiaomiTokenPlanSgpProvider, 4], ['zai-coding-cn', ZaiCodingCnProvider, 4],
  ] as const)('composes %s through encrypted native registry lifecycle without discovery or borrowed model admission', async (dialect, Adapter, count) => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected discovery'));
    const id = 'owned-native', key = 'synthetic-native-first', rotated = 'synthetic-native-rotated';
    await service.upsertProvider({ id, name: 'Owned native', dialect, apiKey: key, baseUrl: 'http://127.0.0.1/owned/v1' });
    const provider = proxy.getAgentProvider(id)!;
    expect(provider).toBeInstanceOf(Adapter);
    const model = provider.getConfiguredModel()!;
    const original = provider.getPublishedModels?.()?.find(row => row.id === model)!;
    expect(provider.getPublishedModels?.()).toHaveLength(count);
    const override = await service.upsertModel({ provider: id, id: model, name: 'Operator name', contextWindow: 777 });
    const imported = await service.importProviderModels(id);
    expect(imported).toHaveLength(count);
    expect(imported.find(row => row.id === model)).toEqual(override);
    expect(original.id).toBe(model);
    await expect(service.testProvider(id)).rejects.toMatchObject({ status: 409 });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8');
    const beforeSecrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertModel({ provider: id, id: 'future/private' })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before);
    expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(beforeSecrets);
    await service.upsertProvider({ apiKey: rotated }, id);
    expect(proxy.getAgentProvider(id)).toBeInstanceOf(Adapter);
    expect(proxy.getAgentProvider(id)).not.toBe(provider);
    const restoredProxy = new AiProxyServer();
    const restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load();
    expect(restoredProxy.getAgentProvider(id)).toBeInstanceOf(Adapter);
    expect(restored.getModels()).toEqual(service.getModels());
    expect(restored.listProviders()).toContainEqual(expect.objectContaining({ id, dialect, configured: true }));
    for (const secret of [key, rotated]) {
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).not.toContain(secret);
      expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).not.toContain(secret);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('imports native R profile fields without confusing D context or replacing explicit operator metadata', async () => {
    const { root, service, proxy } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    await service.upsertProvider({ id: 'oa-profile', name: 'Native profiles', baseUrl: 'https://models.example/v1', dialect: 'openai', apiKey: 'disposable-profile-key' });
    const override = await service.upsertModel({ provider: 'oa-profile', id: 'gpt-4o', name: 'Operator GPT', contextWindow: 777, maxOutputTokens: 44,
      capabilities: { reasoning: false, imageInput: false, toolCalls: false }, pricing: { inputPerMillion: 999 } });
    const imported = await service.importProviderModels('oa-profile'); expect(imported).toHaveLength(44);
    expect(imported.find(model => model.id === 'gpt-6-luna')).toMatchObject({ name: 'GPT-6 Luna', contextWindow: 272000, maxOutputTokens: 128000,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125 } });
    expect(imported.find(model => model.id === 'o3-mini')?.capabilities.imageInput).toBe(false);
    expect(imported.find(model => model.id === 'gpt-4o')).toEqual(override);
    expect(proxy.getAgentProvider('oa-profile')?.getSpecializedModels()).toContainEqual(expect.objectContaining({ id: 'gpt-6-luna', api: 'openai-decisions', contextWindow: 922000 }));
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(imported)).not.toContain('disposable-profile-key');
    const snapshot = service.getModels(), revision = service.getRevision();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const originalLoad = service.load.bind(service);
    const load = vi.spyOn(service, 'load').mockImplementationOnce(async () => { entered(); await held; await originalLoad(); });
    const reload = service.reload(); await started;
    try {
      expect(service.getModels()).toEqual(snapshot); expect(service.getRevision()).toBe(revision);
      expect(service.listProviders()).toContainEqual(expect.objectContaining({ id: 'oa-profile', modelCount: 44 }));
    } finally { release(); await reload; load.mockRestore(); }
    expect(service.getModels()).toEqual(snapshot);
    await rm(path.join(root, 'providers.json')); await service.reload();
    expect(service.getModels()).toEqual([]); expect(service.listProviders()).toEqual([]); expect(proxy.getAgentProvider('oa-profile')).toBeUndefined();
  });
  it('restores explicit native NVIDIA hosts with21-profile admission and unknown prices before mutation', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const baseline = 'deepseek-ai/deepseek-v4.1-flash', large = 'moonshotai/kimi-k3', priced = 'nvidia/nemotron-3-super-120b-a12b', ultra = 'nvidia/nemotron-3-ultra-550b-a55b';
    const ids = ["deepseek-ai/deepseek-v4.1-flash","google/diffusiongemma-26b-a4b-it","google/gemma-3-12b-it","google/gemma-3-4b-it","meta/llama-3.2-11b-vision-instruct","meta/llama-3.2-90b-vision-instruct","meta/muse-glimmer-30b","mistralai/mistral-7b-instruct-v0.3","moonshotai/kimi-k2.6","moonshotai/kimi-k3","nvidia/cosmos-reason2-8b","nvidia/llama-3.1-nemotron-70b-instruct","nvidia/llama-3.1-nemotron-ultra-253b-v1","nvidia/nemotron-3-nano-omni-30b-a3b-reasoning","nvidia/nemotron-3-super-120b-a12b","nvidia/nemotron-3-ultra-550b-a55b","nvidia/nemotron-3.5-lightning-30b-a3b","openai/gpt-oss-20b","poolside/laguna-xs-2.1","z-ai/glm-5.3","z-ai/glm-5.3-flash"];
    await service.upsertProvider({ id: 'nv-native', name: 'Native NVIDIA', baseUrl: 'https://models.example/proxy%2Fowned/v1/chat/completions', dialect: 'nvidia', apiKey: 'disposable-nv-key' });
    const initial = proxy.getAgentProvider('nv-native')!;
    expect(initial).toBeInstanceOf(NvidiaProvider); expect(initial.getConfiguredModel()).toBe(baseline);
    const published = initial.getPublishedModels?.()!; expect(published).toHaveLength(21); expect(published.filter(model => model.pricing !== undefined)).toHaveLength(2);
    const override = await service.upsertModel({ provider: 'nv-native', id: large, name: 'Operator Kimi', contextWindow: 777, maxOutputTokens: 44,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 999 } });
    expect(proxy.getAgentProvider('nv-native')).toBe(initial); expect(initial.getConfiguredModel()).toBe(baseline);
    await service.upsertProvider({ apiKey: 'disposable-nv-replaced' }, 'nv-native');
    const selected = proxy.getAgentProvider('nv-native')!;
    expect(selected).toBeInstanceOf(NvidiaProvider); expect(selected.getConfiguredModel()).toBe(large);
    expect(selected.getSpecializedModels()).toEqual([expect.objectContaining({ id: large + ':classifier', model: large, api: 'openai-completions', contextWindow: 1048576, imageInput: true, virtual: true })]);
    expect(selected.getSpecializedModels()[0]?.pricing).toBeUndefined();
    const imported = await service.importProviderModels('nv-native'); expect(imported.map(model => model.id).sort()).toEqual([...ids].sort());
    expect(imported.find(model => model.id === large)).toEqual(override);
    expect(imported.find(model => model.id === baseline)).toMatchObject({ name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxOutputTokens: 384000,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true } });
    expect(imported.find(model => model.id === priced)).toMatchObject({ name: 'Nemotron 3 Super', contextWindow: 262144, maxOutputTokens: 262144,
      capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.2, outputPerMillion: 0.8, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    expect(imported.find(model => model.id === ultra)).toMatchObject({ name: 'Nemotron 3 Ultra 550B A55B', contextWindow: 1000000, maxOutputTokens: 65536,
      capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0 } });
    for (const id of ids.filter(id => ![large, priced, ultra].includes(id))) expect(imported.find(model => model.id === id)?.pricing).toBeUndefined();
    await expect(service.testProvider('nv-native')).rejects.toMatchObject({ status: 409, message: 'Provider does not support connection discovery.' });
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    for (const id of ['future/private', 'kimi-k3', '~typesafe/jev']) {
      await expect(service.upsertModel({ provider: 'nv-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'Nvidia chat model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    }
    await service.upsertProvider({ id: 'legacy-nv', name: 'Legacy C', baseUrl: 'https://models.example/v1', dialect: 'openai-completions', apiKey: 'disposable-legacy-nv' });
    await service.upsertModel({ provider: 'legacy-nv', id: 'future/private' });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8'), beforeSecrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'nvidia', apiKey: 'must-not-replace' }, 'legacy-nv')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(beforeSecrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load(); expect(restoredProxy.getAgentProvider('nv-native')).toBeInstanceOf(NvidiaProvider);
    expect(restoredProxy.getAgentProvider('nv-native')?.getConfiguredModel()).toBe(baseline); expect(restoredProxy.getAgentProvider('nv-native')?.getSpecializedModels()).toHaveLength(1);
    expect(metadata).not.toContain('disposable-nv'); expect(secrets).not.toContain('disposable-nv'); expect(fetch).not.toHaveBeenCalled();
  });
  it('restores explicit native Moonshot hosts with four-profile admission before mutation', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const baseline = 'kimi-k2.6', large = 'kimi-k2.7-code', vision = 'kimi-k3';
    const ids = [baseline, large, 'kimi-k2.7-code-highspeed', vision];
    await service.upsertProvider({ id: 'ms-native', name: 'Native Moonshot', baseUrl: 'https://models.example/proxy%2Fowned/v1/chat/completions', dialect: 'moonshot', apiKey: 'disposable-ms-key' });
    const initial = proxy.getAgentProvider('ms-native')!;
    expect(initial).toBeInstanceOf(MoonshotProvider); expect(initial.getConfiguredModel()).toBe(baseline);
    const override = await service.upsertModel({ provider: 'ms-native', id: large, name: 'Operator Kimi', contextWindow: 777, maxOutputTokens: 44,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 999 } });
    expect(proxy.getAgentProvider('ms-native')).toBe(initial); expect(initial.getConfiguredModel()).toBe(baseline);
    await service.upsertProvider({ apiKey: 'disposable-ms-replaced' }, 'ms-native');
    const selected = proxy.getAgentProvider('ms-native')!;
    expect(selected).toBeInstanceOf(MoonshotProvider); expect(selected.getConfiguredModel()).toBe(large);
    expect(selected.getSpecializedModels()).toEqual([expect.objectContaining({ id: `${large}:classifier`, model: large, api: 'openai-completions', contextWindow: 262144, imageInput: true, virtual: true })]);
    const imported = await service.importProviderModels('ms-native'); expect(imported.map(model => model.id).sort()).toEqual([...ids].sort());
    expect(imported.find(model => model.id === large)).toEqual(override);
    expect(imported.find(model => model.id === baseline)).toMatchObject({ name: 'Kimi K2.6', contextWindow: 262144, maxOutputTokens: 262144,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.16, cacheWritePerMillion: 0 } });
    expect(imported.find(model => model.id === vision)).toMatchObject({ name: 'Kimi K3', contextWindow: 1048576, maxOutputTokens: 1048576,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0 } });
    await expect(service.testProvider('ms-native')).rejects.toMatchObject({ status: 409, message: 'Provider does not support connection discovery.' });
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    for (const id of ['future/private', 'kimi-old', '~typesafe/jev']) {
      await expect(service.upsertModel({ provider: 'ms-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'Moonshot chat model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    }
    await service.upsertProvider({ id: 'legacy-ms', name: 'Legacy C', baseUrl: 'https://models.example/v1', dialect: 'openai-completions', apiKey: 'disposable-legacy-ms' });
    await service.upsertModel({ provider: 'legacy-ms', id: 'future/private' });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8'), beforeSecrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'moonshot', apiKey: 'must-not-replace' }, 'legacy-ms')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(beforeSecrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load(); expect(restoredProxy.getAgentProvider('ms-native')).toBeInstanceOf(MoonshotProvider);
    expect(restoredProxy.getAgentProvider('ms-native')?.getConfiguredModel()).toBe(baseline); expect(restoredProxy.getAgentProvider('ms-native')?.getSpecializedModels()).toHaveLength(1);
    expect(metadata).not.toContain('disposable-ms'); expect(secrets).not.toContain('disposable-ms'); expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps an explicit CN Moonshot endpoint through key replacement and encrypted reload', async () => {
    const { root, proxy, service } = await fixture();
    const id = 'regional-host', baseUrl = 'https://api.moonshot.cn/v1';
    const firstKey = 'disposable-cn-first', rotatedKey = 'disposable-cn-rotated';
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'CN fixture reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await service.upsertProvider({ id, name: 'Explicit regional endpoint', baseUrl, dialect: 'moonshot', apiKey: firstKey });
    const initial = proxy.getAgentProvider(id)!;
    expect(initial).toBeInstanceOf(MoonshotProvider);
    expect((await service.importProviderModels(id)).map(model => model.id).sort())
      .toEqual(['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k3']);
    await expect(service.testProvider(id)).rejects.toMatchObject({ status: 409 });
    expect(fetch).not.toHaveBeenCalled();
    const message = { id: 'cn-host-control', timestamp: new Date(0), role: 'user' as const, content: 'CN host control' };
    expect((await initial.chat([message], { maxTokens: 64 })).content).toBe('CN fixture reply');
    await service.upsertProvider({ apiKey: rotatedKey }, id);
    const replaced = proxy.getAgentProvider(id)!;
    expect(replaced).not.toBe(initial); expect(replaced).toBeInstanceOf(MoonshotProvider);
    expect(service.listProviders()).toContainEqual(expect.objectContaining({ id, baseUrl, dialect: 'moonshot', configured: true }));
    await replaced.chat([message], { maxTokens: 64 });
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(
      path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters',
    );
    await restored.load();
    expect(restored.listProviders()).toContainEqual(expect.objectContaining({ id, baseUrl, dialect: 'moonshot', configured: true, modelCount: 4 }));
    const reloaded = restoredProxy.getAgentProvider(id)!;
    expect(reloaded).toBeInstanceOf(MoonshotProvider);
    await reloaded.chat([message], { maxTokens: 64 });
    expect(requests).toEqual([
      { url: `${baseUrl}/chat/completions`, authorization: `Bearer ${firstKey}` },
      { url: `${baseUrl}/chat/completions`, authorization: `Bearer ${rotatedKey}` },
      { url: `${baseUrl}/chat/completions`, authorization: `Bearer ${rotatedKey}` },
    ]);
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    for (const key of [firstKey, rotatedKey]) { expect(metadata).not.toContain(key); expect(secrets).not.toContain(key); }
  });
  it('restores explicit native Z.ai hosts with seven-profile admission and unknown highspeed prices before mutation', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const baseline = 'glm-4.7', large = 'glm-5.2', vision = 'glm-5.3-flash';
    const ids = [baseline, 'glm-5-turbo', large, 'glm-5.2-highspeed', 'glm-5.3', vision, 'glm-5.3-highspeed'];
    await service.upsertProvider({ id: 'za-native', name: 'Native Z.ai', baseUrl: 'https://models.example/proxy%2Fowned/v1/chat/completions', dialect: 'zai', apiKey: 'disposable-za-key' });
    const initial = proxy.getAgentProvider('za-native')!;
    expect(initial).toBeInstanceOf(ZaiProvider); expect(initial.getConfiguredModel()).toBe(baseline);
    const override = await service.upsertModel({ provider: 'za-native', id: large, name: 'Operator GLM', contextWindow: 777, maxOutputTokens: 44,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 999 } });
    expect(proxy.getAgentProvider('za-native')).toBe(initial); expect(initial.getConfiguredModel()).toBe(baseline);
    await service.upsertProvider({ apiKey: 'disposable-za-replaced' }, 'za-native');
    const selected = proxy.getAgentProvider('za-native')!;
    expect(selected).toBeInstanceOf(ZaiProvider); expect(selected.getConfiguredModel()).toBe(large);
    expect(selected.getSpecializedModels()).toEqual([expect.objectContaining({ id: `${large}:classifier`, model: large, api: 'openai-completions', contextWindow: 1000000, imageInput: false, virtual: true })]);
    const imported = await service.importProviderModels('za-native'); expect(imported.map(model => model.id).sort()).toEqual([...ids].sort());
    expect(imported.find(model => model.id === large)).toEqual(override);
    expect(imported.find(model => model.id === baseline)).toMatchObject({ name: 'GLM-4.7', contextWindow: 204800, maxOutputTokens: 131072,
      capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.6, outputPerMillion: 2.2, cacheReadPerMillion: 0.11, cacheWritePerMillion: 0 } });
    expect(imported.find(model => model.id === vision)).toMatchObject({ name: 'GLM-5.3-Flash', contextWindow: 1000000, maxOutputTokens: 131072,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.15, outputPerMillion: 0.5, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0 } });
    for (const id of ['glm-5.2-highspeed', 'glm-5.3-highspeed']) expect(imported.find(model => model.id === id)?.pricing).toBeUndefined();
    await expect(service.testProvider('za-native')).rejects.toMatchObject({ status: 409, message: 'Provider does not support connection discovery.' });
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    for (const id of ['future/private', 'glm-4-plus', '~typesafe/jev']) {
      await expect(service.upsertModel({ provider: 'za-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'Z.ai chat model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    }
    await service.upsertProvider({ id: 'legacy-za', name: 'Legacy C', baseUrl: 'https://models.example/v1', dialect: 'openai-completions', apiKey: 'disposable-legacy-za' });
    await service.upsertModel({ provider: 'legacy-za', id: 'future/private' });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8'), beforeSecrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'zai', apiKey: 'must-not-replace' }, 'legacy-za')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(beforeSecrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load(); expect(restoredProxy.getAgentProvider('za-native')).toBeInstanceOf(ZaiProvider);
    expect(restoredProxy.getAgentProvider('za-native')?.getConfiguredModel()).toBe(baseline); expect(restoredProxy.getAgentProvider('za-native')?.getSpecializedModels()).toHaveLength(1);
    expect(metadata).not.toContain('disposable-za'); expect(secrets).not.toContain('disposable-za'); expect(fetch).not.toHaveBeenCalled();
  });
  it('restores explicit native Groq hosts with seven-profile admission before secret or metadata replacement', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const llama = 'llama-3.1-8b-instant', gpt = 'openai/gpt-oss-120b', qwen = 'qwen/qwen3.8-27b';
    const ids = [llama, 'llama-3.3-70b-versatile', gpt, 'openai/gpt-oss-20b', 'openai/gpt-oss-safeguard-20b', 'qwen/qwen3.6-27b', qwen];
    await service.upsertProvider({ id: 'gq-native', name: 'Native Groq', baseUrl: 'https://models.example/proxy%2Fowned/v1/chat/completions', dialect: 'groq', apiKey: 'disposable-gq-key' });
    const initial = proxy.getAgentProvider('gq-native')!;
    expect(initial).toBeInstanceOf(GroqProvider); expect(initial.getConfiguredModel()).toBe(llama);
    const override = await service.upsertModel({ provider: 'gq-native', id: gpt, name: 'Operator GPT', contextWindow: 777, maxOutputTokens: 44,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 999 } });
    expect(proxy.getAgentProvider('gq-native')).toBe(initial); expect(initial.getConfiguredModel()).toBe(llama);
    await service.upsertProvider({ apiKey: 'disposable-gq-replaced' }, 'gq-native');
    const selected = proxy.getAgentProvider('gq-native')!;
    expect(selected).toBeInstanceOf(GroqProvider); expect(selected.getConfiguredModel()).toBe(gpt);
    expect(selected.getSpecializedModels()).toEqual([expect.objectContaining({ id: `${gpt}:classifier`, model: gpt, api: 'openai-completions', contextWindow: 131072, imageInput: false, virtual: true })]);
    const imported = await service.importProviderModels('gq-native'); expect(imported.map(model => model.id).sort()).toEqual([...ids].sort());
    expect(imported.find(model => model.id === gpt)).toEqual(override);
    expect(imported.find(model => model.id === llama)).toMatchObject({ name: 'Llama 3.1 8B', contextWindow: 131072, maxOutputTokens: 131072,
      capabilities: { reasoning: false, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.05, outputPerMillion: 0.08, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    expect(imported.find(model => model.id === qwen)).toMatchObject({ name: 'Qwen3.8 27B', contextWindow: 131042, maxOutputTokens: 16384,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    await expect(service.testProvider('gq-native')).rejects.toMatchObject({ status: 409, message: 'Provider does not support connection discovery.' });
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    for (const id of ['future/private', 'mixtral-8x7b-32768', '~typesafe/jev']) {
      await expect(service.upsertModel({ provider: 'gq-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'Groq chat model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    }
    await service.upsertProvider({ id: 'legacy-gq', name: 'Legacy C', baseUrl: 'https://models.example/v1', dialect: 'openai-completions', apiKey: 'disposable-legacy-gq' });
    await service.upsertModel({ provider: 'legacy-gq', id: 'future/private' });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8'), beforeSecrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'groq', apiKey: 'must-not-replace' }, 'legacy-gq')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(beforeSecrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load(); expect(restoredProxy.getAgentProvider('gq-native')).toBeInstanceOf(GroqProvider);
    expect(restoredProxy.getAgentProvider('gq-native')?.getConfiguredModel()).toBe(llama); expect(restoredProxy.getAgentProvider('gq-native')?.getSpecializedModels()).toHaveLength(1);
    expect(metadata).not.toContain('disposable-gq'); expect(secrets).not.toContain('disposable-gq'); expect(fetch).not.toHaveBeenCalled();
  });
  it('restores explicit native DeepSeek hosts with two-profile admission before secret or metadata replacement', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const flash = 'deepseek-flash', pro = 'deepseek-v4-pro';
    await service.upsertProvider({ id: 'ds-native', name: 'Native DeepSeek', baseUrl: 'https://models.example/proxy%2Fowned/v1/chat/completions', dialect: 'deepseek', apiKey: 'disposable-ds-key' });
    const initial = proxy.getAgentProvider('ds-native')!;
    expect(initial).toBeInstanceOf(DeepSeekProvider); expect(initial.getConfiguredModel()).toBe(flash);
    const override = await service.upsertModel({ provider: 'ds-native', id: pro, name: 'Operator Pro', contextWindow: 777, maxOutputTokens: 44,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 999 } });
    expect(proxy.getAgentProvider('ds-native')).toBe(initial); expect(initial.getConfiguredModel()).toBe(flash);
    await service.upsertProvider({ apiKey: 'disposable-ds-replaced' }, 'ds-native');
    const selected = proxy.getAgentProvider('ds-native')!;
    expect(selected).toBeInstanceOf(DeepSeekProvider); expect(selected.getConfiguredModel()).toBe(pro);
    expect(selected.getSpecializedModels()).toEqual([expect.objectContaining({ id: `${pro}:classifier`, model: pro, api: 'openai-completions', contextWindow: 1000000, virtual: true })]);
    expect(selected.getSpecializedModels()[0]?.imageInput).not.toBe(true);
    const imported = await service.importProviderModels('ds-native'); expect(imported).toHaveLength(2);
    expect(imported.find(model => model.id === pro)).toEqual(override);
    expect(imported.find(model => model.id === flash)).toMatchObject({ name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxOutputTokens: 384000,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006, cacheWritePerMillion: 0 } });
    await expect(service.testProvider('ds-native')).rejects.toMatchObject({ status: 409, message: 'Provider does not support connection discovery.' });
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    for (const id of ['future/private', 'deepseek-chat', '~typesafe/jev']) {
      await expect(service.upsertModel({ provider: 'ds-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'DeepSeek chat model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    }
    await service.upsertProvider({ id: 'legacy-ds', name: 'Legacy C', baseUrl: 'https://models.example/v1', dialect: 'openai-completions', apiKey: 'disposable-legacy-ds' });
    await service.upsertModel({ provider: 'legacy-ds', id: 'future/private' });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8'), beforeSecrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'deepseek', apiKey: 'must-not-replace' }, 'legacy-ds')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(beforeSecrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load(); expect(restoredProxy.getAgentProvider('ds-native')).toBeInstanceOf(DeepSeekProvider);
    expect(restoredProxy.getAgentProvider('ds-native')?.getConfiguredModel()).toBe(flash); expect(restoredProxy.getAgentProvider('ds-native')?.getSpecializedModels()).toHaveLength(1);
    expect(metadata).not.toContain('disposable-ds'); expect(secrets).not.toContain('disposable-ds'); expect(fetch).not.toHaveBeenCalled();
  });
  it('restores explicit native Cerebras hosts with two-profile admission and no discovery certificate', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const qwen = 'qwen-3.8-27b', gpt = 'gpt-oss-120b';
    await service.upsertProvider({ id: 'cb-native', name: 'Native Cerebras', baseUrl: 'https://models.example/proxy%2Fowned/v1/chat/completions', dialect: 'cerebras', apiKey: 'disposable-cb-key' });
    const initial = proxy.getAgentProvider('cb-native')!;
    expect(initial).toBeInstanceOf(CerebrasProvider); expect(initial.getConfiguredModel()).toBe(gpt);
    const override = await service.upsertModel({ provider: 'cb-native', id: qwen, name: 'Operator Qwen', contextWindow: 777, maxOutputTokens: 44,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 999 } });
    expect(proxy.getAgentProvider('cb-native')).toBe(initial); expect(initial.getConfiguredModel()).toBe(gpt);
    await service.upsertProvider({ apiKey: 'disposable-cb-replaced' }, 'cb-native');
    const selected = proxy.getAgentProvider('cb-native')!;
    expect(selected).toBeInstanceOf(CerebrasProvider); expect(selected.getConfiguredModel()).toBe(qwen);
    expect(selected.getSpecializedModels()).toEqual([expect.objectContaining({ id: `${qwen}:classifier`, model: qwen, api: 'openai-completions', imageInput: true, contextWindow: 131072, virtual: true })]);
    const imported = await service.importProviderModels('cb-native'); expect(imported).toHaveLength(2);
    expect(imported.find(model => model.id === qwen)).toEqual(override);
    expect(imported.find(model => model.id === gpt)).toMatchObject({ name: 'GPT OSS 120B', contextWindow: 131072, maxOutputTokens: 40960,
      capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.35, outputPerMillion: 0.75, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    expect(selected.getConfiguredModel()).toBe(qwen); expect(selected.getPublishedModels?.()).toHaveLength(2);
    await expect(service.testProvider('cb-native')).rejects.toMatchObject({ status: 409, message: 'Provider does not support connection discovery.' });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8');
    for (const id of ['future/private', 'qwen3-32b', '~typesafe/jev']) {
      await expect(service.upsertModel({ provider: 'cb-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'Cerebras chat model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before);
    }
    await service.upsertProvider({ id: 'legacy-cb', name: 'Legacy C', baseUrl: 'https://models.example/v1', dialect: 'openai-completions', apiKey: 'disposable-legacy-cb' });
    await service.upsertModel({ provider: 'legacy-cb', id: 'future/private' });
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'cerebras', apiKey: 'must-not-replace' }, 'legacy-cb')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load(); expect(restored.listProviders()).toContainEqual(expect.objectContaining({ id: 'cb-native', dialect: 'cerebras', configured: true }));
    expect(restoredProxy.getAgentProvider('cb-native')).toBeInstanceOf(CerebrasProvider);
    expect(restoredProxy.getAgentProvider('cb-native')?.getConfiguredModel()).toBe(gpt);
    expect(restoredProxy.getAgentProvider('cb-native')?.getSpecializedModels()).toHaveLength(1);
    expect(metadata).not.toContain('disposable-cb'); expect(secrets).not.toContain('disposable-cb');
    const invalid = JSON.parse(metadata), invalidModel = invalid.models.find((item: { provider: string }) => item.provider === 'cb-native');
    invalidModel.id = 'future/native-only'; invalidModel.key = 'cb-native:future/native-only';
    await writeFile(path.join(root, 'providers.json'), JSON.stringify(invalid));
    await expect(new ProviderRegistryService(path.join(root, 'providers.json'), new AiProxyServer(), path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters').load()).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    await writeFile(path.join(root, 'providers.json'), metadata); await restored.load();
    await restored.renameProvider('cb-native', 'cb-renamed', restored.getRevision(), async commit => commit());
    expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets); expect(restored.getModels().filter(model => model.provider === 'cb-renamed')).toHaveLength(2);
    expect(restoredProxy.getAgentProvider('cb-native')).toBeUndefined(); expect(restoredProxy.getAgentProvider('cb-renamed')).toBeInstanceOf(CerebrasProvider);
    await restored.disconnect('cb-renamed'); await restored.load(); expect(restoredProxy.getAgentProvider('cb-renamed')).toBeUndefined();
    await restored.upsertProvider({ apiKey: 'disposable-cb-reconnected' }, 'cb-renamed');
    expect(restoredProxy.getAgentProvider('cb-renamed')).toBeInstanceOf(CerebrasProvider); expect(fetch).not.toHaveBeenCalled();
  });
  it('restores explicit native OpenAI R/D hosts without conflating the shared model ID or replacing legacy Responses', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const model = 'gpt-6-luna';
    await service.upsertProvider({ id: 'oa-native', name: 'Native OpenAI', baseUrl: 'https://models.example/proxy%2Fowned/v1/responses', dialect: 'openai', apiKey: 'disposable-oa-key' });
    await service.upsertModel({ provider: 'oa-native', id: model });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8');
    for (const id of ['future/private', 'gpt-6-luna-decisions', '~typesafe/jev']) {
      await expect(service.upsertModel({ provider: 'oa-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'OpenAI response model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before);
    }
    const provider = proxy.getAgentProvider('oa-native')!;
    expect(provider.getModelApi?.(model)).toBe('openai-responses');
    expect(provider.getSpecializedModels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: model, model, api: 'openai-decisions' }),
      expect.objectContaining({ id: 'gpt-4o:classifier', model: 'gpt-4o', api: 'openai-responses', virtual: true }),
    ]));
    expect(provider.getSpecializedModels()).toHaveLength(2);
    await service.upsertProvider({ apiKey: 'disposable-oa-replaced' }, 'oa-native');
    expect(proxy.getAgentProvider('oa-native')?.getSpecializedModels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `${model}:classifier`, model, api: 'openai-responses', contextWindow: 272000, virtual: true }),
      expect.objectContaining({ id: model, model, api: 'openai-decisions', contextWindow: 922000 }),
    ]));
    await expect(service.testProvider('oa-native')).rejects.toMatchObject({ status: 409, message: 'Provider does not support connection discovery.' });
    expect(await service.importProviderModels('oa-native')).toHaveLength(44); expect(fetch).not.toHaveBeenCalled();
    await service.upsertProvider({ id: 'legacy-r', name: 'Legacy R', baseUrl: 'https://models.example/v1', dialect: 'openai-responses', apiKey: 'disposable-legacy-r' });
    await service.upsertModel({ provider: 'legacy-r', id: 'future/private' });
    expect(proxy.getAgentProvider('legacy-r')?.getModelApi?.('future/private')).toBe('openai-responses');
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'openai', apiKey: 'must-not-replace' }, 'legacy-r')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load(); expect(restored.listProviders()).toContainEqual(expect.objectContaining({ id: 'oa-native', dialect: 'openai', configured: true }));
    expect(restoredProxy.getAgentProvider('oa-native')?.getSpecializedModels()).toHaveLength(2);
    expect(metadata).not.toMatch(/disposable-oa/); expect(secrets).not.toMatch(/disposable-oa/);
    const invalid = JSON.parse(metadata); const invalidModel = invalid.models.find((item: { provider: string }) => item.provider === 'oa-native');
    invalidModel.id = 'future/native-only'; invalidModel.key = 'oa-native:future/native-only';
    await writeFile(path.join(root, 'providers.json'), JSON.stringify(invalid));
    await expect(new ProviderRegistryService(path.join(root, 'providers.json'), new AiProxyServer(), path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters').load()).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    await writeFile(path.join(root, 'providers.json'), metadata); await restored.load();
    await restored.renameProvider('oa-native', 'oa-renamed', restored.getRevision(), async commit => commit());
    expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets); expect(restored.getModels().filter(model => model.provider === 'oa-renamed')).toHaveLength(44);
    expect(restoredProxy.getAgentProvider('oa-native')).toBeUndefined(); expect(restoredProxy.getAgentProvider('oa-renamed')?.getSpecializedModels()).toHaveLength(2);
    await restored.disconnect('oa-renamed'); await restored.load(); expect(restoredProxy.getAgentProvider('oa-renamed')).toBeUndefined();
    await restored.upsertProvider({ apiKey: 'disposable-oa-reconnected' }, 'oa-renamed');
    expect(restoredProxy.getAgentProvider('oa-renamed')?.getModelApi?.(model)).toBe('openai-responses'); expect(fetch).not.toHaveBeenCalled();
  });
  it('restores explicit Cloudflare C/S hosts, bounded chat admission and encrypted lifecycle without discovery claims', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const model = '@cf/deepseek-ai/deepseek-v4-flash-0731', native = '@cf/cloudflare/clef';
    await service.upsertProvider({ id: 'cf-native', name: 'Native Cloudflare', baseUrl: 'https://models.example/accounts/explicit/ai/v1', dialect: 'cloudflare-workers-ai', apiKey: 'disposable-cf-key' });
    await service.upsertModel({ provider: 'cf-native', id: model });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8');
    for (const id of ['future/private', native, 'typesafe/jev']) {
      await expect(service.upsertModel({ provider: 'cf-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'Cloudflare chat model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before);
    }
    expect(proxy.getAgentProvider('cf-native')?.getModelApi?.(model)).toBe('openai-completions');
    expect(proxy.getAgentProvider('cf-native')?.getModelApi?.(native)).toBe('cloudflare-workers-ai-system-one');
    expect(proxy.getAgentProvider('cf-native')?.getSpecializedModels()).toHaveLength(4);
    await expect(service.testProvider('cf-native')).rejects.toMatchObject({ status: 409, message: 'Provider does not support connection discovery.' });
    const beforeImport = service.getModels().find(entry => entry.provider === 'cf-native' && entry.id === model);
    const imported = await service.importProviderModels('cf-native'); expect(imported).toHaveLength(18);
    expect(imported.find(entry => entry.id === model)).toEqual(beforeImport);
    expect(imported.find(entry => entry.id === '@cf/google/gemma-4-26b-a4b-it')).toMatchObject({ name: 'Gemma 4 26B A4B IT', contextWindow: 256000, maxOutputTokens: 16384,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.1, outputPerMillion: 0.3, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0 } });
    expect(imported.find(entry => entry.id === '@cf/ibm-granite/granite-4.0-h-micro')?.capabilities).toEqual({ reasoning: false, imageInput: false, toolCalls: true });
    expect(fetch).not.toHaveBeenCalled();
    await service.upsertProvider({ id: 'legacy-cf', name: 'Legacy', baseUrl: 'https://models.example/ai', dialect: 'openai-completions', apiKey: 'disposable-legacy-cf' });
    await service.upsertModel({ provider: 'legacy-cf', id: 'future/private' });
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'cloudflare-workers-ai', apiKey: 'must-not-replace' }, 'legacy-cf')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata); expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load(); expect(restored.listProviders()).toContainEqual(expect.objectContaining({ id: 'cf-native', dialect: 'cloudflare-workers-ai', configured: true }));
    expect(restoredProxy.getAgentProvider('cf-native')?.getModelApi?.(native)).toBe('cloudflare-workers-ai-system-one');
    expect(metadata).not.toContain('disposable-cf-key'); expect(secrets).not.toContain('disposable-cf-key');
    const invalid = JSON.parse(metadata); invalid.models[0].id = native; invalid.models[0].key = `cf-native:${native}`;
    await writeFile(path.join(root, 'providers.json'), JSON.stringify(invalid));
    await expect(new ProviderRegistryService(path.join(root, 'providers.json'), new AiProxyServer(), path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters').load()).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    await writeFile(path.join(root, 'providers.json'), metadata); await restored.load();
    await restored.renameProvider('cf-native', 'cf-renamed', restored.getRevision(), async commit => commit());
    expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    expect(restored.getModels().filter(model => model.provider === 'cf-renamed')).toHaveLength(18);
    expect(restoredProxy.getAgentProvider('cf-native')).toBeUndefined(); expect(restoredProxy.getAgentProvider('cf-renamed')?.getSpecializedModels()).toHaveLength(4);
    await restored.disconnect('cf-renamed'); await restored.load(); expect(restoredProxy.getAgentProvider('cf-renamed')).toBeUndefined();
    await restored.upsertProvider({ apiKey: 'disposable-cf-reconnected' }, 'cf-renamed');
    expect(restoredProxy.getAgentProvider('cf-renamed')?.getModelApi?.(model)).toBe('openai-completions'); expect(fetch).not.toHaveBeenCalled();
  });

  it('restores explicit OpenRouter composition and refuses unsupported model mutations or static connection certificates', async () => {
    const { root, proxy, service } = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const a = 'anthropic/claude-sonnet-4.6', c = 'google/gemini-3-pro-image';
    await service.upsertProvider({ id: 'router-native', name: 'Native router', baseUrl: 'https://models.example/api/v1', dialect: 'openrouter', apiKey: 'disposable-router-key' });
    await service.upsertModel({ provider: 'router-native', id: a });
    await service.upsertModel({ provider: 'router-native', id: c });
    const before = await readFile(path.join(root, 'providers.json'), 'utf8');
    for (const id of ['future/private', '~typesafe/jev-latest']) {
      await expect(service.upsertModel({ provider: 'router-native', id })).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL', message: 'OpenRouter chat model is not supported.' });
      expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(before);
    }
    expect(proxy.getAgentProvider('router-native')?.getModelApi?.(a)).toBe('anthropic-messages');
    expect(proxy.getAgentProvider('router-native')?.getModelApi?.(c)).toBe('openai-completions');
    await expect(service.testProvider('router-native')).rejects.toMatchObject({ status: 409 });
    const beforeImport = service.getModels().filter(entry => entry.provider === 'router-native');
    const imported = await service.importProviderModels('router-native'); expect(imported).toHaveLength(393);
    for (const entry of beforeImport) expect(imported.find(model => model.id === entry.id)).toEqual(entry);
    expect(imported.find(entry => entry.id === 'openai/gpt-4o')).toMatchObject({ name: 'OpenAI: GPT-4o', contextWindow: 128000, maxOutputTokens: 16384,
      capabilities: { reasoning: false, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25, cacheWritePerMillion: 0 } });
    expect(imported.find(entry => entry.id === 'anthropic/claude-fable-5')).toMatchObject({ name: 'Anthropic: Claude Fable 5', contextWindow: 1000000, maxOutputTokens: 128000,
      pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5 } });
    expect(imported.find(entry => entry.id === 'openrouter/auto')?.pricing).toBeUndefined();
    expect(imported.every(entry => !entry.pricing || !('tiers' in entry.pricing))).toBe(true); expect(fetch).not.toHaveBeenCalled();
    await service.upsertProvider({ id: 'legacy-router', name: 'Legacy router', baseUrl: 'https://models.example/api/v1', dialect: 'openai-completions', apiKey: 'disposable-legacy-key' });
    await service.upsertModel({ provider: 'legacy-router', id: 'future/private' });
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8'), secrets = await readFile(path.join(root, 'secrets.enc'), 'utf8');
    await expect(service.upsertProvider({ dialect: 'openrouter', apiKey: 'must-not-replace' }, 'legacy-router')).rejects.toMatchObject({ status: 400, code: 'INVALID_MODEL' });
    expect(await readFile(path.join(root, 'providers.json'), 'utf8')).toBe(metadata);
    expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters');
    await restored.load();
    expect(restored.listProviders()).toContainEqual(expect.objectContaining({ id: 'router-native', dialect: 'openrouter', configured: true }));
    expect(restoredProxy.getAgentProvider('router-native')?.getModelApi?.(a)).toBe('anthropic-messages');
    expect(restoredProxy.getAgentProvider('router-native')?.getModelApi?.(c)).toBe('openai-completions');
    expect(restoredProxy.getAgentProvider('router-native')?.getSpecializedModels()).toHaveLength(83);
    expect(metadata).not.toContain('disposable-router-key'); expect(secrets).not.toContain('disposable-router-key');
    await restored.renameProvider('router-native', 'router-renamed', restored.getRevision(), async commit => commit());
    expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).toBe(secrets);
    expect(restoredProxy.getAgentProvider('router-native')).toBeUndefined();
    expect(restoredProxy.getAgentProvider('router-renamed')?.getModelApi?.(a)).toBe('anthropic-messages');
    expect(restored.getModels().filter(model => model.provider === 'router-renamed')).toHaveLength(393);
    await restored.disconnect('router-renamed'); await restored.load();
    expect(restoredProxy.getAgentProvider('router-renamed')).toBeUndefined();
    expect(restored.listProviders()).toContainEqual(expect.objectContaining({ id: 'router-renamed', configured: false }));
    await restored.upsertProvider({ apiKey: 'disposable-router-reconnected' }, 'router-renamed');
    expect(restoredProxy.getAgentProvider('router-renamed')?.getModelApi?.(c)).toBe('openai-completions');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists only non-secret metadata and restores encrypted custom providers', async () => {
    const { root, proxy, service } = await fixture();
    const saved = await service.upsertProvider({
      id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1', dialect: 'openai-completions',
      apiKey: 'super-secret-token', headers: { 'X-Private-Token': 'header-secret' },
    });

    expect(saved).toMatchObject({ id: 'acme', configured: true, headerNames: ['X-Private-Token'] });
    expect(proxy.isConfigured('acme')).toBe(true);
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8');
    expect(metadata).not.toContain('super-secret-token');
    expect(metadata).not.toContain('header-secret');
    expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).not.toContain('super-secret-token');

    const restoredProxy = new AiProxyServer();
    const restored = new ProviderRegistryService(
      path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters',
    );
    await restored.load();
    expect(restored.listProviders()).toEqual([expect.objectContaining({ id: 'acme', configured: true })]);
    expect(restoredProxy.isConfigured('acme')).toBe(true);
  });

  it('refuses volatile custom credentials when encrypted persistence is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-registry-volatile-'));
    roots.push(root);
    const service = new ProviderRegistryService(
      path.join(root, 'providers.json'),
      new AiProxyServer(),
      path.join(root, 'secrets.enc'),
      '',
    );
    await service.load();

    await expect(service.upsertProvider({
      id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1',
      dialect: 'openai-completions', apiKey: 'must-not-be-volatile',
    })).rejects.toMatchObject({ status: 503, message: 'Credential storage is unavailable.' });
    expect(service.listProviders()).toEqual([]);
  });

  it('migrates the legacy combined secret payload to the shared credential namespace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-registry-legacy-'));
    roots.push(root);
    const metadataPath = path.join(root, 'providers.json');
    const secretsPath = path.join(root, 'secrets.enc');
    const key = 'test-master-key-with-32-characters';
    await writeFile(metadataPath, JSON.stringify({
      version: 1,
      providers: [{
        id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1', dialect: 'openai-responses',
        headerNames: ['X-Private'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }],
      models: [],
    }));
    const legacy = new EncryptedCredentialStore(secretsPath, key);
    await legacy.load();
    await legacy.set('provider:acme', JSON.stringify({
      apiKey: 'legacy-api-secret', headers: { 'X-Private': 'legacy-header-secret' },
    }));
    const proxy = new AiProxyServer();
    const service = new ProviderRegistryService(metadataPath, proxy, secretsPath, key);

    await service.load();

    expect(service.listProviders()).toEqual([expect.objectContaining({ id: 'acme', configured: true })]);
    expect(proxy.isConfigured('acme')).toBe(true);
    expect(proxy.redactText('legacy-api-secret legacy-header-secret')).toBe('[REDACTED] [REDACTED]');
    const migrated = new EncryptedCredentialStore(secretsPath, key);
    await migrated.load();
    expect(JSON.parse(migrated.get('provider:acme')!)).toMatchObject({
      version: 1, type: 'api-key', apiKey: 'legacy-api-secret',
    });
    expect(JSON.parse(migrated.get('provider-headers:acme')!)).toEqual({ 'X-Private': 'legacy-header-secret' });
  });

  it('restores provider credentials when metadata deletion cannot be persisted', async () => {
    const { root, service } = await fixture();
    const key = 'test-master-key-with-32-characters';
    await service.upsertProvider({
      id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1', dialect: 'openai-completions',
      apiKey: 'rollback-api-secret', headers: { 'X-Private': 'rollback-header-secret' },
    });
    const metadataPath = path.join(root, 'providers.json');
    await rm(metadataPath);
    await mkdir(metadataPath);

    await expect(service.deleteProvider('acme')).rejects.toThrow();

    expect(service.listProviders()).toEqual([expect.objectContaining({ id: 'acme', configured: true })]);
    const stored = new EncryptedCredentialStore(path.join(root, 'secrets.enc'), key);
    await stored.load();
    expect(JSON.parse(stored.get('provider:acme')!)).toMatchObject({ apiKey: 'rollback-api-secret' });
    expect(JSON.parse(stored.get('provider-headers:acme')!)).toEqual({ 'X-Private': 'rollback-header-secret' });
  });

  it('validates provider input, discovers models, and cascades provider deletion', async () => {
    const { service } = await fixture();
    await expect(service.upsertProvider({
      id: 'openai', name: 'Reserved', baseUrl: 'https://example.test', dialect: 'openai-completions',
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.upsertProvider({
      id: 'bad-provider', name: 'Bad', baseUrl: 'https://user:pass@example.test', dialect: 'openai-completions',
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.upsertProvider({
      id: 'bad-provider', name: 'Bad', baseUrl: 'https://example.test', dialect: 'openai-completions',
      headers: { Host: 'internal' },
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.upsertProvider({
      id: 'bad-provider', name: 'Bad', baseUrl: 'https://example.test', dialect: 'openai-completions',
      headers: { Authorization: 'Bearer untrusted' },
    })).rejects.toMatchObject({ status: 400 });

    await service.upsertProvider({
      id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1', dialect: 'openai-completions', apiKey: 'token',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-a' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const imported = await service.importProviderModels('acme');
    expect(imported.map(model => model.id)).toEqual(['model-a', 'model-b']);
    expect(service.getModels()).toHaveLength(2);
    expect(await service.deleteProvider('acme')).toBe(true);
    expect(service.getModels()).toEqual([]);
  });

  it('auto-fills versioned published metadata and preserves full custom pricing', async () => {
    const { service } = await fixture();
    const model = await service.upsertModel({
      provider: 'openai', id: 'gpt-4o',
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25, cacheWritePerMillion: 3 },
      compatibility: { supportsDeveloperRole: true, maxParallelCalls: 8 },
    });
    expect(model).toMatchObject({
      name: 'GPT-4o', contextWindow: 128_000, maxOutputTokens: 16_384,
      capabilities: { reasoning: false, imageInput: true, toolCalls: true },
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25, cacheWritePerMillion: 3 },
      compatibility: { supportsDeveloperRole: true, maxParallelCalls: 8 },
    });
  });
});
