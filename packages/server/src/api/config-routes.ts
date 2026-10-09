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
      await services.configurationStore.load();
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
      await configurationStore.load();
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

  router.patch('/defaults', requireCapability('configuration'), async (request, response, next) => {
    try {
      const body = request.body as Record<string, unknown> | undefined;
      const model = body?.kind === 'model';
      const keys = model ? ['kind', 'provider', 'model', 'projectId'] : ['kind', 'thinking', 'projectId'];
      if (!body || (body.kind !== 'model' && body.kind !== 'thinking')
        || Object.keys(body).some(key => !keys.includes(key))
        || (!model && (typeof body.thinking !== 'string'
          || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.thinking)))
        || (body.projectId !== undefined && (typeof body.projectId !== 'string' || body.projectId.length > 2_000))
        || (model && [body.provider, body.model].some(value => typeof value !== 'string'
          || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)))) {
        response.status(400).json({ error: 'Invalid new-session default.' });
        return;
      }
      const services = await servicesPromise;
      const projectId = body.projectId as string | undefined;
      // Validate the context before writing, and inspect project settings even
      // when a current session override hides their effective provenance.
      if (projectId) services.configurationStore.get('project', projectId);
      const patch = model ? { provider: body.provider, model: body.model } : { thinking: body.thinking };
      const values = await services.configurationStore.patch('global', patch);
      const effective = resolveEffectiveConfiguration(services, { projectId });
      const overridden = Object.keys(patch).filter(key =>
        ['project', 'environment'].includes(effective.provenance[key as keyof typeof effective.provenance]?.scope ?? ''));
      response.json({ values, overridden, effective });
    } catch (error) { next(error); }
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
