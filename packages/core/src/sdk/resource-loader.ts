import {
  ResourceManager,
  type ResourceManagerOptions,
  type ResourceInventoryItem,
} from '../resources/resource-manager.js';

export interface AgentResourceContext {
  /** Canonical, allowed-root cwd. Fresh trust decision for this explicit load. */
  cwd: string;
  projectTrusted: boolean;
}

/** Caller loaders are trusted host code; load is never called by factory/reads. */
export interface AgentResourceLoader {
  load(context: AgentResourceContext): Promise<LoadedAgentResources>;
}

/** Declarative Markdown resources only; no extension/module execution. */
export interface LoadedAgentResources {
  inventory(): ResourceInventoryItem[];
  expandPrompt(name: string, args: string[]): string;
  invokeSkill(name: string, request?: string): string;
  /** Value-free diagnostics. Resource bodies/paths are not copied into errors. */
  diagnostics: readonly string[];
}

export type AgentResourceLoaderOptions = Omit<ResourceManagerOptions, 'cwd' | 'projectTrusted'>;

/** Passive constructor; bounded Core Markdown discovery runs only on load. */
export function createAgentResourceLoader(options: AgentResourceLoaderOptions = {}): AgentResourceLoader {
  return {
    async load(context) {
      const manager = new ResourceManager({ ...options, ...context, strictSkills: options.strictSkills ?? true });
      const result = await manager.loadAll();
      return {
        inventory: () => manager.listInventory(),
        expandPrompt: (name, args) => manager.expandPrompt(name, args),
        invokeSkill: (name, request) => manager.invokeSkill(name, request),
        diagnostics: result.errors.map(() => 'Resource could not be loaded.'),
      };
    },
  };
}
