import path from 'node:path';
import {
  loadAgentSettings,
  PluginService,
  resolvePluginNpmCommand,
  type PluginContextInput,
  type ProjectTrustManager,
  type WorkspaceManager,
} from '@ai-harness/core';

export interface ConfiguredPluginOperation {
  service: PluginService;
  context: { cwd: string; projectId: string };
}

/** Explicit operation admission only. Passive inventory/reload use the existing service.
 * Each request captures fresh eligible policy without changing a shared runner/options.
 * The Core service uses the same state file, managed root and inter-process locks.
 */
export async function createConfiguredPluginService(
  dependencies: {
    workspaceManager: WorkspaceManager;
    trustManager: ProjectTrustManager;
    dataDir: string;
    restricted: boolean;
  },
  input: Pick<PluginContextInput, 'cwd' | 'projectId'> = {},
): Promise<ConfiguredPluginOperation> {
  if (dependencies.restricted) throw Object.assign(
    new Error('Package operations are unavailable in exclusive provider-administration mode.'),
    { status: 409, code: 'PROVIDER_REFERENCE_OWNER_UNAVAILABLE' },
  );
  const { workspaceManager, trustManager, dataDir } = dependencies;
  const cwd = await workspaceManager.resolve(input.cwd ?? await workspaceManager.getDefaultCwd(), { kind: 'directory' });
  // Saved trust is refreshed before opening any project settings body; never accept
  // an HTTP/process-local projectTrusted assertion or resource-sensitive default.
  const projectTrusted = await trustManager.isTrusted(cwd);
  const descriptor = await workspaceManager.describe(cwd, projectTrusted);
  if (input.projectId && input.projectId !== descriptor.id) throw Object.assign(
    new Error('Workspace identifier does not match cwd.'),
    { status: 400, code: 'WORKSPACE_MISMATCH' },
  );
  const settings = await loadAgentSettings({ cwd, agentDir: dataDir, agentDirTrusted: true, projectTrusted });
  const service = new PluginService(
    workspaceManager, trustManager, path.join(dataDir, 'plugins.json'), dataDir,
    undefined, resolvePluginNpmCommand(settings),
  );
  await service.load();
  return { service, context: { cwd, projectId: descriptor.id } };
}
