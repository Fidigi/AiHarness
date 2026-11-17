import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@ai-harness/core';
import { createConfiguredProviders } from '../../packages/cli/dist/providers/configured-providers.js';
import { ProviderRegistryService } from '../../packages/server/dist/runtime/provider-registry.js';
import { validateReference, sha256 } from './provider-reference.mjs';

// Explicit native ownership, never inferred from a shared model ID or an endpoint alias.
const bindings = {
  'amazon-bedrock': ['BedrockProvider', 'bedrock'],
  'ant-ling': ['AntLingProvider'], anthropic: ['AnthropicProvider', 'anthropic', 'anthropic'],
  azure: ['AzureResponsesProvider', 'azure'], baseten: ['BasetenProvider'],
  cerebras: ['CerebrasProvider', 'cerebras', 'cerebras'],
  'cloudflare-workers-ai': ['CloudflareWorkersAiMixedProvider', null, 'cloudflare-workers-ai'],
  deepseek: ['DeepSeekProvider', null, 'deepseek'], fireworks: ['FireworksProvider'],
  'google-vertex': ['VertexGeminiProvider', 'vertex'], google: ['GeminiProvider', 'google', 'google'],
  groq: ['GroqProvider', null, 'groq'], huggingface: ['HuggingFaceProvider'],
  'kimi-coding': ['KimiCodingProvider'], meta: ['MetaProvider'],
  'minimax-cn': ['MiniMaxCnProvider'], minimax: ['MiniMaxProvider'],
  mistral: ['MistralProvider', 'mistral-conversations', 'mistral-conversations'],
  'moonshotai-cn': ['MoonshotCnProvider', null, 'moonshot'],
  moonshotai: ['MoonshotProvider', null, 'moonshot'], nvidia: ['NvidiaProvider', null, 'nvidia'],
  openai: ['OpenAiMixedProvider', 'openai', 'openai'],
  'opencode-go': ['OpenCodeGoProvider'], opencode: ['OpenCodeProvider'],
  openrouter: ['OpenRouterProvider', null, 'openrouter'], together: ['TogetherProvider'],
  typesafe: ['TypesafeProvider'], xai: ['XaiProvider'], xiaomi: ['XiaomiProvider'],
  zai: ['ZaiProvider', null, 'zai'],
};
const specializedSdk = {
  'cloudflare-workers-ai:cloudflare-workers-ai-system-one': 'CloudflareWorkersAiProvider',
  'openai:openai-decisions': 'OpenAiDecisionsProvider',
  'openrouter:typesafe-system-one': 'OpenRouterClassifiersProvider',
  'openrouter:openrouter-images': 'OpenRouterImagesProvider',
};
const environment = {
  OPENAI_API_KEY: 'disposable-coverage', ANTHROPIC_API_KEY: 'disposable-coverage',
  GEMINI_API_KEY: 'disposable-coverage', CEREBRAS_API_KEY: 'disposable-coverage',
  AZURE_OPENAI_API_KEY: 'disposable-coverage', AZURE_OPENAI_BASE_URL: 'https://owned.invalid/openai/v1',
  GOOGLE_VERTEX_ACCESS_TOKEN: 'disposable-coverage', GOOGLE_CLOUD_PROJECT: 'owned-project',
  AWS_BEARER_TOKEN_BEDROCK: 'disposable-coverage', AWS_REGION: 'us-east-1',
};

function configuration(type, api) {
  return { type, apiKey: 'disposable-coverage', accountId: 'owned-account',
    region: 'us-east-1', project: 'owned-project', location: 'us-central1',
    ...(type === 'azure' ? { baseUrl: 'https://owned.invalid/openai/v1',
      azureApi: api === 'azure-openai-responses' ? 'responses' : 'completions' } : {}) };
}
function projection(provider, [,, api, type], model) {
  if (!provider) return null;
  const profile = type === 'chat' ? undefined : provider.getSpecializedModels().find(item =>
    !item.virtual && item.type === type && (item.model ?? item.id) === model && item.api === api);
  const actualApi = type === 'chat' ? provider.getModelApi?.(model) : profile?.api;
  return { constructor: provider.constructor.name, api: actualApi ?? null, apiMatch: actualApi === api,
    nativeSpecializedDescriptor: Boolean(profile),
    nativeScalarQuestions: type === 'classifier' && typeof provider.classifyNativeQuestions === 'function',
    nativeImageRequest: type === 'image' && typeof provider.generateNativeImages === 'function' };
}
function nativeMetadata(provider, identity) {
  const [, model, api, type] = identity;
  const owned = core.getProviderPublishedModels(provider);
  const profile = type === 'chat'
    ? core.getProviderPublishedModel(provider.getProviderType(), model, provider)
    : provider.getSpecializedModels().find(item => !item.virtual && item.type === type
      && (item.model ?? item.id) === model && item.api === api);
  if (!profile) return null;
  return { source: type !== 'chat' || owned ? 'adapter' : 'legacy', api: profile.api ?? null,
    contextWindow: profile.contextWindow ?? null, maxOutputTokens: profile.maxOutputTokens ?? null,
    capabilities: profile.capabilities ?? null, pricing: profile.pricing ?? null,
    imageInput: type === 'chat' ? profile.capabilities?.imageInput === true : profile.imageInput === true };
}

/** Local metadata/admission census only: no streaming, discovery, credential resolution or vendor access. */
export async function createProviderCoverage(reference, root = process.cwd()) {
  validateReference(reference);
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'aih-provider-coverage-'));
  const custom = new Map(), adapters = new Map(), factories = new Map();
  const proxy = { getCredentialRedactor: () => new core.CredentialRedactor(),
    getAgentProvider: id => custom.get(id), setCustomProvider: (id, provider) => custom.set(id, provider),
    removeProvider: id => custom.delete(id), isConfigured: id => custom.has(id),
    resetNetworkDispatchers: async () => {} };
  const registry = new ProviderRegistryService(path.join(temporary, 'providers.json'), proxy,
    path.join(temporary, 'secrets.enc'), 'disposable-provider-coverage-master');
  const cli = createConfiguredProviders(environment);
  const legacyAzureCli = createConfiguredProviders({ ...environment, AZURE_OPENAI_BASE_URL: undefined,
    AZURE_OPENAI_ENDPOINT: 'https://owned.invalid/legacy' });
  try {
    await registry.load();
    for (const [id, [constructor, nativeId, dialect]] of Object.entries(bindings)) {
      for (const api of new Set(reference.rows.filter(row => row[0] === id).map(row => row[2]))) {
        const name = specializedSdk[`${id}:${api}`]
          ?? (id === 'azure' && api === 'openai-completions' ? 'OpenAiProvider' : constructor);
        assert.equal(typeof core[name], 'function', name);
        adapters.set(`${id}:${api}`, new core[name](configuration(nativeId ?? id, api)));
        if (nativeId && core.ProviderFactory.has(nativeId)) {
          factories.set(`${id}:${api}`, core.ProviderFactory.create(configuration(nativeId, api)));
        }
      }
      if (dialect) await registry.upsertProvider({ id: `audit-${id}`, name: 'Owned census fixture', dialect,
        baseUrl: 'https://owned.invalid/v1', apiKey: 'disposable-provider-coverage' });
    }
    const rows = [];
    for (const identity of reference.rows) {
      const [provider, model, api, type, declaredImages] = identity;
      const binding = bindings[provider], adapter = adapters.get(`${provider}:${api}`);
      const sdk = projection(adapter, identity, model);
      const metadata = adapter ? nativeMetadata(adapter, identity) : null;
      const customId = `audit-${provider}`, customProvider = custom.get(customId);
      let customAdmission = null;
      if (customProvider) {
        let modelAdmitted = false;
        if (type === 'chat') {
          try { await registry.upsertModel({ provider: customId, id: model }); modelAdmitted = true; }
          catch (error) { if (error.code !== 'INVALID_MODEL') throw error; }
        }
        customAdmission = { dialect: binding[2], ...projection(customProvider, identity, model), modelAdmitted,
          regionalSelection: provider.endsWith('-cn') ? 'explicit-operator-url-only' : null };
      }
      const nativeId = binding?.[1];
      let builtinChatRecord = null;
      if (nativeId && type === 'chat') {
        let admitted = false;
        try { await registry.upsertModel({ provider: nativeId, id: model }); admitted = true; }
        catch (error) { if (error.code !== 'INVALID_MODEL') throw error; }
        builtinChatRecord = { slot: nativeId, modelAdmitted: admitted };
      }
      const cliProvider = (provider === 'azure' && api === 'openai-completions' ? legacyAzureCli : cli).get(nativeId);
      const imageInput = !declaredImages ? 'not-in-reference'
        : metadata?.imageInput === true ? 'declared' : sdk?.apiMatch ? 'not-declared-or-refused' : 'missing';
      rows.push({ provider, model, api, type, declaredImages,
        coverage: !sdk?.apiMatch ? 'missing' : !metadata || metadata.api !== api || (declaredImages && !metadata.imageInput)
          ? 'transport-only-or-partial-profile' : 'native-declaration',
        sdk, metadata, imageInput, hosts: {
          factory: projection(factories.get(`${provider}:${api}`), identity, model),
          automaticCli: projection(cliProvider, identity, model), builtinChatRecord, custom: customAdmission,
        }, operations: {
          chat: type === 'chat' && sdk?.apiMatch === true,
          streamChat: type === 'chat' && sdk?.apiMatch === true,
          classify: type === 'classifier' && sdk?.apiMatch === true,
          classifyQuestions: type === 'classifier' && sdk?.apiMatch === true,
          classifyNativeQuestions: type === 'classifier' && sdk?.apiMatch === true
            && typeof adapter.classifyNativeQuestions === 'function',
          generateImages: type === 'image' && sdk?.apiMatch === true,
          generateNativeImages: type === 'image' && sdk?.apiMatch === true
            && typeof adapter.generateNativeImages === 'function',
        }, wireQualification: 'not-executed-by-this-census' });
    }
    const sources = readdirSync(path.join(root, 'packages/core/src/providers')).filter(file =>
      file.endsWith('.ts') && !file.endsWith('.test.ts')).map(file => `packages/core/src/providers/${file}`);
    sources.push('packages/core/src/types/index.ts', 'packages/cli/src/providers/configured-providers.ts',
      'packages/server/src/runtime/provider-registry.ts');
    const sourceHashes = Object.fromEntries(sources.sort().map(file => [file, sha256(readFileSync(path.join(root, file)))]));
    return { reference: { schema: reference.schema, rowsSha256: reference.rowsSha256 }, sourceHashes,
      summary: { providers: new Set(reference.rows.map(row => row[0])).size, entries: rows.length,
        ...Object.fromEntries(['native-declaration', 'transport-only-or-partial-profile', 'missing']
          .map(state => [state, rows.filter(row => row.coverage === state).length])) },
      limitations: ['Declarations/admission are not a wire, entitlement, price-freshness or full-profile certificate.',
        'Factory and CLI fields describe their actual API projection, not generic same-ID compatibility.',
        'Custom admission uses the real local registry with disposable encrypted storage; Settings/HTTP are not exercised.',
        'Classifier/image descriptors are separate from chat admission and virtual classifiers.'], rows };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reference = JSON.parse(readFileSync(new URL('../fixtures/provider-reference.json', import.meta.url)));
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Coverage census must not fetch'); };
  try {
    const report = await createProviderCoverage(reference);
    assert.equal(requests, 0);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally { globalThis.fetch = original; }
}
