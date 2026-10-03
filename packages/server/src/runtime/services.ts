import os from 'node:os';
import path from 'node:path';
import {
  AgentRuntime,
  ExtensionModuleLoader,
  ExtensionRegistry,
  JsonlSessionStore,
  ProjectTrustManager,
  SessionManager,
  WorkspaceManager,
} from '@ai-harness/core';
import type { AiProvider, ChatResponse } from '@ai-harness/core';
import type { AiProxyServer } from '../api/proxy.js';
import { registerWorkspaceTools } from '../agent/workspace-tools.js';
import { ConfigurationStore } from '../config/config-store.js';
import { resolveEffectiveConfiguration } from '../config/effective-configuration.js';
import { CommandRuntime } from './command-runtime.js';
import { ModelCatalogService } from './model-catalog.js';
import { PluginService } from './plugin-service.js';
import { ProviderRegistryService } from './provider-registry.js';
import { PushService } from './push-service.js';
import { SkillCatalogService } from './skill-catalog.js';
import { SkillRegistryService } from './skill-registry.js';
import { SubagentRuntime } from './subagent-runtime.js';
import { SubagentService } from './subagent-service.js';
import { TerminalRuntime } from './terminal-runtime.js';

export interface RuntimeServiceOptions {
  dataDir?: string;
  sessionsDir?: string;
  allowedRoots?: string[];
  defaultCwd?: string;
  trustFile?: string;
  configurationFile?: string;
}

export interface RuntimeServices {
  sessionManager: SessionManager;
  sessionStore: JsonlSessionStore;
  workspaceManager: WorkspaceManager;
  trustManager: ProjectTrustManager;
  configurationStore: ConfigurationStore;
  extensionRegistry: ExtensionRegistry;
  agentRuntime: AgentRuntime;
  commandRuntime: CommandRuntime;
  modelCatalog: ModelCatalogService;
  pluginService: PluginService;
  providerRegistry: ProviderRegistryService;
  pushService: PushService;
  skillCatalog: SkillCatalogService;
  skillRegistry: SkillRegistryService;
  subagentService: SubagentService;
  subagentRuntime: SubagentRuntime;
  terminalRuntime: TerminalRuntime;
  reloadResources(input?: { cwd?: string; projectId?: string }): Promise<{
    generation: number;
    loadedExtensions: string[];
    errors: Array<{ path: string; message: string }>;
  }>;
  resolveProvider(provider: string): AiProvider | undefined;
  recordUsage(provider: string, model: string | undefined, usage: NonNullable<ChatResponse['usage']>): number | undefined;
}

function environmentRoots(): string[] | undefined {
  const value = process.env.AI_HARNESS_ALLOWED_ROOTS;
  return value?.split(path.delimiter).map(item => item.trim()).filter(Boolean);
}

export async function createRuntimeServices(
  proxy: AiProxyServer,
  options: RuntimeServiceOptions = {},
): Promise<RuntimeServices> {
  const dataDir = options.dataDir ?? process.env.AI_HARNESS_DATA_DIR
    ?? path.join(os.homedir(), '.ai-harness');
  const defaultCwd = options.defaultCwd ?? process.env.AI_HARNESS_DEFAULT_CWD ?? process.cwd();
  const sessionStore = new JsonlSessionStore(options.sessionsDir ?? path.join(dataDir, 'sessions'));
  const sessionManager = new SessionManager();
  sessionManager.setStore(sessionStore);
  await sessionManager.loadAllSessions();

  const workspaceManager = new WorkspaceManager({
    allowedRoots: options.allowedRoots ?? environmentRoots(),
    defaultCwd,
  });
  await workspaceManager.initialize();

  const trustManager = new ProjectTrustManager(options.trustFile ?? path.join(dataDir, 'trust.json'));
  await trustManager.load();
  const configurationStore = new ConfigurationStore(
    options.configurationFile ?? path.join(dataDir, 'config.json'),
  );
  await configurationStore.load();
  const subagentService = new SubagentService(
    workspaceManager,
    trustManager,
    path.join(dataDir, 'subagents.json'),
  );
  await subagentService.load();
  const pluginService = new PluginService(
    workspaceManager,
    trustManager,
    path.join(dataDir, 'plugins.json'),
    dataDir,
  );
  await pluginService.load();
  const providerRegistry = new ProviderRegistryService(
    path.join(dataDir, 'providers.json'),
    proxy,
    path.join(dataDir, 'provider-secrets.enc'),
  );
  await providerRegistry.load();
  const modelCatalog = new ModelCatalogService(proxy, () => providerRegistry.getModels());
  await proxy.initializeUsage(
    path.join(dataDir, 'usage-metrics.json'),
    (provider, model) => modelCatalog.getPricing(provider, model),
  );
  const pushService = new PushService(path.join(dataDir, 'push.enc'));
  await pushService.load();

  const skillCatalog = new SkillCatalogService(
    workspaceManager,
    trustManager,
    configurationStore,
    dataDir,
    input => pluginService.getEnabledSkillRoots(input),
  );
  const skillRegistry = new SkillRegistryService(
    workspaceManager,
    trustManager,
    skillCatalog,
    dataDir,
  );
  const extensionRegistry = new ExtensionRegistry();
  extensionRegistry.attachSessionManager(sessionManager);
  await registerWorkspaceTools(extensionRegistry, workspaceManager);
  await extensionRegistry.load('builtin:skills', api => {
    api.registerTool({
      name: 'load_skill',
      description: 'List model-enabled skills, or load the instructions for one enabled skill by name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Enabled skill name. Omit it to list available skills.' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const requested = typeof (input as { name?: unknown }).name === 'string'
          ? String((input as { name: string }).name).trim().toLowerCase()
          : '';
        const workspace = {
          cwd: context.cwd,
          projectId: context.workspaceId,
          allowedSkills: context.allowedSkills,
        };
        if (!requested) {
          const skills = await skillCatalog.getModelInvocableSkills(workspace);
          return {
            content: skills.length
              ? skills.map(skill => `${skill.name} — ${skill.description}`).join('\n')
              : 'No skill is enabled for autonomous model invocation.',
            details: { count: skills.length },
          };
        }
        const skill = await skillCatalog.resolveModelInvocableSkill(requested, workspace);
        if (!skill) return { content: `Skill unavailable for model invocation: ${requested}`, isError: true };
        return {
          content: skill.instructions,
          details: { name: skill.name, filePath: skill.filePath },
        };
      },
    });
  });
  const agentRuntime = new AgentRuntime({
    sessionManager,
    extensionRegistry,
    resolveProvider: provider => proxy.getAgentProvider(provider),
    isProjectTrusted: cwd => trustManager.isTrusted(cwd),
    onUsage: (provider, model, usage) => proxy.recordUsage(provider, model, usage),
    onNotification: (category, run) => {
      const session = sessionManager.get(run.sessionId);
      return pushService.notify(category, {
        title: session?.title || 'AiHarness',
        body: category === 'completion' ? 'Agent completed.' : run.extensionRequest?.message || run.error || 'Agent needs attention.',
        tag: `agent:${run.sessionId}:${category}`,
        url: `/chat/${encodeURIComponent(run.sessionId)}?cwd=${encodeURIComponent(run.cwd)}`,
      });
    },
  });
  const subagentRuntime = new SubagentRuntime(subagentService, agentRuntime, sessionManager);
  await extensionRegistry.load('builtin:subagents', api => {
    api.registerTool({
      name: 'spawn_subagent',
      description: 'Delegate a focused task to an enabled child-agent profile. It can continue in the background.',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Profile id, such as explore, general, or plan.' },
          task: { type: 'string', description: 'The focused task to delegate.' },
          background: { type: 'boolean', description: 'Return immediately while the child continues.' },
        },
        required: ['profile', 'task'],
        additionalProperties: false,
      },
      execute: async (input, context, signal) => {
        if (!context.currentSessionId || !context.providerName) throw new Error('Parent agent context is unavailable.');
        const values = input as { profile?: unknown; task?: unknown; background?: unknown };
        if (typeof values.profile !== 'string' || typeof values.task !== 'string') {
          throw new Error('profile and task are required.');
        }
        const run = await subagentRuntime.start({
          parentSessionId: context.currentSessionId,
          profileId: values.profile,
          task: values.task,
          provider: context.providerName,
          parentToolPreset: context.toolPreset,
          ...(typeof values.background === 'boolean' ? { background: values.background } : {}),
        });
        if (run.background) return {
          content: `Subagent ${run.profileName} started in the background.`,
          details: { runId: run.id, childSessionId: run.childSessionId, background: true },
        };
        const stop = () => {
          try { subagentRuntime.stop(run.id); } catch { /* Child already completed. */ }
        };
        signal?.addEventListener('abort', stop, { once: true });
        try {
          const completed = await subagentRuntime.wait(run.id);
          if (!completed || completed.status !== 'completed') return {
            content: completed?.error || `Subagent ended with status ${completed?.status ?? 'unknown'}.`,
            isError: true,
            details: completed,
          };
          return {
            content: completed.output || 'Subagent completed without a textual result.',
            details: completed,
          };
        } finally {
          signal?.removeEventListener('abort', stop);
        }
      },
    });
  });
  let extensionContext = {
    cwd: await workspaceManager.getDefaultCwd(),
    projectId: undefined as string | undefined,
    trusted: false,
  };
  extensionContext.trusted = await trustManager.isTrusted(extensionContext.cwd);
  extensionContext.projectId = (await workspaceManager.describe(extensionContext.cwd, extensionContext.trusted)).id;
  const extensionLoader = new ExtensionModuleLoader(extensionRegistry, {
    cwd: extensionContext.cwd,
    includeGlobalLocation: false,
    includeProjectLocation: false,
    paths: async () => [
      path.join(dataDir, 'extensions'),
      ...(extensionContext.trusted ? [path.join(extensionContext.cwd, '.ai-harness', 'extensions')] : []),
      ...await pluginService.getEnabledExtensionFiles({
        cwd: extensionContext.cwd,
        projectId: extensionContext.projectId,
      }),
    ],
    isProjectTrusted: () => extensionContext.trusted,
  });
  const reloadResources: RuntimeServices['reloadResources'] = async (input = {}) => {
    const cwd = await workspaceManager.resolve(input.cwd ?? extensionContext.cwd, { kind: 'directory' });
    const trusted = await trustManager.isTrusted(cwd);
    const descriptor = await workspaceManager.describe(cwd, trusted);
    if (input.projectId && input.projectId !== descriptor.id) {
      throw Object.assign(new Error('Workspace identifier does not match cwd.'), { status: 400, code: 'WORKSPACE_MISMATCH' });
    }
    const contextChanged = cwd !== extensionContext.cwd;
    extensionContext = { cwd, projectId: descriptor.id, trusted };
    let result = await extensionLoader.reload();
    // Never keep executable handlers from another workspace when its replacement is invalid.
    if (contextChanged && !result.committed) result = {
      ...await extensionLoader.clear(),
      errors: result.errors,
      committed: false,
    };
    if (result.committed) skillCatalog.invalidate(cwd);
    return {
      generation: result.generation,
      loadedExtensions: result.loaded,
      errors: result.errors.map(item => ({ path: item.path, message: item.error.message })),
    };
  };
  extensionRegistry.setReloadHandler(async () => { await reloadResources(); });
  const initialExtensionLoad = await reloadResources();
  for (const error of initialExtensionLoad.errors) {
    console.error(`[ExtensionLoader] ${error.path}: ${error.message}`);
  }

  sessionManager.setAutoCompactionPolicy(session => {
    if (session.autoCompaction !== undefined) return session.autoCompaction;
    return resolveEffectiveConfiguration({ configurationStore }, {
      projectId: session.workspaceId,
      sessionId: session.id,
      session,
    }).values.autoCompaction !== false;
  });
  sessionManager.on('compaction:start', event => {
    if (event.automatic) agentRuntime.publishSessionEvent(event.sessionId, 'compaction.started', event);
  });
  sessionManager.on('compaction:end', event => {
    if (event.automatic) agentRuntime.publishSessionEvent(event.sessionId, 'compaction.completed', event);
  });
  sessionManager.on('compaction:error', event => {
    if (event.automatic) agentRuntime.publishSessionEvent(event.sessionId, 'compaction.failed', {
      automatic: true,
      message: event.error,
      cancelled: event.cancelled,
    });
  });
  sessionManager.setAutoCompactionCallback(async (sessionId, toCompact, _keptEntries, signal) => {
    const session = sessionManager.get(sessionId);
    const effective = resolveEffectiveConfiguration({ configurationStore }, {
      projectId: session?.workspaceId,
      sessionId,
      session,
    });
    const activeRun = agentRuntime.getSessionRun(sessionId);
    const configuredProvider = effective.provenance.provider?.scope === 'default'
      ? undefined
      : effective.values.provider;
    const providerName = String(configuredProvider
      ?? activeRun?.provider
      ?? session?.providerConfig?.type
      ?? effective.values.provider
      ?? 'mock');
    const provider = proxy.getAgentProvider(providerName);
    if (!provider) throw new Error(`Provider unavailable: ${providerName}`);
    const requestedModel = effective.values.model ?? activeRun?.model;
    const response = await provider.chat(toCompact
      .filter((entry): entry is typeof entry & { role: 'user' | 'assistant' | 'system' | 'tool'; content: string } => entry.type === 'message')
      .map(entry => ({
        id: entry.id,
        role: entry.role,
        content: entry.content,
        timestamp: new Date(entry.timestamp),
      })), {
        model: requestedModel,
        systemPrompt: 'Summarize this conversation while preserving decisions and unresolved tasks.',
        signal,
      });
    if (response.usage) proxy.recordUsage(providerName, response.model ?? requestedModel, response.usage);
    return response.content;
  });

  return {
    sessionManager,
    sessionStore,
    workspaceManager,
    trustManager,
    configurationStore,
    extensionRegistry,
    agentRuntime,
    commandRuntime: new CommandRuntime(sessionManager),
    modelCatalog,
    pluginService,
    providerRegistry,
    pushService,
    skillCatalog,
    skillRegistry,
    subagentService,
    subagentRuntime,
    terminalRuntime: new TerminalRuntime(),
    reloadResources,
    resolveProvider: provider => proxy.getAgentProvider(provider),
    recordUsage: (provider, model, usage) => proxy.recordUsage(provider, model, usage),
  };
}
