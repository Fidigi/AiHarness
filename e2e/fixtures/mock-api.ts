import type { Page, Route } from '@playwright/test';
import type {
  CustomModelDefinition,
  CustomProviderDefinition,
  ExtensionInteractionSnapshot,
  ModelCatalog,
  ModelCatalogEntry,
  PluginCatalog,
  PluginPackageInfo,
  ProviderAuthStatus,
  ProviderModelCatalog,
  SkillCatalog,
  SkillRegistry,
  SubagentConfiguration,
  SubagentProfile,
  SubagentRunSnapshot,
  ToolSettings,
} from '@ai-harness/core';

export interface MockMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  usage?: {
    inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
    cacheWriteTokens?: number; totalTokens?: number; costUsd?: number;
  };
  blocks?: unknown[];
}

export interface MockSession {
  version?: 2;
  schemaVersion?: 2;
  id: string;
  title?: string;
  messages: MockMessage[];
  createdAt: string;
  updatedAt: string;
  cwd?: string;
  workspaceId?: string;
  parentId?: string;
  branchId?: string;
  activeLeafId?: string;
  model?: string;
  thinking?: string;
  toolPreset?: string;
  autoCompaction?: boolean;
  gitBranch?: string;
  providerConfig?: { type: string; model?: string; contextWindowTokens?: number };
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
    cacheWriteTokens?: number; totalTokens?: number; costUsd?: number;
  };
  messagePage?: {
    start: number; end: number; total: number; hasMoreBefore: boolean; hasMoreAfter: boolean;
    nextBefore?: string; nextAfter?: string; revision: number; targetIndex?: number;
  };
}

export interface MockProvider { type: string; configured: boolean }
export interface MockStreamEvent {
  type: 'message_start' | 'text_delta' | 'message_end' | 'error';
  content?: string;
}
export interface MockWorktree {
  path: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
}
export interface MockWorkspaceBrowse {
  cwd: string;
  parent?: string;
  entries: Array<{ name: string; path: string; isDirectory: boolean; isSymbolicLink: boolean }>;
}
export interface RecordedApiRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}
export interface MockApiOptions {
  sessions?: MockSession[];
  providers?: MockProvider[];
  modelCatalog?: ModelCatalog;
  pluginCatalog?: PluginCatalog;
  skillCatalog?: SkillCatalog;
  skillRegistry?: SkillRegistry;
  providerAuthStatuses?: ProviderAuthStatus[];
  customProviders?: CustomProviderDefinition[];
  customModels?: CustomModelDefinition[];
  toolSettings?: ToolSettings;
  subagentConfiguration?: SubagentConfiguration;
  subagentRuns?: SubagentRunSnapshot[];
  effectiveConfiguration?: {
    values?: { model?: string; thinking?: string; toolPreset?: string; autoCompaction?: boolean };
    provenance?: Record<string, { value: unknown; scope: 'default' | 'global' | 'project' | 'session' | 'environment'; source: string }>;
  };
  stream?: MockStreamEvent[];
  unavailable?: boolean;
  createSessionError?: boolean;
  configureProviderError?: boolean;
  authRequired?: boolean;
  authToken?: string;
  appUpdate?: {
    webVersion?: string;
    agentVersion?: string;
    available: boolean;
    release?: { version: string; name: string; url: string; publishedAt?: string; notes?: string };
    error?: { code: 'disabled' | 'unavailable' | 'invalid-response'; message: string };
  };
  workspaceTrusted?: boolean;
  indexedFiles?: string[];
  indexedDirectories?: string[];
  fileIndexTruncated?: boolean;
  workspaceFiles?: Array<{
    path: string; content: string; language?: string; binary?: boolean; sourceUnavailable?: boolean; tooLarge?: boolean; gitStatus?: string;
    diff?: string; additions?: number; deletions?: number;
  }>;
  holdAgentRun?: boolean;
  holdCompaction?: boolean;
  automaticCompaction?: boolean;
  holdCommands?: boolean;
  commandOutput?: string;
  capabilities?: {
    systemPrompt: string;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; extensionId: string }>;
  };
  extensionInteraction?: ExtensionInteractionSnapshot;
  extensionWidgets?: Array<{ name: string; placement: 'header' | 'status'; content: string; extensionId: string }>;
  paletteItems?: Array<{ name: string; description: string; source: 'builtin' | 'extension' | 'prompt' | 'skill'; usage?: string }>;
  workspaceBrowse?: Record<string, MockWorkspaceBrowse>;
  worktrees?: MockWorktree[];
}
export interface MockApiController {
  requests: RecordedApiRequest[];
  sessions: MockSession[];
  worktrees: MockWorktree[];
  subagentRuns: SubagentRunSnapshot[];
  releaseCompaction: () => void;
  setRunPhase: (
    sessionId: string,
    phase: 'queued' | 'prompting' | 'streaming' | 'tool' | 'command' | 'compacting' | 'completed' | 'failed' | 'stopped',
    details?: {
      retry?: { attempt: number; max: number; delayMs: number; message: string; scheduledAt: string };
      activeTool?: { id: string; name: string; input: unknown; startedAt: string };
    },
  ) => void;
}

const DEFAULT_DATE = '2025-01-01T12:00:00.000Z';
const WORKSPACE = {
  id: 'workspace-e2e', cwd: '/workspace', name: 'workspace', trusted: true,
  git: { root: '/workspace', branch: 'main', detached: false },
};

const MOCK_CATALOG_MODELS: Record<string, Array<{ id: string; name: string; reasoning?: boolean; images?: boolean; tools?: boolean }>> = {
  mock: [{ id: 'mock-model', name: 'Mock model', tools: true }],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o (Recommended)', images: true, tools: true },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', images: true, tools: true },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', tools: true },
    { id: 'o3', name: 'o3', reasoning: true, images: true, tools: true },
  ],
  anthropic: [{ id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', images: true, tools: true }],
  google: [{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', images: true, tools: true }],
  vertex: [{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', images: true, tools: true }],
  azure: [{ id: 'gpt-4o', name: 'GPT-4o deployment', images: true, tools: true }],
  bedrock: [{ id: 'anthropic.claude-3-haiku-20240307-v1:0', name: 'Claude 3 Haiku', images: true, tools: true }],
  local: [{ id: 'local-model', name: 'Local server model' }],
};

function mockModelCatalog(providers: MockProvider[]): ModelCatalog {
  const groups: ProviderModelCatalog[] = providers.map(provider => ({
    provider: provider.type,
    configured: provider.configured,
    models: (MOCK_CATALOG_MODELS[provider.type] ?? [{ id: `${provider.type}-model`, name: `${provider.type} model` }]).map(model => ({
      key: `${provider.type}:${model.id}`,
      provider: provider.type,
      id: model.id,
      name: model.name,
      available: provider.configured,
      enabled: true,
      source: 'published',
      capabilities: {
        reasoning: Boolean(model.reasoning),
        imageInput: Boolean(model.images),
        toolCalls: Boolean(model.tools),
      },
    } satisfies ModelCatalogEntry)),
  }));
  return {
    updatedAt: DEFAULT_DATE,
    enabledScope: 'default',
    enabledSource: 'built-in',
    providers: groups,
  };
}

function mockSkillCatalog(workspace: typeof WORKSPACE & { trusted: boolean }): SkillCatalog {
  return {
    updatedAt: DEFAULT_DATE,
    projectId: workspace.id,
    cwd: workspace.cwd,
    projectTrusted: workspace.trusted,
    enabledScope: 'default',
    enabledSource: 'skill metadata',
    errorCount: 0,
    skills: [
      {
        key: 'project:review-project:e2e', name: 'review-project', description: 'Review this workspace safely',
        scope: 'project', source: '.agents/skills', filePath: '.agents/skills/review-project/SKILL.md',
        trusted: workspace.trusted, defaultModelInvocable: true, modelInvocable: workspace.trusted,
      },
      {
        key: 'global:release-notes:e2e', name: 'release-notes', description: 'Prepare concise release notes',
        version: '1.2.0', scope: 'global', source: '~/.ai-harness/skills',
        filePath: '~/.ai-harness/skills/release-notes/SKILL.md', trusted: true,
        defaultModelInvocable: true, modelInvocable: true,
      },
      {
        key: 'path:documentation:e2e', name: 'documentation', description: 'Write project documentation',
        scope: 'path', source: 'configured path 1', filePath: '/skills/documentation/SKILL.md',
        trusted: true, defaultModelInvocable: false, modelInvocable: false,
      },
      {
        key: 'package:test-plan:e2e', name: 'test-plan', description: 'Build a package test plan',
        scope: 'package', source: 'installed packages', filePath: 'packages/quality/skills/test-plan/SKILL.md',
        trusted: true, defaultModelInvocable: true, modelInvocable: true,
      },
    ],
  };
}

function mockPluginCatalog(workspace: typeof WORKSPACE & { trusted: boolean }): PluginCatalog {
  const globalPackage: PluginPackageInfo = {
    key: 'global:global:11111111111111111111',
    source: 'npm:@aiharness/review-kit', sourceType: 'npm', scope: 'global', enabled: true, trusted: true,
    canCheckForUpdates: true, installedPath: 'plugins/installed/global/review-kit', packageName: '@aiharness/review-kit',
    version: '1.4.0', description: 'Review tools, prompts and a calm interface theme.',
    counts: { extensions: 1, skills: 1, prompts: 1, themes: 1 },
    resources: [
      { kind: 'extension', name: 'review-tools', path: 'plugins/review-kit/extensions/review-tools.js', relativePath: 'extensions/review-tools.js' },
      { kind: 'skill', name: 'release-review', path: 'plugins/review-kit/skills/release-review', relativePath: 'skills/release-review' },
      { kind: 'prompt', name: 'review', path: 'plugins/review-kit/prompts/review.md', relativePath: 'prompts/review.md' },
      { kind: 'theme', name: 'calm', path: 'plugins/review-kit/themes/calm.json', relativePath: 'themes/calm.json' },
    ],
    diagnostics: [], status: 'active', restartRequired: true,
    installedAt: DEFAULT_DATE, updatedAt: DEFAULT_DATE,
  };
  const projectPackage: PluginPackageInfo = {
    key: 'project:workspace-e2e:22222222222222222222',
    source: 'git:https://github.com/example/workspace-kit.git#main', sourceType: 'git', scope: 'project',
    enabled: true, trusted: workspace.trusted, canCheckForUpdates: true,
    installedPath: 'plugins/installed/projects/workspace-e2e/workspace-kit', packageName: 'workspace-kit',
    version: '0.8.2', configuredVersion: 'main', description: 'Workspace-specific planning resources.',
    counts: workspace.trusted
      ? { extensions: 1, skills: 1, prompts: 0, themes: 0 }
      : { extensions: 0, skills: 0, prompts: 0, themes: 0 },
    resources: workspace.trusted ? [
      { kind: 'extension', name: 'workspace-plan', path: 'plugins/workspace-kit/extensions/plan.js', relativePath: 'extensions/plan.js' },
      { kind: 'skill', name: 'workspace-plan', path: 'plugins/workspace-kit/skills/workspace-plan', relativePath: 'skills/workspace-plan' },
    ] : [],
    diagnostics: workspace.trusted ? [] : [{
      severity: 'warning', code: 'PROJECT_TRUST_REQUIRED', source: 'git:https://github.com/example/workspace-kit.git#main',
      message: 'Project resources require workspace trust.',
    }],
    status: workspace.trusted ? 'active' : 'installed', restartRequired: workspace.trusted,
    installedAt: DEFAULT_DATE, updatedAt: DEFAULT_DATE,
  };
  return {
    updatedAt: DEFAULT_DATE, generation: 4, cwd: workspace.cwd, projectId: workspace.id,
    projectTrusted: workspace.trusted, projectResourcesLoaded: workspace.trusted,
    packages: [projectPackage, globalPackage],
    standaloneExtensions: [
      ...(workspace.trusted ? [{
        kind: 'extension' as const, name: 'workspace-banner', relativePath: 'workspace-banner.js',
        path: '.ai-harness/extensions/workspace-banner.js', scope: 'project' as const, enabled: true, trusted: true,
      }] : []),
      {
        kind: 'extension' as const, name: 'global-status', relativePath: 'global-status.js',
        path: '~/.ai-harness/extensions/global-status.js', scope: 'global' as const, enabled: true, trusted: true,
      },
    ],
    totals: workspace.trusted
      ? { extensions: 4, skills: 2, prompts: 1, themes: 1 }
      : { extensions: 2, skills: 1, prompts: 1, themes: 1 },
    diagnostics: [],
  };
}

function withPluginTotals(catalog: PluginCatalog): PluginCatalog {
  const active = catalog.packages.filter(pkg => pkg.enabled && pkg.trusted && pkg.status === 'active')
    .flatMap(pkg => pkg.resources);
  const standalone = catalog.standaloneExtensions.filter(extension => extension.enabled);
  return {
    ...catalog,
    totals: {
      extensions: active.filter(resource => resource.kind === 'extension').length + standalone.length,
      skills: active.filter(resource => resource.kind === 'skill').length,
      prompts: active.filter(resource => resource.kind === 'prompt').length,
      themes: active.filter(resource => resource.kind === 'theme').length,
    },
  };
}

function mockSubagentConfiguration(workspace: typeof WORKSPACE): SubagentConfiguration {
  const base = (id: string, name: string, kind: SubagentProfile['kind'], background: boolean): SubagentProfile => ({
    id, name, kind, background, builtIn: true, enabled: true,
    description: `${name} child-agent profile`, instructions: `${name} the delegated task.`,
    tools: kind === 'general' ? [] : ['ls', 'read', 'grep', 'find'],
    skills: [], extensions: [], maxTurns: kind === 'general' ? 12 : 8, inheritContext: true,
  });
  return {
    updatedAt: DEFAULT_DATE,
    projectId: workspace.id,
    cwd: workspace.cwd,
    scope: 'global',
    source: 'built-in',
    engineEnabled: true,
    maxConcurrency: 4,
    profiles: [
      base('explore', 'Explore', 'explore', true),
      base('general', 'General purpose', 'general', true),
      base('plan', 'Plan', 'plan', false),
    ],
  };
}

function paginatedSession(
  session: MockSession,
  options: { limit: number; before?: string; around?: string },
): MockSession {
  const total = session.messages.length;
  const limit = Math.max(0, Math.min(250, options.limit));
  let start = total;
  let end = total;
  let targetIndex: number | undefined;
  if (limit > 0 && options.around) {
    targetIndex = session.messages.findIndex(message => message.id === options.around);
    if (targetIndex < 0) throw new Error('Message target not found');
    start = Math.max(0, Math.min(targetIndex - Math.floor(limit / 3), Math.max(0, total - limit)));
    end = Math.min(total, start + limit);
  } else if (limit > 0) {
    if (options.before) {
      const cursor = session.messages.findIndex(message => message.id === options.before);
      if (cursor < 0) throw new Error('Message cursor not found');
      end = cursor;
    }
    start = Math.max(0, end - limit);
  }
  return {
    ...structuredClone(session),
    messages: structuredClone(session.messages.slice(start, end)),
    messagePage: {
      start, end, total,
      hasMoreBefore: start > 0,
      hasMoreAfter: end < total,
      ...(start > 0 && session.messages[start] ? { nextBefore: session.messages[start]!.id } : {}),
      ...(end < total && end > 0 && session.messages[end - 1] ? { nextAfter: session.messages[end - 1]!.id } : {}),
      revision: new Date(session.updatedAt).getTime(),
      ...(targetIndex === undefined ? {} : { targetIndex }),
    },
  };
}

export function mockSession(
  id: string,
  title: string,
  messages: Array<Pick<MockMessage, 'role' | 'content'>> = [],
): MockSession {
  return {
    version: 2,
    schemaVersion: 2,
    id,
    title,
    messages: messages.map((message, index) => ({
      ...message,
      id: `${id}-message-${index + 1}`,
      timestamp: DEFAULT_DATE,
      blocks: [{ type: 'text', text: message.content }],
    })),
    createdAt: DEFAULT_DATE,
    updatedAt: DEFAULT_DATE,
    cwd: WORKSPACE.cwd,
    workspaceId: WORKSPACE.id,
    model: 'mock-model',
    thinking: 'off',
    toolPreset: 'default',
  };
}

export async function installMockApi(page: Page, options: MockApiOptions = {}): Promise<MockApiController> {
  const workspace = { ...WORKSPACE, trusted: options.workspaceTrusted ?? true };
  const workspaceFiles = structuredClone(options.workspaceFiles ?? []);
  const indexedFiles = options.indexedFiles ?? workspaceFiles.map(file => file.path);
  const indexedDirectories = options.indexedDirectories ?? [];
  const worktrees = structuredClone(options.worktrees ?? [
    { path: workspace.cwd, branch: workspace.git.branch, bare: false, detached: false },
  ]);
  const providers = structuredClone(options.providers ?? [{ type: 'mock', configured: true }]);
  let modelCatalog = structuredClone(options.modelCatalog ?? mockModelCatalog(providers));
  let pluginCatalog = structuredClone(options.pluginCatalog ?? mockPluginCatalog(workspace));
  let skillCatalog = structuredClone(options.skillCatalog ?? mockSkillCatalog(workspace));
  let skillRegistry = structuredClone(options.skillRegistry ?? {
    source: 'https://skills.example.test/index.json', updatedAt: DEFAULT_DATE,
    entries: [{
      id: 'security-review', name: 'security-review', description: 'Review trust boundaries', version: '2.0.0',
      downloadUrl: 'https://skills.example.test/security-review.md', sha256: 'a'.repeat(64),
    }],
  } satisfies SkillRegistry);
  let providerAuthStatuses = structuredClone(options.providerAuthStatuses ?? providers.map(provider => ({
    type: provider.type, name: provider.type === 'mock' ? 'Mock' : provider.type,
    configured: provider.configured, connected: provider.configured, method: provider.type === 'mock' ? 'none' : 'api-key',
    reconnectSupported: provider.type !== 'mock', disconnectSupported: provider.type !== 'mock',
    ...(provider.configured ? { usage: { requests: 3, inputTokens: 120, outputTokens: 30, costUsd: 0.0042 } } : {}),
  } satisfies ProviderAuthStatus)));
  let customProviders = structuredClone(options.customProviders ?? []);
  let customModels = structuredClone(options.customModels ?? []);
  let toolSettings = structuredClone(options.toolSettings ?? {
    scope: 'project', source: workspace.id, preset: 'default', powershellAvailable: false, powershellEnabled: false,
    tools: [
      { name: 'read', description: 'Read a workspace file', extensionId: 'builtin:workspace-tools', enabled: true, available: true },
      { name: 'write', description: 'Write a workspace file', extensionId: 'builtin:workspace-tools', enabled: true, available: true },
      { name: 'powershell', description: 'Run PowerShell', extensionId: 'builtin:workspace-tools', enabled: false, available: false, unavailableReason: 'Windows only' },
    ],
  } satisfies ToolSettings);
  const configurationScopes: Record<'global' | 'project', Record<string, unknown>> = {
    global: { provider: 'mock', model: 'mock-model', toolPreset: 'default' },
    project: { provider: 'mock', model: 'mock-model', toolPreset: 'default' },
  };
  let subagentConfiguration = structuredClone(options.subagentConfiguration ?? mockSubagentConfiguration(workspace));
  const subagentRuns = structuredClone(options.subagentRuns ?? []);
  const stream = options.stream ?? [
    { type: 'message_start' },
    { type: 'text_delta', content: 'Mock response' },
    { type: 'message_end', content: 'Mock response' },
  ];
  const completedRuns = new Set<string>();
  const runs = new Map<string, {
    id: string; sessionId: string; workspaceId?: string; cwd: string; provider: string;
    phase: 'queued' | 'prompting' | 'streaming' | 'tool' | 'command' | 'compacting' | 'completed' | 'failed' | 'stopped';
    steerQueue: Array<{ id: string; kind: 'steer'; content: string; createdAt: string }>;
    followUpQueue: Array<{ id: string; kind: 'follow-up'; content: string; createdAt: string }>;
    retry?: { attempt: number; max: number; delayMs: number; message: string; scheduledAt: string };
    activeTool?: { id: string; name: string; input: unknown; startedAt: string };
    extensionRequest?: ExtensionInteractionSnapshot;
    lastSequence: number;
  }>();
  const commands = new Map<string, {
    id: string; sessionId: string; command: string; cwd: string; excludedFromContext: boolean;
    status: 'running' | 'completed' | 'failed' | 'cancelled'; startedAt: string; completedAt?: string;
    exitCode?: number; output: string; truncated: boolean; lastSequence: number;
  }>();
  const terminals = new Map<string, {
    id: string; cwd: string; name: string; shell: string; pid: number; cols: number; rows: number;
    status: 'running' | 'exited' | 'killed' | 'failed'; startedAt: string; completedAt?: string;
    exitCode?: number; lastOffset: number; output: string;
  }>();
  let nextSessionId = 1;
  let nextMessageId = 1;
  let nextCommandId = 1;
  let nextTerminalId = 1;
  let nextRunId = 1;
  let authenticated = !options.authRequired;
  let pendingCompaction: (() => void) | undefined;
  const normalizeWorkspacePath = (input?: string | null) => {
    if (!input || input === '~') return workspace.cwd;
    if (input.startsWith('~/')) return `${workspace.cwd}/${input.slice(2)}`.replace(/\/{2,}/g, '/');
    return input;
  };
  const describeWorkspace = (input?: string | null) => {
    const cwd = normalizeWorkspacePath(input);
    const worktree = worktrees.find(item => item.path === cwd);
    return {
      id: cwd === workspace.cwd ? workspace.id : `workspace-e2e-${cwd.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`,
      cwd,
      name: cwd.split('/').filter(Boolean).at(-1) || cwd,
      trusted: workspace.trusted,
      git: { root: workspace.cwd, branch: worktree?.branch ?? 'main', detached: worktree?.detached ?? false },
    };
  };
  const controller: MockApiController = {
    requests: [],
    sessions: structuredClone(options.sessions ?? []),
    worktrees,
    subagentRuns,
    releaseCompaction: () => {
      pendingCompaction?.();
      pendingCompaction = undefined;
    },
    setRunPhase: (sessionId, phase, details = {}) => {
      const run = runs.get(sessionId);
      if (!run) throw new Error(`Mock run not found for ${sessionId}`);
      Object.assign(run, { phase, ...details });
      if (!details.retry) delete run.retry;
      if (!details.activeTool) delete run.activeTool;
      run.lastSequence += 1;
    },
  };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = readRequestBody(route);
    controller.requests.push({ method, path: url.pathname, headers: request.headers(), ...(body === undefined ? {} : { body }) });

    if (options.unavailable) {
      await route.abort('failed');
      return;
    }

    if (url.pathname === '/api/auth/status' && method === 'GET') {
      await fulfillJson(route, { required: Boolean(options.authRequired), authenticated, ...(authenticated ? { role: 'admin' } : {}) }); return;
    }
    if (url.pathname === '/api/auth/login' && method === 'POST') {
      if ((body as { token?: string })?.token !== (options.authToken || 'e2e-secret')) {
        await fulfillJson(route, { error: 'Invalid credentials' }, 401); return;
      }
      authenticated = true;
      await fulfillJson(route, { authenticated: true, role: 'admin' }); return;
    }
    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      authenticated = false;
      await fulfillJson(route, { authenticated: false }); return;
    }
    if (url.pathname === '/api/providers' && method === 'GET') { await fulfillJson(route, providers); return; }
    if (url.pathname === '/api/push/public-key' && method === 'GET') {
      await fulfillJson(route, { publicKey: 'BElhaGFybmVzcy1lMmUtdmFwaWQta2V5', persistent: false }); return;
    }
    if (url.pathname === '/api/push/subscribe' && method === 'POST') {
      await fulfillJson(route, { subscribed: true, persistent: false }, 201); return;
    }
    if (url.pathname === '/api/push/subscribe' && method === 'DELETE') {
      await fulfillJson(route, { subscribed: false }); return;
    }
    if (url.pathname === '/api/provider-registry/auth' && method === 'GET') {
      await fulfillJson(route, providerAuthStatuses); return;
    }
    const providerAuthTest = url.pathname.match(/^\/api\/provider-registry\/auth\/([^/]+)\/test$/);
    if (providerAuthTest && method === 'POST') {
      await fulfillJson(route, { ok: true, models: ['mock-model'], checkedAt: DEFAULT_DATE }); return;
    }
    const providerAuth = url.pathname.match(/^\/api\/provider-registry\/auth\/([^/]+)$/);
    if (providerAuth && method === 'DELETE') {
      const id = decodeURIComponent(providerAuth[1]!);
      providerAuthStatuses = providerAuthStatuses.map(status => status.type === id
        ? { ...status, configured: false, connected: false, method: 'api-key' } : status);
      await fulfillJson(route, { success: true, type: id, connected: false }); return;
    }
    const oauthStart = url.pathname.match(/^\/api\/provider-registry\/auth\/([^/]+)\/oauth$/);
    if (oauthStart && method === 'POST') {
      const provider = decodeURIComponent(oauthStart[1]!);
      await fulfillJson(route, {
        id: `oauth-${provider}`, provider, state: 'pending', userCode: 'E2E-CODE',
        verificationUri: 'https://oauth.example.test/activate', expiresAt: '2025-01-01T12:15:00.000Z',
      }, 201); return;
    }
    const oauthFlow = url.pathname.match(/^\/api\/provider-registry\/auth\/oauth\/([^/]+)$/);
    if (oauthFlow && method === 'GET') {
      await fulfillJson(route, {
        id: decodeURIComponent(oauthFlow[1]!), provider: 'openai', state: 'pending', userCode: 'E2E-CODE',
        verificationUri: 'https://oauth.example.test/activate', expiresAt: '2025-01-01T12:15:00.000Z',
      }); return;
    }
    if (oauthFlow && method === 'DELETE') { await fulfillJson(route, { state: 'cancelled' }); return; }
    if (url.pathname === '/api/provider-registry/custom' && method === 'GET') {
      await fulfillJson(route, customProviders); return;
    }
    if (url.pathname === '/api/provider-registry/custom' && method === 'POST') {
      const input = body as Record<string, unknown>;
      const id = String(input.id || 'custom-provider');
      const provider: CustomProviderDefinition = {
        id, name: String(input.name || id), baseUrl: String(input.baseUrl || ''),
        dialect: String(input.dialect || 'openai-completions') as CustomProviderDefinition['dialect'],
        configured: Boolean(input.apiKey) || Boolean(input.headers),
        headerNames: input.headers && typeof input.headers === 'object' ? Object.keys(input.headers) : [],
        modelCount: 0, createdAt: DEFAULT_DATE, updatedAt: DEFAULT_DATE,
      };
      customProviders.push(provider);
      providerAuthStatuses.push({
        type: id, name: provider.name, configured: provider.configured, connected: provider.configured,
        method: provider.configured ? 'api-key' : 'none', reconnectSupported: true, disconnectSupported: provider.configured,
      });
      await fulfillJson(route, provider, 201); return;
    }
    const customProvider = url.pathname.match(/^\/api\/provider-registry\/custom\/([^/]+)$/);
    if (customProvider && method === 'PUT') {
      const id = decodeURIComponent(customProvider[1]!);
      const input = body as Record<string, unknown>;
      customProviders = customProviders.map(provider => provider.id === id ? {
        ...provider, name: String(input.name || provider.name), baseUrl: String(input.baseUrl || provider.baseUrl),
        dialect: String(input.dialect || provider.dialect) as CustomProviderDefinition['dialect'], updatedAt: DEFAULT_DATE,
      } : provider);
      await fulfillJson(route, customProviders.find(provider => provider.id === id)); return;
    }
    if (customProvider && method === 'DELETE') {
      const id = decodeURIComponent(customProvider[1]!);
      customProviders = customProviders.filter(provider => provider.id !== id);
      customModels = customModels.filter(model => model.provider !== id);
      providerAuthStatuses = providerAuthStatuses.filter(provider => provider.type !== id);
      await fulfillJson(route, { success: true }); return;
    }
    const customProviderAction = url.pathname.match(/^\/api\/provider-registry\/custom\/([^/]+)\/(test|import-models)$/);
    if (customProviderAction && method === 'POST') {
      const id = decodeURIComponent(customProviderAction[1]!);
      if (customProviderAction[2] === 'test') {
        await fulfillJson(route, { ok: true, models: [`${id}-model`], checkedAt: DEFAULT_DATE }); return;
      }
      const key = `${id}:${id}-model`;
      if (!customModels.some(model => model.key === key)) customModels.push({
        key, provider: id, id: `${id}-model`, name: `${id}-model`,
        capabilities: { reasoning: false, imageInput: false, toolCalls: true },
        createdAt: DEFAULT_DATE, updatedAt: DEFAULT_DATE,
      });
      customProviders = customProviders.map(provider => provider.id === id ? { ...provider, modelCount: 1 } : provider);
      await fulfillJson(route, customModels.filter(model => model.provider === id)); return;
    }
    if (url.pathname === '/api/provider-registry/models' && method === 'GET') {
      await fulfillJson(route, customModels); return;
    }
    if (url.pathname === '/api/provider-registry/models' && method === 'POST') {
      const input = body as Record<string, any>;
      const key = `${input.provider}:${input.id}`;
      const model: CustomModelDefinition = {
        key, provider: String(input.provider), id: String(input.id), name: String(input.name || input.id),
        capabilities: input.capabilities ?? { reasoning: false, imageInput: false, toolCalls: true },
        ...(input.contextWindow ? { contextWindow: Number(input.contextWindow) } : {}),
        ...(input.maxOutputTokens ? { maxOutputTokens: Number(input.maxOutputTokens) } : {}),
        ...(input.pricing ? { pricing: input.pricing } : {}),
        ...(input.compatibility ? { compatibility: input.compatibility } : {}),
        createdAt: DEFAULT_DATE, updatedAt: DEFAULT_DATE,
      };
      customModels.push(model);
      await fulfillJson(route, model, 201); return;
    }
    const customModelAction = url.pathname.match(/^\/api\/provider-registry\/models\/(.+?)(?:\/(test))?$/);
    if (customModelAction && method === 'POST' && customModelAction[2] === 'test') {
      await fulfillJson(route, { ok: true, model: decodeURIComponent(customModelAction[1]!), checkedAt: DEFAULT_DATE }); return;
    }
    if (customModelAction && method === 'DELETE') {
      const key = decodeURIComponent(customModelAction[1]!);
      customModels = customModels.filter(model => model.key !== key);
      await fulfillJson(route, { success: true }); return;
    }
    if (customModelAction && method === 'PUT') {
      const key = decodeURIComponent(customModelAction[1]!);
      const input = body as Record<string, any>;
      customModels = customModels.map(model => model.key === key ? { ...model, ...input, key: `${input.provider}:${input.id}`, updatedAt: DEFAULT_DATE } : model);
      await fulfillJson(route, customModels.find(model => model.key === `${input.provider}:${input.id}`)); return;
    }
    if (url.pathname === '/api/tools' && method === 'GET') { await fulfillJson(route, toolSettings); return; }
    if (url.pathname === '/api/tools' && method === 'PATCH') {
      const input = body as { enabledTools?: string[]; toolPreset?: ToolSettings['preset']; powershellEnabled?: boolean; projectId?: string };
      const enabled = new Set(input.enabledTools ?? []);
      toolSettings = {
        ...toolSettings, scope: input.projectId ? 'project' : 'global', source: input.projectId || 'global',
        preset: input.toolPreset ?? toolSettings.preset, powershellEnabled: input.powershellEnabled === true,
        tools: toolSettings.tools.map(tool => ({ ...tool, enabled: enabled.has(tool.name) && tool.available })),
      };
      await fulfillJson(route, toolSettings); return;
    }
    if (url.pathname === '/api/skills/registry' && method === 'GET') {
      const query = (url.searchParams.get('query') || '').toLowerCase();
      await fulfillJson(route, { ...skillRegistry, entries: skillRegistry.entries.filter(entry => !query || entry.name.includes(query)) }); return;
    }
    if (url.pathname === '/api/skills/registry/install' && method === 'POST') {
      const input = body as { id?: string; scope?: 'global' | 'project' };
      skillRegistry = { ...skillRegistry, entries: skillRegistry.entries.map(entry => entry.id === input.id
        ? { ...entry, installed: { scope: input.scope ?? 'global', version: entry.version, updateAvailable: false } } : entry) };
      await fulfillJson(route, { entry: skillRegistry.entries.find(entry => entry.id === input.id), catalog: skillCatalog }, 201); return;
    }
    if (url.pathname === '/api/skills/registry/update' && method === 'POST') {
      skillRegistry = { ...skillRegistry, entries: skillRegistry.entries.map(entry => entry.installed
        ? { ...entry, installed: { ...entry.installed, version: entry.version, updateAvailable: false } } : entry) };
      await fulfillJson(route, { result: [], catalog: skillCatalog }); return;
    }
    if (url.pathname === '/api/configuration/scope' && method === 'GET') {
      const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'project';
      await fulfillJson(route, { scope, scopeId: url.searchParams.get('scopeId') ?? undefined, values: configurationScopes[scope] }); return;
    }
    if (url.pathname === '/api/configuration/scope' && method === 'PATCH') {
      const input = body as { scope?: 'global' | 'project'; values?: Record<string, unknown>; scopeId?: string };
      const scope = input.scope === 'global' ? 'global' : 'project';
      configurationScopes[scope] = { ...configurationScopes[scope], ...(input.values ?? {}) };
      await fulfillJson(route, { scope, scopeId: input.scopeId, values: configurationScopes[scope] }); return;
    }
    if (url.pathname === '/api/models' && method === 'GET') {
      if (url.searchParams.get('refresh') === 'true') modelCatalog.updatedAt = '2025-01-01T12:01:00.000Z';
      await fulfillJson(route, modelCatalog); return;
    }
    if (url.pathname === '/api/models/enabled' && method === 'PATCH') {
      const enabledModels = Array.isArray((body as { enabledModels?: unknown[] })?.enabledModels)
        ? new Set((body as { enabledModels: unknown[] }).enabledModels.filter((value): value is string => typeof value === 'string'))
        : undefined;
      if (!enabledModels) { await fulfillJson(route, { error: 'Invalid enabled models' }, 400); return; }
      modelCatalog = {
        ...modelCatalog,
        enabledScope: (body as { projectId?: string }).projectId ? 'project' : 'global',
        enabledSource: (body as { projectId?: string }).projectId || 'global',
        providers: modelCatalog.providers.map(provider => ({
          ...provider,
          models: provider.models.map(model => ({ ...model, enabled: enabledModels.has(model.key) })),
        })),
      };
      await fulfillJson(route, modelCatalog); return;
    }
    if (url.pathname === '/api/skills' && method === 'GET') {
      if (url.searchParams.get('refresh') === 'true') skillCatalog.updatedAt = '2025-01-01T12:01:00.000Z';
      await fulfillJson(route, skillCatalog); return;
    }
    if (url.pathname === '/api/skills/enabled' && method === 'PATCH') {
      const enabledSkills = Array.isArray((body as { enabledSkills?: unknown[] })?.enabledSkills)
        ? new Set((body as { enabledSkills: unknown[] }).enabledSkills.filter((value): value is string => typeof value === 'string'))
        : undefined;
      if (!enabledSkills) { await fulfillJson(route, { error: 'Invalid enabled skills' }, 400); return; }
      const untrusted = skillCatalog.skills.find(skill => enabledSkills.has(skill.key) && !skill.trusted);
      if (untrusted) { await fulfillJson(route, { error: 'Project trust required', code: 'PROJECT_TRUST_REQUIRED' }, 409); return; }
      skillCatalog = {
        ...skillCatalog,
        enabledScope: 'project',
        enabledSource: skillCatalog.projectId,
        skills: skillCatalog.skills.map(skill => ({ ...skill, modelInvocable: enabledSkills.has(skill.key) && skill.trusted })),
      };
      await fulfillJson(route, skillCatalog); return;
    }
    if (url.pathname === '/api/plugins' && method === 'GET') {
      if (url.searchParams.get('refresh') === 'true') pluginCatalog.updatedAt = '2025-01-01T12:01:00.000Z';
      const requestedWorkspace = describeWorkspace(url.searchParams.get('cwd'));
      const scopedCatalog = requestedWorkspace.id === pluginCatalog.projectId
        ? pluginCatalog
        : withPluginTotals({
          ...pluginCatalog,
          cwd: requestedWorkspace.cwd,
          projectId: requestedWorkspace.id,
          projectTrusted: requestedWorkspace.trusted,
          projectResourcesLoaded: requestedWorkspace.trusted,
          packages: pluginCatalog.packages.filter(pkg => pkg.scope === 'global'),
          standaloneExtensions: pluginCatalog.standaloneExtensions.filter(extension => extension.scope === 'global'),
        });
      await fulfillJson(route, scopedCatalog); return;
    }
    if (url.pathname === '/api/plugins' && method === 'POST') {
      const input = body as {
        action?: string; key?: string; source?: string; scope?: 'global' | 'project';
      };
      if (input.scope === 'project' && !workspace.trusted && ['install', 'enable', 'update'].includes(input.action ?? '')) {
        await fulfillJson(route, { error: 'Project trust required', code: 'PROJECT_TRUST_REQUIRED' }, 409); return;
      }
      if (input.action === 'install') {
        const validSource = typeof input.source === 'string' && (
          input.source.startsWith('npm:') || input.source.startsWith('git:') || input.source.startsWith('/')
        );
        if (!validSource || (input.scope !== 'global' && input.scope !== 'project')) {
          await fulfillJson(route, { error: 'Invalid plugin source' }, 400); return;
        }
        const source = input.source!;
        const identity = source.startsWith('npm:')
          ? source.slice(4)
          : source.split('/').filter(Boolean).at(-1)?.replace(/\.git(?:#.*)?$/, '') || 'installed-plugin';
        const key = `${input.scope}:${input.scope === 'project' ? workspace.id : 'global'}:${String(pluginCatalog.packages.length + 3).repeat(20).slice(0, 20)}`;
        if (pluginCatalog.packages.some(pkg => pkg.source === source && pkg.scope === input.scope)) {
          await fulfillJson(route, { error: 'Plugin already installed' }, 409); return;
        }
        pluginCatalog.packages.unshift({
          key, source, sourceType: source.startsWith('npm:') ? 'npm' : source.startsWith('git:') ? 'git' : 'path',
          scope: input.scope, enabled: true, trusted: input.scope === 'global' || workspace.trusted,
          canCheckForUpdates: !source.startsWith('/'), installedPath: source.startsWith('/') ? source : `plugins/${identity}`,
          packageName: identity, version: '1.0.0', description: 'Explicitly installed package.',
          counts: { extensions: 1, skills: 1, prompts: 0, themes: 0 },
          resources: [
            { kind: 'extension', name: 'installed-tool', path: `plugins/${identity}/extensions/tool.js`, relativePath: 'extensions/tool.js' },
            { kind: 'skill', name: 'installed-skill', path: `plugins/${identity}/skills/installed-skill`, relativePath: 'skills/installed-skill' },
          ],
          diagnostics: [], status: 'active', restartRequired: true,
          installedAt: DEFAULT_DATE, updatedAt: DEFAULT_DATE,
        });
      } else if (input.action === 'remove') {
        pluginCatalog.packages = pluginCatalog.packages.filter(pkg => pkg.key !== input.key);
      } else if (input.action === 'enable' || input.action === 'disable') {
        pluginCatalog.packages = pluginCatalog.packages.map(pkg => pkg.key === input.key ? {
          ...pkg, enabled: input.action === 'enable', status: input.action === 'enable' ? 'active' : 'disabled',
        } : pkg);
      } else if (input.action === 'update') {
        pluginCatalog.packages = pluginCatalog.packages.map(pkg => (!input.key || pkg.key === input.key) && pkg.sourceType !== 'path'
          ? { ...pkg, version: pkg.sourceType === 'npm' ? '1.5.0' : '0.8.3', updatedAt: '2025-01-01T12:02:00.000Z' }
          : pkg);
      } else {
        await fulfillJson(route, { error: 'Invalid plugin action' }, 400); return;
      }
      pluginCatalog = withPluginTotals({ ...pluginCatalog, updatedAt: '2025-01-01T12:02:00.000Z' });
      await fulfillJson(route, pluginCatalog); return;
    }
    if (url.pathname === '/api/plugins/check' && method === 'POST') {
      const input = body as { key?: string; scope?: 'global' | 'project' };
      const packages = pluginCatalog.packages.filter(pkg => !input.key || (pkg.key === input.key && (!input.scope || pkg.scope === input.scope)));
      await fulfillJson(route, { updates: packages.map(pkg => ({
        key: pkg.key, source: pkg.source, scope: pkg.scope, displayName: pkg.packageName || pkg.source, type: pkg.sourceType,
        ...(pkg.version ? { installedVersion: pkg.version } : {}),
        ...(pkg.sourceType === 'path' ? {
          state: 'unsupported', message: 'Local paths are refreshed directly.',
        } : pkg.sourceType === 'npm' && pkg.version !== '1.5.0' ? {
          state: 'update-available', availableVersion: '1.5.0',
        } : {
          state: 'up-to-date', availableVersion: pkg.version,
        }),
      })) }); return;
    }
    if (url.pathname === '/api/plugins/reload' && method === 'POST') {
      const input = body as { sessionId?: string };
      pluginCatalog = { ...pluginCatalog, generation: pluginCatalog.generation + 1, updatedAt: '2025-01-01T12:03:00.000Z' };
      await fulfillJson(route, {
        catalog: pluginCatalog,
        reload: {
          reloadedAt: pluginCatalog.updatedAt, generation: pluginCatalog.generation,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          resourceCounts: pluginCatalog.totals,
          restartRequired: pluginCatalog.packages.some(pkg => pkg.enabled && pkg.restartRequired)
            || pluginCatalog.standaloneExtensions.length > 0,
          message: 'Declarative resources reloaded. Restart the server for executable extensions.',
        },
      }); return;
    }
    if (url.pathname === '/api/subagents/settings' && method === 'GET') {
      const requestedScope = url.searchParams.get('scope');
      await fulfillJson(route, requestedScope === 'global'
        ? { ...subagentConfiguration, scope: 'global', source: 'global' }
        : subagentConfiguration);
      return;
    }
    if (url.pathname === '/api/subagents/settings' && method === 'PATCH') {
      const input = body as {
        engineEnabled?: unknown; maxConcurrency?: unknown; projectId?: string; scope?: 'global' | 'project';
      };
      if (input.engineEnabled !== undefined) subagentConfiguration.engineEnabled = Boolean(input.engineEnabled);
      if (typeof input.maxConcurrency === 'number') subagentConfiguration.maxConcurrency = input.maxConcurrency;
      subagentConfiguration = {
        ...subagentConfiguration,
        scope: input.scope ?? (input.projectId ? 'project' : 'global'),
        source: input.scope === 'global' ? 'global' : input.projectId || 'global',
      };
      await fulfillJson(route, subagentConfiguration); return;
    }
    if (url.pathname === '/api/subagents/profiles' && method === 'POST') {
      const profile = (body as { profile?: SubagentProfile }).profile;
      if (!profile) { await fulfillJson(route, { error: 'Invalid profile' }, 400); return; }
      subagentConfiguration.profiles.push({ ...profile, id: profile.id || `profile-${Date.now()}`, builtIn: false });
      subagentConfiguration = { ...subagentConfiguration, scope: 'project', source: workspace.id };
      await fulfillJson(route, subagentConfiguration, 201); return;
    }
    const duplicateProfileMatch = url.pathname.match(/^\/api\/subagents\/profiles\/([^/]+)\/duplicate$/);
    if (duplicateProfileMatch && method === 'POST') {
      const source = subagentConfiguration.profiles.find(profile => profile.id === decodeURIComponent(duplicateProfileMatch[1]!));
      if (!source) { await fulfillJson(route, { error: 'Profile not found' }, 404); return; }
      subagentConfiguration.profiles.push({
        ...source, id: `${source.id}-copy`, name: `${source.name} copy`, kind: 'custom', builtIn: false,
      });
      await fulfillJson(route, subagentConfiguration, 201); return;
    }
    const profileMatch = url.pathname.match(/^\/api\/subagents\/profiles\/([^/]+)$/);
    if (profileMatch && method === 'PATCH') {
      const id = decodeURIComponent(profileMatch[1]!);
      const index = subagentConfiguration.profiles.findIndex(profile => profile.id === id);
      if (index < 0) { await fulfillJson(route, { error: 'Profile not found' }, 404); return; }
      subagentConfiguration.profiles[index] = {
        ...subagentConfiguration.profiles[index]!, ...((body as { profile?: Partial<SubagentProfile> }).profile ?? {}), id,
      };
      await fulfillJson(route, subagentConfiguration); return;
    }
    if (profileMatch && method === 'DELETE') {
      const id = decodeURIComponent(profileMatch[1]!);
      const profile = subagentConfiguration.profiles.find(item => item.id === id);
      if (!profile || profile.builtIn) { await fulfillJson(route, { error: 'Profile cannot be deleted' }, 409); return; }
      subagentConfiguration.profiles = subagentConfiguration.profiles.filter(item => item.id !== id);
      await fulfillJson(route, subagentConfiguration); return;
    }
    if (url.pathname === '/api/subagents/runs' && method === 'GET') {
      const parent = url.searchParams.get('parentSessionId');
      await fulfillJson(route, subagentRuns.filter(run => !parent || run.parentSessionId === parent)); return;
    }
    if (url.pathname === '/api/subagents/runs' && method === 'POST') {
      const input = body as { parentSessionId?: string; profileId?: string; task?: string; provider?: string; background?: boolean };
      const parent = controller.sessions.find(session => session.id === input.parentSessionId);
      const profile = subagentConfiguration.profiles.find(item => item.id === input.profileId);
      if (!parent || !profile || !input.task) { await fulfillJson(route, { error: 'Invalid subagent run' }, 400); return; }
      const child = mockSession(`e2e-subagent-session-${nextSessionId++}`, `${profile.name}: ${input.task}`);
      child.parentId = parent.id;
      child.cwd = parent.cwd;
      child.workspaceId = parent.workspaceId;
      child.metadata = { subagent: true, subagentProfileId: profile.id };
      controller.sessions.push(child);
      const run: SubagentRunSnapshot = {
        id: `e2e-subagent-${subagentRuns.length + 1}`, parentSessionId: parent.id, childSessionId: child.id,
        workspaceId: parent.workspaceId, profileId: profile.id, profileName: profile.name, task: input.task,
        provider: input.provider || 'mock', status: 'running', phase: 'streaming',
        background: input.background ?? profile.background, attention: false, turn: 1, maxTurns: profile.maxTurns,
        startedAt: DEFAULT_DATE,
      };
      subagentRuns.unshift(run);
      await fulfillJson(route, run, 202); return;
    }
    const subagentActionMatch = url.pathname.match(/^\/api\/subagents\/runs\/([^/]+)\/(stop|acknowledge)$/);
    if (subagentActionMatch && method === 'POST') {
      const run = subagentRuns.find(item => item.id === decodeURIComponent(subagentActionMatch[1]!));
      if (!run) { await fulfillJson(route, { error: 'Run not found' }, 404); return; }
      if (subagentActionMatch[2] === 'stop') Object.assign(run, {
        status: 'stopped', phase: 'stopped', completedAt: DEFAULT_DATE, attention: true,
      });
      else run.attention = false;
      await fulfillJson(route, run, subagentActionMatch[2] === 'stop' ? 202 : 200); return;
    }
    const subagentRunMatch = url.pathname.match(/^\/api\/subagents\/runs\/([^/]+)$/);
    if (subagentRunMatch && method === 'GET') {
      const run = subagentRuns.find(item => item.id === decodeURIComponent(subagentRunMatch[1]!));
      await fulfillJson(route, run ?? { error: 'Run not found' }, run ? 200 : 404); return;
    }
    if (url.pathname === '/api/configuration/effective' && method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? controller.sessions.find(item => item.id === sessionId) : undefined;
      const values: Record<string, unknown> = {
        thinking: 'off', toolPreset: 'default', autoCompaction: true,
        ...(options.effectiveConfiguration?.values ?? {}),
      };
      const provenance: Record<string, { value: unknown; scope: 'default' | 'global' | 'project' | 'session' | 'environment'; source: string }> = {
        thinking: { value: values.thinking, scope: 'default', source: 'built-in' },
        toolPreset: { value: values.toolPreset, scope: 'default', source: 'built-in' },
        autoCompaction: { value: values.autoCompaction, scope: 'default', source: 'built-in' },
        ...(options.effectiveConfiguration?.provenance ?? {}),
      };
      for (const key of ['model', 'thinking', 'toolPreset', 'autoCompaction'] as const) {
        if (session?.[key] === undefined || options.effectiveConfiguration?.provenance?.[key]?.scope === 'environment') continue;
        values[key] = session[key];
        provenance[key] = { value: session[key], scope: 'session', source: session.id };
      }
      await fulfillJson(route, { values, provenance }); return;
    }
    if (url.pathname === '/api/app-update' && method === 'GET') {
      await fulfillJson(route, {
        webVersion: options.appUpdate?.webVersion ?? '0.1.0',
        agentVersion: options.appUpdate?.agentVersion ?? '0.1.0',
        checkedAt: DEFAULT_DATE,
        available: options.appUpdate?.available ?? false,
        ...(options.appUpdate?.release ? { release: options.appUpdate.release } : {}),
        ...(options.appUpdate?.error ? { error: options.appUpdate.error } : {}),
      }); return;
    }
    if (url.pathname === '/api/config' && method === 'POST') {
      if (options.configureProviderError) { await fulfillJson(route, { error: 'Configuration refused' }, 500); return; }
      const configuration = body as { type?: string } | undefined;
      const provider = providers.find(item => item.type === configuration?.type);
      if (provider) provider.configured = true;
      await fulfillJson(route, { success: true, message: 'Provider configured' }); return;
    }

    if (url.pathname === '/api/workspaces/default' && method === 'GET') { await fulfillJson(route, workspace); return; }
    if (url.pathname === '/api/workspaces/validate' && method === 'POST') {
      await fulfillJson(route, describeWorkspace((body as { cwd?: string })?.cwd)); return;
    }
    if (url.pathname === '/api/workspaces/browse' && method === 'GET') {
      const cwd = normalizeWorkspacePath(url.searchParams.get('path'));
      const configured = options.workspaceBrowse?.[cwd];
      const parent = cwd !== workspace.cwd && cwd.startsWith(`${workspace.cwd}/`)
        ? cwd.slice(0, cwd.lastIndexOf('/')) || workspace.cwd
        : undefined;
      await fulfillJson(route, configured ?? { cwd, ...(parent ? { parent } : {}), entries: [] }); return;
    }
    if (url.pathname === '/api/workspaces/worktrees' && method === 'GET') {
      await fulfillJson(route, worktrees); return;
    }
    if (url.pathname === '/api/workspaces/worktrees' && method === 'POST') {
      const input = body as { path?: string; branch?: string };
      if (!input.path || !input.branch) { await fulfillJson(route, { error: 'Invalid worktree' }, 400); return; }
      const path = normalizeWorkspacePath(input.path);
      worktrees.push({ path, branch: input.branch, bare: false, detached: false });
      await fulfillJson(route, describeWorkspace(path), 201); return;
    }
    if (url.pathname === '/api/workspaces/worktrees' && method === 'DELETE') {
      const input = body as { path?: string; confirm?: boolean };
      const index = worktrees.findIndex(item => item.path === normalizeWorkspacePath(input.path));
      if (index < 0 || input.confirm !== true) { await fulfillJson(route, { error: 'Unknown worktree' }, 400); return; }
      worktrees.splice(index, 1);
      await fulfillJson(route, { success: true }); return;
    }
    if (url.pathname === '/api/workspaces/trust') {
      const input = (body as { cwd?: string } | undefined)?.cwd ?? url.searchParams.get('cwd');
      workspace.trusted = method !== 'DELETE';
      skillCatalog = {
        ...skillCatalog,
        projectTrusted: workspace.trusted,
        skills: skillCatalog.skills.map(skill => skill.scope === 'project'
          ? { ...skill, trusted: workspace.trusted, modelInvocable: workspace.trusted && skill.defaultModelInvocable }
          : skill),
      };
      const trustedPluginDefaults = mockPluginCatalog({ ...workspace, trusted: true });
      pluginCatalog = withPluginTotals({
        ...pluginCatalog,
        projectTrusted: workspace.trusted,
        projectResourcesLoaded: workspace.trusted,
        packages: pluginCatalog.packages.map(pkg => {
          if (pkg.scope !== 'project') return pkg;
          const defaults = trustedPluginDefaults.packages.find(candidate => candidate.key === pkg.key);
          return workspace.trusted
            ? { ...pkg, trusted: true, status: pkg.enabled ? 'active' : 'disabled', resources: defaults?.resources ?? pkg.resources,
              counts: defaults?.counts ?? pkg.counts, diagnostics: [], restartRequired: pkg.enabled && (defaults?.counts.extensions ?? pkg.counts.extensions) > 0 }
            : { ...pkg, trusted: false, status: pkg.enabled ? 'installed' : 'disabled', resources: [],
              counts: { extensions: 0, skills: 0, prompts: 0, themes: 0 }, restartRequired: false,
              diagnostics: [{ severity: 'warning', code: 'PROJECT_TRUST_REQUIRED', source: pkg.source,
                message: 'Project resources require workspace trust.' }] };
        }),
        standaloneExtensions: workspace.trusted
          ? trustedPluginDefaults.standaloneExtensions
          : pluginCatalog.standaloneExtensions.filter(extension => extension.scope === 'global'),
      });
      await fulfillJson(route, { cwd: normalizeWorkspacePath(input), trusted: workspace.trusted }); return;
    }

    if (url.pathname === '/api/files' && method === 'GET') {
      const requested = (url.searchParams.get('path') || '.').replace(/^\.\/?/, '').replace(/\/$/, '');
      const prefix = requested ? `${requested}/` : '';
      const names = new Map<string, { name: string; path: string; isDirectory: boolean; isSymbolicLink: boolean; hidden: boolean; gitStatus?: string }>();
      for (const file of workspaceFiles.filter(item => item.path.startsWith(prefix))) {
        const remainder = file.path.slice(prefix.length);
        const [name, ...tail] = remainder.split('/');
        if (!name) continue;
        const entryPath = `${prefix}${name}`;
        names.set(name, {
          name, path: entryPath, isDirectory: tail.length > 0, isSymbolicLink: false, hidden: name.startsWith('.'),
          ...(tail.length === 0 && file.gitStatus ? { gitStatus: file.gitStatus } : {}),
        });
      }
      await fulfillJson(route, { cwd: workspace.cwd, path: requested || '.', entries: [...names.values()] }); return;
    }
    if (url.pathname === '/api/files/content' && method === 'GET') {
      const file = workspaceFiles.find(item => item.path === url.searchParams.get('path'));
      if (!file || file.sourceUnavailable) { await fulfillJson(route, { error: 'File not found' }, 404); return; }
      if (file.tooLarge) {
        await fulfillJson(route, {
          error: 'File too large', path: file.path, name: file.path.split('/').at(-1), size: 3_000_000,
          modifiedAt: DEFAULT_DATE, language: file.language || 'text', binary: false, tooLarge: true, downloadable: true,
        }, 413); return;
      }
      await fulfillJson(route, {
        path: file.path, name: file.path.split('/').at(-1), size: new TextEncoder().encode(file.content).length,
        modifiedAt: DEFAULT_DATE, language: file.language || 'text', binary: file.binary ?? false,
        lineCount: file.binary ? undefined : file.content.split('\n').length,
        ...(file.binary ? {} : { content: file.content }),
      }); return;
    }
    if (url.pathname === '/api/files/download' && method === 'GET') {
      const file = workspaceFiles.find(item => item.path === url.searchParams.get('path'));
      const available = file && !file.sourceUnavailable;
      await route.fulfill({ status: available ? 200 : 404, contentType: 'application/octet-stream', body: available ? file.content : '' }); return;
    }
    if (url.pathname === '/api/files/git/status' && method === 'GET') {
      const files = workspaceFiles.filter(file => file.gitStatus).map(file => ({
        path: file.path, status: file.gitStatus, staged: false, additions: file.additions, deletions: file.deletions,
      }));
      await fulfillJson(route, {
        repository: true, files, total: files.length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      }); return;
    }
    if (url.pathname === '/api/files/git/diff' && method === 'GET') {
      const file = workspaceFiles.find(item => item.path === url.searchParams.get('path'));
      await fulfillJson(route, { path: file?.path, diff: file?.diff || '', binary: file?.binary ?? false }); return;
    }
    if (url.pathname === '/api/files/watch' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: connection.ready\ndata: {"revision":0}\n\n` }); return;
    }
    if (url.pathname === '/api/files/upload' && method === 'POST') {
      const input = body as { files?: Array<{ name: string; content: string }>; collision?: string };
      const names: string[] = [];
      for (const file of input.files ?? []) {
        workspaceFiles.push({ path: file.name, content: atob(file.content), language: 'text', gitStatus: 'untracked' });
        names.push(file.name);
      }
      await fulfillJson(route, { files: names, collision: input.collision || 'reject' }, 201); return;
    }
    if (url.pathname === '/api/files/index' && method === 'GET') {
      const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
      const fuzzy = (value: string) => {
        let cursor = 0;
        for (const character of query) {
          cursor = value.toLocaleLowerCase().indexOf(character, cursor);
          if (cursor < 0) return false;
          cursor += 1;
        }
        return true;
      };
      const files = indexedFiles.filter(fuzzy);
      const directories = indexedDirectories.filter(fuzzy);
      await fulfillJson(route, {
        files, directories, total: files.length, directoryTotal: directories.length,
        truncated: options.fileIndexTruncated ?? false,
      }); return;
    }

    if (url.pathname === '/api/terminals' && method === 'GET') {
      await fulfillJson(route, [...terminals.values()].filter(item => !url.searchParams.get('cwd') || item.cwd === url.searchParams.get('cwd'))); return;
    }
    if (url.pathname === '/api/terminals' && method === 'POST') {
      const input = body as { cwd: string; name?: string; cols?: number; rows?: number };
      const terminal = {
        id: `terminal-${nextTerminalId++}`, cwd: input.cwd, name: input.name || 'Terminal', shell: '/bin/sh', pid: 4242,
        cols: input.cols || 100, rows: input.rows || 30, status: 'running' as const,
        startedAt: DEFAULT_DATE, lastOffset: 0, output: '',
      };
      terminals.set(terminal.id, terminal);
      await fulfillJson(route, terminal, 201); return;
    }
    const terminalEvents = url.pathname.match(/^\/api\/terminals\/([^/]+)\/events$/);
    if (terminalEvents && method === 'GET') {
      const terminal = terminals.get(decodeURIComponent(terminalEvents[1]!));
      if (!terminal) { await fulfillJson(route, { error: 'Terminal not found' }, 404); return; }
      let records = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: terminal, reset: false, oldestOffset: 0, lastOffset: terminal.lastOffset })}\n\n`;
      if (terminal.output) {
        records += `id: ${terminal.lastOffset}\nevent: output\ndata: ${JSON.stringify({ type: 'output', terminalId: terminal.id, offset: 0, endOffset: terminal.lastOffset, data: terminal.output, timestamp: DEFAULT_DATE })}\n\n`;
      }
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: records }); return;
    }
    const terminalInput = url.pathname.match(/^\/api\/terminals\/([^/]+)\/input$/);
    if (terminalInput && method === 'POST') {
      const terminal = terminals.get(decodeURIComponent(terminalInput[1]!));
      if (!terminal) { await fulfillJson(route, { error: 'Terminal not found' }, 404); return; }
      const data = String((body as { data?: string })?.data || '');
      terminal.output += data.includes('hello-terminal') ? 'hello-terminal\r\n' : data;
      terminal.lastOffset = new TextEncoder().encode(terminal.output).length;
      await fulfillJson(route, terminal); return;
    }
    const terminalResize = url.pathname.match(/^\/api\/terminals\/([^/]+)\/resize$/);
    if (terminalResize && method === 'POST') {
      const terminal = terminals.get(decodeURIComponent(terminalResize[1]!));
      if (!terminal) { await fulfillJson(route, { error: 'Terminal not found' }, 404); return; }
      terminal.cols = Number((body as { cols?: number })?.cols) || terminal.cols;
      terminal.rows = Number((body as { rows?: number })?.rows) || terminal.rows;
      await fulfillJson(route, terminal); return;
    }
    const terminalMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)$/);
    if (terminalMatch && method === 'DELETE') {
      const terminal = terminals.get(decodeURIComponent(terminalMatch[1]!));
      if (!terminal) { await fulfillJson(route, { error: 'Terminal not found' }, 404); return; }
      Object.assign(terminal, { status: 'killed' as const, completedAt: DEFAULT_DATE });
      terminals.delete(terminal.id);
      await fulfillJson(route, terminal); return;
    }

    if (url.pathname === '/api/agent/running' && method === 'GET') {
      await fulfillJson(route, [...runs.values()].filter(run => !['completed', 'failed', 'stopped'].includes(run.phase))); return;
    }
    const stopRunMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/stop$/);
    if (stopRunMatch && method === 'POST') {
      const run = [...runs.values()].find(item => item.id === decodeURIComponent(stopRunMatch[1]!));
      if (!run) { await fulfillJson(route, { error: 'Run not found' }, 404); return; }
      run.phase = 'stopped';
      delete run.retry;
      delete run.activeTool;
      run.lastSequence += 1;
      await fulfillJson(route, run, 202); return;
    }
    const runSnapshotMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)$/);
    if (runSnapshotMatch && method === 'GET') {
      const run = [...runs.values()].find(item => item.id === decodeURIComponent(runSnapshotMatch[1]!));
      if (!run) { await fulfillJson(route, { error: 'Run not found' }, 404); return; }
      await fulfillJson(route, run); return;
    }
    if (url.pathname === '/api/agent/palette' && method === 'GET') {
      await fulfillJson(route, options.paletteItems ?? [
        { name: 'auto-compact', description: 'Set automatic compaction', source: 'builtin' },
        { name: 'compact', description: 'Compact conversation', source: 'builtin' },
        { name: 'review', description: 'Review prompt', source: 'prompt' },
        { name: 'release-notes', description: 'Release notes skill', source: 'skill' },
        { name: 'approve', description: 'Extension approval command', source: 'extension' },
      ]); return;
    }
    const paletteResource = url.pathname.match(/^\/api\/agent\/palette\/(prompt|skill)\/([^/]+)$/);
    if (paletteResource && method === 'GET') {
      await fulfillJson(route, { content: `${paletteResource[1]}:${decodeURIComponent(paletteResource[2]!)}`, source: 'e2e' }); return;
    }
    const extensionWidgets = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/extensions$/);
    if (extensionWidgets && method === 'GET') {
      await fulfillJson(route, options.extensionWidgets ?? []); return;
    }
    const extensionInteraction = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/interactions\/([^/]+)$/);
    if (extensionInteraction && method === 'POST') {
      const sessionId = decodeURIComponent(extensionInteraction[1]!);
      const run = runs.get(sessionId);
      if (!run?.extensionRequest || run.extensionRequest.id !== decodeURIComponent(extensionInteraction[2]!)) {
        await fulfillJson(route, { error: 'Extension interaction not found' }, 404); return;
      }
      delete run.extensionRequest;
      run.phase = 'streaming';
      run.lastSequence++;
      await fulfillJson(route, run); return;
    }
    const capabilities = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/capabilities$/);
    if (capabilities && method === 'GET') {
      const session = controller.sessions.find(item => item.id === decodeURIComponent(capabilities[1]!));
      const preset = session?.toolPreset ?? options.effectiveConfiguration?.values?.toolPreset ?? 'default';
      const readOnly = new Set(['read', 'grep', 'find', 'ls', 'load_skill']);
      const tools = (options.capabilities?.tools ?? []).filter(tool => (
        preset !== 'chat-only' && (preset !== 'read-only' || readOnly.has(tool.name))
      ));
      await fulfillJson(route, { systemPrompt: options.capabilities?.systemPrompt ?? '', toolPreset: preset, tools }); return;
    }

    if (url.pathname === '/api/sessions' && method === 'GET') {
      const rawLimit = url.searchParams.get('messageLimit');
      const cwd = url.searchParams.get('cwd');
      const matching = cwd ? controller.sessions.filter(session => session.cwd === cwd) : controller.sessions;
      const sessions = rawLimit === null
        ? matching
        : matching.map(session => paginatedSession(session, { limit: Number(rawLimit) || 0 }));
      await fulfillJson(route, sessions); return;
    }
    if (url.pathname === '/api/sessions' && method === 'POST') {
      if (options.createSessionError) { await fulfillJson(route, { error: 'Failed to create session' }, 500); return; }
      const input = body as { title?: string; cwd?: string } | undefined;
      const session = mockSession(`e2e-session-${nextSessionId++}`, input?.title || '');
      session.cwd = input?.cwd || workspace.cwd;
      session.workspaceId = describeWorkspace(session.cwd).id;
      controller.sessions.unshift(session);
      await fulfillJson(route, session, 201); return;
    }
    if (url.pathname === '/api/sessions/search' && method === 'GET') {
      const query = (url.searchParams.get('q') || '').toLowerCase();
      const cwd = url.searchParams.get('cwd');
      const results = controller.sessions.filter(session => !cwd || session.cwd === cwd).flatMap(session => session.messages
        .filter(message => message.content.toLowerCase().includes(query))
        .map(message => ({ sessionId: session.id, messageId: message.id, title: session.title, cwd: session.cwd, updatedAt: session.updatedAt, excerpt: message.content, matchStart: message.content.toLowerCase().indexOf(query), matchLength: query.length, field: 'content' })));
      await fulfillJson(route, { query, count: results.length, results }); return;
    }
    if (url.pathname === '/api/sessions/tree' && method === 'GET') {
      await fulfillJson(route, controller.sessions.map(session => ({ id: session.id, title: session.title, depth: 0 }))); return;
    }
    const infoMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/info$/);
    if (infoMatch && method === 'GET') {
      const session = controller.sessions.find(item => item.id === decodeURIComponent(infoMatch[1]!));
      if (!session) { await fulfillJson(route, { error: 'Session not found' }, 404); return; }
      const count = (role: MockMessage['role']) => session.messages.filter(message => message.role === role).length;
      const blockCount = (type: string) => session.messages.reduce((total, message) => total
        + ((message.blocks as Array<{ type?: string }> | undefined)?.filter(block => block.type === type).length ?? 0), 0);
      const contextWindowTokens = Number(session.metadata?.contextWindowTokens
        ?? session.providerConfig?.contextWindowTokens) || undefined;
      const contextUsedTokens = session.usage?.totalTokens;
      const inputTokens = session.usage?.inputTokens ?? 0;
      await fulfillJson(route, {
        id: session.id,
        file: `${session.id}.jsonl`,
        cwd: session.cwd,
        gitBranch: session.gitBranch,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        durationMs: new Date(session.updatedAt).getTime() - new Date(session.createdAt).getTime(),
        counts: {
          user: count('user'), assistant: count('assistant'), tool: count('tool'), system: count('system'),
          toolCalls: blockCount('tool_call'), toolResults: blockCount('tool_result') || count('tool'),
          commands: 0, total: session.messages.length,
        },
        usage: session.usage,
        contextWindowTokens,
        contextUsedTokens,
        contextUtilization: contextWindowTokens && contextUsedTokens !== undefined
          ? Math.min(1, contextUsedTokens / contextWindowTokens) : undefined,
        cacheHitRate: inputTokens > 0 ? Math.min(1, (session.usage?.cacheReadTokens ?? 0) / inputTokens) : undefined,
        model: session.model,
        provider: session.providerConfig?.type ?? 'mock',
      }); return;
    }
    const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      const session = controller.sessions.find(item => item.id === decodeURIComponent(messagesMatch[1]!));
      if (!session) { await fulfillJson(route, { error: 'Session not found' }, 404); return; }
      try {
        const paged = paginatedSession(session, {
          limit: Number(url.searchParams.get('limit')) || 80,
          before: url.searchParams.get('before') || undefined,
          around: url.searchParams.get('around') || undefined,
        });
        await fulfillJson(route, { ...paged.messagePage, messages: paged.messages, hasMore: paged.messagePage!.hasMoreBefore });
      } catch (error) {
        await fulfillJson(route, { error: error instanceof Error ? error.message : 'Invalid cursor' }, 400);
      }
      return;
    }
    const autoNameMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/auto-name$/);
    if (autoNameMatch && method === 'POST') {
      const session = controller.sessions.find(item => item.id === decodeURIComponent(autoNameMatch[1]!));
      if (!session) { await fulfillJson(route, { error: 'Session not found' }, 404); return; }
      if (!session.messages.some(message => message.role === 'user')) {
        await fulfillJson(route, { error: 'A user message is required before generating a title.' }, 409); return;
      }
      Object.assign(session, { title: 'Generated conversation title', updatedAt: DEFAULT_DATE });
      await fulfillJson(route, session); return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const session = controller.sessions.find(item => item.id === sessionId);
      if (!session) { await fulfillJson(route, { error: 'Session not found' }, 404); return; }
      if (method === 'GET') {
        const rawLimit = url.searchParams.get('messageLimit');
        await fulfillJson(route, rawLimit === null ? session : paginatedSession(session, { limit: Number(rawLimit) || 0 }));
        return;
      }
      if (method === 'PATCH') {
        for (const [key, value] of Object.entries((body ?? {}) as Record<string, unknown>)) {
          if (value === null) delete (session as unknown as Record<string, unknown>)[key];
          else Object.assign(session, { [key]: value });
        }
        session.updatedAt = DEFAULT_DATE;
        await fulfillJson(route, session); return;
      }
      if (method === 'DELETE') {
        const deleted = new Set([sessionId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const item of controller.sessions) {
            if (item.parentId && deleted.has(item.parentId) && !deleted.has(item.id)) {
              deleted.add(item.id);
              changed = true;
            }
          }
        }
        const descendants = controller.sessions.filter(item => item.id !== sessionId && deleted.has(item.id));
        if (descendants.length && url.searchParams.get('cascade') !== 'true') {
          await fulfillJson(route, {
            error: 'Cascade confirmation required', code: 'CASCADE_CONFIRMATION_REQUIRED',
            descendants: descendants.map(item => ({ id: item.id, title: item.title })),
          }, 409); return;
        }
        for (let index = controller.sessions.length - 1; index >= 0; index--) {
          if (deleted.has(controller.sessions[index]!.id)) controller.sessions.splice(index, 1);
        }
        await fulfillJson(route, { success: true, deletedCount: deleted.size }); return;
      }
    }

    const branchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(fork|clone)$/);
    if (branchMatch && method === 'POST') {
      const source = controller.sessions.find(item => item.id === decodeURIComponent(branchMatch[1]!));
      if (!source) { await fulfillJson(route, { error: 'Session not found' }, 404); return; }
      const input = body as { messageIndex?: number; messageId?: string; title?: string } | undefined;
      const messageIndex = input?.messageId
        ? source.messages.findIndex(message => message.id === input.messageId)
        : input?.messageIndex;
      const end = messageIndex === undefined || messageIndex < 0 ? source.messages.length : messageIndex + 1;
      const branched: MockSession = {
        ...structuredClone(source),
        id: `e2e-session-${nextSessionId++}`,
        title: input?.title || source.title,
        messages: structuredClone(source.messages.slice(0, end)),
        createdAt: DEFAULT_DATE,
        updatedAt: DEFAULT_DATE,
        ...(branchMatch[2] === 'fork' ? { parentId: source.id, branchId: source.branchId || source.id } : {}),
      } as MockSession;
      controller.sessions.unshift(branched);
      await fulfillJson(route, branched, 201); return;
    }

    if (url.pathname === '/api/agent/commands' && method === 'POST') {
      const input = body as { sessionId: string; command: string; cwd: string; excludedFromContext: boolean };
      const command = {
        id: `e2e-command-${nextCommandId++}`,
        sessionId: input.sessionId,
        command: input.command,
        cwd: input.cwd,
        excludedFromContext: input.excludedFromContext,
        status: 'running' as const,
        startedAt: DEFAULT_DATE,
        output: '',
        truncated: false,
        lastSequence: 0,
      };
      commands.set(command.id, command);
      await fulfillJson(route, command, 202); return;
    }
    const commandEvents = url.pathname.match(/^\/api\/agent\/commands\/([^/]+)\/events$/);
    if (commandEvents && method === 'GET') {
      const command = commands.get(decodeURIComponent(commandEvents[1]!));
      if (!command) { await fulfillJson(route, { error: 'Command not found' }, 404); return; }
      let records = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: command })}\n\n`;
      if (!options.holdCommands) {
        const output = options.commandOutput ?? `output:${command.command}`;
        records += `id: 1\nevent: output\ndata: ${JSON.stringify({ sequence: 1, type: 'output', data: { stream: 'stdout', chunk: output } })}\n\n`;
        records += `id: 2\nevent: exit\ndata: ${JSON.stringify({ sequence: 2, type: 'exit', data: { exitCode: 0 } })}\n\n`;
        Object.assign(command, {
          status: 'completed' as const, completedAt: DEFAULT_DATE, exitCode: 0,
          output, lastSequence: 2,
        });
      }
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: records }); return;
    }
    const commandMatch = url.pathname.match(/^\/api\/agent\/commands\/([^/]+)$/);
    if (commandMatch && method === 'DELETE') {
      const command = commands.get(decodeURIComponent(commandMatch[1]!));
      if (!command) { await fulfillJson(route, { error: 'Command not found' }, 404); return; }
      Object.assign(command, { status: 'cancelled' as const, completedAt: DEFAULT_DATE, lastSequence: command.lastSequence + 1 });
      await fulfillJson(route, command); return;
    }

    if (url.pathname === '/api/agent/runs' && method === 'POST') {
      if (options.createSessionError) { await fulfillJson(route, { error: 'Failed to create session' }, 500); return; }
      const input = body as {
        sessionId?: string; input: string; cwd: string; provider: string; model?: string; thinking?: string;
        toolPreset?: string; autoCompaction?: boolean; settingOverrides?: string[]; blocks?: unknown[];
      };
      let session = input.sessionId ? controller.sessions.find(item => item.id === input.sessionId) : undefined;
      if (!session) {
        session = mockSession(`e2e-session-${nextSessionId++}`, input.input.slice(0, 50));
        session.cwd = input.cwd;
        session.workspaceId = describeWorkspace(input.cwd).id;
        controller.sessions.unshift(session);
      }
      const user: MockMessage = {
        id: `e2e-message-${nextMessageId++}`, role: 'user', content: input.input,
        timestamp: DEFAULT_DATE, blocks: input.blocks ?? [{ type: 'text', text: input.input }],
      };
      session.messages.push(user);
      session.title ||= input.input.slice(0, 50);
      session.updatedAt = user.timestamp;
      if (Array.isArray(input.settingOverrides)) {
        for (const key of ['model', 'thinking', 'toolPreset', 'autoCompaction'] as const) {
          if (input.settingOverrides.includes(key) && input[key] !== undefined) Object.assign(session, { [key]: input[key] });
          else delete (session as unknown as Record<string, unknown>)[key];
        }
      } else {
        Object.assign(session, {
          model: input.model,
          thinking: input.thinking,
          toolPreset: input.toolPreset,
          autoCompaction: input.autoCompaction,
        });
      }
      const run = {
        id: `e2e-run-${nextRunId++}`, sessionId: session.id, workspaceId: describeWorkspace(input.cwd).id,
        cwd: input.cwd, provider: input.provider, phase: options.extensionInteraction ? 'tool' as const : 'streaming' as const,
        steerQueue: [], followUpQueue: [], lastSequence: 1,
        ...(options.extensionInteraction ? { extensionRequest: structuredClone(options.extensionInteraction) } : {}),
      };
      runs.set(session.id, run);
      await fulfillJson(route, { run, session: paginatedSession(session, { limit: 80 }), workspace: describeWorkspace(input.cwd) }, 202); return;
    }

    const compactMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/compact$/);
    if (compactMatch && method === 'POST') {
      const session = controller.sessions.find(item => item.id === decodeURIComponent(compactMatch[1]!));
      if (!session) { await fulfillJson(route, { error: 'Session not found' }, 404); return; }
      if (options.holdCompaction) {
        await new Promise<void>(resolve => { pendingCompaction = resolve; });
      }
      session.messages = session.messages.slice(-2);
      session.metadata = {
        ...session.metadata,
        compactionSummary: 'Compacted conversation',
        compactionStats: { tokensBefore: 120, tokensAfter: 40 },
      };
      try {
        await fulfillJson(route, {
          session, summary: 'Compacted conversation', tokensBefore: 120, tokensAfter: 40, tokensSaved: 80,
        });
      } catch {
        // The browser may have cancelled the request while the deterministic fixture was held.
      }
      return;
    }

    const stateMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/state$/);
    if (stateMatch && method === 'GET') {
      const sessionId = decodeURIComponent(stateMatch[1]!);
      const session = controller.sessions.find(item => item.id === sessionId);
      if (!session) { await fulfillJson(route, { error: 'Session not found' }, 404); return; }
      const run = runs.get(sessionId);
      const rawLimit = url.searchParams.get('messageLimit');
      const responseSession = rawLimit === null ? session : paginatedSession(session, { limit: Number(rawLimit) || 0 });
      await fulfillJson(route, { sessionId, lastSequence: run?.lastSequence ?? 0, run, session: responseSession }); return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && method === 'GET') {
      const sessionId = decodeURIComponent(eventsMatch[1]!);
      const session = controller.sessions.find(item => item.id === sessionId)!;
      const run = runs.get(sessionId);
      const text = stream.filter(event => event.type === 'text_delta').map(event => event.content || '').join('')
        || stream.find(event => event.type === 'message_end')?.content || 'Mock response';
      const streamError = stream.find(event => event.type === 'error')?.content;
      let records = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: { sessionId, lastSequence: 0 }, reset: false })}\n\n`;
      if (run) {
        const after = Number(url.searchParams.get('after') || 0);
        const ready = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: { sessionId, lastSequence: run.lastSequence, run }, reset: false })}\n\n`;
        if (options.holdAgentRun) {
          records = ready;
        } else if (streamError) {
          run.phase = 'failed';
          run.lastSequence = 2;
          records = ready + `id: ${sessionId}:2\nevent: run.failed\ndata: ${JSON.stringify({ protocolVersion: 1, id: `${sessionId}:2`, sequence: 2, sessionId, runId: run.id, type: 'run.failed', timestamp: DEFAULT_DATE, data: { message: streamError } })}\n\n`;
        } else {
          if (!completedRuns.has(run.id)) {
            session.messages.push({
              id: `e2e-message-${nextMessageId++}`, role: 'assistant', content: text,
              timestamp: DEFAULT_DATE, blocks: [{ type: 'text', text }],
            });
            completedRuns.add(run.id);
          }
          const effectiveAutoCompaction = session.autoCompaction
            ?? options.effectiveConfiguration?.values?.autoCompaction
            ?? true;
          const automaticallyCompacted = options.automaticCompaction && effectiveAutoCompaction;
          if (automaticallyCompacted) {
            session.messages = session.messages.slice(-2);
            session.metadata = {
              ...session.metadata,
              compactionSummary: 'Automatic compacted conversation',
              compactionStats: { tokensBefore: 120, tokensAfter: 40 },
            };
          }
          run.phase = 'completed';
          run.lastSequence = automaticallyCompacted ? 6 : 4;
          records = ready + [
            `id: ${sessionId}:2\nevent: message.start\ndata: ${JSON.stringify({ protocolVersion: 1, id: `${sessionId}:2`, sequence: 2, sessionId, runId: run.id, type: 'message.start', timestamp: DEFAULT_DATE, data: { messageId: `stream:${run.id}` } })}\n\n`,
            `id: ${sessionId}:3\nevent: message.delta\ndata: ${JSON.stringify({ protocolVersion: 1, id: `${sessionId}:3`, sequence: 3, sessionId, runId: run.id, type: 'message.delta', timestamp: DEFAULT_DATE, data: { messageId: `stream:${run.id}`, content: text } })}\n\n`,
            ...(automaticallyCompacted ? [
              `id: ${sessionId}:4\nevent: compaction.started\ndata: ${JSON.stringify({ protocolVersion: 1, id: `${sessionId}:4`, sequence: 4, sessionId, runId: run.id, type: 'compaction.started', timestamp: DEFAULT_DATE, data: { automatic: true, tokensBefore: 120 } })}\n\n`,
              `id: ${sessionId}:5\nevent: compaction.completed\ndata: ${JSON.stringify({ protocolVersion: 1, id: `${sessionId}:5`, sequence: 5, sessionId, runId: run.id, type: 'compaction.completed', timestamp: DEFAULT_DATE, data: { automatic: true, tokensBefore: 120, tokensAfter: 40, tokensSaved: 80 } })}\n\n`,
            ] : []),
            `id: ${sessionId}:${automaticallyCompacted ? 6 : 4}\nevent: run.completed\ndata: ${JSON.stringify({ protocolVersion: 1, id: `${sessionId}:${automaticallyCompacted ? 6 : 4}`, sequence: automaticallyCompacted ? 6 : 4, sessionId, runId: run.id, type: 'run.completed', timestamp: DEFAULT_DATE, data: {} })}\n\n`,
          ].join('');
        }
        if (after >= run.lastSequence) {
          records = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: { sessionId, lastSequence: run.lastSequence, run }, reset: false })}\n\n`;
        }
      }
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: records }); return;
    }

    const queueMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/queue$/);
    if (queueMatch && method === 'POST') {
      const run = [...runs.values()].find(item => item.id === decodeURIComponent(queueMatch[1]!));
      if (!run) { await fulfillJson(route, { error: 'Run not found' }, 404); return; }
      const input = body as { kind: 'steer' | 'follow-up'; content: string };
      const queue = input.kind === 'steer' ? run.steerQueue : run.followUpQueue;
      queue.push({ id: `queued-${queue.length + 1}`, ...input, createdAt: DEFAULT_DATE });
      run.lastSequence++;
      await fulfillJson(route, run, 202); return;
    }
    if (queueMatch && method === 'DELETE') {
      const run = [...runs.values()].find(item => item.id === decodeURIComponent(queueMatch[1]!));
      if (!run) { await fulfillJson(route, { error: 'Run not found' }, 404); return; }
      const kind = url.searchParams.get('kind');
      if (!kind || kind === 'steer') run.steerQueue = [];
      if (!kind || kind === 'follow-up') run.followUpQueue = [];
      run.lastSequence++;
      await fulfillJson(route, run); return;
    }

    await fulfillJson(route, { error: `Unhandled mock route: ${method} ${url.pathname}` }, 404);
  });

  return controller;
}

function readRequestBody(route: Route): unknown {
  const rawBody = route.request().postData();
  if (!rawBody) return undefined;
  try { return JSON.parse(rawBody) as unknown; } catch { return rawBody; }
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
