import {
  MCP_IMPORT_MAX_BYTES,
  MCP_IMPORT_MAX_FIELDS,
  MCP_IMPORT_MAX_SERVERS,
  McpConfigMutationError,
  McpOAuthFlowServiceError,
  mcpOAuthUrl,
  McpServerTargetError,
  type McpConfigScope,
  type McpExposure,
  type McpImportFieldValue,
  type McpImportSyntax,
  type McpImportWriteConfirmations,
  type McpOAuthCredentialManager,
  type McpOAuthFlowService,
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
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function serverName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256
    && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u.test(value);
}

function exposureOf(value: unknown): McpExposure | undefined {
  return value === 'direct' || value === 'codemode' || value === 'deferred' || value === 'hidden' ? value : undefined;
}

function configKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function flowId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{16,128}$/u.test(value);
}

function importFieldValues(value: unknown): Record<string, McpImportFieldValue> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > MCP_IMPORT_MAX_FIELDS) return undefined;
  const output: Record<string, McpImportFieldValue> = {};
  for (const [field, given] of Object.entries(value)) {
    if (!field || Buffer.byteLength(field, 'utf8') > 16 * 1024 || /[\u0000-\u001f\u007f]/u.test(field)) return undefined;
    if (typeof given === 'string' && Buffer.byteLength(given, 'utf8') <= 16 * 1024) {
      Object.defineProperty(output, field, { value: given, enumerable: true });
    } else if (isRecord(given) && hasOnlyKeys(given, ['reference'])
      && typeof given.reference === 'string' && Buffer.byteLength(given.reference, 'utf8') <= 256
      && !/[\u0000-\u001f\u007f]/u.test(given.reference)) {
      Object.defineProperty(output, field, {
        value: { reference: given.reference }, enumerable: true,
      });
    } else return undefined;
  }
  return output;
}

function importSecretReferences(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > MCP_IMPORT_MAX_FIELDS) return undefined;
  const output: Record<string, string> = {};
  for (const [field, name] of Object.entries(value)) {
    if (!field || Buffer.byteLength(field, 'utf8') > 16 * 1024 || /[\u0000-\u001f\u007f]/u.test(field)
      || typeof name !== 'string' || Buffer.byteLength(name, 'utf8') > 256
      || /[\u0000-\u001f\u007f]/u.test(name)) return undefined;
    Object.defineProperty(output, field, { value: name, enumerable: true });
  }
  return output;
}

function importConfirmations(value: unknown): McpImportWriteConfirmations | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || !hasOnlyKeys(value, ['literalSecret', 'remoteHostVariables'])
    || (value.literalSecret !== undefined && value.literalSecret !== true)
    || (value.remoteHostVariables !== undefined && (!Array.isArray(value.remoteHostVariables)
      || value.remoteHostVariables.length > 128
      || !value.remoteHostVariables.every(name => typeof name === 'string'
        && Buffer.byteLength(name, 'utf8') <= 256 && !/[\u0000-\u001f\u007f]/u.test(name))))) {
    return undefined;
  }
  return {
    ...(value.literalSecret === true ? { literalSecret: true as const } : {}),
    ...(Array.isArray(value.remoteHostVariables)
      ? { remoteHostVariables: value.remoteHostVariables as string[] }
      : {}),
  };
}

function mutationStatus(error: McpConfigMutationError): number {
  switch (error.code) {
    case 'invalid-request': return 400;
    case 'trust-required': return 403;
    case 'trust-unavailable': return 503;
    case 'target-not-found': return 404;
    case 'lock-timeout': return 423;
    case 'folder-not-fresh':
    case 'invalid-config':
    case 'stale-revision':
    case 'trust-too-broad':
    case 'target-conflict':
    case 'target-invalid':
    case 'import-invalid':
    case 'fields-incomplete':
    case 'confirmation-required':
    case 'scope-blocked':
    case 'reserved-variable':
    case 'unsafe-path': return 409;
    case 'write-failed': return 500;
    default: return 500;
  }
}

function testTargetStatus(error: McpServerTargetError): number {
  switch (error.code) {
    case 'invalid-request': return 400;
    case 'trust-required': return 403;
    case 'server-not-found': return 404;
    case 'trust-unavailable': return 503;
    case 'config-unavailable':
    case 'server-invalid':
    case 'working-directory-unavailable': return 409;
    default: return 500;
  }
}

function sendMutationError(response: Response, error: unknown): void {
  if (error instanceof McpConfigMutationError) {
    response.status(mutationStatus(error)).json({
      error: error.message,
      code: error.code,
      uncertain: error.uncertain,
      ...(error.trustKept ? { trustKept: true } : {}),
    });
    return;
  }
  response.status(500).json({
    error: 'La mutation MCP a échoué.',
    code: 'write-failed',
    uncertain: true,
  });
}

export interface McpRouterOptions {
  getOAuthRuntime?: () => Promise<{
    credentials: McpOAuthCredentialManager;
    flows: McpOAuthFlowService;
  } | undefined>;
}

export function createMcpRouter(
  servicesPromise: Promise<RuntimeServices>,
  options: McpRouterOptions = {},
): Router {
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

  router.post('/oauth/status', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body: unknown = request.body;
    if (!isRecord(body) || !hasOnlyKeys(body, ['cwd', 'servers'])
      || !Array.isArray(body.servers) || body.servers.length > MCP_IMPORT_MAX_SERVERS
      || (body.cwd !== undefined && typeof body.cwd !== 'string')
      || !body.servers.every(item => isRecord(item)
        && hasOnlyKeys(item, ['configKey', 'name', 'scope'])
        && scopeOf(item.scope) !== undefined && serverName(item.name) && configKey(item.configKey))) {
      response.status(400).json({ error: 'Statut OAuth MCP invalide.', code: 'invalid-request' });
      return;
    }
    try {
      const cwd = optionalCwd(body.cwd);
      const services = await servicesPromise;
      const runtime = await options.getOAuthRuntime?.();
      if (!runtime) {
        response.status(503).json({ error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
        return;
      }
      const resolved = [] as Array<{
        scope: McpConfigScope;
        name: string;
        configKey: string;
        identity: { name: string; url: string };
      }>;
      for (const item of body.servers as Array<Record<string, unknown>>) {
        try {
          const scope = scopeOf(item.scope)!;
          const server = await services.mcpInventory.resolveServerTarget({
            scope,
            name: item.name as string,
            expectedConfigKey: item.configKey as string,
            ...(cwd ? { cwd } : {}),
          });
          const url = mcpOAuthUrl(server.target.config);
          if (!url) continue;
          resolved.push({
            scope,
            name: server.target.name,
            configKey: server.target.configKey,
            identity: { name: server.target.name, url },
          });
        } catch {
          // A stale/invalid row remains unknown; no target detail crosses this batch boundary.
        }
      }
      const statuses = await runtime.credentials.statuses(resolved.map(item => item.identity));
      response.json({
        statuses: resolved.map((item, index) => ({
          scope: item.scope,
          name: item.name,
          configKey: item.configKey,
          ...statuses[index],
        })),
      });
    } catch (error) {
      if (error instanceof McpConfigMutationError && error.code === 'invalid-request') {
        response.status(400).json({ error: CWD_INVALID, code: 'invalid-request' });
      } else {
        response.status(503).json({ error: 'Le statut OAuth MCP est indisponible.', code: 'oauth-unavailable' });
      }
    }
  });

  router.post('/oauth/start', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body: unknown = request.body;
    const scope = isRecord(body) ? scopeOf(body.scope) : undefined;
    if (!isRecord(body) || !hasOnlyKeys(body, ['configKey', 'cwd', 'name', 'scope'])
      || !scope || !serverName(body.name) || !configKey(body.configKey)
      || (body.cwd !== undefined && typeof body.cwd !== 'string')) {
      response.status(400).json({ error: 'Connexion OAuth MCP invalide.', code: 'invalid-request' });
      return;
    }
    try {
      const cwd = optionalCwd(body.cwd);
      const services = await servicesPromise;
      const resolved = await services.mcpInventory.resolveServerTarget({
        scope,
        name: body.name,
        expectedConfigKey: body.configKey,
        ...(cwd ? { cwd } : {}),
      });
      if (!mcpOAuthUrl(resolved.target.config)) {
        response.status(409).json({ error: 'Ce serveur MCP n’utilise pas OAuth.', code: 'not-oauth' });
        return;
      }
      const runtime = await options.getOAuthRuntime?.();
      if (!runtime) {
        response.status(503).json({ error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
        return;
      }
      const started = runtime.flows.start(resolved);
      response.json({ ...started.flow, ...(started.joined ? { joined: true as const } : {}) });
    } catch (error) {
      if (error instanceof McpServerTargetError) {
        response.status(testTargetStatus(error)).json({ error: error.message, code: error.code });
      } else if (error instanceof McpConfigMutationError && error.code === 'invalid-request') {
        response.status(400).json({ error: CWD_INVALID, code: 'invalid-request' });
      } else if (error instanceof McpOAuthFlowServiceError) {
        response.status(error.code === 'flow-limit' ? 429 : 409).json({
          error: 'La connexion OAuth MCP ne peut pas démarrer.',
          code: error.code,
        });
      } else {
        response.status(500).json({ error: 'La connexion OAuth MCP a échoué.', code: 'oauth-failed' });
      }
    }
  });

  router.get('/oauth/flows/:flowId', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!flowId(request.params.flowId)) {
      response.status(400).json({ error: 'Flux OAuth MCP invalide.', code: 'invalid-request' });
      return;
    }
    try {
      const runtime = await options.getOAuthRuntime?.();
      if (!runtime) {
        response.status(503).json({ error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
        return;
      }
      const flow = runtime.flows.read(request.params.flowId);
      if (!flow) {
        response.status(404).json({ error: 'Flux OAuth MCP introuvable.', code: 'flow-not-found' });
        return;
      }
      response.json(flow);
    } catch {
      response.status(503).json({ error: 'Le flux OAuth MCP est indisponible.', code: 'oauth-unavailable' });
    }
  });

  router.post('/oauth/flows/:flowId/redirect', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body: unknown = request.body;
    if (!flowId(request.params.flowId) || !isRecord(body) || !hasOnlyKeys(body, ['redirectUrl'])) {
      response.status(400).json({ error: 'Redirection OAuth MCP invalide.', code: 'invalid-request' });
      return;
    }
    try {
      const runtime = await options.getOAuthRuntime?.();
      if (!runtime) {
        response.status(503).json({ error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
        return;
      }
      const result = runtime.flows.pasteRedirect(request.params.flowId, body.redirectUrl);
      if (!result) {
        response.status(404).json({ error: 'Flux OAuth MCP introuvable.', code: 'flow-not-found' });
      } else if (!result.ok) {
        response.status(400).json({ error: 'La redirection OAuth MCP a été refusée.', code: result.code });
      } else response.json(result.flow);
    } catch {
      response.status(503).json({ error: 'Le flux OAuth MCP est indisponible.', code: 'oauth-unavailable' });
    }
  });

  router.delete('/oauth/flows/:flowId', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!flowId(request.params.flowId)) {
      response.status(400).json({ error: 'Flux OAuth MCP invalide.', code: 'invalid-request' });
      return;
    }
    try {
      const runtime = await options.getOAuthRuntime?.();
      if (!runtime) {
        response.status(503).json({ error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
        return;
      }
      const flow = runtime.flows.cancel(request.params.flowId);
      if (!flow) {
        response.status(404).json({ error: 'Flux OAuth MCP introuvable.', code: 'flow-not-found' });
        return;
      }
      response.json(flow);
    } catch {
      response.status(503).json({ error: 'Le flux OAuth MCP est indisponible.', code: 'oauth-unavailable' });
    }
  });

  router.post('/oauth/logout', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body: unknown = request.body;
    const scope = isRecord(body) ? scopeOf(body.scope) : undefined;
    if (!isRecord(body) || !hasOnlyKeys(body, ['configKey', 'cwd', 'name', 'scope'])
      || !scope || !serverName(body.name) || !configKey(body.configKey)
      || (body.cwd !== undefined && typeof body.cwd !== 'string')) {
      response.status(400).json({ error: 'Déconnexion OAuth MCP invalide.', code: 'invalid-request' });
      return;
    }
    try {
      const cwd = optionalCwd(body.cwd);
      const services = await servicesPromise;
      const resolved = await services.mcpInventory.resolveServerTarget({
        scope,
        name: body.name,
        expectedConfigKey: body.configKey,
        ...(cwd ? { cwd } : {}),
      });
      const url = mcpOAuthUrl(resolved.target.config);
      if (!url) {
        response.status(409).json({ error: 'Ce serveur MCP n’utilise pas OAuth.', code: 'not-oauth' });
        return;
      }
      const runtime = await options.getOAuthRuntime?.();
      if (!runtime) {
        response.status(503).json({ error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
        return;
      }
      let removed: boolean;
      try {
        removed = await runtime.flows.signOut({ name: resolved.target.name, url });
      } finally {
        await services.mcpHost.disconnectServer(scope, resolved.target.name);
      }
      response.json({
        scope,
        name: resolved.target.name,
        configKey: resolved.target.configKey,
        removed,
      });
    } catch (error) {
      if (error instanceof McpServerTargetError) {
        response.status(testTargetStatus(error)).json({ error: error.message, code: error.code });
      } else if (error instanceof McpConfigMutationError && error.code === 'invalid-request') {
        response.status(400).json({ error: CWD_INVALID, code: 'invalid-request' });
      } else {
        response.status(500).json({ error: 'La déconnexion OAuth MCP a échoué.', code: 'oauth-failed' });
      }
    }
  });

  router.post('/test', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body: unknown = request.body;
    const scope = isRecord(body) ? scopeOf(body.scope) : undefined;
    if (!isRecord(body) || !hasOnlyKeys(body, ['cwd', 'name', 'scope']) || !scope
      || !serverName(body.name)
      || (body.cwd !== undefined && body.cwd !== null && (
        typeof body.cwd !== 'string' || body.cwd.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(body.cwd)
      ))) {
      response.status(400).json({ error: 'Test MCP invalide.', code: 'invalid-request' });
      return;
    }
    const controller = new AbortController();
    const abortDisconnectedClient = (): void => {
      if (!response.writableEnded) controller.abort('client-disconnected');
    };
    response.once('close', abortDisconnectedClient);
    if (response.destroyed) abortDisconnectedClient();
    try {
      const services = await servicesPromise;
      const cwd = optionalCwd(body.cwd);
      const result = await services.mcpInventory.testServer({
        scope,
        name: body.name,
        ...(cwd ? { cwd } : {}),
        signal: controller.signal,
      });
      if (!controller.signal.aborted && !response.destroyed) response.json(result);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      if (error instanceof McpServerTargetError) {
        response.status(testTargetStatus(error)).json({ error: error.message, code: error.code });
      } else if (error instanceof McpConfigMutationError && error.code === 'invalid-request') {
        response.status(400).json({ error: CWD_INVALID, code: 'invalid-request' });
      } else {
        response.status(500).json({ error: 'Le test MCP a échoué.', code: 'test-failed' });
      }
    } finally {
      response.off('close', abortDisconnectedClient);
    }
  });

  router.post('/preview', requireCapability('configuration'), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body: unknown = request.body;
    if (!isRecord(body)
      || !hasOnlyKeys(body, ['cwd', 'replacement', 'syntax', 'text'])
      || typeof body.text !== 'string'
      || body.text.includes('\0')
      || Buffer.byteLength(body.text, 'utf8') > MCP_IMPORT_MAX_BYTES
      || (body.cwd !== undefined && typeof body.cwd !== 'string')
      || (body.syntax !== undefined && body.syntax !== 'foreign' && body.syntax !== 'aiharness')) {
      response.status(400).json({ error: 'Aperçu d’import MCP invalide.', code: 'invalid-request' });
      return;
    }
    const replacement = body.replacement;
    if (replacement !== undefined && (!isRecord(replacement)
      || !hasOnlyKeys(replacement, ['name', 'revision', 'scope'])
      || !scopeOf(replacement.scope)
      || !serverName(replacement.name)
      || typeof replacement.revision !== 'string'
      || !/^[a-f0-9]{64}$/u.test(replacement.revision))) {
      response.status(400).json({ error: 'Aperçu d’import MCP invalide.', code: 'invalid-request' });
      return;
    }
    try {
      const services = await servicesPromise;
      const preview = await services.mcpInventory.previewImport(
        body.text,
        (body.syntax ?? 'foreign') as McpImportSyntax,
        optionalCwd(body.cwd),
        isRecord(replacement) ? {
          scope: scopeOf(replacement.scope)!,
          name: replacement.name as string,
          revision: replacement.revision as string,
        } : undefined,
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
      if (body.action === 'import') {
        const scope = scopeOf(body.scope);
        const revision = revisionOf(body.revision);
        const values = importFieldValues(body.values);
        const secretReferences = importSecretReferences(body.secretReferences);
        const confirmations = importConfirmations(body.confirmations);
        if (!hasOnlyKeys(body, [
          'action', 'confirmations', 'cwd', 'entryIndex', 'name', 'revision', 'scope',
          'secretReferences', 'syntax', 'text', 'trustProject', 'values',
        ]) || !scope || revision === undefined || values === undefined
          || secretReferences === undefined || confirmations === undefined
          || typeof body.text !== 'string' || body.text.includes('\0')
          || Buffer.byteLength(body.text, 'utf8') > MCP_IMPORT_MAX_BYTES
          || (body.syntax !== 'foreign' && body.syntax !== 'aiharness')
          || !Number.isSafeInteger(body.entryIndex) || (body.entryIndex as number) < 0
          || (body.entryIndex as number) >= MCP_IMPORT_MAX_SERVERS
          || (body.name !== undefined && (!serverName(body.name) || body.name.length > 64))
          || (body.trustProject !== undefined && body.trustProject !== true)
          || (body.trustProject === true && scope !== 'project')
          || (body.cwd !== undefined && typeof body.cwd !== 'string')) {
          throw new McpConfigMutationError('invalid-request', INVALID_ACTION);
        }
        const services = await servicesPromise;
        const cwd = optionalCwd(body.cwd);
        response.json(await services.mcpInventory.importServer({
          scope,
          revision,
          text: body.text,
          syntax: body.syntax,
          entryIndex: body.entryIndex as number,
          values,
          secretReferences,
          confirmations,
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(body.trustProject === true ? { trustProject: true as const } : {}),
          ...(cwd ? { cwd } : {}),
        }));
        return;
      }

      if (body.action === 'replace') {
        const scope = scopeOf(body.scope);
        const revision = revisionOf(body.revision);
        const values = importFieldValues(body.values);
        const secretReferences = importSecretReferences(body.secretReferences);
        const confirmations = importConfirmations(body.confirmations);
        if (!hasOnlyKeys(body, [
          'action', 'confirmations', 'cwd', 'entryIndex', 'name', 'revision', 'scope',
          'secretReferences', 'syntax', 'targetName', 'text', 'values',
        ]) || !scope || revision === undefined || values === undefined
          || secretReferences === undefined || confirmations === undefined
          || !serverName(body.targetName)
          || typeof body.text !== 'string' || body.text.includes('\0')
          || Buffer.byteLength(body.text, 'utf8') > MCP_IMPORT_MAX_BYTES
          || (body.syntax !== 'foreign' && body.syntax !== 'aiharness')
          || !Number.isSafeInteger(body.entryIndex) || (body.entryIndex as number) < 0
          || (body.entryIndex as number) >= MCP_IMPORT_MAX_SERVERS
          || (body.name !== undefined && (!serverName(body.name)
            || (body.name.length > 64 && body.name !== body.targetName)))
          || (body.cwd !== undefined && typeof body.cwd !== 'string')) {
          throw new McpConfigMutationError('invalid-request', INVALID_ACTION);
        }
        const services = await servicesPromise;
        const cwd = optionalCwd(body.cwd);
        response.json(await services.mcpInventory.replaceServer({
          scope,
          revision,
          targetName: body.targetName,
          text: body.text,
          syntax: body.syntax,
          entryIndex: body.entryIndex as number,
          values,
          secretReferences,
          confirmations,
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(cwd ? { cwd } : {}),
        }));
        return;
      }

      if (body.action === 'set-enabled') {
        const scope = scopeOf(body.scope);
        const revision = revisionOf(body.revision);
        if (!hasOnlyKeys(body, ['action', 'cwd', 'enabled', 'names', 'revision', 'scope'])
          || !scope || revision === undefined || typeof body.enabled !== 'boolean'
          || !Array.isArray(body.names) || body.names.length > MCP_IMPORT_MAX_SERVERS
          || !body.names.every(serverName)
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

      if (body.action === 'set-exposure') {
        const scope = scopeOf(body.scope);
        const revision = revisionOf(body.revision);
        const exposure = exposureOf(body.exposure);
        if (!hasOnlyKeys(body, ['action', 'cwd', 'exposure', 'name', 'revision', 'scope', 'tool'])
          || !scope || revision === undefined || !exposure || !serverName(body.name)
          || (body.tool !== undefined && !serverName(body.tool))
          || (body.cwd !== undefined && typeof body.cwd !== 'string')) {
          throw new McpConfigMutationError('invalid-request', INVALID_ACTION);
        }
        const services = await servicesPromise;
        const cwd = optionalCwd(body.cwd);
        response.json(await services.mcpInventory.setExposure({
          scope,
          revision,
          name: body.name,
          exposure,
          ...(body.tool !== undefined ? { tool: body.tool as string } : {}),
          ...(cwd ? { cwd } : {}),
        }));
        return;
      }

      if (body.action === 'remove') {
        const scope = scopeOf(body.scope);
        const revision = revisionOf(body.revision);
        if (!hasOnlyKeys(body, ['action', 'cwd', 'name', 'revision', 'scope'])
          || !scope || revision === undefined || !serverName(body.name)
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
