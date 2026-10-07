import { Router, type Response } from 'express';
import { ExternalOpenError, WorkspacePathError, type ProjectTrustStatus } from '@ai-harness/core';
import type { RuntimeServices } from '../runtime/services.js';
import { requireCapability } from '../security/request-security.js';
import {
  fileManagerAvailable,
  openWorkspaceDirectory,
  type WorkspaceFileManagerOptions,
} from './workspace-file-manager.js';

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every(key => keys.includes(key));
}

function sendWorkspacePathError(response: Response, error: unknown): boolean {
  if (!(error instanceof WorkspacePathError)) return false;
  const status = error.code === 'OUTSIDE_ALLOWED_ROOTS' ? 403
    : error.code === 'NOT_FOUND' ? 404
      : ['ALREADY_EXISTS', 'FORCE_REQUIRED', 'GIT_ERROR'].includes(error.code) ? 409 : 400;
  const code = error.code.toLowerCase().replaceAll('_', '-');
  const message = error.code === 'ALREADY_EXISTS' ? 'A file or directory already has this name.'
    : error.code === 'FORCE_REQUIRED' ? 'Worktree removal requires force confirmation.'
      : error.code === 'OUTSIDE_ALLOWED_ROOTS' ? 'The path is outside the allowed workspace roots.'
        : error.code === 'NOT_FOUND' ? 'The workspace path was not found.'
          : error.code === 'WRONG_KIND' ? 'The path must identify a directory.'
            : error.code === 'GIT_ERROR' ? 'The Git workspace operation failed.'
              : 'The workspace path is invalid.';
  response.status(status).json({ error: message, code });
  return true;
}

function withOperationTrust(status: ProjectTrustStatus): ProjectTrustStatus & { operationTrusted: boolean } {
  return {
    ...status,
    operationTrusted: status.decision === true && status.decisionError === undefined,
  };
}

async function describeWorkspace(services: RuntimeServices, cwd: string) {
  const status = await services.trustManager.getStatus(cwd);
  return {
    ...await services.workspaceManager.describe(cwd, status.trusted),
    operationTrusted: status.decision === true && status.decisionError === undefined,
  };
}

export function createWorkspaceRouter(
  servicesPromise: Promise<RuntimeServices>,
  fileManagerOptions: WorkspaceFileManagerOptions = {},
): Router {
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
      response.json(await describeWorkspace(services, cwd));
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
      response.json(await describeWorkspace(services, cwd));
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
      if (!sendWorkspacePathError(response, error)) next(error);
    }
  });

  router.post('/browse', requireCapability('workspace:write'), async (request, response, next) => {
    try {
      if (!hasOnlyKeys(request.body, ['parent', 'name'])
        || typeof request.body.parent !== 'string' || request.body.parent.length > 4_096
        || typeof request.body.name !== 'string' || request.body.name.length > 255) {
        response.status(400).json({ error: 'A bounded parent and directory name are required.', code: 'invalid-request' });
        return;
      }
      const services = await servicesPromise;
      const created = await services.workspaceManager.createDirectory(request.body.parent, request.body.name);
      response.status(201).json({ path: created });
    } catch (error) {
      if (!sendWorkspacePathError(response, error)) next(error);
    }
  });

  router.get('/file-manager', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(fileManagerAvailable(request, fileManagerOptions.platform));
  });

  router.post('/file-manager', requireCapability('workspace:write'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const availability = fileManagerAvailable(request, fileManagerOptions.platform);
    if (!availability.available) {
      response.status(403).json({
        error: availability.reason === 'remote-request'
          ? 'Opening a host file manager is limited to loopback requests.'
          : 'Opening a host file manager is unsupported on this platform.',
        code: availability.reason,
      });
      return;
    }
    try {
      if (!hasOnlyKeys(request.body, ['cwd'])
        || typeof request.body.cwd !== 'string' || request.body.cwd.length > 4_096) {
        response.status(400).json({ error: 'A bounded cwd is required.', code: 'invalid-request' });
        return;
      }
      const services = await servicesPromise;
      const cwd = await services.workspaceManager.resolve(request.body.cwd, { kind: 'directory' });
      await openWorkspaceDirectory(cwd, fileManagerOptions);
      response.json({ opened: true });
    } catch (error) {
      if (sendWorkspacePathError(response, error)) return;
      if (error instanceof ExternalOpenError) {
        response.status(error.code === 'UNSUPPORTED_PLATFORM' ? 403 : 503).json({
          error: error.code === 'UNSUPPORTED_PLATFORM'
            ? 'Opening a host file manager is unsupported on this platform.'
            : 'The host file manager could not be started.',
          code: error.code.toLowerCase().replaceAll('_', '-'),
        });
        return;
      }
      response.status(503).json({ error: 'The host file manager could not be started.', code: 'launch-failed' });
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
      response.status(201).json(await describeWorkspace(services, createdPath));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/worktrees', requireCapability('workspace:write'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { cwd, path, confirm, force } = request.body ?? {};
      if (!hasOnlyKeys(request.body, ['cwd', 'path', 'confirm', 'force'])
        || typeof cwd !== 'string' || cwd.length > 4_096
        || typeof path !== 'string' || path.length > 4_096
        || confirm !== true || (force !== undefined && typeof force !== 'boolean')) {
        response.status(400).json({ error: 'cwd, path et confirmation sont requis.', code: 'invalid-request' });
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
      if (!sendWorkspacePathError(response, error)) next(error);
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
      response.json(withOperationTrust(await services.trustManager.getStatus(cwd)));
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
      response.json(withOperationTrust(await services.trustManager.getStatus(cwd)));
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
      await services.trustManager.refuse(cwd);
      for (const terminal of services.terminalRuntime.list(cwd)) {
        if (terminal.status === 'running') services.terminalRuntime.kill(terminal.id);
      }
      response.json(withOperationTrust(await services.trustManager.getStatus(cwd)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
