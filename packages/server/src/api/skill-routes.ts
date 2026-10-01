import { Router } from 'express';
import { requireCapability } from '../security/request-security.js';
import type { RuntimeServices } from '../runtime/services.js';

function optionalString(value: unknown, field: string, max = 4_096): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error(`${field} invalide.`), { status: 400, code: 'INVALID_INPUT' });
  }
  return value;
}

function requiredString(value: unknown, field: string, max: number): string {
  const result = optionalString(value, field, max)?.trim();
  if (!result) throw Object.assign(new Error(`${field} requis.`), { status: 400, code: 'INVALID_INPUT' });
  return result;
}

function enabledSkillKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000
    || !value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 500)) {
    throw Object.assign(new Error('Liste de skills activés invalide.'), { status: 400, code: 'INVALID_ENABLED_SKILLS' });
  }
  return [...new Set(value)];
}

export function createSkillRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const projectId = optionalString(request.query.projectId, 'projectId', 200);
      const catalog = await services.skillCatalog.getCatalog({
        cwd: optionalString(request.query.cwd, 'cwd'),
        projectId,
        refresh: request.query.refresh === '1' || request.query.refresh === 'true',
        configurationScope: projectId ? 'project' : 'global',
      });
      response.setHeader('Cache-Control', 'no-store');
      response.json(catalog);
    } catch (error) {
      next(error);
    }
  });

  router.get('/registry', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.setHeader('Cache-Control', 'no-store');
      response.json(await services.skillRegistry.search({
        query: optionalString(request.query.query, 'query', 500),
        cwd: optionalString(request.query.cwd, 'cwd'),
        projectId: optionalString(request.query.projectId, 'projectId', 200),
        refresh: request.query.refresh === '1' || request.query.refresh === 'true',
      }));
    } catch (error) { next(error); }
  });

  router.post('/registry/install', requireCapability('packages'), async (request, response, next) => {
    try {
      const scope = request.body?.scope === 'global' || request.body?.scope === 'project' ? request.body.scope : undefined;
      if (!scope) {
        response.status(400).json({ error: 'Skill installation scope is invalid.' });
        return;
      }
      const services = await servicesPromise;
      const cwd = optionalString(request.body?.cwd, 'cwd');
      const projectId = optionalString(request.body?.projectId, 'projectId', 200);
      const result = await services.skillRegistry.install({
        id: requiredString(request.body?.id, 'id', 200), scope, cwd, projectId,
      });
      const catalog = await services.skillCatalog.getCatalog({ cwd, projectId, refresh: true });
      response.status(201).json({ entry: result.entry, catalog });
    } catch (error) { next(error); }
  });

  router.post('/registry/update', requireCapability('packages'), async (request, response, next) => {
    try {
      const scope = request.body?.scope === 'global' || request.body?.scope === 'project' ? request.body.scope : undefined;
      if (!scope) {
        response.status(400).json({ error: 'Skill update scope is invalid.' });
        return;
      }
      const services = await servicesPromise;
      const shared = {
        scope,
        cwd: optionalString(request.body?.cwd, 'cwd'),
        projectId: optionalString(request.body?.projectId, 'projectId', 200),
      };
      const result = request.body?.all === true
        ? await services.skillRegistry.updateAll(shared)
        : { entry: (await services.skillRegistry.install({
          id: requiredString(request.body?.id, 'id', 200), ...shared,
        })).entry };
      const catalog = await services.skillCatalog.getCatalog({
        cwd: shared.cwd, projectId: shared.projectId, refresh: true,
      });
      response.json({ result, catalog });
    } catch (error) { next(error); }
  });

  router.patch('/enabled', requireCapability('configuration'), async (request, response, next) => {
    try {
      const cwd = optionalString(request.body?.cwd, 'cwd');
      const projectId = optionalString(request.body?.projectId, 'projectId', 200);
      const enabledSkills = enabledSkillKeys(request.body?.enabledSkills);
      const services = await servicesPromise;
      const configurationScope = projectId ? 'project' : 'global';
      const catalog = await services.skillCatalog.getCatalog({ cwd, projectId, configurationScope });
      const known = new Map(catalog.skills.map(skill => [skill.key, skill]));
      const unknown = enabledSkills.find(key => !known.has(key));
      if (unknown) {
        response.status(400).json({ error: `Skill inconnu : ${unknown}`, code: 'UNKNOWN_SKILL' });
        return;
      }
      const untrusted = enabledSkills.map(key => known.get(key)).find(skill => skill && !skill.trusted);
      if (untrusted) {
        response.status(409).json({
          error: `Le projet doit être approuvé avant d'activer ${untrusted.name}.`,
          code: 'PROJECT_TRUST_REQUIRED',
        });
        return;
      }
      await services.configurationStore.patch(
        configurationScope,
        { enabledSkills },
        configurationScope === 'project' ? catalog.projectId : undefined,
      );
      response.json(await services.skillCatalog.getCatalog({
        cwd: catalog.cwd,
        ...(configurationScope === 'project' ? { projectId: catalog.projectId } : {}),
        configurationScope,
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
