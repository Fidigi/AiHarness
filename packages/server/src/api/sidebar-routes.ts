import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RuntimeServices } from '../runtime/services.js';
import { parseSidebarChange, sidebarError, SidebarStateStore } from '../runtime/sidebar-state.js';
import { requireCapability } from '../security/request-security.js';

export function createSidebarRouter(services: Promise<RuntimeServices>, file: string): Router {
  const router = Router();
  const store = new SidebarStateStore(file);
  router.use(requireCapability('sessions'), (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', async (_request, response, next) => {
    try { response.json(await store.read()); } catch (error) { next(error); }
  });
  router.post('/', async (request, response, next) => {
    try {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['revision', 'change', 'undoToken'].includes(key))
        || (body.undoToken !== undefined && (typeof body.undoToken !== 'string' || body.undoToken.length > 64 || body.change !== undefined))) {
        throw sidebarError(400, 'invalid-sidebar-change');
      }
      const change = body.undoToken === undefined ? parseSidebarChange(body.change) : undefined;
      if (change) {
        const runtime = await services;
        if (change.kind === 'families') {
          const known = new Set(runtime.sessionManager.list().map(session => session.branchId || session.id));
          if (change.ids.some(id => !known.has(id))) throw sidebarError(404, 'sidebar-family-not-found');
        } else {
          change.cwd = await runtime.workspaceManager.resolve(change.cwd, { kind: 'directory' });
          if (change.kind === 'move-project' && change.before) change.before = await runtime.workspaceManager.resolve(change.before, { kind: 'directory' });
        }
      }
      response.json(await store.mutate(body.revision, change, body.undoToken));
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    const failure = error as { code?: string; status?: number };
    if (failure && typeof failure.code === 'string' && /^(?:invalid-sidebar-|sidebar-)[a-z-]+$/.test(failure.code)
      && [400, 404, 409, 503].includes(failure.status ?? 0)) {
      response.status(failure.status!).json({ error: failure.code, code: failure.code });
    } else next(error);
  });
  return router;
}
