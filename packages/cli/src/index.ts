#!/usr/bin/env node
// ============================================================
// AiHarness CLI - Regular readline and fullscreen TUI entry point
// ============================================================

import {
  AgentMessageQueue,
  clampPublishedThinkingLevel,
  closeProviderNetworkDispatchers,
  collectToolSearchLoadedNames,
  createAgentToolLoadout,
  CODEMODE_TOOL_NAME,
  createMcpOAuthProviderFactory,
  CredentialRedactor,
  DEFAULT_CODING_TOOL_NAMES,
  EncryptedCredentialStore,
  ExtensionRegistry,
  getSupportedThinkingLevels,
  inspectMcpConfig,
  JsonlSessionStore,
  loadAgentSettings,
  loadPromptFiles,
  McpOAuthCredentialManager,
  McpSessionHost,
  normalizeProviderUsage,
  PluginService,
  resolveInstructionPrompt,
  resolvePreTrustAgentDirectory,
  resolveAgentCompactionSettings,
  resolveAgentDefaultTools,
  resolveAgentResourcePaths,
  resolveAgentThinkingLevel,
  selectAgentResourcePaths,
  readMcpServerTestTarget,
  registerWorkspaceTools,
  selectRegisteredTools,
  SessionManager,
  toChatToolDefinitions,
  truncateToolTail,
  TOOL_SEARCH_TOOL_NAME,
  unknownToolNames,
  WorkspaceManager,
} from '@ai-harness/core';
import type {
  AgentMessageQueueKind,
  AiProvider,
  Message,
  MessageContentBlock,
  PluginResourceKind,
  ResolvedAgentSettings,
  Session,
  SessionEntry,
  ThinkingLevel,
  ToolCall,
} from '@ai-harness/core';
import path from 'node:path';
import readline from 'readline';
import chalk from 'chalk';
import { CommandHandler } from './commands/handler.js';
import { TerminalUI } from './tui/terminal-ui.js';
import { FullscreenUI } from './tui/fullscreen-ui.js';
import { FullscreenInput } from './tui/fullscreen-input.js';
import { ThemeFilteredInput } from './tui/theme-input-filter.js';
import {
  TerminalEscapeSequence,
  TERMINAL_ESCAPE_CODE_TIMEOUT_MS,
} from './tui/terminal-escape.js';
import { resolveTerminalMode } from './tui/mode.js';
import { KeyBindingManager } from './utils/keybinding-manager.js';
import { ExtensionLoader } from './extensions/extension-loader.js';
import { runToolLoop } from './agent/tool-loop.js';
import { streamProviderTurn } from './agent/provider-turn.js';
import { parseResourceCommandLine, ResourceManager } from './resources/resource-manager.js';
import { editInExternalEditor } from './utils/system-integration.js';
import { runRpcMode } from './rpc/rpc-server.js';
import {
  ProjectTrustManager,
  promptForProjectTrust,
  resolveProjectTrust,
} from './security/project-trust.js';
import {
  startSystemThemeProbe,
  ThemeManager,
  type SystemThemeProbe,
} from './tui/theme-manager.js';
import {
  CliArgumentError,
  cliVersion,
  formatCliHelp,
  parseCliArguments,
  readPipedStdin,
  resolveCliApplicationMode,
  type CliThinkingLevel,
} from './cli/args.js';
import {
  applyAgentModelSettings,
  createConfiguredProviders,
  resolveStartupProvider,
} from './providers/configured-providers.js';
import { createCliProviderRuntime } from './providers/provider-runtime.js';
import { reserveProcessStdoutForJson, toJsonProtocolUsage } from './cli/json-output.js';
import { cleanupCliEarlyExit } from './cli/lifecycle.js';
import { InteractiveShellController } from './cli/shell-controller.js';
import { formatConfiguredModelList } from './cli/model-list.js';
import { runPackageCommand } from './cli/package-command.js';
import { runMcpCommand } from './cli/mcp-command.js';
import {
  resolveStartupSession,
  resolveStartupSessionDirectory,
  StartupSessionSelectionCancelledError,
} from './sessions/startup-session.js';

const outputCredentialRedactor = new CredentialRedactor();
outputCredentialRedactor.addEnvironment(process.env);

interface InputDriver {
  prompt(): void;
  close(): void;
  setPrompt(prompt: string): void;
  getValue(): string;
  replaceValue(value: string): void;
}

interface InteractiveQueuedInput {
  content: string;
  imageBlocks?: MessageContentBlock[];
}

function messagesFromSessionEntries(entries: SessionEntry[]): Message[] {
  return entries.flatMap(entry => entry.type === 'message' ? [{
    id: entry.id,
    role: entry.role,
    content: entry.content,
    timestamp: new Date(entry.timestamp),
    blocks: entry.blocks,
    toolCalls: entry.toolCalls,
    toolCallId: entry.toolCallId,
    name: entry.name,
    isError: entry.isError,
    provider: entry.provider,
    model: entry.model,
    usage: entry.usage,
    durationMs: entry.durationMs,
    parentMessageId: entry.parentMessageId,
    agentId: entry.agentId,
    metadata: entry.metadata,
  }] : []);
}

function coreThinkingLevel(level: CliThinkingLevel | undefined): ThinkingLevel | undefined {
  return level;
}

function reportAgentSettingsDiagnostics(settings: ResolvedAgentSettings): void {
  for (const diagnostic of settings.diagnostics) {
    const field = diagnostic.setting ? ` [${diagnostic.setting}]` : '';
    const message = `Warning: Settings ignored (${diagnostic.path})${field}: ${diagnostic.message}`;
    process.stderr.write(`${outputCredentialRedactor.redact(message)}\n`);
  }
}

function configuredExtensionPaths(
  cliPaths: readonly string[],
  settings: ResolvedAgentSettings,
): string[] {
  const configured = selectAgentResourcePaths(resolveAgentResourcePaths(settings, 'extensions'))
    .filter(entry => !entry.includes('builtin:'));
  return [...cliPaths, ...configured];
}

function formatAgentSettingsSummary(resolved: ResolvedAgentSettings): string {
  const source = (field: string): string => resolved.provenance[field]?.scopes.join('+') ?? 'default';
  const values: Array<[string, unknown, string]> = [
    ['defaultProvider', resolved.settings.defaultProvider ?? 'automatic', 'defaultProvider'],
    ['defaultModel', resolved.settings.defaultModel ?? 'automatic', 'defaultModel'],
    ['defaultThinkingLevel', resolved.settings.defaultThinkingLevel ?? 'medium', 'defaultThinkingLevel'],
    ['enabledModels', resolved.settings.enabledModels ?? 'all available', 'enabledModels'],
    ['defaultTools', resolveAgentDefaultTools(resolved.settings.defaultTools, DEFAULT_CODING_TOOL_NAMES)
      ?? DEFAULT_CODING_TOOL_NAMES, 'defaultTools'],
    ['steeringMode', resolved.settings.steeringMode ?? 'one-at-a-time', 'steeringMode'],
    ['followUpMode', resolved.settings.followUpMode ?? 'one-at-a-time', 'followUpMode'],
    ['defaultProjectTrust', resolved.settings.defaultProjectTrust ?? 'ask', 'defaultProjectTrust'],
    ['sessionDir', resolved.settings.sessionDir ?? 'agent default', 'sessionDir'],
    ['compaction.enabled', resolved.settings.compaction?.enabled ?? true, 'compaction.enabled'],
    ['compaction.reserveTokens', resolved.settings.compaction?.reserveTokens ?? 16_384, 'compaction.reserveTokens'],
    ['compaction.keepRecentTokens', resolved.settings.compaction?.keepRecentTokens ?? 20_000, 'compaction.keepRecentTokens'],
    ['retry.enabled', resolved.settings.retry?.enabled ?? true, 'retry.enabled'],
    ['retry.maxRetries', resolved.settings.retry?.maxRetries ?? 3, 'retry.maxRetries'],
    ['theme', resolved.settings.theme ?? 'system', 'theme'],
    ['tuiMode', resolved.settings.tuiMode ?? 'fullscreen', 'tuiMode'],
  ];
  return [
    `Agent settings: ${resolved.paths.global}`,
    `Project settings: ${resolved.paths.project} (${resolved.projectTrusted ? 'trusted' : 'blocked'})`,
    ...values.map(([name, value, field]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)} [${source(field)}]`),
  ].join('\n');
}

async function chooseStartupSession(sessions: Session[]): Promise<Session | undefined> {
  if (sessions.length === 0) return undefined;
  process.stdout.write('Stored sessions:\n');
  sessions.forEach((session, index) => {
    process.stdout.write(`${outputCredentialRedactor.redact(
      `  ${index + 1}. ${session.title || 'Untitled'} (${session.id})${session.cwd ? ` — ${session.cwd}` : ''}`,
    )}\n`);
  });
  const selector = await new Promise<string>(resolve => {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    prompt.question('Select a session number or ID (empty to cancel): ', answer => {
      prompt.close();
      resolve(answer.trim());
    });
  });
  if (!selector) return undefined;
  const numeric = Number(selector);
  if (Number.isSafeInteger(numeric) && numeric > 0 && numeric <= sessions.length) return sessions[numeric - 1];
  const selected = sessions.find(session => session.id === selector)
    ?? sessions.find(session => session.id.startsWith(selector));
  if (!selected) throw new Error(`No session found matching: ${selector}`);
  return selected;
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments[0] === 'mcp') {
    process.exitCode = await runMcpCommand(rawArguments.slice(1));
    return;
  }
  const packageCommand = rawArguments[0] === 'package' || rawArguments[0] === 'packages';
  const directPackageCommand = ['install', 'remove', 'uninstall', 'update', 'list', 'config'].includes(rawArguments[0] ?? '');
  if (packageCommand || directPackageCommand) {
    const packageArguments = packageCommand ? rawArguments.slice(1) : rawArguments;
    process.exitCode = await runPackageCommand(packageArguments);
    return;
  }
  let cliArguments: ReturnType<typeof parseCliArguments>;
  try {
    cliArguments = parseCliArguments(rawArguments);
  } catch (error) {
    const message = error instanceof CliArgumentError ? error.message : String(error);
    process.stderr.write(`Error: ${outputCredentialRedactor.redact(message)}\n`);
    process.exitCode = 2;
    return;
  }
  outputCredentialRedactor.add(cliArguments.apiKey);
  if (cliArguments.help) {
    process.stdout.write(formatCliHelp());
    return;
  }
  if (cliArguments.version) {
    process.stdout.write(`${cliVersion()}\n`);
    return;
  }
  if (cliArguments.listModels) {
    try {
      const cwd = process.cwd();
      const trustManager = new ProjectTrustManager(
        path.join(resolvePreTrustAgentDirectory(cwd), 'trust.json'),
      );
      await trustManager.load();
      const bootstrapSettings = await loadAgentSettings({ cwd, projectTrusted: false });
      const trust = await resolveProjectTrust({
        cwd,
        trustManager,
        override: cliArguments.projectTrust,
        defaultProjectTrust: bootstrapSettings.settings.defaultProjectTrust,
        includeContextFiles: !cliArguments.noContextFiles,
      });
      const resolvedSettings = await loadAgentSettings({ cwd, projectTrusted: trust.resourceTrusted });
      reportAgentSettingsDiagnostics(resolvedSettings);
      const providerRuntime = await createCliProviderRuntime(
        resolvedSettings.agentDir,
        resolvedSettings.settings,
        process.env,
        undefined,
        resolvedSettings.agentDirTrusted,
        [],
        outputCredentialRedactor,
      );
      const providers = createConfiguredProviders(process.env, {
        credentials: providerRuntime.values,
        network: providerRuntime.network,
      });
      const search = typeof cliArguments.listModels === 'string' ? cliArguments.listModels : undefined;
      process.stdout.write(`${outputCredentialRedactor.redact(await formatConfiguredModelList(providers, search))}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Error: ${outputCredentialRedactor.redact(message)}\n`);
      process.exitCode = 1;
    } finally {
      await cleanupCliEarlyExit({ closeNetwork: closeProviderNetworkDispatchers });
    }
    return;
  }

  const applicationMode = resolveCliApplicationMode(cliArguments, {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });
  if (applicationMode === 'rpc') {
    try {
      await runRpcMode({
      noSession: cliArguments.noSession,
      sessionDir: cliArguments.sessionDir,
      provider: cliArguments.provider,
      model: cliArguments.model,
      models: cliArguments.models,
      apiKey: cliArguments.apiKey,
      thinking: coreThinkingLevel(cliArguments.thinking),
      systemPrompt: cliArguments.systemPrompt,
      appendSystemPrompts: cliArguments.appendSystemPrompts,
      noContextFiles: cliArguments.noContextFiles,
      continueSession: cliArguments.continueSession,
      session: cliArguments.session,
      sessionId: cliArguments.sessionId,
      fork: cliArguments.fork,
      name: cliArguments.name,
      extensions: cliArguments.extensions,
      skills: cliArguments.skills,
      promptTemplates: cliArguments.promptTemplates,
      noSkills: cliArguments.noSkills,
      noPromptTemplates: cliArguments.noPromptTemplates,
      tools: cliArguments.tools,
      excludeTools: cliArguments.excludeTools,
      noBuiltinTools: cliArguments.noBuiltinTools,
      noTools: cliArguments.noTools,
      projectTrust: cliArguments.projectTrust,
        credentialRedactor: outputCredentialRedactor,
      });
    } finally {
      await cleanupCliEarlyExit({ closeNetwork: closeProviderNetworkDispatchers });
    }
    return;
  }
  const redactOutput = (value: string): string => outputCredentialRedactor.redact(value);
  const jsonOutput = applicationMode === 'json' ? reserveProcessStdoutForJson(
    record => outputCredentialRedactor.redactJson(record),
    redactOutput,
    () => outputCredentialRedactor.createStream(),
  ) : undefined;
  const printMode = applicationMode === 'print' || applicationMode === 'json';
  let pipedInput: string | undefined;
  if (printMode && process.stdin.isTTY !== true) {
    try { pipedInput = await readPipedStdin(); }
    catch (error) {
      process.stderr.write(`Error: ${redactOutput(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
      jsonOutput?.restore();
      return;
    }
  }

  const workspaceManager = new WorkspaceManager({
    allowedRoots: [process.cwd()],
    defaultCwd: process.cwd(),
  });
  await workspaceManager.initialize();
  const workspaceCwd = await workspaceManager.getDefaultCwd();
  const trustManager = new ProjectTrustManager(
    path.join(resolvePreTrustAgentDirectory(workspaceCwd), 'trust.json'),
  );
  await trustManager.load();
  let projectTrusted = false;
  let projectResourcesTrusted = false;
  let sessionProjectTrust: boolean | undefined;
  const resolveSettingsForTrust = async (allowPrompt = false): Promise<ResolvedAgentSettings> => {
    const bootstrapSettings = await loadAgentSettings({ cwd: workspaceCwd, projectTrusted: false });
    const trust = await resolveProjectTrust({
      cwd: workspaceCwd,
      trustManager,
      override: cliArguments.projectTrust ?? sessionProjectTrust,
      defaultProjectTrust: bootstrapSettings.settings.defaultProjectTrust,
      includeContextFiles: !cliArguments.noContextFiles,
      ...(allowPrompt && applicationMode === 'interactive' ? { prompt: promptForProjectTrust } : {}),
    });
    if (allowPrompt && trust.source === 'prompt' && trust.decision === null) {
      sessionProjectTrust = trust.trusted;
    }
    projectTrusted = trust.trusted;
    projectResourcesTrusted = trust.resourceTrusted;
    const resolved = await loadAgentSettings({ cwd: workspaceCwd, projectTrusted: projectResourcesTrusted });
    reportAgentSettingsDiagnostics(resolved);
    return resolved;
  };
  let settingsResolution = await resolveSettingsForTrust(true);
  let providerRuntime: Awaited<ReturnType<typeof createCliProviderRuntime>>;
  const reloadAgentSettings = async (): Promise<void> => {
    settingsResolution = await resolveSettingsForTrust();
  };
  const currentProjectTrust = (fallback: boolean): boolean => {
    if (cliArguments.projectTrust !== undefined) return cliArguments.projectTrust;
    if (sessionProjectTrust !== undefined) return sessionProjectTrust;
    return trustManager.getDecisionSync(workspaceCwd)?.decision ?? fallback;
  };
  const isProjectTrusted = (): boolean => currentProjectTrust(projectTrusted);
  const mayLoadProjectResources = (): boolean => currentProjectTrust(projectResourcesTrusted);
  const sessionDirectory = resolveStartupSessionDirectory(
    cliArguments,
    workspaceCwd,
    process.env,
    undefined,
    settingsResolution.settings.sessionDir,
  );
  const store = new JsonlSessionStore(sessionDirectory, !cliArguments.noSession);
  const sessionManager = new SessionManager({
    redactText: value => outputCredentialRedactor.redact(value),
    redactJson: value => outputCredentialRedactor.redactJson(value),
  });
  sessionManager.setCompactionSettings(resolveAgentCompactionSettings(settingsResolution.settings));
  if (!cliArguments.noSession) {
    sessionManager.setStore(store);
    await sessionManager.loadAllSessions();
  }

  const workspaceDescriptor = await workspaceManager.describe(
    workspaceCwd,
    isProjectTrusted(),
  );
  let pluginServiceAgentDir = settingsResolution.agentDir;
  let pluginService = new PluginService(
    workspaceManager,
    trustManager,
    path.join(pluginServiceAgentDir, 'plugins.json'),
    pluginServiceAgentDir,
  );
  const refreshPluginService = async (): Promise<void> => {
    if (pluginServiceAgentDir !== settingsResolution.agentDir) {
      pluginServiceAgentDir = settingsResolution.agentDir;
      pluginService = new PluginService(
        workspaceManager,
        trustManager,
        path.join(pluginServiceAgentDir, 'plugins.json'),
        pluginServiceAgentDir,
      );
    }
    if (settingsResolution.agentDirTrusted) await pluginService.load();
  };
  await refreshPluginService();
  type PackagePaths = Record<PluginResourceKind, { global: string[]; project: string[] }>;
  const emptyPackagePaths = (): PackagePaths => ({
    extension: { global: [], project: [] },
    skill: { global: [], project: [] },
    prompt: { global: [], project: [] },
    theme: { global: [], project: [] },
  });
  const loadPackagePaths = async (): Promise<PackagePaths> => {
    const result = emptyPackagePaths();
    if (!settingsResolution.agentDirTrusted) return result;
    try {
      await Promise.all((['extension', 'skill', 'prompt', 'theme'] as PluginResourceKind[]).map(async kind => {
        const locations = await pluginService.getEnabledResourceLocations(kind, {
          cwd: workspaceCwd,
          projectId: workspaceDescriptor.id,
          projectTrusted: mayLoadProjectResources(),
        });
        for (const location of locations) result[kind][location.scope].push(location.path);
      }));
    } catch (error) {
      process.stderr.write(`${outputCredentialRedactor.redact(
        `Warning: Package resources ignored: ${error instanceof Error ? error.message : String(error)}`,
      )}\n`);
    }
    return result;
  };
  let packagePaths = await loadPackagePaths();

  let activeThemeSelection = cliArguments.theme ?? settingsResolution.settings.theme ?? 'auto';
  let themeSelectedInteractively = false;
  const packageThemeSources = () => [
    ...packagePaths.theme.global.map(themePath => ({
      path: themePath, scope: 'user' as const, source: 'package' as const, trusted: true,
    })),
    ...packagePaths.theme.project.map(themePath => ({
      path: themePath, scope: 'project' as const, source: 'package' as const,
      trusted: mayLoadProjectResources(),
    })),
  ];
  let theme = await ThemeManager.load(
    activeThemeSelection,
    packageThemeSources(),
    process.env,
    { cwd: workspaceCwd, projectTrusted: mayLoadProjectResources() },
  ).catch(error => {
    console.error(outputCredentialRedactor.redact(
      `Thème ignoré : ${error instanceof Error ? error.message : String(error)}`,
    ));
    activeThemeSelection = 'dark';
    return ThemeManager.load('dark');
  });
  const fullscreenSupported = !printMode && FullscreenUI.isSupported();
  const terminalMode = resolveTerminalMode(
    rawArguments,
    process.env,
    fullscreenSupported,
    settingsResolution.settings.tuiMode,
  );
  const terminalOptions = {
    title: 'AiHarness CLI',
    theme,
    redactText: (value: string) => outputCredentialRedactor.redact(value),
    createTextRedactor: () => outputCredentialRedactor.createStream(),
  };
  const fullscreenTerminal = !printMode && terminalMode === 'fullscreen'
    ? new FullscreenUI(terminalOptions)
    : null;
  const terminal: TerminalUI = fullscreenTerminal ?? new TerminalUI(terminalOptions);
  let streamWriter: ReturnType<TerminalUI['startStreaming']> | null = null;
  let isStreaming = false;
  let isMultiLineMode = false;
  let shuttingDown = false;
  let conversationRunning = false;
  let foregroundInputRunning = false;
  let activeAbortController: AbortController | null = null;
  let systemThemeProbe: SystemThemeProbe | undefined;
  let filteredTerminalInput: ThemeFilteredInput | undefined;
  const activateSystemThemeProbe = async (): Promise<void> => {
    systemThemeProbe?.close();
    systemThemeProbe = undefined;
    if (printMode || activeThemeSelection !== 'system') return;
    const probe = startSystemThemeProbe({
      input: process.stdin,
      output: process.stdout,
      environment: process.env,
      onTheme: detected => {
        if (systemThemeProbe !== probe || activeThemeSelection !== 'system' || shuttingDown) return;
        theme = detected;
        terminal.setTheme(detected);
      },
    });
    systemThemeProbe = probe;
    const detected = await probe.initial;
    if (systemThemeProbe === probe && activeThemeSelection === 'system') {
      theme = detected;
      terminal.setTheme(detected);
    }
  };
  const interactiveQueue = new AgentMessageQueue<InteractiveQueuedInput>({
    steeringMode: settingsResolution.settings.steeringMode,
    followUpMode: settingsResolution.settings.followUpMode,
  });
  let inputDriver: InputDriver = {
    prompt: () => undefined,
    close: () => undefined,
    setPrompt: () => undefined,
    getValue: () => '',
    replaceValue: () => undefined,
  };
  const reportError = (message: string): void => {
    const safeMessage = redactOutput(message);
    if (printMode) process.stderr.write(`Error: ${safeMessage}\n`);
    else terminal.showError(safeMessage);
  };
  const reportOutput = (message: string): void => {
    if (!printMode) terminal.writeOutput(redactOutput(message));
  };

  const createResourceManager = (): ResourceManager => new ResourceManager({
    cwd: workspaceCwd,
    agentDir: settingsResolution.agentDir,
    agentDirTrusted: settingsResolution.agentDirTrusted,
    projectTrusted: settingsResolution.projectTrusted,
    strictSkills: true,
    globalSkillPaths: resolveAgentResourcePaths(settingsResolution, 'skills', undefined, 'global'),
    projectSkillPaths: resolveAgentResourcePaths(settingsResolution, 'skills', undefined, 'project'),
    globalPromptPaths: resolveAgentResourcePaths(settingsResolution, 'prompts', undefined, 'global'),
    projectPromptPaths: resolveAgentResourcePaths(settingsResolution, 'prompts', undefined, 'project'),
    globalPackageSkillPaths: packagePaths.skill.global,
    projectPackageSkillPaths: packagePaths.skill.project,
    globalPackagePromptPaths: packagePaths.prompt.global,
    projectPackagePromptPaths: packagePaths.prompt.project,
    skillPaths: cliArguments.skills,
    promptPaths: cliArguments.promptTemplates,
    disableSkills: cliArguments.noSkills,
    disablePrompts: cliArguments.noPromptTemplates,
  });
  let resourceManager = createResourceManager();
  const resourceLoadResult = await resourceManager.loadAll();
  for (const error of resourceLoadResult.errors) reportError(`Ressource : ${error.message}`);

  const extensionRegistry = new ExtensionRegistry();
  extensionRegistry.attachSessionManager(sessionManager);
  const mcpOAuth = process.env.AI_HARNESS_MASTER_KEY && settingsResolution.agentDirTrusted
    ? new McpOAuthCredentialManager(
      new EncryptedCredentialStore(
        path.join(settingsResolution.agentDir, 'credentials.enc'),
        process.env.AI_HARNESS_MASTER_KEY,
      ),
      outputCredentialRedactor,
    )
    : undefined;
  const mcpHost = new McpSessionHost({
    agentDir: settingsResolution.agentDir,
    trustManager,
    resolveWorkingDirectory: (configured, base) => workspaceManager.resolve(configured, {
      base,
      kind: 'directory',
    }),
    ...(mcpOAuth ? {
      oauthProviderFactory: createMcpOAuthProviderFactory({
        manager: mcpOAuth,
        resolveTarget: target => readMcpServerTestTarget({
          agentDir: settingsResolution.agentDir,
          scope: target.scope,
          name: target.name,
          cwd: target.cwd,
          defaultCwd: target.cwd,
          trustManager,
          resolveWorkingDirectory: (configured, base) => workspaceManager.resolve(configured, {
            base,
            kind: 'directory',
          }),
        }),
      }),
    } : {}),
  });
  let earlyCleanupPromise: Promise<void> | undefined;
  const cleanupEarlyExit = (
    additional: readonly (() => void | Promise<void>)[] = [],
  ): Promise<void> => {
    if (earlyCleanupPromise) return earlyCleanupPromise;
    const filteredInput = filteredTerminalInput;
    filteredTerminalInput = undefined;
    const themeProbe = systemThemeProbe;
    systemThemeProbe = undefined;
    earlyCleanupPromise = cleanupCliEarlyExit({
      input: inputDriver,
      filteredInput,
      themeProbe,
      extensions: extensionRegistry,
      jsonOutput,
      closeNetwork: closeProviderNetworkDispatchers,
      additional: [() => mcpHost.shutdown(), ...additional],
    });
    return earlyCleanupPromise;
  };
  await registerWorkspaceTools(extensionRegistry, workspaceManager, {
    shellPath: () => settingsResolution.settings.shellPath,
    shellCommandPrefix: () => settingsResolution.settings.shellCommandPrefix,
  });
  let instructionSystemPrompt = '';
  const reloadInstructionPrompt = async (): Promise<void> => {
    const resolved = await resolveInstructionPrompt({
      cwd: workspaceCwd,
      agentDir: settingsResolution.agentDir,
      agentDirTrusted: settingsResolution.agentDirTrusted,
      projectTrusted: mayLoadProjectResources(),
      noContextFiles: cliArguments.noContextFiles,
      systemPromptInput: cliArguments.systemPrompt,
      appendSystemPromptInputs: cliArguments.appendSystemPrompts,
    });
    instructionSystemPrompt = resolved.systemPrompt;
    for (const diagnostic of resolved.diagnostics) {
      const message = redactOutput(`Instruction ignorée (${diagnostic.path}) : ${diagnostic.message}`);
      if (printMode) process.stderr.write(`Warning: ${message}\n`);
      else terminal.writeOutput(`Avertissement : ${message}`);
    }
  };
  try {
    await reloadInstructionPrompt();
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    await cleanupEarlyExit();
    return;
  }
  const extensionLoader = new ExtensionLoader(extensionRegistry, {
    paths: async () => [
      ...configuredExtensionPaths(cliArguments.extensions, settingsResolution),
      ...(settingsResolution.agentDirTrusted ? await pluginService.getEnabledExtensionFiles({
        cwd: workspaceCwd,
        projectId: workspaceDescriptor.id,
        projectTrusted: mayLoadProjectResources(),
      }).catch(error => {
        process.stderr.write(`${outputCredentialRedactor.redact(
          `Warning: Package extensions ignored: ${error instanceof Error ? error.message : String(error)}`,
        )}\n`);
        return [];
      }) : []),
    ],
    isProjectTrusted: mayLoadProjectResources,
  });
  const registerSkillTool = async (): Promise<void> => {
    await extensionRegistry.unload('builtin:skills');
    const skills = resourceManager.getModelInvocableSkills();
    if (skills.length === 0) return;
    await extensionRegistry.load('builtin:skills', api => {
      api.registerTool({
        name: 'load_skill',
        description: `Charger les instructions d'un skill disponible : ${skills.map(skill => skill.name).join(', ')}`,
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', enum: skills.map(skill => skill.name) } },
          required: ['name'],
          additionalProperties: false,
        },
        execute: input => {
          const name = String((input as { name?: unknown }).name ?? '');
          const skill = skills.find(candidate => candidate.name === name);
          if (!skill) return { content: `Skill indisponible pour le modèle : ${name}`, isError: true };
          return { content: skill.instructions, details: { name: skill.name, filePath: skill.filePath } };
        },
      });
    });
  };

  extensionRegistry.setReloadHandler(async () => {
    await reloadAgentSettings();
    await refreshPluginService();
    const refreshedStoreId = `${settingsResolution.agentDirTrusted ? 'persistent' : 'memory'}:${path.resolve(settingsResolution.agentDir)}`;
    const refreshedRuntime = await createCliProviderRuntime(
      settingsResolution.agentDir,
      settingsResolution.settings,
      process.env,
      providerRuntime.credentialStoreId === refreshedStoreId ? providerRuntime.credentials : undefined,
      settingsResolution.agentDirTrusted,
      extensionRegistry.getProviderDefinitions().map(item => item.type),
      outputCredentialRedactor,
    );
    const refreshedProviders = createConfiguredProviders(process.env, {
      credentials: refreshedRuntime.values,
      network: refreshedRuntime.network,
    });
    const commandContext = commandHandler.getContext();
    for (const name of [...configuredProviders.keys()]) {
      if (!commandContext.extensionProviderNames.has(name)) configuredProviders.delete(name);
    }
    for (const [name, provider] of refreshedProviders) configuredProviders.set(name, provider);
    providerRuntime = refreshedRuntime;
    commandContext.credentialService = refreshedRuntime.credentials;
    commandContext.providerCredentialValues = refreshedRuntime.values;
    commandContext.providerNetwork = refreshedRuntime.network;
    const refreshedModelSettings = applyAgentModelSettings({
      provider: cliArguments.provider,
      model: cliArguments.model,
      models: cliArguments.models,
      apiKey: cliArguments.apiKey,
    }, settingsResolution.settings);
    const refreshedStartup = await resolveStartupProvider(configuredProviders, refreshedModelSettings.selection);
    commandContext.provider = refreshedStartup.provider;
    commandContext.modelPatterns = refreshedModelSettings.modelPatterns;
    const refreshedModel = refreshedStartup.model ?? refreshedStartup.provider.getConfiguredModel();
    commandContext.thinkingLevel = clampPublishedThinkingLevel(
      coreThinkingLevel(cliArguments.thinking)
        ?? refreshedStartup.thinkingLevel
        ?? resolveAgentThinkingLevel(settingsResolution.settings, refreshedStartup.providerName, refreshedModel)
        ?? commandContext.thinkingLevel,
      getSupportedThinkingLevels(refreshedStartup.providerName, refreshedModel),
    );
    sessionManager.setCompactionSettings(resolveAgentCompactionSettings(
      settingsResolution.settings,
      refreshedStartup.providerName,
      refreshedModel,
    ));
    interactiveQueue.setMode('steer', settingsResolution.settings.steeringMode ?? 'one-at-a-time');
    interactiveQueue.setMode('follow-up', settingsResolution.settings.followUpMode ?? 'one-at-a-time');
    await reloadInstructionPrompt();
    packagePaths = await loadPackagePaths();
    if (!themeSelectedInteractively) {
      activeThemeSelection = cliArguments.theme ?? settingsResolution.settings.theme ?? 'auto';
    }
    try {
      theme = await ThemeManager.load(
        activeThemeSelection,
        packageThemeSources(),
        process.env,
        { cwd: workspaceCwd, projectTrusted: mayLoadProjectResources() },
      );
      terminal.setTheme(theme);
      await activateSystemThemeProbe();
    } catch (error) {
      reportError(`Thème ignoré : ${error instanceof Error ? error.message : String(error)}`);
    }
    resourceManager = createResourceManager();
    const resources = await resourceManager.loadAll();
    for (const error of resources.errors) reportError(`Ressource : ${error.message}`);
    const result = await extensionLoader.reload();
    for (const failure of result.errors) {
      reportError(`Extension ${failure.path}: ${failure.error.message}`);
    }
    await registerSkillTool();
  });
  const extensionLoadResult = await extensionLoader.loadAll();
  for (const failure of extensionLoadResult.errors) {
    reportError(`Extension ${failure.path}: ${failure.error.message}`);
  }
  await registerSkillTool();

  const toolSelectionOptions = () => {
    const configuredDefaults = resolveAgentDefaultTools(
      settingsResolution.settings.defaultTools,
      DEFAULT_CODING_TOOL_NAMES,
    );
    return {
      allowedTools: cliArguments.tools,
      excludedTools: cliArguments.excludeTools,
      defaultTools: configuredDefaults ?? DEFAULT_CODING_TOOL_NAMES,
      builtInExtensionId: 'builtin:workspace-tools',
      includeNonBuiltInByDefault: true,
      noBuiltInTools: cliArguments.noBuiltinTools,
      noTools: cliArguments.noTools,
    };
  };
  const selectedTools = () => {
    const registered = extensionRegistry.getTools();
    const unknown = unknownToolNames(registered, cliArguments.tools, cliArguments.excludeTools)
      .filter(name => !name.startsWith('mcp__') && name !== TOOL_SEARCH_TOOL_NAME && name !== CODEMODE_TOOL_NAME);
    if (unknown.length) throw new Error(`Unknown tool name(s): ${unknown.join(', ')}.`);
    return selectRegisteredTools(registered, toolSelectionOptions());
  };
  try { selectedTools(); }
  catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    await cleanupEarlyExit();
    return;
  }

  const effectiveModelSettings = applyAgentModelSettings({
    provider: cliArguments.provider,
    model: cliArguments.model,
    models: cliArguments.models,
    apiKey: cliArguments.apiKey,
  }, settingsResolution.settings);
  try {
    providerRuntime = await createCliProviderRuntime(
      settingsResolution.agentDir,
      settingsResolution.settings,
      process.env,
      undefined,
      settingsResolution.agentDirTrusted,
      extensionRegistry.getProviderDefinitions().map(item => item.type),
      outputCredentialRedactor,
    );
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    await cleanupEarlyExit();
    return;
  }
  // Credentials loaded from the encrypted store may only become known here; scrub legacy rows now.
  if (!cliArguments.noSession) await sessionManager.loadAllSessions();
  const configuredProviders: Map<string, AiProvider> = createConfiguredProviders(process.env, {
    credentials: providerRuntime.values,
    network: providerRuntime.network,
  });

  const commandHandler = new CommandHandler(
    sessionManager,
    store,
    terminal,
    extensionRegistry,
    trustManager,
    {
      cwd: workspaceCwd,
      workspaceManager,
      workspaceId: workspaceDescriptor.id,
      isProjectTrusted,
      enabledToolNames: () => selectedTools().map(tool => tool.name),
      modelPatterns: effectiveModelSettings.modelPatterns,
      settingsInfo: () => formatAgentSettingsSummary(settingsResolution),
      providers: configuredProviders,
      credentialService: providerRuntime.credentials,
      providerCredentialValues: providerRuntime.values,
      allowCredentialReveal: applicationMode === 'interactive'
        && process.stdin.isTTY === true && process.stdout.isTTY === true,
      providerNetwork: providerRuntime.network,
      mcpControl: {
        overview: async () => mcpHost.decorateInventory(await inspectMcpConfig({
          agentDir: settingsResolution.agentDir,
          cwd: workspaceCwd,
          trustManager,
        })),
        prepare: (sessionId, preset) => mcpHost.prepareForPrompt({
          sessionId,
          cwd: workspaceCwd,
          preset,
        }),
        finish: sessionId => mcpHost.finishPrompt(sessionId),
        reconnect: sessionId => mcpHost.reconnect(sessionId),
      },
      redactText: redactOutput,
      redactJson: value => outputCredentialRedactor.redactJson(value),
      themeControl: {
        current: () => theme.name,
        list: () => ThemeManager.inventory(
          packageThemeSources(),
          theme.name,
          { cwd: workspaceCwd, projectTrusted: mayLoadProjectResources() },
        ),
        select: async selection => {
          const selected = await ThemeManager.load(
            selection,
            packageThemeSources(),
            process.env,
            { cwd: workspaceCwd, projectTrusted: mayLoadProjectResources() },
          );
          activeThemeSelection = selection;
          themeSelectedInteractively = true;
          theme = selected;
          terminal.setTheme(selected);
          await activateSystemThemeProbe();
          return theme.name;
        },
      },
    },
  );
  let ctx = commandHandler.getContext();
  try {
    const startup = await resolveStartupProvider(ctx.providers, effectiveModelSettings.selection);
    ctx.provider = startup.provider;
    const startupModel = startup.model ?? startup.provider.getConfiguredModel();
    const requestedThinking = coreThinkingLevel(cliArguments.thinking)
      ?? startup.thinkingLevel
      ?? resolveAgentThinkingLevel(settingsResolution.settings, startup.providerName, startupModel)
      ?? ctx.thinkingLevel;
    ctx.thinkingLevel = clampPublishedThinkingLevel(
      requestedThinking,
      getSupportedThinkingLevels(startup.providerName, startupModel),
    );
    sessionManager.setCompactionSettings(resolveAgentCompactionSettings(
      settingsResolution.settings,
      startup.providerName,
      startupModel,
    ));
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    await cleanupEarlyExit();
    return;
  }

  let loadedPromptFiles: Awaited<ReturnType<typeof loadPromptFiles>>;
  try {
    loadedPromptFiles = await loadPromptFiles(
      workspaceManager,
      workspaceCwd,
      cliArguments.fileArgs,
    );
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await cleanupEarlyExit();
    return;
  }
  const remainingInitialMessages = [...cliArguments.messages];
  const firstMessageParts = [pipedInput, loadedPromptFiles.text, remainingInitialMessages.shift()]
    .filter((part): part is string => Boolean(part));
  const initialPrompts: Array<{ content: string; images?: MessageContentBlock[] }> = [];
  if (firstMessageParts.length) {
    initialPrompts.push({
      content: firstMessageParts.join(''),
      ...(loadedPromptFiles.images.length ? { images: loadedPromptFiles.images } : {}),
    });
  }
  initialPrompts.push(...remainingInitialMessages.map(content => ({ content })));
  if (printMode && initialPrompts.length === 0) {
    reportError('Print and JSON modes require a prompt, @file, or piped input.');
    process.exitCode = 2;
    await cleanupEarlyExit();
    return;
  }

  const keyBindings = new KeyBindingManager(redactOutput);
  if (!printMode) {
    const helpAction = {
      description: 'Afficher l’aide',
      handler: async () => {
        terminal.displayUserMessage('/help');
        terminal.showHelp();
      },
    };
    keyBindings.registerAction('app.help', helpAction);
    keyBindings.registerAction('terminal.clear', {
      description: 'Rafraîchir le terminal',
      handler: async () => terminal.clear(),
    });
    keyBindings.registerHandler({ keys: ['ctrl+slash'], ...helpAction });
    if (process.env.AI_HARNESS_KEYBINDINGS) {
      await keyBindings.loadFromFile(process.env.AI_HARNESS_KEYBINDINGS);
    }
  }

  let startupSession: Session;
  try {
    startupSession = await resolveStartupSession({
      sessionManager,
      args: cliArguments,
      cwd: workspaceCwd,
      workspaceId: workspaceDescriptor.id,
      interactive: applicationMode === 'interactive',
      chooseSession: chooseStartupSession,
    });
  } catch (error) {
    if (!(error instanceof StartupSessionSelectionCancelledError)) {
      reportError(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
    await cleanupEarlyExit();
    return;
  }
  let currentSessionId = startupSession.id;

  sessionManager.setAutoCompactionCallback(async (_sessionId, toCompact, _keptEntries, signal) => {
    const provider = ctx.provider;
    if (!provider?.validateConfig()) throw new Error('No configured provider for automatic compaction.');
    const response = await provider.chat(messagesFromSessionEntries(toCompact), {
      thinking: ctx.thinkingLevel,
      systemPrompt: 'Summarize this conversation while preserving decisions and unresolved tasks.',
      signal,
    });
    if (!response.content.trim()) throw new Error('Automatic compaction produced an empty summary.');
    return {
      summary: response.content,
      provider: provider.getProviderType(),
      model: response.model ?? provider.getConfiguredModel(),
      usage: normalizeProviderUsage(response.usage),
    };
  });
  sessionManager.on('compaction:start', async event => {
    if (event.automatic) await jsonOutput?.events.compactionStart('threshold');
  });
  sessionManager.on('compaction:end', async event => {
    if (!event.automatic) return;
    const compacted = sessionManager.get(event.sessionId);
    await jsonOutput?.events.compactionEnd('threshold', {
      result: {
        summary: typeof compacted?.metadata?.compactionSummary === 'string'
          ? compacted.metadata.compactionSummary : '',
        firstKeptEntryId: compacted?.messages[0]?.id,
        tokensBefore: event.tokensBefore,
        estimatedTokensAfter: event.tokensAfter,
        ...(() => {
          const stats = compacted?.metadata?.compactionStats as {
            provider?: string;
            model?: string;
            usage?: NonNullable<Session['usage']>;
          } | undefined;
          return stats?.usage ? {
            usage: toJsonProtocolUsage(stats.usage, stats.provider, stats.model),
          } : {};
        })(),
        details: {},
      },
    });
  });
  sessionManager.on('compaction:error', async event => {
    if (event.automatic) {
      await jsonOutput?.events.compactionEnd('threshold', { aborted: event.cancelled, error: event.error });
    }
  });

  ctx.currentSessionId = currentSessionId;
  const activeSession = sessionManager.get(currentSessionId);
  if (!activeSession) throw new Error('Aucune session active.');
  fullscreenTerminal?.setPanelProvider(() => extensionRegistry.getUIComponents().map(component => {
    try {
      return component.render({
        currentSessionId,
        provider: String((ctx.provider as unknown as { config?: { type?: string } } | undefined)?.config?.type ?? 'unknown'),
      });
    } catch (error) {
      return `[${component.name}] Erreur: ${error instanceof Error ? error.message : String(error)}`;
    }
  }));
  await extensionRegistry.emit('system:ready');

  // Seed the TUI viewport with the active persisted conversation and shell history.
  const startupHistory = [
    ...(sessionManager.get(currentSessionId)?.messages ?? []).map(message => ({
      type: message.role === 'user' || message.role === 'assistant' ? message.role : 'system' as const,
      content: redactOutput(message.content),
      timestamp: message.timestamp,
    })),
    ...(sessionManager.get(currentSessionId)?.commands ?? []).map(command => ({
      type: 'command' as const,
      content: redactOutput(`$ ${command.command}\n${command.output ?? ''}\n[${command.status}${command.exitCode === undefined ? '' : ` · exit ${command.exitCode}`}]`),
      timestamp: command.timestamp,
    })),
  ].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  for (const entry of startupHistory) {
    terminal.addTranscriptEntry({ type: entry.type, content: entry.content });
  }

  const shellController = new InteractiveShellController(sessionManager, terminal, {
    getSessionId: () => currentSessionId,
    getCwd: () => workspaceCwd,
    isTrusted: () => isProjectTrusted(),
    reportError,
    redactText: redactOutput,
  }, {
    shellPath: () => settingsResolution.settings.shellPath,
    commandPrefix: () => settingsResolution.settings.shellCommandPrefix,
    redactText: redactOutput,
    redactJson: value => outputCredentialRedactor.redactJson(value),
    createTextRedactor: () => outputCredentialRedactor.createStream(),
  });

  const sessionPrompt = (): string => {
    const title = sessionManager.get(currentSessionId)?.title;
    return title ? `${redactOutput(title)}: ` : '> ';
  };

  const refreshPrompt = (): void => {
    inputDriver.setPrompt(sessionPrompt());
    inputDriver.prompt();
  };

  const restoreQueuedInput = (
    currentInput = '',
    previouslyTaken: InteractiveQueuedInput[] = [],
  ): string | undefined => {
    const cleared = interactiveQueue.clear();
    const pending = [...previouslyTaken, ...cleared.ordered];
    if (pending.length === 0) return undefined;
    const restored = [...pending.map(item => item.content), currentInput]
      .filter(Boolean)
      .join(' ');
    reportOutput(`[Files restaurées dans l’éditeur : ${pending.length}]`);
    return restored;
  };

  const shutdown = (message: string, exitCode?: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    activeAbortController?.abort();
    shellController.abort();
    streamWriter?.cancel();
    terminal.exitMessage(message);
    void cleanupEarlyExit([() => shellController.close()]).finally(() => {
      if (exitCode !== undefined) process.exit(exitCode);
    });
  };

  const cancelActiveOperation = (): boolean => {
    if (shellController.abort()) {
      terminal.addTranscriptEntry({ type: 'system', content: '[Commande interrompue]' });
      return true;
    }

    if (activeAbortController) {
      const restored = restoreQueuedInput(inputDriver.getValue());
      if (restored !== undefined) inputDriver.replaceValue(restored);
      activeAbortController.abort();
      streamWriter?.cancel();
      isStreaming = false;
      streamWriter = null;
      keyBindings.setStreaming(false);
      terminal.addTranscriptEntry({ type: 'system', content: '[Interrompu]' });
      refreshPrompt();
      return true;
    }

    if (isMultiLineMode) {
      terminal.cancelMultiLineEditor();
      isMultiLineMode = false;
      refreshPrompt();
      return true;
    }

    return false;
  };

  const interrupt = (): void => {
    if (cancelActiveOperation()) return;
    shutdown('Au revoir ! 👋', terminalMode === 'fullscreen' ? 0 : undefined);
  };

  const escapeInterrupt = (): void => {
    cancelActiveOperation();
  };

  /** Process a command or conversation message. */
  async function processInput(
    input: string,
    options: { allowCommands?: boolean; imageBlocks?: MessageContentBlock[] } = {},
  ): Promise<string | undefined> {
    let trimmed = input.trim();
    const unprocessedQueuedInputs: InteractiveQueuedInput[] = [];
    if (!trimmed) {
      if (!printMode) inputDriver.prompt();
      return undefined;
    }

    if (options.allowCommands !== false && trimmed.startsWith('!')) {
      await shellController.handle(trimmed);
      refreshPrompt();
      return undefined;
    }

    if (options.allowCommands !== false && trimmed.startsWith('/')) {
      let resourceParts: string[];
      try { resourceParts = parseResourceCommandLine(trimmed.slice(1)); }
      catch (error) {
        reportError(error instanceof Error ? error.message : String(error));
        refreshPrompt();
        return undefined;
      }
      const [resourceCommand = '', ...resourceArgs] = resourceParts;
      if (resourceCommand === 'skills') {
        const skills = resourceManager.listSkills();
        reportOutput(skills.length
          ? skills.map(skill => `• ${skill.name} — ${skill.description}${skill.disableModelInvocation ? ' [explicite uniquement]' : ''} [${skill.provenance.scope}/${skill.provenance.source}]`).join('\n')
          : 'Aucun skill découvert.');
        refreshPrompt();
        return undefined;
      }
      if (resourceCommand === 'prompts') {
        const prompts = resourceManager.listPrompts();
        reportOutput(prompts.length
          ? prompts.map(prompt => `• /${prompt.name}${prompt.description ? ` — ${prompt.description}` : ''} [${prompt.provenance.scope}/${prompt.provenance.source}]`).join('\n')
          : 'Aucun prompt découvert.');
        refreshPrompt();
        return undefined;
      }
      if (resourceCommand === 'resources') {
        const inventory = resourceManager.listInventory();
        reportOutput(inventory.length
          ? inventory.map(item => `${item.active ? '●' : '○'} ${item.kind}:${item.name} [${item.provenance.scope}/${item.provenance.source}]`).join('\n')
          : 'Aucune ressource découverte.');
        refreshPrompt();
        return undefined;
      }
      if (resourceCommand.startsWith('skill:')) {
        if (settingsResolution.settings.enableSkillCommands === false) {
          reportError('Les commandes de skill sont désactivées par enableSkillCommands.');
          refreshPrompt();
          return undefined;
        }
        try {
          trimmed = resourceManager.invokeSkill(resourceCommand.slice('skill:'.length), resourceArgs.join(' '));
        } catch (error) {
          reportError(error instanceof Error ? error.message : String(error));
          refreshPrompt();
          return undefined;
        }
      } else {
        const prompt = resourceManager.getPrompt(resourceCommand);
        if (prompt && !commandHandler.hasCommand(resourceCommand)) {
          trimmed = resourceManager.expandPrompt(resourceCommand, resourceArgs);
        } else {
          if (trimmed === '/help') terminal.showHelp();
          else await commandHandler.execute(trimmed);

          ctx = commandHandler.getContext();
          currentSessionId = ctx.currentSessionId ?? currentSessionId;

          if (commandHandler.isExiting()) shutdown('Au revoir ! 👋');
          else refreshPrompt();
          return undefined;
        }
      }
    }

    const provider = ctx.provider;
    try {
      if (!provider) throw new Error('Aucun provider IA configuré. Utilisez /provider.');
      if (!provider.validateConfig()) {
        const name = (provider as unknown as { config?: { type?: string } }).config?.type ?? 'inconnu';
        throw new Error(`Le provider « ${name} » n’est pas configuré.`);
      }
      if (!sessionManager.get(currentSessionId)) {
        throw new Error('Aucune session active. Créez-en une avec /new.');
      }
      if (conversationRunning) throw new Error('Une réponse est déjà en cours.');

      conversationRunning = true;
      const operationController = new AbortController();
      activeAbortController = operationController;
      const providerName = String((provider as unknown as { config?: { type?: string } }).config?.type ?? 'unknown');
      const providerModel = (provider as unknown as { config?: { model?: string } }).config?.model;

      const persistUserInput = async (
        queued: InteractiveQueuedInput,
        queueKind?: AgentMessageQueueKind,
        announceJson = false,
      ): Promise<boolean> => {
        try {
          const agentHook = await extensionRegistry.runBefore('before:agent', {
            sessionId: currentSessionId,
            provider: redactOutput(providerName),
            input: redactOutput(queued.content),
          });
          if (agentHook.cancelled) {
            throw new Error(agentHook.reason ?? "Requête annulée par un hook d'extension.");
          }
          const safeHookData = outputCredentialRedactor.redactJson(agentHook.data);
          const userInput = safeHookData.input.trim();
          if (!userInput) throw new Error("Requête annulée : le hook d'extension a produit une entrée vide.");
          const userBlocks: MessageContentBlock[] = [
            { type: 'text', text: userInput },
            ...outputCredentialRedactor.redactJson(
              (queued.imageBlocks ?? []).filter(block => block.type !== 'text'),
            ),
          ];
          if (announceJson) await jsonOutput?.events.startAgent(userInput, userBlocks);
          await sessionManager.addMessage(currentSessionId, {
            role: 'user',
            content: userInput,
            blocks: userBlocks,
            ...(queueKind ? { metadata: { queueKind } } : {}),
          }, { signal: operationController.signal });
          if (!printMode) {
            terminal.addTranscriptEntry({ type: 'user', content: userInput });
            terminal.displayUserMessage(userInput);
          }
          return true;
        } catch (error) {
          if (!queueKind) throw error;
          reportError(error instanceof Error ? error.message : String(error));
          return false;
        }
      };

      const persistQueuedBatch = async (
        queueKind: AgentMessageQueueKind,
        batch: InteractiveQueuedInput[],
      ): Promise<boolean> => {
        let persisted = false;
        for (const queued of batch) {
          const accepted = await persistUserInput(queued, queueKind);
          if (!accepted) unprocessedQueuedInputs.push(queued);
          persisted = accepted || persisted;
        }
        return persisted;
      };

      await persistUserInput({ content: trimmed, imageBlocks: options.imageBlocks }, undefined, true);
      await extensionRegistry.emit('agent:start', { sessionId: currentSessionId, provider: providerName });

      let activeToolCall: ToolCall | undefined;
      let activeToolOutput = '';
      let activeToolRedactor = outputCredentialRedactor.createStream();
      let finalContent = '';
      let continueConversation = true;
      while (continueConversation) {
        const currentSession = sessionManager.get(currentSessionId);
        const suppressAllTools = cliArguments.tools?.length === 0
          || (cliArguments.noTools && cliArguments.tools === undefined);
        const mcpPrepared = currentSession?.toolPreset === 'chat-only' || suppressAllTools
          ? mcpHost.getPreparedTools(currentSessionId, 'chat-only')
          : await mcpHost.prepareForPrompt({
              sessionId: currentSessionId,
              cwd: workspaceCwd,
              preset: currentSession?.toolPreset,
              signal: operationController.signal,
            });
        const toolLoadout = createAgentToolLoadout({
          staticTools: extensionRegistry.getTools(),
          currentStaticTools: () => extensionRegistry.getTools(),
          codemode: settingsResolution.settings.codemode,
          redactText: value => outputCredentialRedactor.redact(value),
          dynamicSource: {
            directTools: mcpPrepared.tools,
            hasPotentialSearchableTools: mcpPrepared.hasPotentialDiscoverableTools ?? false,
            currentSearchableTools: () => mcpPrepared.currentDiscoverableTools?.()
              ?? mcpPrepared.discoverableTools ?? [],
            waitForSearchableTools: signal => mcpPrepared.waitForDiscoverableTools?.(signal)
              ?? Promise.resolve(mcpPrepared.discoverableTools ?? []),
            has: name => mcpPrepared.has(name),
          },
          selection: {
            ...toolSelectionOptions(),
            preset: currentSession?.toolPreset,
          },
          initialLoadedTools: collectToolSearchLoadedNames(
            await sessionManager.getRawEntries(currentSessionId),
            currentSession?.activeLeafId,
          ),
        });
        const executeSelectedTool = (name: string, input: unknown, context: Parameters<typeof extensionRegistry.executeTool>[2], signal?: AbortSignal): ReturnType<typeof extensionRegistry.executeTool> => {
          if (toolLoadout.isCodemode(name)) {
            return extensionRegistry.executeHostedTool(name, input, context,
              (hostInput, hostContext, hostSignal) => toolLoadout.executeCodemode(hostInput, hostContext, executeSelectedTool, hostSignal), signal);
          }
          if (toolLoadout.isToolSearch(name)) {
            return extensionRegistry.executeHostedTool(
              name,
              input,
              context,
              (hostInput, hostContext, hostSignal) => toolLoadout.executeToolSearch(
                hostInput, hostContext, hostSignal,
              ),
              signal,
            );
          }
          if (toolLoadout.isDynamicTool(name)) {
            return extensionRegistry.executeHostedTool(
              name,
              input,
              context,
              (hostInput, hostContext, hostSignal) => mcpPrepared.execute(
                name, hostInput, hostContext, hostSignal,
              ),
              signal,
            );
          }
          return extensionRegistry.executeTool(name, input, context, signal);
        };
        finalContent = await runToolLoop({
        sessionManager,
        sessionId: currentSessionId,
        extensionRegistry,
        tools: toChatToolDefinitions(toolLoadout.getTools()),
        resolveTools: () => toChatToolDefinitions(toolLoadout.getTools()),
        executeTool: executeSelectedTool,
        getActivatedTools: (name, result) => toolLoadout.activatedTools(name, result),
        getToolResultMetadata: (name, result) => toolLoadout.resultMetadata(name, result),
        toolContext: {
          sessionManager,
          currentSessionId,
          provider,
          providerName,
          toolPreset: currentSession?.toolPreset,
          cwd: workspaceCwd,
          workspaceId: workspaceDescriptor.id,
          projectTrusted: isProjectTrusted(),
          onProcessOutput: chunk => {
            if (!activeToolCall) return;
            const safeChunk = activeToolRedactor.push(chunk);
            if (!safeChunk) return;
            activeToolOutput = truncateToolTail(activeToolOutput + safeChunk).content;
            return jsonOutput?.events.toolExecutionUpdate(activeToolCall, activeToolOutput);
          },
          notify: (message, level = 'info') => {
            if (level === 'error') reportError(message);
            else reportOutput(message);
          },
        },
        onTurnStart: () => jsonOutput?.events.startTurn(),
        streamTurn: async (messages, tools) => streamProviderTurn({
          provider,
          providerName,
          model: providerModel,
          sessionId: currentSessionId,
          messages,
          tools,
          systemPrompt: instructionSystemPrompt,
          thinking: ctx.thinkingLevel,
          signal: operationController.signal,
          extensionRegistry,
          maxRetries: settingsResolution.settings.retry?.enabled === false
            ? 0 : settingsResolution.settings.retry?.maxRetries ?? 3,
          retryDelayMs: settingsResolution.settings.retry?.baseDelayMs ?? 2_000,
          retryMaxDelayMs: settingsResolution.settings.retry?.maxAgentDelayMs ?? 60_000,
          redactText: redactOutput,
          redactJson: value => outputCredentialRedactor.redactJson(value),
          createTextRedactor: () => outputCredentialRedactor.createStream(),
          onStart: (effectiveProvider, effectiveModel) => {
            streamWriter = printMode ? null : terminal.startStreaming();
            isStreaming = true;
            keyBindings.setStreaming(true);
            return jsonOutput?.events.startAssistant(effectiveProvider, effectiveModel);
          },
          onTextDelta: chunk => {
            if (!isStreaming) return;
            streamWriter?.write(chunk);
            return jsonOutput?.events.textDelta(chunk);
          },
          onReasoningDelta: delta => (
            isStreaming ? jsonOutput?.events.reasoningDelta(delta) : undefined
          ),
          onComplete: () => {
            isStreaming = false;
            keyBindings.setStreaming(false);
            streamWriter?.finish();
          },
          onError: error => {
            isStreaming = false;
            keyBindings.setStreaming(false);
            return jsonOutput?.events.finishAssistantError(error, operationController.signal.aborted);
          },
          onRetryStart: ({ attempt, maxAttempts, delayMs, error }) => (
            jsonOutput?.events.retryStart(attempt, maxAttempts, delayMs, error)
          ),
          onRetryEnd: ({ success, attempt, finalError }) => (
            jsonOutput?.events.retryEnd(success, attempt, finalError)
          ),
        }),
        onAssistantResponse: response => jsonOutput?.events.finishAssistant(response),
        onToolCall: call => {
          activeToolCall = call;
          activeToolOutput = '';
          activeToolRedactor = outputCredentialRedactor.createStream();
          const event = jsonOutput?.events.toolExecutionStart(call);
          if (!printMode) {
            terminal.addTranscriptEntry({ type: 'command', content: `[Tool] ${call.name}` });
            terminal.displayCommand('tool', `${call.name}(${JSON.stringify(call.input)})`);
          }
          return event;
        },
        onToolResult: async result => {
          const finalChunk = activeToolRedactor.flush();
          if (activeToolCall && finalChunk) {
            activeToolOutput = truncateToolTail(activeToolOutput + finalChunk).content;
            await jsonOutput?.events.toolExecutionUpdate(activeToolCall, activeToolOutput);
          }
          const event = await jsonOutput?.events.toolExecutionEnd(result);
          activeToolCall = undefined;
          activeToolOutput = '';
          if (!printMode) terminal.displayCommand(result.call.name, result.content);
          return event;
        },
          onTurnEnd: () => jsonOutput?.events.endTurn(),
          beforeNextTurn: async () => {
            await persistQueuedBatch('steer', interactiveQueue.take('steer'));
          },
          onFinalResponse: content => {
            if (!printMode && content) terminal.addTranscriptEntry({ type: 'assistant', content });
          },
          signal: operationController.signal,
          redactText: redactOutput,
        });

        await extensionRegistry.emit('agent:end', {
          sessionId: currentSessionId,
          contentLength: finalContent.length,
        });
        continueConversation = false;
        while (!continueConversation) {
          const next = interactiveQueue.takeNext();
          if (!next) break;
          continueConversation = await persistQueuedBatch(next.kind, next.items);
        }
        if (continueConversation) {
          await extensionRegistry.emit('agent:start', { sessionId: currentSessionId, provider: providerName });
        }
      }

      if (jsonOutput) await jsonOutput.events.endAgent();
      return finalContent;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Une erreur inconnue est survenue.';
      await jsonOutput?.events.failAgent(error, activeAbortController?.signal.aborted ?? false);
      await extensionRegistry.emit('agent:error', { sessionId: currentSessionId, error: errorMessage });
      if (printMode) throw error;
      if (!isStreaming && !activeAbortController?.signal.aborted) reportError(errorMessage);
      return undefined;
    } finally {
      if (activeAbortController?.signal.aborted) await mcpHost.releaseSession(currentSessionId);
      else mcpHost.finishPrompt(currentSessionId);
      if (!printMode && (interactiveQueue.size() > 0 || unprocessedQueuedInputs.length > 0)) {
        const restored = restoreQueuedInput(inputDriver.getValue(), unprocessedQueuedInputs);
        if (restored !== undefined) inputDriver.replaceValue(restored);
      }
      isStreaming = false;
      streamWriter = null;
      activeAbortController = null;
      conversationRunning = false;
      keyBindings.setStreaming(false);
      if (!printMode && !shuttingDown) refreshPrompt();
    }
  }

  /** Shared line-oriented multi-line editor and regular input dispatcher. */
  async function handleLine(input: string, submission: AgentMessageQueueKind = 'steer'): Promise<void> {
    const trimmed = input.trim();

    if (conversationRunning) {
      if (!trimmed) {
        inputDriver.prompt();
        return;
      }
      if (trimmed.startsWith('/') || trimmed.startsWith('!')) {
        inputDriver.replaceValue(input);
        reportError('Les commandes ne peuvent pas être mises en file pendant une réponse.');
        inputDriver.prompt();
        return;
      }
      try {
        interactiveQueue.enqueue(submission, { content: trimmed });
        const queued = interactiveQueue.snapshot();
        reportOutput(`[${submission === 'steer' ? 'Steering' : 'Follow-up'} en file · ${queued.steering.length + queued.followUp.length}]`);
      } catch (error) {
        inputDriver.replaceValue(input);
        reportError(error instanceof Error ? error.message : String(error));
      }
      inputDriver.prompt();
      return;
    }

    if (trimmed === '/edit' && !isMultiLineMode) {
      terminal.startMultiLineEditor();
      isMultiLineMode = true;
      inputDriver.setPrompt('… ');
      inputDriver.prompt();
      return;
    }

    if (isMultiLineMode) {
      if (trimmed === '/cancel') {
        terminal.cancelMultiLineEditor();
        isMultiLineMode = false;
        refreshPrompt();
        return;
      }

      if (trimmed === '/send') {
        const content = terminal.getMultiLineContent();
        isMultiLineMode = false;
        inputDriver.setPrompt(sessionPrompt());
        if (content) await processInput(content);
        else inputDriver.prompt();
        return;
      }

      terminal.addMultiLineBuffer(input);
      inputDriver.prompt();
      return;
    }

    await processInput(input);
  }

  async function dispatchLine(input: string, submission: AgentMessageQueueKind = 'steer'): Promise<void> {
    if (conversationRunning) {
      await handleLine(input, submission);
      return;
    }
    if (foregroundInputRunning) {
      if (input.trim()) inputDriver.replaceValue(input);
      reportError('Une commande ou saisie est déjà en cours.');
      inputDriver.prompt();
      return;
    }

    foregroundInputRunning = true;
    try {
      await handleLine(input, submission);
    } finally {
      foregroundInputRunning = false;
    }
  }

  const completeCommands = (input: string): string[] => {
    if (!input.startsWith('/') || input.includes(' ')) return [];
    const names = [
      ...commandHandler.getCommandNames(),
      'skills',
      'prompts',
      'resources',
      ...(settingsResolution.settings.enableSkillCommands === false
        ? [] : resourceManager.listSkills().map(skill => `skill:${skill.name}`)),
      ...resourceManager.listPrompts().map(prompt => prompt.name),
    ];
    return names.map(name => `/${name}`).filter(name => name.startsWith(input));
  };

  if (printMode) {
    try {
      await jsonOutput?.events.sessionHeader(activeSession, workspaceCwd);
      let finalContent: string | undefined;
      for (const prompt of initialPrompts) {
        finalContent = await processInput(prompt.content, {
          allowCommands: false,
          imageBlocks: prompt.images,
        });
      }
      if (applicationMode === 'print') process.stdout.write(`${redactOutput(finalContent ?? '')}\n`);
    } catch (error) {
      process.stderr.write(`Error: ${redactOutput(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    } finally {
      await cleanupEarlyExit();
    }
    return;
  }

  await activateSystemThemeProbe();
  filteredTerminalInput = new ThemeFilteredInput(process.stdin);
  if (fullscreenTerminal) {
    const fullscreenInput = new FullscreenInput(fullscreenTerminal, {
      onLine: dispatchLine,
      onInterrupt: interrupt,
      onEscape: escapeInterrupt,
      onExit: () => shutdown('Au revoir ! 👋', 0),
      onError: error => terminal.showError(error.message),
      complete: completeCommands,
      onDequeue: currentInput => restoreQueuedInput(currentInput),
      onExternalEditor: async currentInput => {
        fullscreenTerminal.leave();
        try {
          return await editInExternalEditor(currentInput, settingsResolution.settings.externalEditor);
        } finally {
          fullscreenTerminal.enter();
        }
      },
    }, filteredTerminalInput);
    inputDriver = fullscreenInput;
    if (settingsResolution.settings.quietStartup !== true) terminal.welcome();
    fullscreenInput.setPrompt(sessionPrompt());
    fullscreenInput.start();
  } else {
    const rl = readline.createInterface({
      input: filteredTerminalInput,
      output: process.stdout,
      prompt: sessionPrompt(),
      completer: (line: string): [string[], string] => [completeCommands(line), line],
      escapeCodeTimeout: TERMINAL_ESCAPE_CODE_TIMEOUT_MS,
    });
    const replaceReadlineValue = (value: string): void => {
      rl.write(null, { ctrl: true, name: 'u' });
      const singleLine = value.replace(/[\r\n]+/g, ' ');
      if (singleLine) rl.write(singleLine);
    };
    const escapeSequence = new TerminalEscapeSequence(escapeInterrupt);
    let suppressLineEvent = false;
    const submitRegularFollowUp = (): void => {
      const currentInput = rl.line;
      suppressLineEvent = true;
      queueMicrotask(() => { suppressLineEvent = false; });
      replaceReadlineValue('');
      void dispatchLine(currentInput, 'follow-up')
        .catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
    };
    const regularKeypress = (_text: string, key: readline.Key): void => {
      if (key.name === 'escape' && !key.ctrl && !key.shift) {
        escapeSequence.deferEscape();
        return;
      }
      const escapedEnter = escapeSequence.consumeFollowingKey(key);
      if ((key.name === 'return' || key.name === 'enter') && (key.meta || escapedEnter)) {
        submitRegularFollowUp();
        return;
      }
      if (key.ctrl && key.name === 'q') {
        submitRegularFollowUp();
        return;
      }
      if (key.meta && key.name === 'up') {
        const restored = restoreQueuedInput(rl.line);
        if (restored !== undefined) setImmediate(() => replaceReadlineValue(restored));
        else terminal.scrollUp();
        return;
      }
      if (key.meta && key.name === 'down') {
        terminal.scrollDown();
        return;
      }
      if (key.ctrl && key.name === 'g') {
        const currentInput = rl.line;
        replaceReadlineValue('');
        void editInExternalEditor(currentInput, settingsResolution.settings.externalEditor)
          .then(content => { if (content !== undefined) replaceReadlineValue(content); })
          .catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (key.ctrl && key.name === 'c') return; // readline emits SIGINT below.
      keyBindings.handleKeypress(key);
    };
    filteredTerminalInput.prependListener('keypress', regularKeypress);
    inputDriver = {
      prompt: () => rl.prompt(),
      close: () => {
        escapeSequence.cancel();
        filteredTerminalInput?.removeListener('keypress', regularKeypress);
        rl.close();
      },
      setPrompt: prompt => rl.setPrompt(prompt),
      getValue: () => rl.line,
      replaceValue: replaceReadlineValue,
    };
    terminal.setReadline(rl);
    if (settingsResolution.settings.quietStartup !== true) terminal.welcome();

    rl.on('SIGINT', interrupt);
    rl.on('line', input => {
      if (suppressLineEvent) {
        suppressLineEvent = false;
        return;
      }
      void dispatchLine(input, 'steer')
        .catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
    });
    rl.prompt();
  }

  if (initialPrompts.length) {
    void (async () => {
      for (const prompt of initialPrompts) {
        await processInput(prompt.content, {
          allowCommands: false,
          imageBlocks: prompt.images,
        });
      }
    })().catch(error => reportError(error instanceof Error ? error.message : String(error)));
  }

  process.on('SIGINT', interrupt);
  process.on('SIGTERM', () => shutdown('Arrêt en cours…', 0));
  process.on('exit', () => fullscreenTerminal?.leave());
}

main().catch(error => {
  if (process.stdout.isTTY) process.stdout.write('\u001b[?25h\u001b[?1049l');
  console.error(chalk.red('Erreur fatale :'), outputCredentialRedactor.redact(
    error instanceof Error ? error.message : String(error),
  ));
  process.exitCode = 1;
});
