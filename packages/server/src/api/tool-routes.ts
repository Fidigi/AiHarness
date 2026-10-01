import { Router } from 'express';
import type { ToolSettings } from '@ai-harness/core';
import type { RuntimeServices } from '../runtime/services.js';
import { resolveEffectiveConfiguration } from '../config/effective-configuration.js';
import { requireCapability } from '../security/request-security.js';

function optionalString(value: unknown, name: string, max = 4_096): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error(`${name} is invalid.`), { status: 400 });
  }
  return value;
}

async function context(services: RuntimeServices, cwd?: string, requestedProjectId?: string): Promise<{ projectId?: string }> {
  if (!cwd) {
    if (requestedProjectId) throw Object.assign(new Error('cwd is required with a project identifier.'), { status: 400, code: 'WORKSPACE_MISMATCH' });
    return {};
  }
  const canonical = await services.workspaceManager.resolve(cwd, { kind: 'directory' });
  const descriptor = await services.workspaceManager.describe(canonical, await services.trustManager.isTrusted(canonical));
  if (requestedProjectId && requestedProjectId !== descriptor.id) {
    throw Object.assign(new Error('Workspace identifier does not match cwd.'), { status: 400, code: 'WORKSPACE_MISMATCH' });
  }
  return { projectId: descriptor.id };
}

function settings(services: RuntimeServices, projectId?: string): ToolSettings {
  const effective = resolveEffectiveConfiguration(services, { projectId });
  const enabled = effective.values.enabledTools === undefined ? undefined : new Set(effective.values.enabledTools);
  const provenance = effective.provenance.enabledTools ?? effective.provenance.toolPreset;
  const powershellAvailable = process.platform === 'win32';
  return {
    scope: provenance?.scope ?? 'default',
    source: provenance?.source ?? 'built-in',
    preset: effective.values.toolPreset ?? 'default',
    powershellAvailable,
    powershellEnabled: powershellAvailable && effective.values.powershellEnabled === true,
    tools: services.extensionRegistry.getTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      extensionId: tool.extensionId,
      enabled: (enabled === undefined || enabled.has(tool.name))
        && (tool.name !== 'powershell' || effective.values.powershellEnabled === true),
      available: tool.name !== 'powershell' || powershellAvailable,
      ...(tool.name === 'powershell' && !powershellAvailable
        ? { unavailableReason: 'PowerShell is only available on Windows hosts.' } : {}),
    })),
  };
}

export function createToolRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const selected = await context(
        services,
        optionalString(request.query.cwd, 'cwd'),
        optionalString(request.query.projectId, 'projectId', 500),
      );
      response.json(settings(services, selected.projectId));
    } catch (error) { next(error); }
  });

  router.patch('/', requireCapability('configuration'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const selected = await context(
        services,
        optionalString(request.body?.cwd, 'cwd'),
        optionalString(request.body?.projectId, 'projectId', 500),
      );
      const known = new Set(services.extensionRegistry.getTools().map(tool => tool.name));
      const enabledTools = request.body?.enabledTools;
      if (!Array.isArray(enabledTools) || enabledTools.length > 2_000
        || !enabledTools.every((tool: unknown) => typeof tool === 'string' && known.has(tool))) {
        response.status(400).json({ error: 'Enabled tool list is invalid.', code: 'INVALID_ENABLED_TOOLS' });
        return;
      }
      const toolPreset = request.body?.toolPreset;
      if (!['configured', 'chat-only', 'read-only', 'default', 'full'].includes(String(toolPreset))) {
        response.status(400).json({ error: 'Tool preset is invalid.', code: 'INVALID_TOOL_PRESET' });
        return;
      }
      if (typeof request.body?.powershellEnabled !== 'boolean') {
        response.status(400).json({ error: 'PowerShell setting is invalid.', code: 'INVALID_POWERSHELL_SETTING' });
        return;
      }
      if (request.body.powershellEnabled && process.platform !== 'win32') {
        response.status(409).json({ error: 'PowerShell is unavailable on this host.', code: 'POWERSHELL_UNAVAILABLE' });
        return;
      }
      await services.configurationStore.patch(selected.projectId ? 'project' : 'global', {
        enabledTools: [...new Set(enabledTools)],
        toolPreset,
        powershellEnabled: request.body.powershellEnabled,
      }, selected.projectId);
      response.json(settings(services, selected.projectId));
    } catch (error) { next(error); }
  });

  return router;
}
