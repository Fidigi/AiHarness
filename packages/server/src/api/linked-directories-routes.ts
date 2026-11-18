import { Router, type Response } from 'express';
import { LinkedDirectoryError, WorkspacePathError, type LinkedDirectoryAccess, type LinkedDirectorySelector } from '@ai-harness/core';
import type { LinkedDirectoriesService } from '../runtime/linked-directories-service.js';
import { requireCapability } from '../security/request-security.js';

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}
function string(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0');
}
function selector(value: unknown, access = false, mutation = false): value is Record<string, unknown> & LinkedDirectorySelector {
  return object(value, ['cwd', 'directory', 'id', 'revision', ...(access ? ['path'] : []), ...(mutation ? ['allowed', 'confirm'] : [])])
    && string(value.cwd, 4096) && string(value.directory, 4096)
    && typeof value.id === 'string' && /^[a-f0-9]{64}$/u.test(value.id)
    && typeof value.revision === 'string' && /^[a-f0-9]{64}$/u.test(value.revision)
    && (!access || string(value.path, 4096));
}
function failure(response: Response, error: unknown): void {
  const code = error instanceof LinkedDirectoryError ? error.code
    : error instanceof WorkspacePathError ? 'unsafe-target'
      : (error as { code?: unknown })?.code === 'source-trust-required' ? 'source-trust-required' : 'store-unavailable';
  const status = code === 'invalid-request' ? 400 : code === 'too-large' ? 413
    : ['stale-entry', 'consent-required', 'source-trust-required'].includes(code) ? 409
      : code === 'unsafe-target' ? 403 : 503;
  response.status(status).json({ error: 'The linked-directory operation was refused.', code });
}
/** Must also be mounted behind the application's authentication and Origin middleware. */
export function createLinkedDirectoriesRouter(service: () => Promise<LinkedDirectoriesService | undefined>): Router {
  const router = Router();
  router.use(requireCapability('workspace:read'));
  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  const getService = async (): Promise<LinkedDirectoriesService> => {
    const result = await service();
    if (!result) throw new LinkedDirectoryError('store-unavailable');
    return result;
  };
  router.get('/', async (request, response) => {
    try {
      if (!object(request.query, ['cwd', 'directory']) || !string(request.query.cwd, 4096)
        || (request.query.directory !== undefined && !string(request.query.directory, 4096))) {
        throw new LinkedDirectoryError('invalid-request');
      }
      response.json(await (await getService()).list(request.query.cwd, request.query.directory as string | undefined));
    } catch (error) { failure(response, error); }
  });
  router.post('/consent', requireCapability('workspace:write'), async (request, response) => {
    try {
      if (!selector(request.body, false, true) || request.body.confirm !== true || typeof request.body.allowed !== 'boolean') {
        throw new LinkedDirectoryError('invalid-request');
      }
      response.json(await (await getService()).setConsent(request.body, request.body.allowed, true));
    } catch (error) { failure(response, error); }
  });
  for (const operation of ['browse', 'content'] as const) {
    router.get(`/${operation}`, requireCapability('files:read'), async (request, response) => {
      try {
        if (!selector(request.query, true)) throw new LinkedDirectoryError('invalid-request');
        const current = await getService();
        const input = request.query as unknown as LinkedDirectoryAccess;
        response.json(operation === 'browse' ? await current.browse(input) : await current.read(input));
      } catch (error) { failure(response, error); }
    });
  }
  return router;
}
