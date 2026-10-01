import { Router } from 'express';
import type { ModelCatalog, ProviderModelCatalog } from '@ai-harness/core';
import { resolveEffectiveConfiguration } from '../config/effective-configuration.js';
import type { RuntimeServices } from '../runtime/services.js';
import { requireCapability } from '../security/request-security.js';

function optionalProjectId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2_000) {
    throw Object.assign(new Error('Identifiant de projet invalide.'), { status: 400, code: 'INVALID_PROJECT_ID' });
  }
  return value;
}

function enabledModelKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 2_000
    || !value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 500)) {
    throw Object.assign(new Error('Liste de modèles activés invalide.'), { status: 400, code: 'INVALID_ENABLED_MODELS' });
  }
  return [...new Set(value)];
}

function withEnabledState(
  providers: ProviderModelCatalog[],
  services: RuntimeServices,
  projectId?: string,
): ModelCatalog {
  const effective = resolveEffectiveConfiguration(services, { projectId });
  const configured = effective.values.enabledModels;
  const enabled = configured ? new Set(configured) : undefined;
  const provenance = effective.provenance.enabledModels;
  return {
    updatedAt: services.modelCatalog.getUpdatedAt(),
    enabledScope: provenance?.scope ?? 'default',
    enabledSource: provenance?.source ?? 'built-in',
    providers: providers.map(provider => ({
      ...provider,
      models: provider.models.map(model => ({
        ...model,
        enabled: enabled === undefined || enabled.has(model.key) || enabled.has(model.id),
      })),
    })),
  };
}

export function createModelRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const projectId = optionalProjectId(request.query.projectId);
      const services = await servicesPromise;
      const providers = await services.modelCatalog.getCatalog(
        request.query.refresh === '1' || request.query.refresh === 'true',
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(withEnabledState(providers, services, projectId));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/enabled', requireCapability('configuration'), async (request, response, next) => {
    try {
      const projectId = optionalProjectId(request.body?.projectId);
      const enabledModels = enabledModelKeys(request.body?.enabledModels);
      const services = await servicesPromise;
      const providers = await services.modelCatalog.getCatalog(false);
      const knownKeys = new Set(providers.flatMap(provider => provider.models.map(model => model.key)));
      const unknown = enabledModels.find(model => !knownKeys.has(model));
      if (unknown) {
        response.status(400).json({ error: `Modèle inconnu : ${unknown}`, code: 'UNKNOWN_MODEL' });
        return;
      }
      await services.configurationStore.patch(
        projectId ? 'project' : 'global',
        { enabledModels },
        projectId,
      );
      response.json(withEnabledState(providers, services, projectId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
