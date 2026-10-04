import { Router } from 'express';
import type { RuntimeServices } from '../runtime/services.js';

function optionalCwd(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error('cwd invalide.'), { status: 400, code: 'INVALID_INPUT' });
  }
  return value;
}

/** File-only MCP inventory. GET never starts a process, command resolver, network transport, or OAuth store. */
export function createMcpRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const overview = await services.mcpInventory.getOverview(optionalCwd(request.query.cwd));
      response.setHeader('Cache-Control', 'no-store');
      response.json(overview);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
