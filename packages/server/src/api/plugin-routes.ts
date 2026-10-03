import { Router, type Request } from 'express';
import type { PluginScope } from '@ai-harness/core';
import { requireCapability } from '../security/request-security.js';
import type { RuntimeServices } from '../runtime/services.js';

function optionalString(value: unknown, field: string, max = 4_096): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error(`${field} invalide.`), { status: 400, code: 'INVALID_INPUT' });
  }
  return value;
}

function requiredString(value: unknown, field: string, max = 4_096): string {
  const result = optionalString(value, field, max)?.trim();
  if (!result) throw Object.assign(new Error(`${field} requis.`), { status: 400, code: 'INVALID_INPUT' });
  return result;
}

function optionalScope(value: unknown): PluginScope | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'global' && value !== 'project') {
    throw Object.assign(new Error('Portée de plugin invalide.'), { status: 400, code: 'INVALID_PLUGIN_SCOPE' });
  }
  return value;
}

function requiredScope(value: unknown): PluginScope {
  const scope = optionalScope(value);
  if (!scope) throw Object.assign(new Error('Portée de plugin requise.'), { status: 400, code: 'INVALID_PLUGIN_SCOPE' });
  return scope;
}

function operationSignal(request: Request): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  return {
    signal: controller.signal,
    dispose: () => request.off('aborted', abort),
  };
}

function context(body: Record<string, unknown> | undefined): { cwd?: string; projectId?: string } {
  return {
    ...(optionalString(body?.cwd, 'cwd') ? { cwd: optionalString(body?.cwd, 'cwd') } : {}),
    ...(optionalString(body?.projectId, 'projectId', 200)
      ? { projectId: optionalString(body?.projectId, 'projectId', 200) }
      : {}),
  };
}

async function refreshSkills(services: RuntimeServices, cwd?: string, projectId?: string): Promise<void> {
  // A global package can affect every workspace, so discard all derived skill catalogues.
  services.skillCatalog.invalidate();
  await services.skillCatalog.getCatalog({ cwd, projectId, refresh: true });
}

/** Explicit plugin administration. No install, update, or network check runs from a GET request. */
export function createPluginRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const cwd = optionalString(request.query.cwd, 'cwd');
      const projectId = optionalString(request.query.projectId, 'projectId', 200);
      const catalog = await services.pluginService.getCatalog({
        cwd,
        projectId,
        refresh: request.query.refresh === '1' || request.query.refresh === 'true',
      });
      response.setHeader('Cache-Control', 'no-store');
      response.json(catalog);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', requireCapability('packages'), async (request, response, next) => {
    const operation = operationSignal(request);
    try {
      const services = await servicesPromise;
      const input = context(request.body);
      const action = requiredString(request.body?.action, 'action', 30);
      let catalog;
      if (action === 'install') {
        catalog = await services.pluginService.install({
          ...input,
          scope: requiredScope(request.body?.scope),
          source: requiredString(request.body?.source, 'source', 1_000),
        }, operation.signal);
      } else if (action === 'enable' || action === 'disable') {
        catalog = await services.pluginService.setEnabled({
          ...input,
          scope: requiredScope(request.body?.scope),
          key: requiredString(request.body?.key, 'key', 300),
          enabled: action === 'enable',
        });
      } else if (action === 'remove') {
        catalog = await services.pluginService.remove({
          ...input,
          scope: requiredScope(request.body?.scope),
          key: requiredString(request.body?.key, 'key', 300),
        });
      } else if (action === 'update') {
        const key = optionalString(request.body?.key, 'key', 300);
        catalog = key
          ? await services.pluginService.update({
            ...input,
            scope: requiredScope(request.body?.scope),
            key,
          }, operation.signal)
          : await services.pluginService.updateAll({
            ...input,
            scope: optionalScope(request.body?.scope),
          }, operation.signal);
      } else {
        throw Object.assign(new Error('Action de plugin invalide.'), { status: 400, code: 'INVALID_PLUGIN_ACTION' });
      }
      await refreshSkills(services, catalog.cwd, catalog.projectId);
      response.json(catalog);
    } catch (error) {
      next(error);
    } finally {
      operation.dispose();
    }
  });

  router.post('/check', requireCapability('packages'), async (request, response, next) => {
    const operation = operationSignal(request);
    try {
      const services = await servicesPromise;
      const updates = await services.pluginService.checkUpdates({
        ...context(request.body),
        ...(optionalString(request.body?.key, 'key', 300) ? { key: optionalString(request.body?.key, 'key', 300) } : {}),
        ...(optionalScope(request.body?.scope) ? { scope: optionalScope(request.body?.scope) } : {}),
      }, operation.signal);
      response.json({ updates });
    } catch (error) {
      next(error);
    } finally {
      operation.dispose();
    }
  });

  router.post('/reload', requireCapability('packages'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      let input = context(request.body);
      const sessionId = optionalString(request.body?.sessionId, 'sessionId', 300);
      if (sessionId) {
        const session = services.sessionManager.get(sessionId) ?? await services.sessionManager.loadFromStore(sessionId);
        if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404, code: 'SESSION_NOT_FOUND' });
        if (input.projectId && session.workspaceId && input.projectId !== session.workspaceId) throw Object.assign(
          new Error('La session n’appartient pas au workspace demandé.'),
          { status: 409, code: 'SESSION_WORKSPACE_MISMATCH' },
        );
        if (input.cwd && session.cwd) {
          const [requestedCwd, sessionCwd] = await Promise.all([
            services.workspaceManager.resolve(input.cwd, { kind: 'directory' }),
            services.workspaceManager.resolve(session.cwd, { kind: 'directory' }),
          ]);
          if (requestedCwd !== sessionCwd) throw Object.assign(
            new Error('La session n’appartient pas au workspace demandé.'),
            { status: 409, code: 'SESSION_WORKSPACE_MISMATCH' },
          );
        }
        input = {
          ...(session.cwd ? { cwd: session.cwd } : input.cwd ? { cwd: input.cwd } : {}),
          ...(session.workspaceId ? { projectId: session.workspaceId } : input.projectId ? { projectId: input.projectId } : {}),
        };
      }
      const result = await services.pluginService.reload(input);
      const executable = await services.reloadResources({
        cwd: result.catalog.cwd,
        projectId: result.catalog.projectId,
      });
      await refreshSkills(services, result.catalog.cwd, result.catalog.projectId);
      response.json({
        ...result,
        reload: {
          ...result.reload,
          generation: Math.max(result.reload.generation, executable.generation),
          restartRequired: executable.errors.length > 0,
          message: executable.errors.length
            ? 'Declarative resources were reloaded; executable extensions kept the previous atomic generation.'
            : 'Extensions, skills, tools and commands were reloaded atomically.',
          loadedExtensions: executable.loadedExtensions.length,
          errors: executable.errors,
          ...(sessionId ? { sessionId } : {}),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
