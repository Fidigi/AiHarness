import path from 'node:path';
import {
  ExtensionRegistry, loadAgentSettings, PluginService, resolveAgentResourcePaths,
  resolvePreTrustAgentDirectory, selectAgentResourcePaths, WorkspaceManager,
} from '@ai-harness/core';
import { ExtensionLoader } from '../extensions/extension-loader.js';
import { ProjectTrustManager, resolveProjectTrust } from '../security/project-trust.js';
import { CliArgumentError, parseCliArguments, type CliArguments } from './args.js';

/** Load once, behind the ordinary trust policy, before final argument validation or session IO. */
export async function prepareExtensionStartup(raw: readonly string[], bootstrap: CliArguments): Promise<{
  arguments: CliArguments;
  registry: ExtensionRegistry;
  loader: ExtensionLoader;
  setDiscovery(paths: () => Promise<string[]>, trusted: () => boolean): void;
}> {
  const cwd = process.cwd();
  const trustManager = new ProjectTrustManager(path.join(resolvePreTrustAgentDirectory(cwd), 'trust.json'));
  await trustManager.load();
  const global = await loadAgentSettings({ cwd, projectTrusted: false });
  const trust = await resolveProjectTrust({
    cwd, trustManager, override: bootstrap.projectTrust,
    defaultProjectTrust: global.settings.defaultProjectTrust,
    includeContextFiles: !bootstrap.noContextFiles,
  });
  const settings = await loadAgentSettings({ cwd, projectTrusted: trust.resourceTrusted });
  const workspaceManager = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd });
  await workspaceManager.initialize();
  const descriptor = await workspaceManager.describe(cwd, trust.trusted);
  const plugins = new PluginService(workspaceManager, trustManager, path.join(settings.agentDir, 'plugins.json'), settings.agentDir);
  let packagePaths: string[] = [];
  if (settings.agentDirTrusted) {
    await plugins.load();
    packagePaths = await plugins.getEnabledExtensionFiles({ cwd, projectId: descriptor.id, projectTrusted: trust.resourceTrusted });
  }
  const registry = new ExtensionRegistry();
  let currentTrusted: () => boolean = () => trust.resourceTrusted;
  let currentPaths: () => Promise<string[]> = async () => [
    ...(settings.agentDirTrusted ? [path.join(settings.agentDir, 'extensions')] : []),
    ...bootstrap.extensions,
    ...selectAgentResourcePaths(resolveAgentResourcePaths(settings, 'extensions')).filter(item => !item.includes('builtin:')),
    ...packagePaths,
  ];
  const loader = new ExtensionLoader(registry, {
    cwd,
    includeGlobalLocation: false,
    paths: () => currentPaths(),
    isProjectTrusted: () => currentTrusted(),
  });
  // Factories are executable code. Keep their incidental output off protocol/print stdout.
  const originalWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try {
    const loaded = await loader.loadAll();
    if (!loaded.committed) throw new CliArgumentError('Extension startup registration failed. Check trusted extension metadata.');
    const parsed = parseCliArguments(raw, registry.getOptions());
    registry.setOptionValues(parsed.extensionOptions);
    return { arguments: parsed, registry, loader, setDiscovery: (paths, trusted) => {
      currentPaths = paths;
      currentTrusted = trusted;
    } };
  } catch (error) {
    await registry.unloadAll();
    throw error;
  } finally {
    process.stdout.write = originalWrite;
  }
}
