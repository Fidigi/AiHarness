#!/usr/bin/env node
// ============================================================
// AiHarness CLI - Regular readline and fullscreen TUI entry point
// ============================================================

import {
  AgentMessageQueue,
  retainAgentWork,
  assertCompactionTranscript,
  getSummaryModelMessages,
  compactionMessagesFromEntries,
  copyCompactionResponse,
  clampPublishedThinkingLevel,
  closeProviderNetworkDispatchers,
  collectToolSearchLoadedNames,
  createAgentToolLoadout,
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
  resolveAgentCompactionContextWindow,
  resolveAgentCompactionSettings,
  resolveAgentDefaultTools,
  resolveAgentResourceSelectors,
  resolveAgentThinkingLevel,
  readMcpServerTestTarget,
  registerWorkspaceTools,
  selectRegisteredTools,
  SessionManager,
  toChatToolDefinitions,
  truncateToolTail,
  WorkspaceManager,
} from '@ai-harness/core';
import type {
  AgentMessageQueueKind,
  AiProvider,
  MessageContentBlock,
  PluginResourceKind,
  ResolvedAgentSettings,
  RegisteredAgentTool,
  Session,
  ThinkingLevel,
  ToolCall,
} from '@ai-harness/core';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import readline from 'readline';
import chalk from 'chalk';
import { CommandHandler } from './commands/handler.js';
import { TerminalUI } from './tui/terminal-ui.js';
import { FullscreenUI } from './tui/fullscreen-ui.js';
import { FullscreenInput } from './tui/fullscreen-input.js';
import { EditorState } from './tui/editor-state.js';
import { unsupportedCliSettings } from './tui/terminal-settings.js';
import { cliCacheNotices } from './tui/cache-notices.js';
import { KeypressFilteredInput } from './utils/keypress-gate.js';
import { configuredThemeSelection, configuredThemeSources } from './cli/theme-sources.js';
import {
  TerminalEscapeSequence,
  TERMINAL_ESCAPE_CODE_TIMEOUT_MS,
} from './tui/terminal-escape.js';
import { resolveTerminalMode } from './tui/mode.js';
import { KeyBindingManager } from './utils/keybinding-manager.js';
import { HotkeyView } from './utils/hotkey-view.js';
import { resolveKeybindingSource } from './utils/keybinding-source.js';
import { EDITOR_ACTION_KEYS, TERMINAL_ACTIONS, type TerminalActionId } from './utils/terminal-actions.js';
import { configuredBuiltinExtensions, configuredExtensionSelectors, explicitExtensionFiles, ExtensionLoader } from './extensions/extension-loader.js';
import { runToolLoop } from './agent/tool-loop.js';
import { streamProviderTurn } from './agent/provider-turn.js';
import { parseResourceCommandLine, ResourceManager } from './resources/resource-manager.js';
import { createTerminalStatus } from './tui/status.js';
import { PromptBoundaryRefresh } from './tui/status-prompt-refresh.js';
import { terminalText } from './tui/terminal-text.js';
import { editInExternalEditor } from './utils/system-integration.js';
import { runRpcMode } from './rpc/rpc-server.js';
import { resolveVirtualModelFallback } from '@ai-harness/core';
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
  completeCliOptions,
  formatCliHelp,
  parseCliArguments,
  readPipedStdin,
  resolveCliApplicationMode,
  type CliThinkingLevel,
} from './cli/args.js';
import { resolveStartupDisplay } from './cli/startup-display.js';
import { resolveOfflineMode } from './cli/offline-mode.js';
import { cliToolsDisabled, cliToolSelectionOptions, unknownCliToolNames } from './cli/tool-selection.js';
import {
  applyAgentModelSettings,
  createConfiguredProviders,
  getConfiguredSpecializedProviders,
  resolveStartupProvider,
} from './providers/configured-providers.js';
import { createCliProviderRuntime } from './providers/provider-runtime.js';
import { reserveProcessStdoutForJson, toJsonProtocolUsage } from './cli/json-output.js';
import { cleanupCliEarlyExit } from './cli/lifecycle.js';
import { InteractiveShellController } from './cli/shell-controller.js';
import { formatConfiguredModelList } from './cli/model-list.js';
import { resolvePackageNpmOptions, runPackageCommand } from './cli/package-command.js';
import { prepareExtensionStartup } from './cli/extension-startup.js';
import { runMcpCommand } from './cli/mcp-command.js';
import {
  resolveStartupSession,
  resolveStartupSessionDirectory,
  StartupSessionSelectionCancelledError,
} from './sessions/startup-session.js';

const outputCredentialRedactor = new CredentialRedactor();
outputCredentialRedactor.addEnvironment(process.env);

interface InputDriver {
  prompt(preserveCursor?: boolean): void;
  close(): void;
  setPrompt(prompt: string): void;
  getValue(): string;
  replaceValue(value: string, cursor?: number): void;
  getCursor?(): number;
  suspendDraft?(): () => void;
  performAction?(action: TerminalActionId, event?: readline.Key): boolean | Promise<boolean>;
}

interface InteractiveQueuedInput {
  content: string;
  imageBlocks?: MessageContentBlock[];
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
    ['theme (saved)', resolved.settings.theme ?? 'auto', 'theme'],
    ['tuiMode (saved; restart)', resolved.settings.tuiMode ?? 'fullscreen', 'tuiMode'],
  ];
  return [
    `Agent settings: ${resolved.paths.global}`,
    `Project settings: ${resolved.paths.project} (${resolved.projectTrusted ? 'trusted' : 'blocked'})`,
    ...values.map(([name, value, field]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)} [${source(field)}]`),
    ...unsupportedCliSettings(resolved.settings).map(field => `${field}: unsupported by CLI (stored only) [${source(field)}]`),
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
  if (rawArguments[0] === 'auth') {
    const { runProviderAuthCommand } = await import('./cli/provider-auth-command.js');
    process.exitCode = await runProviderAuthCommand(rawArguments.slice(1));
    return;
  }
  if (rawArguments[0] === 'export') {
    const { runExportCommand } = await import('./cli/export-command.js');
    process.exitCode = await runExportCommand(rawArguments.slice(1));
    return;
  }
  let cliArguments: ReturnType<typeof parseCliArguments>;
  try {
    cliArguments = parseCliArguments(rawArguments, [], true);
  } catch (error) {
    const message = error instanceof CliArgumentError ? error.message : String(error);
    process.stderr.write(`Error: ${outputCredentialRedactor.redact(message)}\n`);
    process.exitCode = 2;
    return;
  }
  // Capture environment policy before trusted extension registration, but resolve
  // flag arity only from the authoritative second parse (never the bootstrap).
  const environmentOffline = resolveOfflineMode();
  const keybindingFileOverride = process.env.AI_HARNESS_KEYBINDINGS;
  // Bootstrap guesses may conservatively mask startup errors, but cannot grant
  // permanent redaction authority over definitively parsed prompt input.
  const bootstrapCredentialRedactor = new CredentialRedactor();
  bootstrapCredentialRedactor.addEnvironment(process.env);
  bootstrapCredentialRedactor.add(cliArguments.apiKey);
  if ((cliArguments.help || cliArguments.version || cliArguments.listModels) && cliArguments.deferredOptions.length) {
    process.stderr.write(`Error: Unknown option: ${cliArguments.deferredOptions[0]}. Use --help for available options.\n`);
    process.exitCode = 2;
    return;
  }
  if (cliArguments.help) {
    process.stdout.write(formatCliHelp());
    process.stdout.write('\nStandalone operations (exit before agent startup):\n  auth --help                   Provider credential list/login/logout\n  export --help                 Trusted session file export\n');
    return;
  }
  if (cliArguments.version) {
    process.stdout.write(`${cliVersion()}\n`);
    return;
  }
  let extensionStartup: Awaited<ReturnType<typeof prepareExtensionStartup>> | undefined;
  if (cliArguments.deferredOptions.length || cliArguments.extensionHelp || cliArguments.completion !== undefined) {
    try {
      extensionStartup = await prepareExtensionStartup(rawArguments, cliArguments);
      cliArguments = extensionStartup.arguments;
    } catch (error) {
      const message = error instanceof CliArgumentError ? error.message : 'Extension startup failed.';
      process.stderr.write(`Error: ${bootstrapCredentialRedactor.redact(message)}\n`);
      process.exitCode = 2;
      return;
    }
    if (cliArguments.extensionHelp || cliArguments.completion !== undefined) {
      try {
        process.stdout.write(cliArguments.extensionHelp
          ? formatCliHelp(extensionStartup.registry.getOptions())
          : `${completeCliOptions(cliArguments.completion!, extensionStartup.registry.getOptions()).join('\n')}\n`);
      } finally {
        const originalWrite = process.stdout.write;
        process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
        try { await extensionStartup.registry.unloadAll(); }
        finally { process.stdout.write = originalWrite; }
      }
      return;
    }
  } else {
    // A bootstrap pass is never an authoritative parse, even without custom options.
    cliArguments = parseCliArguments(rawArguments);
  }
  outputCredentialRedactor.add(cliArguments.apiKey);
  const offline = cliArguments.offline === true || environmentOffline;
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
        offline,
      );
      const providers = createConfiguredProviders(process.env, {
        credentials: providerRuntime.values,
        githubCopilot: providerRuntime.githubCopilot,
        openaiCodex: providerRuntime.openaiCodex,
        kimiCodingAuthMode: providerRuntime.kimiCodingAuthMode,
        anthropicAuthMode: providerRuntime.anthropicAuthMode,
        anthropicOAuth: providerRuntime.anthropicOAuth,
        anthropicFederation: providerRuntime.anthropicFederation,
        radiusCatalogueDirectory: providerRuntime.radiusCatalogueDirectory,
        radiusOAuth: providerRuntime.radiusOAuth,
        kimiOAuth: providerRuntime.kimiOAuth,
        metaOAuth: providerRuntime.metaOAuth,
        network: providerRuntime.network,
      });
      const search = typeof cliArguments.listModels === 'string' ? cliArguments.listModels : undefined;
      process.stdout.write(`${outputCredentialRedactor.redact(await formatConfiguredModelList(providers, search, offline))}\n`);
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
      const rpcStartupOptions = {
      offline,
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
      noExtensions: cliArguments.noExtensions,
      noMcp: cliArguments.noMcp,
      extensionRegistry: extensionStartup?.registry,
      extensionLoader: extensionStartup?.loader,
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
      };
      const interrupted = await runRpcMode(rpcStartupOptions);
      if (interrupted) {
        process.stderr.write('Error: Request interrupted.\n');
        process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
      }
    } finally {
      await cleanupCliEarlyExit({ closeNetwork: closeProviderNetworkDispatchers, requireSettlement: true });
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
    if (applicationMode === 'interactive') {
      for (const field of unsupportedCliSettings(resolved.settings)) {
        process.stderr.write(`Warning: ${field} is unsupported by CLI (stored only).\n`);
      }
    }
    return resolved;
  };
  let settingsResolution = await resolveSettingsForTrust(true);
  let builtinExtensions = configuredBuiltinExtensions(settingsResolution, cliArguments);
  let providerRuntime: Awaited<ReturnType<typeof createCliProviderRuntime>>;
  const providerHost = new AbortController();
  const reloadAgentSettings = async (): Promise<void> => {
    const candidate = await resolveSettingsForTrust();
    const candidateBuiltins = configuredBuiltinExtensions(candidate, cliArguments);
    settingsResolution = candidate;
    builtinExtensions = candidateBuiltins;
  };
  const currentProjectTrust = (fallback: boolean): boolean => {
    if (cliArguments.projectTrust !== undefined) return cliArguments.projectTrust;
    if (sessionProjectTrust !== undefined) return sessionProjectTrust;
    return trustManager.getDecisionSync(workspaceCwd)?.decision ?? fallback;
  };
  const isProjectTrusted = (): boolean => currentProjectTrust(projectTrusted);
  const mayLoadProjectResources = (): boolean => currentProjectTrust(projectResourcesTrusted);
  const checkProjectTrust = async (cwd = workspaceCwd): Promise<boolean> => (await resolveProjectTrust({
    cwd, trustManager, override: cliArguments.projectTrust ?? sessionProjectTrust,
    defaultProjectTrust: settingsResolution.settings.defaultProjectTrust,
    includeContextFiles: !cliArguments.noContextFiles,
  })).trusted;
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
  // Only explicit flags/session-only prompt choices are process authority. Never
  // promote resolved/default/saved trust into an override that survives revocation.
  const resolvePluginOptions = () => resolvePackageNpmOptions(
    settingsResolution, workspaceCwd, cliArguments.projectTrust, sessionProjectTrust,
  );
  let pluginServiceAgentDir = settingsResolution.agentDir;
  let pluginCommandKey = JSON.stringify(resolvePluginOptions());
  let pluginService = new PluginService(
    workspaceManager,
    trustManager,
    path.join(pluginServiceAgentDir, 'plugins.json'),
    pluginServiceAgentDir,
    undefined,
    resolvePluginOptions(),
  );
  const refreshPluginService = async (): Promise<void> => {
    const npmOptions = resolvePluginOptions();
    const commandKey = JSON.stringify(npmOptions);
    if (pluginServiceAgentDir !== settingsResolution.agentDir || pluginCommandKey !== commandKey) {
      pluginServiceAgentDir = settingsResolution.agentDir;
      pluginCommandKey = commandKey;
      pluginService = new PluginService(
        workspaceManager,
        trustManager,
        path.join(pluginServiceAgentDir, 'plugins.json'),
        pluginServiceAgentDir,
        undefined,
        npmOptions,
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

  let activeThemeSelection = configuredThemeSelection(settingsResolution, cliArguments);
  let themeSelectedInteractively = false;
  const loadThemeSources = () => configuredThemeSources(settingsResolution, workspaceCwd, packagePaths.theme, cliArguments);
  let themeSources = await loadThemeSources().catch(error => {
    console.error(outputCredentialRedactor.redact(`Thèmes ignorés : ${error instanceof Error ? error.message : String(error)}`));
    return [];
  });
  let theme = await ThemeManager.load(
    activeThemeSelection,
    themeSources,
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
  const startupDisplay = resolveStartupDisplay(settingsResolution.settings.quietStartup, cliArguments.verbose);
  const terminalOptions = {
    title: `AiHarness CLI v${cliVersion()}`,
    startupDetails: startupDisplay.details,
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
  let outputLimitReached = false;
  let foregroundInputRunning = false;
  const inputWork = new Set<Promise<void>>();
  let activeAbortController: AbortController | null = null;
  let systemThemeProbe: SystemThemeProbe | undefined;
  let filteredTerminalInput: KeypressFilteredInput | undefined;
  const keyBindings = new KeyBindingManager(redactOutput);
  let hotkeyView: HotkeyView | undefined;
  let hotkeyDraft = { value: '', cursor: 0 };
  let restoreHotkeyDraft: (() => void) | undefined;
  let selectedKeybindingPath: string | undefined;
  let keybindingGeneration = 0;
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
    globalSkillSelectors: resolveAgentResourceSelectors(settingsResolution, 'skills', undefined, 'global'),
    projectSkillSelectors: resolveAgentResourceSelectors(settingsResolution, 'skills', undefined, 'project'),
    globalPromptSelectors: resolveAgentResourceSelectors(settingsResolution, 'prompts', undefined, 'global'),
    projectPromptSelectors: resolveAgentResourceSelectors(settingsResolution, 'prompts', undefined, 'project'),
    globalPackageSkillPaths: packagePaths.skill.global,
    projectPackageSkillPaths: packagePaths.skill.project,
    globalPackagePromptPaths: packagePaths.prompt.global,
    projectPackagePromptPaths: packagePaths.prompt.project,
    skillPaths: cliArguments.skills,
    promptPaths: cliArguments.promptTemplates,
    discoverSkills: !cliArguments.noSkills,
    discoverPrompts: !cliArguments.noPromptTemplates,
  });
  let resourceManager = createResourceManager();
  const resourceLoadResult = await resourceManager.loadAll();
  let resourceDiagnosticCount = resourceLoadResult.errors.length;
  for (const error of resourceLoadResult.errors) reportError(`Ressource : ${error.message}`);

  const extensionRegistry = extensionStartup?.registry ?? new ExtensionRegistry();
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
  const mcpHost: McpSessionHost = new McpSessionHost({
    agentDir: settingsResolution.agentDir,
    registeredServers: extensionRegistry.mcpServers,
    redactText: value => outputCredentialRedactor.redact(value),
    trustManager,
    resolveWorkingDirectory: (configured, base) => workspaceManager.resolve(configured, {
      base,
      kind: 'directory',
    }),
    ...(mcpOAuth ? {
      oauthProviderFactory: createMcpOAuthProviderFactory({
        manager: mcpOAuth,
        resolveTarget: target => target.registration
          ? mcpHost.readServerTarget(target.scope, target.name, workspaceCwd)
          : readMcpServerTestTarget({
            agentDir: settingsResolution.agentDir, scope: target.scope, name: target.name,
            cwd: target.cwd, defaultCwd: target.cwd, trustManager,
            resolveWorkingDirectory: (configured, base) => workspaceManager.resolve(configured, { base, kind: 'directory' }),
          }),
      }),
    } : {}),
  });
  await mcpHost.setEnabled(builtinExtensions.mcp);
  let earlyCleanupPromise: Promise<void> | undefined;
  const cleanupEarlyExit = (
    additional: readonly (() => void | Promise<void>)[] = [],
  ): Promise<void> => {
    if (earlyCleanupPromise) return earlyCleanupPromise;
    keybindingGeneration++;
    keyBindings.clearAll();
    hotkeyView = undefined; restoreHotkeyDraft = undefined;
    const filteredInput = filteredTerminalInput;
    filteredTerminalInput = undefined;
    if (filteredInput) process.stdout.write('\x1b[?2004l');
    const themeProbe = systemThemeProbe;
    systemThemeProbe = undefined;
    providerHost.abort();
    providerRuntime?.close();
    earlyCleanupPromise = cleanupCliEarlyExit({
      input: inputDriver,
      filteredInput,
      themeProbe,
      extensions: extensionRegistry,
      jsonOutput,
      closeNetwork: closeProviderNetworkDispatchers,
      requireSettlement: true,
      additional: [() => mcpHost.shutdown(), ...additional],
    });
    return earlyCleanupPromise;
  };
  await registerWorkspaceTools(extensionRegistry, workspaceManager, {
    shellPath: () => settingsResolution.settings.shellPath,
    shellCommandPrefix: () => settingsResolution.settings.shellCommandPrefix,
  });
  let instructionSystemPrompt = '';
  let instructionCount = 0;
  let instructionDiagnosticCount = 0;
  let extensionDiagnosticCount = 0;
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
    instructionCount = resolved.contextFiles.length
      + Number(resolved.systemPromptSource.kind !== 'default') + resolved.appendSystemPromptSources.length;
    instructionDiagnosticCount = resolved.diagnostics.length;
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
  const runtimeExtensionPaths = async (): Promise<string[]> => [
      ...(settingsResolution.agentDirTrusted && !cliArguments.noExtensions ? [path.join(settingsResolution.agentDir, 'extensions') + path.sep] : []),
      ...explicitExtensionFiles(cliArguments.extensions),
      ...(settingsResolution.agentDirTrusted && !cliArguments.noExtensions ? await pluginService.getEnabledExtensionFiles({
        cwd: workspaceCwd,
        projectId: workspaceDescriptor.id,
        projectTrusted: mayLoadProjectResources(),
      }).catch(error => {
        process.stderr.write(`${outputCredentialRedactor.redact(
          `Warning: Package extensions ignored: ${error instanceof Error ? error.message : String(error)}`,
        )}\n`);
        return [];
      }) : []),
    ];
  const runtimeExtensionSelectors = () => configuredExtensionSelectors(settingsResolution, cliArguments.noExtensions);
  extensionStartup?.setDiscovery(runtimeExtensionPaths, mayLoadProjectResources, runtimeExtensionSelectors);
  const extensionLoader = extensionStartup?.loader ?? new ExtensionLoader(extensionRegistry, {
    cwd: workspaceCwd,
    includeGlobalLocation: false,
    includeProjectLocation: !cliArguments.noExtensions,
    includeEnvironmentPaths: !cliArguments.noExtensions,
    paths: runtimeExtensionPaths,
    selectors: runtimeExtensionSelectors,
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
    await reloadKeybindings();
    await mcpHost.setEnabled(builtinExtensions.mcp);
    await refreshPluginService();
    const refreshedStoreId = `${settingsResolution.agentDirTrusted ? 'persistent' : 'memory'}:${path.resolve(settingsResolution.agentDir)}`;
    const refreshedRuntime = await createCliProviderRuntime(
      settingsResolution.agentDir,
      settingsResolution.settings,
      process.env,
      providerRuntime.credentialStoreId === refreshedStoreId ? providerRuntime.credentials : undefined,
      settingsResolution.agentDirTrusted,
      extensionRegistry.getProviderDefinitions(),
      outputCredentialRedactor,
      offline,
      providerHost.signal,
    );
    const refreshedProviders = createConfiguredProviders(process.env, {
      credentials: refreshedRuntime.values,
      githubCopilot: refreshedRuntime.githubCopilot,
      openaiCodex: refreshedRuntime.openaiCodex,
      kimiCodingAuthMode: refreshedRuntime.kimiCodingAuthMode,
      anthropicAuthMode: refreshedRuntime.anthropicAuthMode,
      anthropicOAuth: refreshedRuntime.anthropicOAuth,
      anthropicFederation: refreshedRuntime.anthropicFederation,
      radiusCatalogueDirectory: refreshedRuntime.radiusCatalogueDirectory,
      radiusOAuth: refreshedRuntime.radiusOAuth,
      kimiOAuth: refreshedRuntime.kimiOAuth,
      metaOAuth: refreshedRuntime.metaOAuth,
      network: refreshedRuntime.network,
    });
    const commandContext = commandHandler.getContext();
    for (const name of [...configuredProviders.keys()]) {
      if (!commandContext.extensionProviderNames.has(name)) configuredProviders.delete(name);
    }
    for (const [name, provider] of refreshedProviders) configuredProviders.set(name, provider);
    providerRuntime.close();
    providerRuntime = refreshedRuntime;
    commandContext.providerLifetime = refreshedRuntime.signal;
    commandContext.credentialService = refreshedRuntime.credentials;
    commandContext.providerCredentialValues = refreshedRuntime.values;
    commandContext.providerNetwork = refreshedRuntime.network;
    commandContext.radiusCatalogueDirectory = refreshedRuntime.radiusCatalogueDirectory;
    const refreshedModelSettings = applyAgentModelSettings({
      provider: cliArguments.provider,
      model: cliArguments.model,
      models: cliArguments.models,
      apiKey: cliArguments.apiKey,
    }, settingsResolution.settings);
    const refreshedStartup = await resolveStartupProvider(configuredProviders, { ...refreshedModelSettings.selection, offline }, process.env, extensionRegistry.virtualModels, refreshedRuntime);
    refreshedStartup.scopeDiagnostics?.forEach(() => process.stderr.write('Warning: A model scope entry could not be resolved.\n'));
    commandContext.provider = refreshedStartup.provider;
    commandContext.modelPatterns = refreshedModelSettings.modelPatterns;
    const refreshedModel = refreshedStartup.model ?? refreshedStartup.provider.getConfiguredModel();
    commandContext.thinkingLevel = clampPublishedThinkingLevel(
      coreThinkingLevel(cliArguments.thinking)
        ?? refreshedStartup.thinkingLevel
        ?? resolveAgentThinkingLevel(settingsResolution.settings, refreshedStartup.providerName, refreshedModel)
        ?? commandContext.thinkingLevel,
      getSupportedThinkingLevels(refreshedStartup.providerName, refreshedModel, extensionRegistry.virtualModels, refreshedStartup.provider),
    );
    sessionManager.setCompactionSettings(resolveAgentCompactionSettings(
      settingsResolution.settings,
      refreshedStartup.providerName,
      refreshedModel,
    ));
    const refreshedWindow = resolveAgentCompactionContextWindow(
      refreshedStartup.providerName, refreshedModel, refreshedStartup.provider,
    );
    sessionManager.setCompactionContextWindow(refreshedWindow);
    if (commandContext.currentSessionId && sessionManager.get(commandContext.currentSessionId)) {
      sessionManager.setCompactionContextWindow(refreshedWindow, commandContext.currentSessionId);
    }
    interactiveQueue.setMode('steer', settingsResolution.settings.steeringMode ?? 'one-at-a-time');
    interactiveQueue.setMode('follow-up', settingsResolution.settings.followUpMode ?? 'one-at-a-time');
    await reloadInstructionPrompt();
    packagePaths = await loadPackagePaths();
    if (!themeSelectedInteractively) {
      activeThemeSelection = configuredThemeSelection(settingsResolution, cliArguments);
    }
    try {
      // Never retain an old catalogue across a trust/settings generation failure.
      themeSources = [];
      themeSources = await loadThemeSources();
      theme = await ThemeManager.load(
        activeThemeSelection,
        themeSources,
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
    resourceDiagnosticCount = resources.errors.length;
    for (const error of resources.errors) reportError(`Ressource : ${error.message}`);
    const result = await extensionLoader.reload();
    extensionDiagnosticCount = result.errors.length;
    if (result.committed) {
      cliArguments = parseCliArguments(rawArguments, extensionRegistry.getOptions());
      extensionRegistry.setOptionValues(cliArguments.extensionOptions);
    }
    for (const failure of result.errors) {
      reportError(`Extension ${failure.path}: ${failure.error.message}`);
    }
    await registerSkillTool();
  });
  const extensionLoadResult = extensionStartup
    ? { errors: [] }
    : await extensionLoader.loadAll();
  extensionDiagnosticCount = extensionLoadResult.errors.length;
  for (const failure of extensionLoadResult.errors) {
    reportError(`Extension ${failure.path}: ${failure.error.message}`);
  }
  await registerSkillTool();

  const toolSelectionOptions = (dynamicTools: () => readonly RegisteredAgentTool[] = () => [], preset?: Session['toolPreset'], hasPotentialSearchableTools = false) => {
    const configuredDefaults = resolveAgentDefaultTools(
      settingsResolution.settings.defaultTools,
      DEFAULT_CODING_TOOL_NAMES,
    );
    return cliToolSelectionOptions(() => [...extensionRegistry.getTools(), ...dynamicTools()], {
      tools: cliArguments.tools,
      excludeTools: cliArguments.excludeTools,
      codemodeConfigured: Boolean(settingsResolution.settings.codemode),
      hasPotentialSearchableTools,
      preset,
      defaultTools: configuredDefaults ?? DEFAULT_CODING_TOOL_NAMES,
      builtInExtensionId: 'builtin:workspace-tools',
      includeNonBuiltInByDefault: true,
      noBuiltInTools: cliArguments.noBuiltinTools,
      noTools: cliArguments.noTools,
    });
  };
  const selectedTools = () => {
    const registered = extensionRegistry.getTools();
    const unknown = unknownCliToolNames(registered, cliArguments);
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
      extensionRegistry.getProviderDefinitions(),
      outputCredentialRedactor,
      offline,
      providerHost.signal,
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
    githubCopilot: providerRuntime.githubCopilot,
    openaiCodex: providerRuntime.openaiCodex,
    kimiCodingAuthMode: providerRuntime.kimiCodingAuthMode,
    anthropicAuthMode: providerRuntime.anthropicAuthMode,
    anthropicOAuth: providerRuntime.anthropicOAuth,
    anthropicFederation: providerRuntime.anthropicFederation,
    radiusCatalogueDirectory: providerRuntime.radiusCatalogueDirectory,
    radiusOAuth: providerRuntime.radiusOAuth,
    kimiOAuth: providerRuntime.kimiOAuth,
    metaOAuth: providerRuntime.metaOAuth,
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
      offline,
      settingsInfo: () => `${formatAgentSettingsSummary(settingsResolution)}\nActive theme: ${terminal.getThemeName()}\nActive terminal: ${fullscreenTerminal ? 'fullscreen' : 'regular'} (startup selection)`,
      agentSettings: () => settingsResolution.settings,
      providers: configuredProviders,
      credentialService: providerRuntime.credentials,
      providerLifetime: providerRuntime.signal,
      radiusCatalogueDirectory: providerRuntime.radiusCatalogueDirectory,
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
        prepare: (sessionId, preset, signal) => mcpHost.prepareForPrompt({
          sessionId,
          cwd: workspaceCwd,
          preset,
          signal,
        }),
        finish: sessionId => mcpHost.finishPrompt(sessionId),
        reconnect: sessionId => mcpHost.reconnect(sessionId),
        manage: async (args, signal) => {
          const output: string[] = [];
          await runMcpCommand(args, {
            cwd: workspaceCwd, signal, allowOAuthPaste: false,
            host: mcpHost,
            stdout: value => output.push(value),
            stderr: value => terminal.writeOutput(redactOutput(value)),
            onChanged: async (_scope, name) => {
              // Inherited targets and OAuth identities may be shared across scopes.
              await Promise.all((['global', 'project'] as const).map(scope => mcpHost.disconnectServer(scope, name)));
            },
          });
          return output.join('').trim();
        },
      },
      redactText: redactOutput,
      redactJson: value => outputCredentialRedactor.redactJson(value),
      themeControl: {
        current: () => theme.name,
        list: async () => {
          const active = theme;
          const inventory = await ThemeManager.inventory(
            themeSources,
            active.provenance.path,
            { cwd: workspaceCwd, projectTrusted: mayLoadProjectResources() },
          );
          // Direct --theme paths need not belong to discovery. Report the already
          // loaded palette without granting it future discovery/read authority.
          if (!inventory.some(item => item.provenance.path === active.provenance.path)) {
            inventory.unshift({ name: active.name, mode: active.mode, active: true, valid: true,
              provenance: { ...active.provenance, trusted: active.provenance.scope === 'project'
                ? mayLoadProjectResources() : active.provenance.trusted } });
          }
          return inventory;
        },
        select: async selection => {
          const selected = await ThemeManager.load(
            selection,
            themeSources,
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
  let startupSession: Session | undefined;
  const selectStartupSession = () => resolveStartupSession({ sessionManager, args: cliArguments, cwd: workspaceCwd,
    workspaceId: workspaceDescriptor.id, interactive: applicationMode === 'interactive', chooseSession: chooseStartupSession });
  try {
    if (cliArguments.session || cliArguments.continueSession || cliArguments.resume || cliArguments.fork) {
      startupSession = await selectStartupSession();
      if (!cliArguments.model && !cliArguments.provider) {
        const fallback = await resolveVirtualModelFallback(sessionManager, startupSession.id, extensionRegistry.virtualModels, name => ctx.providers.get(name));
        if (fallback) {
          await sessionManager.update(startupSession.id, { model: fallback.selection.id, providerConfig: { type: fallback.selection.provider } });
          ctx.thinkingLevel = fallback.selection.thinkingLevel ?? 'off';
          process.stderr.write('Warning: Saved virtual router unavailable; resuming its last physical model.\n');
        }
        if (startupSession.model && startupSession.providerConfig?.type) {
          effectiveModelSettings.selection = { ...effectiveModelSettings.selection,
            provider: startupSession.providerConfig.type, model: startupSession.model };
        }
      }
    }
    const startup = await resolveStartupProvider(ctx.providers, { ...effectiveModelSettings.selection, offline }, process.env, extensionRegistry.virtualModels, providerRuntime);
    startup.scopeDiagnostics?.forEach(() => process.stderr.write('Warning: A model scope entry could not be resolved.\n'));
    ctx.provider = startup.provider;
    const startupModel = startup.model ?? startup.provider.getConfiguredModel();
    const requestedThinking = coreThinkingLevel(cliArguments.thinking)
      ?? startup.thinkingLevel
      ?? resolveAgentThinkingLevel(settingsResolution.settings, startup.providerName, startupModel)
      ?? ctx.thinkingLevel;
    ctx.thinkingLevel = clampPublishedThinkingLevel(
      requestedThinking,
      getSupportedThinkingLevels(startup.providerName, startupModel, extensionRegistry.virtualModels, startup.provider),
    );
    sessionManager.setCompactionSettings(resolveAgentCompactionSettings(
      settingsResolution.settings,
      startup.providerName,
      startupModel,
    ));
    sessionManager.setCompactionContextWindow(resolveAgentCompactionContextWindow(startup.providerName, startupModel, startup.provider));
  } catch (error) {
    if (!(error instanceof StartupSessionSelectionCancelledError)) {
      const message = error instanceof Error ? error.message : String(error);
      if (fullscreenTerminal && !fullscreenTerminal.isActive()) process.stderr.write(`Error: ${redactOutput(message)}\n`);
      else reportError(message);
      process.exitCode = 2;
    }
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

  async function reloadKeybindings(): Promise<void> {
    if (applicationMode !== 'interactive' || earlyCleanupPromise || shuttingDown) return;
    const generation = ++keybindingGeneration;
    const source = resolveKeybindingSource({ cwd: workspaceCwd, home: homedir(),
      agentDir: settingsResolution.agentDir, agentDirTrusted: settingsResolution.agentDirTrusted,
      projectTrusted: mayLoadProjectResources(), explicitPath: keybindingFileOverride });
    if (!source.eligible || source.path !== selectedKeybindingPath) keyBindings.clearConfig();
    selectedKeybindingPath = source.path;
    if (!source.eligible) { reportError(`Keybinding source unavailable (${source.reason}).`); return; }
    if (source.kind === 'agent-directory') {
      try { await lstat(source.path!); }
      catch (error) {
        if (generation !== keybindingGeneration || earlyCleanupPromise || shuttingDown) return;
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          keyBindings.clearConfig(); return;
        }
      }
    }
    if (generation !== keybindingGeneration || earlyCleanupPromise || shuttingDown) return;
    await keyBindings.loadFromFile(source.path!);
  }
  await reloadKeybindings();

  try {
    startupSession ??= await selectStartupSession();
  } catch (error) {
    if (!(error instanceof StartupSessionSelectionCancelledError)) {
      const message = error instanceof Error ? error.message : String(error);
      // Startup selection precedes fullscreen entry; its buffered renderer is not visible yet.
      if (fullscreenTerminal && !fullscreenTerminal.isActive()) process.stderr.write(`Error: ${redactOutput(message)}\n`);
      else reportError(message);
      process.exitCode = 2;
    }
    await cleanupEarlyExit();
    return;
  }
  let currentSessionId = startupSession.id;
  let statusRevision = 0;
  let effectiveStatusModel: { provider: string; model?: string } | undefined;
  const refreshTerminalStatus = async (): Promise<void> => {
    if (printMode || shuttingDown) return;
    const revision = ++statusRevision;
    const sessionId = currentSessionId;
    const provider = ctx.provider;
    const snapshot = await createTerminalStatus({
      sessionManager, sessionId, cwd: workspaceCwd,
      sessionFile: cliArguments.noSession ? undefined : path.join(path.resolve(sessionDirectory || path.join(process.env.HOME || '.', '.ai-harness', 'sessions')), `${sessionId}.jsonl`),
      provider: effectiveStatusModel?.provider ?? provider?.getProviderType(),
      providerInstance: effectiveStatusModel ? ctx.providers.get(effectiveStatusModel.provider) : provider,
      model: effectiveStatusModel?.model ?? provider?.getConfiguredModel(),
      thinking: ctx.thinkingLevel,
      resources: {
        skills: resourceManager.listSkills().length,
        prompts: resourceManager.listPrompts().length,
        extensions: extensionRegistry.list().length,
        instructions: instructionCount,
        diagnostics: resourceDiagnosticCount + extensionDiagnosticCount
          + instructionDiagnosticCount + settingsResolution.diagnostics.length,
      },
    });
    if (revision === statusRevision && sessionId === currentSessionId && !shuttingDown) terminal.setStatus(snapshot);
  };
  const onTerminalSessionUpdate = async ({ sessionId }: { sessionId: string }): Promise<void> => {
    if (sessionId === currentSessionId) await refreshTerminalStatus();
  };
  if (!printMode) {
    sessionManager.on('session:update', onTerminalSessionUpdate);
    sessionManager.on('compaction:end', onTerminalSessionUpdate);
  }

  sessionManager.setAutoCompactionCallback(async (_sessionId, toCompact, _keptEntries, signal) => {
    const provider = ctx.provider;
    if (!provider?.validateConfig()) throw new Error('No configured provider for automatic compaction.');
    assertCompactionTranscript(toCompact);
    const messages = getSummaryModelMessages(compactionMessagesFromEntries(toCompact));
    assertCompactionTranscript(messages);
    const chat: AiProvider['chat'] = (messages, options) => extensionRegistry.chat(provider, messages, options, name => ctx.providers.get(name));
    const providerName = provider.getProviderType(), model = provider.getConfiguredModel();
    const thinking = ctx.thinkingLevel;
    const rawResponse = await chat(messages, {
      thinking,
      systemPrompt: 'Summarize this conversation while preserving decisions and unresolved tasks.',
      tools: [], maxTokens: 4096,
      signal,
    });
    const content = Object.getOwnPropertyDescriptor(rawResponse, 'content');
    if (content && 'value' in content && typeof content.value === 'string' && !content.value.trim()) {
      throw new Error('Automatic compaction produced an empty summary.');
    }
    const response = copyCompactionResponse(rawResponse);
    return {
      summary: response.content,
      provider: response.provider ?? providerName,
      model: response.model ?? model,
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
  const startupCacheNotices = printMode ? [] : await cliCacheNotices(sessionManager, currentSessionId,
    settingsResolution.settings.showCacheMissNotices !== false);
  const shownCacheNotices = new Set(startupCacheNotices.map(notice => `${currentSessionId}:${notice.id}`));
  const startupHistory = [
    ...(sessionManager.get(currentSessionId)?.messages ?? []).flatMap(message => [{
      type: message.role === 'user' || message.role === 'assistant' ? message.role : 'system' as const,
      content: redactOutput(message.content),
      timestamp: message.timestamp,
    }, ...startupCacheNotices.filter(notice => notice.afterEntryId === message.id).map(notice => ({
      type: 'system' as const, content: notice.content, timestamp: message.timestamp,
    }))]),
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
    isTrusted: () => checkProjectTrust(),
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
    if (hotkeyView) return 'Hotkeys (filter / :next / :close)> ';
    const title = sessionManager.get(currentSessionId)?.title;
    return title ? `${terminalText(redactOutput(title)).replace(/\s+/g, ' ')}: ` : '> ';
  };

  const promptBoundary = new PromptBoundaryRefresh();
  const refreshPrompt = (): void => {
    const sessionId = currentSessionId;
    void promptBoundary.refresh(sessionId, async () => {
      await refreshTerminalStatus();
      const notices = await cliCacheNotices(sessionManager, sessionId, settingsResolution.settings.showCacheMissNotices !== false);
      if (sessionId !== currentSessionId || shuttingDown || conversationRunning || isStreaming) return;
      for (const notice of notices) {
        const key = `${sessionId}:${notice.id}`;
        if (shownCacheNotices.has(key)) continue;
        shownCacheNotices.add(key);
        terminal.addTranscriptEntry({ type: 'system', content: notice.content });
        if (!fullscreenTerminal) terminal.writeOutput(notice.content);
      }
      while (shownCacheNotices.size > 1000) shownCacheNotices.delete(shownCacheNotices.values().next().value!);
    },
      id => id === currentSessionId && !printMode && !shuttingDown && !conversationRunning && !isStreaming,
      () => {
        terminal.displayStatus();
        inputDriver.setPrompt(sessionPrompt());
        inputDriver.prompt();
      },
      error => reportError(error instanceof Error ? error.message : String(error)));
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
    providerHost.abort();
    providerRuntime.close();
    keybindingGeneration++;
    keyBindings.clearAll();
    hotkeyView = undefined;
    promptBoundary.close();
    statusRevision++;
    sessionManager.off('session:update', onTerminalSessionUpdate);
    sessionManager.off('compaction:end', onTerminalSessionUpdate);
    activeAbortController?.abort();
    shellController.abort();
    streamWriter?.cancel();
    terminal.exitMessage(message);
    // A TTY exit owns the same durable barrier as headless execution. In
    // particular, /quit must not force-exit across an admitted journal append.
    void Promise.allSettled([...inputWork]).then(() => cleanupEarlyExit([() => shellController.close()])).then(() => {
      if (exitCode !== undefined) process.exitCode = exitCode;
    }, error => {
      reportError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
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
    closeHotkeys();
    if (cancelActiveOperation()) return;
    shutdown('Au revoir ! 👋', terminalMode === 'fullscreen' ? 0 : undefined);
  };

  const escapeInterrupt = (): void => {
    if (hotkeyView) { closeHotkeys(); return; }
    cancelActiveOperation();
  };

  /** Reserve physical input ownership before callbacks can initiate shutdown. */
  async function processInput(
    input: string,
    options: { allowCommands?: boolean; imageBlocks?: MessageContentBlock[] } = {},
  ): Promise<string | undefined> {
    if (shuttingDown) return undefined;
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    inputWork.add(done);
    const releaseWork = retainAgentWork();
    try { return await performInput(input, options); }
    finally { inputWork.delete(done); release(); releaseWork(); }
  }

  /** Process a command or conversation message within its owned input lifetime. */
  async function performInput(
    input: string,
    options: { allowCommands?: boolean; imageBlocks?: MessageContentBlock[] },
  ): Promise<string | undefined> {
    // Invalidate before EVERY branch/await: empty input, commands, shell and provider.
    promptBoundary.invalidate();
    statusRevision++;
    let trimmed = input.trim();
    const unprocessedQueuedInputs: InteractiveQueuedInput[] = [];
    if (!trimmed) {
      if (!printMode) inputDriver.prompt();
      return undefined;
    }

    if (!printMode) terminal.finishStartup();
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
          else if (resourceCommand === 'navigate' || resourceCommand === 'fork' || resourceCommand === 'clone' || resourceCommand === 'mcp'
            || resourceCommand === 'login') {
            const controller = new AbortController();
            const commandContext = commandHandler.getContext();
            activeAbortController = controller;
            commandContext.signal = controller.signal;
            try { await commandHandler.execute(trimmed); }
            finally {
              if (commandContext.signal === controller.signal) delete commandContext.signal;
              if (activeAbortController === controller) activeAbortController = null;
            }
          } else await commandHandler.execute(trimmed);

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
      const savedProviderName = sessionManager.get(currentSessionId)?.providerConfig?.type;
      const providerName = savedProviderName && ctx.providers.get(savedProviderName) === provider
        ? savedProviderName : provider.getProviderType();
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
            signal: operationController.signal,
          });
          if (operationController.signal.aborted) throw new Error('Request interrupted.');
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
      if (operationController.signal.aborted) throw new Error('Request interrupted.');
      await extensionRegistry.emit('agent:start', { sessionId: currentSessionId, provider: providerName });

      let activeToolCall: ToolCall | undefined;
      let activeToolOutput = '';
      let activeToolRedactor = outputCredentialRedactor.createStream();
      let finalContent = '';
      let continueConversation = true;
      while (continueConversation) {
        if (operationController.signal.aborted) throw new Error('Request interrupted.');
        const currentSession = sessionManager.get(currentSessionId);
        const suppressAllTools = cliToolsDisabled(cliArguments);
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
          codemode: builtinExtensions.codemode ? settingsResolution.settings.codemode : { enabled: false },
          toolSearchEnabled: builtinExtensions['tool-search'],
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
          selection: toolSelectionOptions(() => [
            ...mcpPrepared.tools,
            ...(mcpPrepared.currentDiscoverableTools?.() ?? mcpPrepared.discoverableTools ?? []),
          ], currentSession?.toolPreset, mcpPrepared.hasPotentialDiscoverableTools),
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
        let streamedAssistantContent = '';
        finalContent = await runToolLoop({
        ...(savedProviderName && ctx.providers.get(savedProviderName) === provider ? { provider: providerName } : {}),
        sessionManager,
        sessionId: currentSessionId,
        extensionRegistry,
        tools: toChatToolDefinitions(toolLoadout.getTools()),
        resolveTools: () => toChatToolDefinitions(toolLoadout.getTools()),
        executeTool: executeSelectedTool,
        canExecuteInParallel: name => !toolLoadout.isDynamicTool(name) && extensionRegistry.getTools()
          .some(tool => tool.name.toLowerCase() === name.toLowerCase() && tool.readOnly === true),
        getActivatedTools: (name, result) => toolLoadout.activatedTools(name, result),
        getToolResultMetadata: (name, result) => toolLoadout.resultMetadata(name, result),
        toolContext: {
          sessionManager,
          currentSessionId,
          provider,
          specializedProviders: () => getConfiguredSpecializedProviders(ctx.providers),
          providerName,
          toolPreset: currentSession?.toolPreset,
          cwd: workspaceCwd,
          workspaceId: workspaceDescriptor.id,
          projectTrusted: isProjectTrusted(),
          isProjectTrusted: checkProjectTrust,
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
        streamTurn: async (messages, tools) => {
          const turnSessionId = currentSessionId;
          let partialContent = '', partialReasoning = '';
          streamedAssistantContent = '';
          let turnProvider = providerName, turnModel = providerModel;
          return streamProviderTurn({
          provider,
          providerName,
          model: providerModel,
          sessionId: currentSessionId,
          sessionManager,
          messages,
          tools,
          systemPrompt: instructionSystemPrompt,
          thinking: ctx.thinkingLevel,
          thinkingBudgets: settingsResolution.settings.thinkingBudgets,
          cacheWarming: settingsResolution.settings.cacheWarming,
          resolveProvider: name => ctx.providers.get(name),
          signal: operationController.signal,
          extensionRegistry,
          maxRetries: settingsResolution.settings.retry?.enabled === false
            ? 0 : settingsResolution.settings.retry?.maxRetries ?? 3,
          retryDelayMs: settingsResolution.settings.retry?.baseDelayMs ?? 2_000,
          retryMaxDelayMs: settingsResolution.settings.retry?.maxAgentDelayMs ?? 60_000,
          redactText: redactOutput,
          redactJson: value => outputCredentialRedactor.redactJson(value),
          createTextRedactor: () => outputCredentialRedactor.createStream(),
          onStart: async (effectiveProvider, effectiveModel) => {
            turnProvider = effectiveProvider;
            turnModel = effectiveModel;
            promptBoundary.invalidate();
            effectiveStatusModel = { provider: effectiveProvider, model: effectiveModel };
            await refreshTerminalStatus();
            if (shuttingDown || operationController.signal.aborted) return;
            streamWriter = printMode ? null : terminal.startStreaming();
            isStreaming = true;
            keyBindings.setStreaming(true);
            return jsonOutput?.events.startAssistant(effectiveProvider, effectiveModel);
          },
          onTextDelta: chunk => {
            partialContent += chunk;
            streamedAssistantContent = partialContent;
            if (!isStreaming) return;
            streamWriter?.write(chunk);
            return jsonOutput?.events.textDelta(chunk);
          },
          onReasoningDelta: delta => {
            partialReasoning += delta;
            return isStreaming ? jsonOutput?.events.reasoningDelta(delta) : undefined;
          },
          onComplete: () => {
            isStreaming = false;
            keyBindings.setStreaming(false);
            streamWriter?.finish();
          },
          onError: async error => {
            isStreaming = false;
            keyBindings.setStreaming(false);
            // The shared loop cannot save a response from a rejected turn. Retain
            // only delivered, already-redacted output; never pending tool calls,
            // invented usage, cancelled work or an automatic compaction request.
            if (!operationController.signal.aborted && (partialContent || partialReasoning)) {
              await sessionManager.addMessage(turnSessionId, {
                role: 'assistant', content: partialContent,
                blocks: [
                  ...(partialReasoning ? [{ type: 'reasoning' as const, text: partialReasoning }] : []),
                  ...(partialContent ? [{ type: 'text' as const, text: partialContent }] : []),
                ],
                provider: turnProvider, model: turnModel,
                metadata: { outputError: redactOutput(error instanceof Error ? error.message : String(error)).slice(0, 4_000) },
              }, { skipAutoCompaction: true, signal: operationController.signal });
            }
            return jsonOutput?.events.finishAssistantError(error, operationController.signal.aborted);
          },
          onRetryStart: ({ attempt, maxAttempts, delayMs, error }) => (
            jsonOutput?.events.retryStart(attempt, maxAttempts, delayMs, error)
          ),
          onRetryEnd: ({ success, attempt, finalError }) => (
            jsonOutput?.events.retryEnd(success, attempt, finalError)
          ),
        });
        },
        onToolProgress: async progress => {
          if (jsonOutput) await jsonOutput.events.toolProgress(progress);
          else if (!printMode && progress.content) reportOutput(`[${progress.toolName}] ${progress.content}`);
        },
        onCodemodeProgress: progress => {
          if (jsonOutput) void jsonOutput.events.codemodeProgress(progress).catch(error => reportError(String(error)));
          else reportOutput(`[codemode ${progress.call.id}] ${progress.call.name}: ${progress.call.state}`);
        },
        onAssistantResponse: response => {
          // Regular output cannot rewrite previously streamed lines. Show the
          // accepted final replacement explicitly; fullscreen redraws history.
          if (!printMode && !fullscreenTerminal && response.content !== streamedAssistantContent) {
            terminal.displayAssistantMessage(response.content);
          }
          return jsonOutput?.events.finishAssistant(response);
        },
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
          onFinalResponse: (content, response) => {
            if (printMode && response.stopReason === 'length') outputLimitReached = true;
            if (!printMode && content) terminal.addTranscriptEntry({ type: 'assistant', content });
          },
          signal: operationController.signal,
          redactText: redactOutput,
        });

        if (operationController.signal.aborted) throw new Error('Request interrupted.');
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

      if (jsonOutput) await jsonOutput.events.endAgent(false);
      return finalContent;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Une erreur inconnue est survenue.';
      await jsonOutput?.events.failAgent(error, activeAbortController?.signal.aborted ?? false, false);
      await extensionRegistry.emit('agent:error', { sessionId: currentSessionId, error: errorMessage });
      if (printMode) throw error;
      if (!isStreaming && !activeAbortController?.signal.aborted) reportError(errorMessage);
      return undefined;
    } finally {
      if (activeAbortController?.signal.aborted) await mcpHost.releaseSession(currentSessionId);
      else mcpHost.finishPrompt(currentSessionId);
      await jsonOutput?.events.settleAgent();
      if (!printMode && (interactiveQueue.size() > 0 || unprocessedQueuedInputs.length > 0)) {
        const restored = restoreQueuedInput(inputDriver.getValue(), unprocessedQueuedInputs);
        if (restored !== undefined) inputDriver.replaceValue(restored);
      }
      isStreaming = false;
      streamWriter = null;
      activeAbortController = null;
      conversationRunning = false;
      keyBindings.setStreaming(false);
      effectiveStatusModel = undefined;
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
    if (shuttingDown) return;
    if (hotkeyView) {
      if (hotkeyView.update(input) === 'close') closeHotkeys();
      else renderHotkeys();
      return;
    }
    if (input.trim()) terminal.finishStartup();
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
    if (input.startsWith('--')) return completeCliOptions(input, extensionRegistry.getOptions());
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
    // Own signals through provider settlement and the existing bounded cleanup,
    // without forcing an exit across admitted journal writes or JSON flushing.
    let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
    const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
      interrupted ??= signal;
      process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
      activeAbortController?.abort();
      providerHost.abort();
      providerRuntime.close();
    };
    const interruptPrint = (): void => stop('SIGINT');
    const terminatePrint = (): void => stop('SIGTERM');
    process.on('SIGINT', interruptPrint);
    process.on('SIGTERM', terminatePrint);
    try {
      await jsonOutput?.events.sessionHeader(activeSession, workspaceCwd);
      let finalContent: string | undefined;
      for (const prompt of initialPrompts) {
        if (interrupted) break;
        finalContent = await processInput(prompt.content, {
          allowCommands: false,
          imageBlocks: prompt.images,
        });
      }
      if (!interrupted && applicationMode === 'print') process.stdout.write(`${redactOutput(finalContent ?? '')}\n`);
      if (outputLimitReached) {
        process.stderr.write('Warning: Model output limit reached; the response may be incomplete.\n');
        process.exitCode = 1;
      }
    } catch (error) {
      if (!interrupted) {
        process.stderr.write(`Error: ${redactOutput(error instanceof Error ? error.message : String(error))}\n`);
        process.exitCode = 1;
      }
    } finally {
      try { await cleanupEarlyExit(); }
      finally {
        process.off('SIGINT', interruptPrint);
        process.off('SIGTERM', terminatePrint);
        if (interrupted) {
          process.stderr.write('Error: Request interrupted.\n');
          process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
        }
      }
    }
    return;
  }

  function renderHotkeys(): void {
    if (!hotkeyView || shuttingDown) return;
    inputDriver.setPrompt(sessionPrompt());
    if (fullscreenTerminal) fullscreenTerminal.render();
    else terminal.displayCommand('hotkeys', hotkeyView.render(process.stdout.columns ?? 80, 14).join('\n'));
    inputDriver.prompt();
  }
  function closeHotkeys(): void {
    if (!hotkeyView) return;
    hotkeyView = undefined;
    if (shuttingDown) return;
    promptBoundary.invalidate();
    if (restoreHotkeyDraft) restoreHotkeyDraft();
    else inputDriver.replaceValue(hotkeyDraft.value, hotkeyDraft.cursor);
    restoreHotkeyDraft = undefined;
    inputDriver.setPrompt(sessionPrompt());
    inputDriver.prompt(true);
  }
  function toggleHotkeys(): void {
    if (shuttingDown) return;
    if (hotkeyView) { closeHotkeys(); return; }
    promptBoundary.invalidate();
    const value = inputDriver.getValue();
    hotkeyDraft = { value, cursor: inputDriver.getCursor?.() ?? value.length };
    restoreHotkeyDraft = inputDriver.suspendDraft?.();
    hotkeyView = new HotkeyView(() => keyBindings.getActionViews(), redactOutput);
    inputDriver.replaceValue('');
    renderHotkeys();
  }
  function hotkeyViewKey(key: readline.Key): boolean | undefined {
    if (!hotkeyView) return undefined;
    // Native escape disambiguation and interrupt ownership remain with the driver.
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return false;
    if ((key.ctrl && key.name === 'd') || key.name === 'f1' || (key.meta && key.name === 'k')) {
      closeHotkeys(); return true;
    }
    if (key.name === 'up' || key.name === 'pageup' || key.name === 'down' || key.name === 'pagedown') {
      hotkeyView.update(key.name === 'up' || key.name === 'pageup' ? ':prev' : ':next');
      renderHotkeys(); return true;
    }
    return false;
  }
  for (const action of TERMINAL_ACTIONS) {
    keyBindings.registerAction(action.id, {
      description: action.description,
      when: () => !shuttingDown && Boolean(inputDriver.performAction)
        && (action.id !== 'app.exit' || inputDriver.getValue().length === 0),
      handler: async context => {
        if (action.id === 'app.hotkeys') { toggleHotkeys(); return; }
        if (action.id === 'app.help') { terminal.displayUserMessage('/help'); terminal.showHelp(); inputDriver.prompt(true); return; }
        await inputDriver.performAction?.(action.id, context.event as readline.Key | undefined);
      },
    });
  }
  fullscreenTerminal?.setViewProvider(() => hotkeyView?.render(
    process.stdout.columns ?? 80, Math.max(1, (process.stdout.rows ?? 24) - 8),
  ));
  await refreshTerminalStatus();
  await activateSystemThemeProbe();
  const keyInput = new KeypressFilteredInput(process.stdin);
  filteredTerminalInput = keyInput;
  if (fullscreenTerminal) {
    const fullscreenInput = new FullscreenInput(fullscreenTerminal, {
      onLine: dispatchLine,
      onInterrupt: interrupt,
      onEscape: escapeInterrupt,
      onExit: () => shutdown('Au revoir ! 👋', 0),
      onError: error => terminal.showError(error.message),
      complete: completeCommands,
      onDequeue: currentInput => restoreQueuedInput(currentInput),
      recordHistory: () => !hotkeyView,
      onExternalEditor: async currentInput => {
        process.stdout.write('\x1b[?2004l');
        fullscreenTerminal.leave();
        try {
          return await editInExternalEditor(currentInput, settingsResolution.settings.externalEditor);
        } finally {
          if (!shuttingDown) { fullscreenTerminal.enter(); process.stdout.write('\x1b[?2004h'); }
        }
      },
    }, keyInput);
    keyInput.setPasteHandler(value => {
      if (value === undefined) reportError('Paste exceeds 65536 bytes; discarded.');
      else fullscreenInput.insertText(value);
    });
    const releaseGate = keyInput.setKeypressGate((_text, key) => {
      const effective = fullscreenInput.keyForBindings(key);
      const modal = hotkeyViewKey(effective);
      if (modal !== undefined) return modal;
      if ((!key.ctrl && !key.shift && key.name === 'escape')
        || (key.ctrl && !key.meta && !key.shift && (key.name === 'c' || key.name === 'd'))) return false;
      const handled = keyBindings.handleKeypress(effective, { currentInput: fullscreenInput.getValue() });
      if (handled) fullscreenInput.cancelPendingEscape();
      return handled;
    });
    const resize = (): void => fullscreenTerminal.render();
    process.stdout.on('resize', resize);
    inputDriver = {
      prompt: () => fullscreenInput.prompt(),
      close: () => { process.stdout.off('resize', resize); releaseGate(); fullscreenInput.close(); },
      setPrompt: prompt => fullscreenInput.setPrompt(prompt),
      getValue: () => fullscreenInput.getValue(),
      getCursor: () => fullscreenInput.getCursor(),
      suspendDraft: () => fullscreenInput.suspendDraft(),
      replaceValue: (value, cursor) => fullscreenInput.replaceValue(value, cursor),
      performAction: action => fullscreenInput.performAction(action),
    };
    // The operational screen must exist even when the welcome is suppressed.
    fullscreenTerminal.enter();
    if (startupDisplay.header) terminal.welcome();
    fullscreenInput.setPrompt(sessionPrompt());
    fullscreenInput.start();
  } else {
    const rl = readline.createInterface({
      input: filteredTerminalInput,
      output: process.stdout,
      prompt: sessionPrompt(),
      completer: (line: string): [string[], string] => [completeCommands(line), line],
      escapeCodeTimeout: TERMINAL_ESCAPE_CODE_TIMEOUT_MS,
      // Node 24's native history normalizes/reverses multiline entries. Own exact drafts instead.
      historySize: 0,
    });
    const regularHistory: string[] = [];
    let historyIndex = 0, historyDraft = '';
    const rememberRegularLine = (value: string): void => {
      if (!hotkeyView && value.trim()) {
        regularHistory.push(value); if (regularHistory.length > 100) regularHistory.shift();
      }
      historyIndex = regularHistory.length; historyDraft = '';
    };
    let regularClosed = false;
    let regularEditing = false;
    const editor = new EditorState();
    const replaceReadlineValue = (value: string, cursor = value.length): void => {
      if (regularClosed || shuttingDown) return;
      const index = Number.isFinite(cursor) ? Math.max(0, Math.min(value.length, cursor)) : value.length;
      // Node 24 exposes writable line/cursor state (typed readonly by @types/node).
      // write(value) would submit embedded LF; publish the owned draft before the public redraw.
      Object.assign(rl, { line: value, cursor: index });
      rl.prompt(true);
    };
    const insertRegularText = (text: string): void => {
      if (regularClosed || regularEditing || shuttingDown) return;
      editor.replace(rl.line, rl.cursor); editor.insert(text);
      const draft = editor.snapshot(); replaceReadlineValue(draft.value, draft.cursor);
    };
    keyInput.setPasteHandler(value => {
      if (value === undefined) reportError('Paste exceeds 65536 bytes; discarded.');
      else insertRegularText(value);
    });
    const escapeSequence = new TerminalEscapeSequence(escapeInterrupt);
    const submitRegularFollowUp = (): void => {
      const currentInput = rl.line;
      rememberRegularLine(currentInput); editor.reset();
      replaceReadlineValue('');
      void dispatchLine(currentInput, 'follow-up')
        .catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
    };
    const releaseGate = keyInput.setKeypressGate((text, key) => {
      if (regularClosed || shuttingDown) return true;
      if (key.name === 'escape' && !key.ctrl && !key.shift) {
        escapeSequence.deferEscape(); return true;
      }
      const escapedEnter = escapeSequence.consumeFollowingKey(key);
      const effective = escapedEnter ? { ...key, name: 'enter', meta: true } : key;
      const modal = hotkeyViewKey(effective);
      if (modal !== undefined) return modal;
      if (key.ctrl && !key.meta && !key.shift && key.name === 'c') return false;
      if (key.ctrl && !key.meta && !key.shift && key.name === 'd') {
        if (!rl.line) { shutdown('Au revoir ! 👋', 0); return true; }
        return false;
      }
      if (keyBindings.handleKeypress(effective, { currentInput: rl.line })) return true;
      if (text && !key.ctrl && !key.meta && [...text].every(character => character >= ' ' && character !== '\x7f')) {
        insertRegularText(text); return true;
      }
      return false;
    });
    inputDriver = {
      prompt: (preserveCursor = false) => { if (!regularClosed) rl.prompt(preserveCursor); },
      close: () => { regularClosed = true; releaseGate(); escapeSequence.cancel(); rl.close(); },
      setPrompt: prompt => rl.setPrompt(prompt),
      getValue: () => rl.line,
      getCursor: () => rl.cursor,
      suspendDraft: () => {
        editor.replace(rl.line, rl.cursor);
        const restore = editor.suspend();
        return () => { restore(); const draft = editor.snapshot(); replaceReadlineValue(draft.value, draft.cursor); };
      },
      replaceValue: replaceReadlineValue,
      performAction: async (action, event) => {
        if (regularClosed || shuttingDown) return false;
        escapeSequence.cancel();
        if (action === 'app.interrupt') { interrupt(); return true; }
        if (action === 'app.escape') { escapeInterrupt(); return true; }
        if (action === 'app.exit') { if (!rl.line) shutdown('Au revoir ! 👋', 0); return true; }
        if (action === 'input.followUp') { submitRegularFollowUp(); return true; }
        if (action === 'input.dequeue') {
          const restored = restoreQueuedInput(rl.line);
          if (restored !== undefined) replaceReadlineValue(restored);
          else { terminal.scrollUp(20); rl.prompt(true); }
          return true;
        }
        if (action === 'transcript.up') { terminal.scrollUp(20); rl.prompt(true); return true; }
        if (action === 'transcript.down') { terminal.scrollDown(20); rl.prompt(true); return true; }
        if (action === 'editor.previous' || action === 'editor.next') {
          if (historyIndex === regularHistory.length) historyDraft = rl.line;
          historyIndex = Math.max(0, Math.min(regularHistory.length, historyIndex + (action === 'editor.previous' ? -1 : 1)));
          replaceReadlineValue(historyIndex === regularHistory.length ? historyDraft : regularHistory[historyIndex]!);
          return true;
        }
        editor.replace(rl.line, rl.cursor);
        if (editor.perform(action)) {
          const draft = editor.snapshot(); replaceReadlineValue(draft.value, draft.cursor); return true;
        }
        if (action === 'input.externalEditor') {
          if (regularEditing) return false;
          regularEditing = true;
          const draft = rl.line, cursor = rl.cursor;
          replaceReadlineValue('');
          process.stdout.write('\x1b[?2004l');
          try {
            const content = await editInExternalEditor(draft, settingsResolution.settings.externalEditor);
            if (!regularClosed && !shuttingDown) replaceReadlineValue(content ?? draft, content === undefined ? cursor : content.length);
          } catch (error) {
            if (!regularClosed && !shuttingDown) { replaceReadlineValue(draft, cursor); reportError(error instanceof Error ? error.message : String(error)); }
          } finally {
            regularEditing = false;
            if (!regularClosed && !shuttingDown) { process.stdout.write('\x1b[?2004h'); rl.prompt(true); }
          }
          return true;
        }
        const key = Object.hasOwn(EDITOR_ACTION_KEYS, action) ? EDITOR_ACTION_KEYS[action] : undefined;
        if (!key) return false;
        const native = action === 'input.submit' && (event?.name === 'enter' || event?.name === 'return')
          ? { ...key, name: event.name, sequence: event.sequence } : key;
        rl.write(null, native); return true;
      },
    };
    terminal.setReadline(rl);
    if (startupDisplay.header) terminal.welcome();

    rl.on('SIGINT', interrupt);
    rl.on('line', input => {
      rememberRegularLine(input); editor.reset();
      void dispatchLine(input, 'steer')
        .catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
    });
    rl.prompt();
  }

  process.stdout.write('\x1b[?2004h');

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
  if (process.stdout.isTTY) process.stdout.write('\u001b[?2004l\u001b[?25h\u001b[?1049l');
  console.error(chalk.red('Erreur fatale :'), outputCredentialRedactor.redact(
    error instanceof Error ? error.message : String(error),
  ));
  if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1;
});
