import { Router } from 'express';
import type { ProviderAuthStatus, ProviderCredentialService } from '@ai-harness/core';
import type { AiProxyServer } from './proxy.js';
import type { RuntimeServices } from '../runtime/services.js';
import { requireCapability } from '../security/request-security.js';
import { ProviderOAuthService } from '../runtime/provider-oauth.js';
import { providerAdministration, providerOperation } from '../runtime/provider-administration.js';

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
  credentialService: () => ProviderCredentialService | undefined,
  oauth = new ProviderOAuthService(proxy, credentialService),
): Router {
  const router = Router();
  const operation = (handler: Parameters<typeof providerOperation>[1]) => providerOperation(servicesPromise, handler);
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

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
        method: services.providerRegistry.hasCredentials(provider.id) ? 'api-key' : 'none',
        reconnectSupported: true,
        disconnectSupported: provider.configured,
        ...(proxy.getUsage(provider.id) ? { usage: proxy.getUsage(provider.id) } : {}),
      }));
      response.setHeader('Cache-Control', 'no-store');
      response.json([...builtin, ...custom]);
    } catch (error) { next(error); }
  });

  router.post('/auth/:id/test', requireCapability('configuration'), operation(async (request, response, next) => {
    try {
      const id = identifier(request.params.id, 'provider id').toLowerCase();
      const services = await servicesPromise;
      if (services.providerRegistry.listProviders().some(provider => provider.id === id)) {
        response.json(await services.providerRegistry.testProvider(id));
        return;
      }
      const provider = proxy.getAgentProvider(id);
      if (!provider || !provider.canDiscoverModels()) {
        response.status(409).json({ error: 'Provider is not connected.', code: 'PROVIDER_NOT_CONNECTED' });
        return;
      }
      let models: string[] = [];
      try { models = await provider.getAvailableModels(); } catch {
        response.status(502).json({ error: 'Provider test failed.', code: 'PROVIDER_TEST_FAILED' });
        return;
      }
      response.json({ ok: true, models: models.slice(0, 500), checkedAt: new Date().toISOString() });
    } catch (error) { next(error); }
  }));

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

  router.delete('/auth/:id', requireCapability('credentials'), operation(async (request, response, next) => {
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
      await credentialService()?.delete(id);
      response.json({ success: true, type: id, connected: false });
    } catch (error) { next(error); }
  }));

  router.get('/custom', operation(async (_request, response, next) => {
    try {
      const services = await servicesPromise;
      await services.providerRegistry.reload();
      // Keep the existing array body for older clients. Add passive capability
      // metadata to the current GET, not a browser/environment inference.
      const supported = providerAdministration(services)?.isActivatedForExclusiveHost === true;
      response.setHeader('X-AiHarness-Provider-Rename', JSON.stringify({
        supported, mode: supported ? 'exclusive-host-single-writer' : 'disabled',
        reason: supported ? 'restricted-single-writer' : 'exclusive-host-required',
      }));
      response.json(services.providerRegistry.listProviders());
    }
    catch (error) { next(error); }
  }));

  router.post('/custom', requireCapability('credentials'), operation(async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const result = await services.providerRegistry.upsertProvider(request.body ?? {});
      services.modelCatalog.invalidateProvider(result.id);
      response.status(201).json(result);
    } catch (error) { next(error); }
  }));

  router.put('/custom/:id', requireCapability('credentials'), operation(async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const result = await services.providerRegistry.upsertProvider(request.body ?? {}, request.params.id);
      services.modelCatalog.invalidateProvider(result.id);
      response.json(result);
    }
    catch (error) { next(error); }
  }));

  router.post('/custom/:id/rename', requireCapability('credentials'), requireCapability('configuration'), async (request, response) => {
    try {
      const body: unknown = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['id', 'revision'].includes(key))) {
        response.status(400).json({ error: 'Invalid rename request.', code: 'INVALID_INPUT', uncertain: false });
        return;
      }
      const { id, revision } = body as Record<string, unknown>;
      if (typeof id !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
        response.status(400).json({ error: 'Invalid rename request.', code: 'INVALID_INPUT', uncertain: false });
        return;
      }
      const services = await servicesPromise;
      const oldId = identifier(request.params.id, 'provider id').toLowerCase();
      // Refuse even idle durable session references: history and provider/model
      // runtime fields must not silently point to a removed identity.
      if (services.agentRuntime.listRunning().length > 0
        || services.sessionManager.list().some(session => String(session.providerConfig?.type ?? '').trim().toLowerCase() === oldId)) {
        response.status(409).json({ error: 'Provider is referenced by a session.', code: 'PROVIDER_IN_USE', uncertain: false });
        return;
      }
      if ([process.env.AI_HARNESS_DEFAULT_PROVIDER, process.env.AI_HARNESS_PROVIDER]
        .some(value => value?.trim().toLowerCase() === oldId)) {
        response.status(409).json({ error: 'Provider is controlled by the environment.', code: 'PROVIDER_ENVIRONMENT_LOCKED', uncertain: false });
        return;
      }
      // Coordinator-owned ConfigurationStore must provide one bounded fresh
      // whole-store rebind. Never simulate this with independent scope writes.
      const store = services.configurationStore as typeof services.configurationStore & {
        rebindProvider?: (oldId: string, newId: string, commit: () => Promise<void>) => Promise<void>;
      };
      if (!store.rebindProvider) {
        response.status(409).json({ error: 'Provider reference transaction is unavailable.', code: 'PROVIDER_REBIND_UNAVAILABLE', uncertain: false });
        return;
      }
      const administration = providerAdministration(services);
      if (!administration) {
        response.status(409).json({ error: 'Provider admission exclusion is unavailable.', code: 'PROVIDER_ADMISSION_UNAVAILABLE', uncertain: false });
        return;
      }
      // Exclusive lease includes registry rollback/reconciliation, not merely
      // its commit callback. HTTP disconnect cannot release this operation.
      const result = await administration.rename(oldId, () => services.providerRegistry.renameProvider(oldId, id, revision,
        commit => store.rebindProvider!(oldId, id.trim().toLowerCase(), async () => {
          await administration.assertRenameReferencesSafe(oldId);
          await commit();
          await administration.assertRenameReferencesSafe(oldId);
        })));
      services.modelCatalog.invalidateProvider(oldId);
      services.modelCatalog.invalidateProvider(result.id);
      response.json(result);
    } catch (error) {
      const failure = error as { status?: number; code?: string; uncertain?: boolean };
      const services = await servicesPromise;
      services.modelCatalog.invalidateProvider(String(request.params.id));
      if (typeof request.body?.id === 'string') services.modelCatalog.invalidateProvider(request.body.id);
      response.status(failure.status ?? 500).json({ error: 'Provider rename failed; refresh before retrying.',
        code: failure.code ?? 'PROVIDER_RENAME_FAILED', uncertain: failure.uncertain ?? !failure.status });
    }
  });

  router.delete('/custom/:id', requireCapability('credentials'), operation(async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const removed = await services.providerRegistry.deleteProvider(request.params.id);
      if (removed) services.modelCatalog.invalidateProvider(request.params.id);
      response.status(removed ? 200 : 404).json(removed ? { success: true } : { error: 'Custom provider not found.' });
    } catch (error) { next(error); }
  }));

  router.post('/custom/:id/test', requireCapability('credentials'), operation(async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.testProvider(request.params.id)); }
    catch (error) { next(error); }
  }));

  router.post('/custom/:id/import-models', requireCapability('configuration'), operation(async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.importProviderModels(request.params.id)); }
    catch (error) { next(error); }
  }));

  router.get('/models', async (_request, response, next) => {
    try { response.json((await servicesPromise).providerRegistry.getModels()); }
    catch (error) { next(error); }
  });

  router.post('/models', requireCapability('configuration'), operation(async (request, response, next) => {
    try { response.status(201).json(await (await servicesPromise).providerRegistry.upsertModel(request.body ?? {})); }
    catch (error) { next(error); }
  }));

  router.put('/models/:key', requireCapability('configuration'), operation(async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.upsertModel(request.body ?? {}, request.params.key)); }
    catch (error) { next(error); }
  }));

  router.delete('/models/:key', requireCapability('configuration'), operation(async (request, response, next) => {
    try {
      const removed = await (await servicesPromise).providerRegistry.deleteModel(request.params.key);
      response.status(removed ? 200 : 404).json(removed ? { success: true } : { error: 'Custom model not found.' });
    } catch (error) { next(error); }
  }));

  router.post('/models/:key/test', requireCapability('configuration'), operation(async (request, response, next) => {
    try { response.json(await (await servicesPromise).providerRegistry.testModel(request.params.key)); }
    catch (error) { next(error); }
  }));

  return router;
}
