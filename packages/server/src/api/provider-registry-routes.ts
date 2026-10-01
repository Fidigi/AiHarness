import { Router } from 'express';
import type { ProviderAuthStatus } from '@ai-harness/core';
import type { AiProxyServer } from './proxy.js';
import type { RuntimeServices } from '../runtime/services.js';
import type { EncryptedCredentialStore } from '../security/credential-store.js';
import { requireCapability } from '../security/request-security.js';
import { ProviderOAuthService } from '../runtime/provider-oauth.js';

const BUILTIN_ENVIRONMENT: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  vertex: ['GOOGLE_VERTEX_ACCESS_TOKEN'],
  bedrock: ['AWS_ACCESS_KEY_ID'],
  local: ['LOCAL_BASE_URL', 'LLAMA_BASE_URL'],
  mock: [],
};

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 500 || !value.trim()) {
    throw Object.assign(new Error(`${name} is invalid.`), { status: 400, code: 'INVALID_INPUT' });
  }
  return value.trim();
}

export function createProviderRegistryRouter(
  servicesPromise: Promise<RuntimeServices>,
  proxy: AiProxyServer,
  credentialStore: () => EncryptedCredentialStore | undefined,
): Router {
  const router = Router();
  const oauth = new ProviderOAuthService(proxy, credentialStore);

  router.get('/auth', async (_request, response, next) => {
    try {
      const services = await servicesPromise;
      const builtin: ProviderAuthStatus[] = proxy.getProviders()
        .filter(provider => provider.type in BUILTIN_ENVIRONMENT)
        .map(provider => {
          const environmentVariable = BUILTIN_ENVIRONMENT[provider.type]?.find(name => Boolean(process.env[name]));
          return {
            type: provider.type,
            name: provider.type,
            configured: provider.configured,
            connected: provider.configured,
            method: provider.type === 'mock' || provider.type === 'local' && !environmentVariable
              ? 'none' : provider.type === 'vertex' && environmentVariable === 'GOOGLE_VERTEX_ACCESS_TOKEN'
                || oauth.isSupported(provider.type) ? 'oauth' : environmentVariable ? 'environment' : 'api-key',
            ...(environmentVariable ? { environmentVariable } : {}),
            reconnectSupported: provider.type !== 'mock',
            disconnectSupported: provider.type !== 'mock' && !environmentVariable,
            ...(proxy.getUsage(provider.type) ? { usage: proxy.getUsage(provider.type) } : {}),
          };
        });
      const custom: ProviderAuthStatus[] = services.providerRegistry.listProviders().map(provider => ({
        type: provider.id,
        name: provider.name,
        configured: provider.configured,
        connected: proxy.isConfigured(provider.id),
        method: provider.configured ? 'api-key' : 'none',
        reconnectSupported: true,
        disconnectSupported: provider.configured,
        ...(proxy.getUsage(provider.id) ? { usage: proxy.getUsage(provider.id) } : {}),
      }));
      response.setHeader('Cache-Control', 'no-store');
      response.json([...builtin, ...custom]);
    } catch (error) { next(error); }
  });

  router.post('/auth/:id/test', requireCapability('configuration'), async (request, response, next) => {
    try {
      const id = identifier(request.params.id, 'provider id').toLowerCase();
      const services = await servicesPromise;
      if (services.providerRegistry.listProviders().some(provider => provider.id === id)) {
        response.json(await services.providerRegistry.testProvider(id));
        return;
      }
      const provider = proxy.getAgentProvider(id);
      if (!provider || !provider.validateConfig()) {
        response.status(409).json({ error: 'Provider is not connected.', code: 'PROVIDER_NOT_CONNECTED' });
        return;
      }
      let models: string[] = [];
      try { models = await provider.getAvailableModels(); } catch (error) {
        response.status(502).json({ error: error instanceof Error ? error.message : String(error), code: 'PROVIDER_TEST_FAILED' });
        return;
      }
      response.json({ ok: true, models: models.slice(0, 500), checkedAt: new Date().toISOString() });
    } catch (error) { next(error); }
  });

  router.post('/auth/:id/oauth', requireCapability('credentials'), async (request, response, next) => {
    try { response.status(201).json(await oauth.start(identifier(request.params.id, 'provider id'))); }
    catch (error) { next(error); }
  });

  router.get('/auth/oauth/:flowId', requireCapability('credentials'), (request, response) => {
    const flow = oauth.get(request.params.flowId);
    response.status(flow ? 200 : 404).json(flow ?? { error: 'OAuth flow not found.' });
  });

  router.delete('/auth/oauth/:flowId', requireCapability('credentials'), (request, response) => {
    const cancelled = oauth.cancel(request.params.flowId);
    response.status(cancelled ? 200 : 404).json(cancelled ? { state: 'cancelled' } : { error: 'OAuth flow not found.' });
  });

  router.delete('/auth/:id', requireCapability('credentials'), async (request, response, next) => {
    try {
      const id = identifier(request.params.id, 'provider id').toLowerCase();
      const services = await servicesPromise;
      if (services.providerRegistry.listProviders().some(provider => provider.id === id)) {
        response.json(await services.providerRegistry.disconnect(id));
        return;
      }
      const environmentVariable = BUILTIN_ENVIRONMENT[id]?.find(name => Boolean(process.env[name]));
      if (environmentVariable) {
        response.status(409).json({
          error: `Provider is controlled by ${environmentVariable}; remove it from the server environment.`,
          code: 'PROVIDER_ENVIRONMENT_LOCKED',
        });
        return;
      }
      if (!(id in BUILTIN_ENVIRONMENT)) {
        response.status(404).json({ error: 'Provider not found.' });
        return;
      }
      proxy.removeProvider(id);
      await credentialStore()?.delete(id);
      response.json({ success: true, type: id, connected: false });
    } catch (error) { next(error); }
  });

  router.get('/custom', async (_request, response, next) => {
    try { response.json((await servicesPromise).providerRegistry.listProviders()); }
    catch (error) { next(error); }
  });

  router.post('/custom', requireCapability('credentials'), async (request, response, next) => {
    try {
      const result = await (await servicesPromise).providerRegistry.upsertProvider(request.body ?? {});
      response.status(201).json(result);
    } catch (error) { next(error); }
  });

  router.put('/custom/:id', requireCapability('credentials'), async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.upsertProvider(request.body ?? {}, request.params.id)); }
    catch (error) { next(error); }
  });

  router.delete('/custom/:id', requireCapability('credentials'), async (request, response, next) => {
    try {
      const removed = await (await servicesPromise).providerRegistry.deleteProvider(request.params.id);
      response.status(removed ? 200 : 404).json(removed ? { success: true } : { error: 'Custom provider not found.' });
    } catch (error) { next(error); }
  });

  router.post('/custom/:id/test', requireCapability('credentials'), async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.testProvider(request.params.id)); }
    catch (error) { next(error); }
  });

  router.post('/custom/:id/import-models', requireCapability('configuration'), async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.importProviderModels(request.params.id)); }
    catch (error) { next(error); }
  });

  router.get('/models', async (_request, response, next) => {
    try { response.json((await servicesPromise).providerRegistry.getModels()); }
    catch (error) { next(error); }
  });

  router.post('/models', requireCapability('configuration'), async (request, response, next) => {
    try { response.status(201).json(await (await servicesPromise).providerRegistry.upsertModel(request.body ?? {})); }
    catch (error) { next(error); }
  });

  router.put('/models/:key', requireCapability('configuration'), async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.upsertModel(request.body ?? {}, request.params.key)); }
    catch (error) { next(error); }
  });

  router.delete('/models/:key', requireCapability('configuration'), async (request, response, next) => {
    try {
      const removed = await (await servicesPromise).providerRegistry.deleteModel(request.params.key);
      response.status(removed ? 200 : 404).json(removed ? { success: true } : { error: 'Custom model not found.' });
    } catch (error) { next(error); }
  });

  router.post('/models/:key/test', requireCapability('configuration'), async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.testModel(request.params.key)); }
    catch (error) { next(error); }
  });

  return router;
}
