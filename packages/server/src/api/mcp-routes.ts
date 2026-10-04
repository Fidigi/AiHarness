import {
  MCP_IMPORT_MAX_BYTES,
  McpConfigMutationError,
  type McpConfigScope,
  type McpImportSyntax,
} from '@ai-harness/core';
import { Router, type Response } from 'express';
import type { RuntimeServices } from '../runtime/services.js';
import { requireCapability } from '../security/request-security.js';

const CWD_INVALID = 'cwd invalide.';
const INVALID_ACTION = 'Action MCP invalide.';

function optionalCwd(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new McpConfigMutationError('invalid-request', CWD_INVALID);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function scopeOf(value: unknown): McpConfigScope | undefined {
  return value === 'global' || value === 'project' ? value : undefined;
}

function revisionOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function mutationStatus(error: McpConfigMutationError): number {
  switch (error.code) {
    case 'invalid-request': return 400;
    case 'trust-required': return 403;
    case 'trust-unavailable': return 503;
    case 'target-not-found': return 404;
    case 'lock-timeout': return 423;
    case 'invalid-config':
    case 'stale-revision':
    case 'target-conflict':
    case 'target-invalid':
    case 'unsafe-path': return 409;
    case 'write-failed': return 500;
    default: return 500;
  }
}

function sendMutationError(response: Response, error: unknown): void {
  if (error instanceof McpConfigMutationError) {
    response.status(mutationStatus(error)).json({
      error: error.message,
      code: error.code,
      uncertain: error.uncertain,
    });
    return;
  }
  response.status(500).json({
    error: 'La mutation MCP a échoué.',
    code: 'write-failed',
    uncertain: true,
  });
}

export function createMcpRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const services = await servicesPromise;
      const overview = await services.mcpInventory.getOverview(optionalCwd(request.query.cwd));
      response.json(overview);
    } catch (error) {
      if (error instanceof McpConfigMutationError && error.code === 'invalid-request') {
        response.status(400).json({ error: CWD_INVALID });
      } else {
        next(error);
      }
    }
  });

  router.post('/preview', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body: unknown = request.body;
    if (!isRecord(body)
      || !hasOnlyKeys(body, ['cwd', 'syntax', 'text'])
      || typeof body.text !== 'string'
      || body.text.includes('\0')
      || Buffer.byteLength(body.text, 'utf8') > MCP_IMPORT_MAX_BYTES
      || (body.cwd !== undefined && typeof body.cwd !== 'string')
      || (body.syntax !== undefined && body.syntax !== 'foreign' && body.syntax !== 'aiharness')) {
      response.status(400).json({ error: 'Aperçu d’import MCP invalide.', code: 'invalid-request' });
      return;
    }
    try {
      const services = await servicesPromise;
      const preview = await services.mcpInventory.previewImport(
        body.text,
        (body.syntax ?? 'foreign') as McpImportSyntax,
        optionalCwd(body.cwd),
      );
      response.json(preview);
    } catch (error) {
      if (error instanceof McpConfigMutationError) sendMutationError(response, error);
      else response.status(500).json({ error: 'L’aperçu MCP a échoué.', code: 'preview-failed' });
    }
  });

  router.post('/actions', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body: unknown = request.body;
    if (!isRecord(body) || typeof body.action !== 'string') {
      response.status(400).json({ error: INVALID_ACTION, code: 'invalid-request', uncertain: false });
      return;
    }

    try {
      if (body.action === 'set-enabled') {
        const scope = scopeOf(body.scope);
        const revision = revisionOf(body.revision);
        if (!hasOnlyKeys(body, ['action', 'cwd', 'enabled', 'names', 'revision', 'scope'])
          || !scope || revision === undefined || typeof body.enabled !== 'boolean'
          || !Array.isArray(body.names) || !body.names.every(name => typeof name === 'string')
          || (body.cwd !== undefined && typeof body.cwd !== 'string')) {
          throw new McpConfigMutationError('invalid-request', INVALID_ACTION);
        }
        const services = await servicesPromise;
        const cwd = optionalCwd(body.cwd);
        response.json(await services.mcpInventory.setEnabled({
          scope,
          revision,
          enabled: body.enabled,
          names: body.names,
          ...(cwd ? { cwd } : {}),
        }));
        return;
      }

      if (body.action === 'remove') {
        const scope = scopeOf(body.scope);
        const revision = revisionOf(body.revision);
        if (!hasOnlyKeys(body, ['action', 'cwd', 'name', 'revision', 'scope'])
          || !scope || revision === undefined || typeof body.name !== 'string'
          || (body.cwd !== undefined && typeof body.cwd !== 'string')) {
          throw new McpConfigMutationError('invalid-request', INVALID_ACTION);
        }
        const services = await servicesPromise;
        const cwd = optionalCwd(body.cwd);
        response.json(await services.mcpInventory.remove({
          scope,
          revision,
          name: body.name,
          ...(cwd ? { cwd } : {}),
        }));
        return;
      }

      if (body.action === 'restore') {
        if (!hasOnlyKeys(body, ['action', 'cwd', 'undoToken'])
          || typeof body.undoToken !== 'string' || body.undoToken.length < 16
          || body.undoToken.length > 128 || !/^[A-Za-z0-9-]+$/u.test(body.undoToken)
          || (body.cwd !== undefined && typeof body.cwd !== 'string')) {
          throw new McpConfigMutationError('invalid-request', INVALID_ACTION);
        }
        const services = await servicesPromise;
        const cwd = optionalCwd(body.cwd);
        response.json(await services.mcpInventory.restore({
          undoToken: body.undoToken,
          ...(cwd ? { cwd } : {}),
        }));
        return;
      }

      throw new McpConfigMutationError('invalid-request', INVALID_ACTION);
    } catch (error) {
      sendMutationError(response, error);
    }
  });

  return router;
}
