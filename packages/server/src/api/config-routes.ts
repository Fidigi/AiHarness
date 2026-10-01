import { Router } from 'express';
import type { ConfigurationScope } from '@ai-harness/core';
import type { RuntimeServices } from '../runtime/services.js';
import { resolveEffectiveConfiguration } from '../config/effective-configuration.js';
import { requireCapability } from '../security/request-security.js';

function scope(value: unknown): ConfigurationScope | undefined {
  return value === 'global' || value === 'project' || value === 'session' ? value : undefined;
}

export function createConfigurationRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/effective', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const sessionId = typeof request.query.sessionId === 'string' ? request.query.sessionId : undefined;
      const session = sessionId
        ? services.sessionManager.get(sessionId) ?? await services.sessionManager.loadFromStore(sessionId) ?? undefined
        : undefined;
      response.json(resolveEffectiveConfiguration(services, {
        projectId: typeof request.query.projectId === 'string' ? request.query.projectId : undefined,
        sessionId,
        session,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/scope', async (request, response, next) => {
    try {
      const selectedScope = scope(request.query.scope);
      if (!selectedScope) {
        response.status(400).json({ error: 'Portée invalide.' });
        return;
      }
      const { configurationStore } = await servicesPromise;
      response.json({
        scope: selectedScope,
        scopeId: typeof request.query.scopeId === 'string' ? request.query.scopeId : undefined,
        values: configurationStore.get(
          selectedScope,
          typeof request.query.scopeId === 'string' ? request.query.scopeId : undefined,
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/scope', requireCapability('configuration'), async (request, response, next) => {
    try {
      const selectedScope = scope(request.body?.scope);
      if (!selectedScope) {
        response.status(400).json({ error: 'Portée invalide.' });
        return;
      }
      const services = await servicesPromise;
      const values = await services.configurationStore.patch(
        selectedScope,
        request.body?.values,
        typeof request.body?.scopeId === 'string' ? request.body.scopeId : undefined,
      );
      response.json({ scope: selectedScope, scopeId: request.body?.scopeId, values });
    } catch (error) {
      next(error);
    }
  });

  router.put('/scope', requireCapability('configuration'), async (request, response, next) => {
    try {
      const selectedScope = scope(request.body?.scope);
      if (!selectedScope) {
        response.status(400).json({ error: 'Portée invalide.' });
        return;
      }
      const services = await servicesPromise;
      const values = await services.configurationStore.replace(
        selectedScope,
        request.body?.values,
        typeof request.body?.scopeId === 'string' ? request.body.scopeId : undefined,
      );
      response.json({ scope: selectedScope, scopeId: request.body?.scopeId, values });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
