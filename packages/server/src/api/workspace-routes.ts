import { Router } from 'express';
import type { RuntimeServices } from '../runtime/services.js';
import { requireCapability } from '../security/request-security.js';

export function createWorkspaceRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/roots', async (_request, response, next) => {
    try {
      const { workspaceManager } = await servicesPromise;
      response.json({ roots: workspaceManager.getAllowedRoots() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/default', async (_request, response, next) => {
    try {
      const services = await servicesPromise;
      const cwd = await services.workspaceManager.getDefaultCwd();
      response.json(await services.workspaceManager.describe(cwd, await services.trustManager.isTrusted(cwd)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/validate', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      if (typeof request.body?.cwd !== 'string') {
        response.status(400).json({ error: 'cwd requis.' });
        return;
      }
      const cwd = await services.workspaceManager.resolve(request.body.cwd, { kind: 'directory' });
      response.json(await services.workspaceManager.describe(cwd, await services.trustManager.isTrusted(cwd)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/browse', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const input = typeof request.query.path === 'string'
        ? request.query.path
        : await services.workspaceManager.getDefaultCwd();
      response.json(await services.workspaceManager.browse(input, request.query.parent === '1'));
    } catch (error) {
      next(error);
    }
  });

  router.get('/worktrees', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      if (typeof request.query.cwd !== 'string') {
        response.status(400).json({ error: 'cwd requis.' });
        return;
      }
      response.json(await services.workspaceManager.listWorktrees(request.query.cwd));
    } catch (error) {
      next(error);
    }
  });

  router.post('/worktrees', requireCapability('workspace:write'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd, path, branch, createBranch, startPoint } = request.body ?? {};
      if (![cwd, path, branch].every(value => typeof value === 'string')) {
        response.status(400).json({ error: 'cwd, path et branch sont requis.' });
        return;
      }
      const canonical = await services.workspaceManager.resolve(cwd, { kind: 'directory' });
      if (!await services.trustManager.isTrusted(canonical)) {
        response.status(409).json({ error: 'Workspace non approuvé.', code: 'PROJECT_TRUST_REQUIRED' });
        return;
      }
      await services.workspaceManager.createWorktree({
        cwd: canonical,
        path,
        branch,
        createBranch: Boolean(createBranch),
        startPoint: typeof startPoint === 'string' ? startPoint : undefined,
      });
      const createdPath = await services.workspaceManager.resolve(path, { kind: 'directory' });
      response.status(201).json(await services.workspaceManager.describe(
        createdPath,
        await services.trustManager.isTrusted(createdPath),
      ));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/worktrees', requireCapability('workspace:write'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd, path, confirm, force } = request.body ?? {};
      if (typeof cwd !== 'string' || typeof path !== 'string' || confirm !== true) {
        response.status(400).json({ error: 'cwd, path et confirmation sont requis.' });
        return;
      }
      const canonical = await services.workspaceManager.resolve(cwd, { kind: 'directory' });
      if (!await services.trustManager.isTrusted(canonical)) {
        response.status(409).json({ error: 'Workspace non approuvé.', code: 'PROJECT_TRUST_REQUIRED' });
        return;
      }
      await services.workspaceManager.removeWorktree(canonical, path, Boolean(force));
      response.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/trust', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      if (typeof request.query.cwd !== 'string') {
        response.status(400).json({ error: 'cwd requis.' });
        return;
      }
      const cwd = await services.workspaceManager.resolve(request.query.cwd, { kind: 'directory' });
      response.json({ cwd, trusted: await services.trustManager.isTrusted(cwd) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/trust', requireCapability('workspace:write'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      if (typeof request.body?.cwd !== 'string' || request.body?.confirm !== true) {
        response.status(400).json({ error: 'Une confirmation explicite est requise.' });
        return;
      }
      const cwd = await services.workspaceManager.resolve(request.body.cwd, { kind: 'directory' });
      await services.trustManager.trust(cwd);
      response.json({ cwd, trusted: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/trust', requireCapability('workspace:write'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      if (typeof request.body?.cwd !== 'string' || request.body?.confirm !== true) {
        response.status(400).json({ error: 'Une confirmation explicite est requise.' });
        return;
      }
      const cwd = await services.workspaceManager.resolve(request.body.cwd, { kind: 'directory' });
      await services.trustManager.untrust(cwd);
      for (const terminal of services.terminalRuntime.list(cwd)) {
        if (terminal.status === 'running') services.terminalRuntime.kill(terminal.id);
      }
      response.json({ cwd, trusted: false });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
