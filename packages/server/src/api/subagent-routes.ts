import { Router } from 'express';
import type { SubagentProfile } from '@ai-harness/core';
import { resolveEffectiveConfiguration } from '../config/effective-configuration.js';
import { requireCapability } from '../security/request-security.js';
import type { RuntimeServices } from '../runtime/services.js';

function optionalString(value: unknown, field: string, max = 4_096): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error(`${field} invalide.`), { status: 400 });
  }
  return value.trim();
}

function requiredString(value: unknown, field: string, max = 100_000): string {
  const result = optionalString(value, field, max);
  if (!result) throw Object.assign(new Error(`${field} requis.`), { status: 400 });
  return result;
}

function context(query: Record<string, unknown>, body?: Record<string, unknown>): {
  cwd?: string;
  projectId?: string;
  scope: 'global' | 'project';
} {
  const cwd = optionalString(body?.cwd ?? query.cwd, 'cwd');
  const projectId = optionalString(body?.projectId ?? query.projectId, 'projectId', 200);
  const requested = body?.scope ?? query.scope;
  const scope = requested === 'global' ? 'global' : requested === 'project' ? 'project' : cwd || projectId ? 'project' : 'global';
  return { cwd, projectId, scope };
}

export function createSubagentRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/settings', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.setHeader('Cache-Control', 'no-store');
      response.json(await services.subagentService.getConfiguration(context(request.query)));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/settings', requireCapability('configuration'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.json(await services.subagentService.updateSettings(context(request.query, request.body), {
        engineEnabled: request.body?.engineEnabled,
        maxConcurrency: request.body?.maxConcurrency,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/profiles', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.setHeader('Cache-Control', 'no-store');
      response.json(await services.subagentService.getConfiguration(context(request.query)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/profiles', requireCapability('configuration'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.status(201).json(await services.subagentService.createProfile(
        context(request.query, request.body),
        request.body?.profile as Partial<SubagentProfile>,
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post('/profiles/:profileId/duplicate', requireCapability('configuration'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.status(201).json(await services.subagentService.duplicateProfile(
        context(request.query, request.body), request.params.profileId,
      ));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/profiles/:profileId', requireCapability('configuration'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.json(await services.subagentService.updateProfile(
        context(request.query, request.body), request.params.profileId,
        request.body?.profile as Partial<SubagentProfile>,
      ));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/profiles/:profileId', requireCapability('configuration'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.json(await services.subagentService.deleteProfile(
        context(request.query, request.body), request.params.profileId,
      ));
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const parentSessionId = optionalString(request.query.parentSessionId, 'parentSessionId', 200);
      response.setHeader('Cache-Control', 'no-store');
      response.json(services.subagentRuntime.list(parentSessionId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const parentSessionId = requiredString(request.body?.parentSessionId, 'parentSessionId', 200);
      const parent = services.sessionManager.get(parentSessionId)
        ?? await services.sessionManager.loadFromStore(parentSessionId);
      if (!parent) {
        response.status(404).json({ error: 'Parent session not found' });
        return;
      }
      const effective = resolveEffectiveConfiguration(services, {
        projectId: parent.workspaceId,
        sessionId: parent.id,
        session: parent,
      });
      const run = await services.subagentRuntime.start({
        parentSessionId,
        profileId: requiredString(request.body?.profileId, 'profileId', 80),
        task: requiredString(request.body?.task, 'task'),
        provider: requiredString(request.body?.provider, 'provider', 100),
        parentToolPreset: effective.values.toolPreset,
        ...(typeof request.body?.background === 'boolean' ? { background: request.body.background } : {}),
      });
      response.status(202).json(run);
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs/:runId', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const run = services.subagentRuntime.get(request.params.runId);
      if (!run) {
        response.status(404).json({ error: 'Subagent run not found' });
        return;
      }
      response.json(run);
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:runId/stop', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.status(202).json(services.subagentRuntime.stop(request.params.runId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:runId/acknowledge', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.json(services.subagentRuntime.acknowledge(request.params.runId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
