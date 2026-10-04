#!/usr/bin/env node
// ============================================================
// AiHarness CLI - Regular readline and fullscreen TUI entry point
// ============================================================

import {
  clampPublishedThinkingLevel,
  DEFAULT_CODING_TOOL_NAMES,
  ExtensionRegistry,
  getSupportedThinkingLevels,
  JsonlSessionStore,
  loadAgentSettings,
  loadPromptFiles,
  normalizeProviderUsage,
  resolveInstructionPrompt,
  resolveAgentCompactionSettings,
  resolveAgentDefaultTools,
  resolveAgentResourcePaths,
  resolveAgentThinkingLevel,
  selectAgentResourcePaths,
  registerWorkspaceTools,
  selectRegisteredTools,
  SessionManager,
  toChatToolDefinitions,
  truncateToolTail,
  unknownToolNames,
  WorkspaceManager,
} from '@ai-harness/core';
import type {
  Message,
  MessageContentBlock,
  ResolvedAgentSettings,
  Session,
  SessionEntry,
  ThinkingLevel,
  ToolCall,
} from '@ai-harness/core';
import readline from 'readline';
import chalk from 'chalk';
import { CommandHandler } from './commands/handler.js';
import { TerminalUI } from './tui/terminal-ui.js';
import { FullscreenUI } from './tui/fullscreen-ui.js';
import { FullscreenInput } from './tui/fullscreen-input.js';
import { resolveTerminalMode } from './tui/mode.js';
import { KeyBindingManager } from './utils/keybinding-manager.js';
import { ExtensionLoader } from './extensions/extension-loader.js';
import { runToolLoop } from './agent/tool-loop.js';
import { streamProviderTurn } from './agent/provider-turn.js';
import { ResourceManager } from './resources/resource-manager.js';
import { editInExternalEditor } from './utils/system-integration.js';
import { runRpcMode } from './rpc/rpc-server.js';
import { ProjectTrustManager } from './security/project-trust.js';
import { ThemeManager } from './tui/theme-manager.js';
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
import { reserveProcessStdoutForJson, toJsonProtocolUsage } from './cli/json-output.js';
import { InteractiveShellController } from './cli/shell-controller.js';
import { formatConfiguredModelList } from './cli/model-list.js';
import {
  resolveStartupSession,
  resolveStartupSessionDirectory,
  StartupSessionSelectionCancelledError,
} from './sessions/startup-session.js';

interface InputDriver {
  prompt(): void;
  close(): void;
  setPrompt(prompt: string): void;
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
    process.stderr.write(`Warning: Settings ignored (${diagnostic.path})${field}: ${diagnostic.message}\n`);
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
    `Project settings: ${resolved.paths.project} (${resolved.projectTrusted ? 'trusted' : 'blocked except sessionDir'})`,
    ...values.map(([name, value, field]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)} [${source(field)}]`),
  ].join('\n');
}

async function chooseStartupSession(sessions: Session[]): Promise<Session | undefined> {
  if (sessions.length === 0) return undefined;
  process.stdout.write('Stored sessions:\n');
  sessions.forEach((session, index) => {
    process.stdout.write(`  ${index + 1}. ${session.title || 'Untitled'} (${session.id})${session.cwd ? ` — ${session.cwd}` : ''}\n`);
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
  let cliArguments: ReturnType<typeof parseCliArguments>;
  try {
    cliArguments = parseCliArguments(rawArguments);
  } catch (error) {
    const message = error instanceof CliArgumentError ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 2;
    return;
  }
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
      const trustManager = new ProjectTrustManager();
      await trustManager.load();
      const cwd = process.cwd();
      reportAgentSettingsDiagnostics(await loadAgentSettings({
        cwd,
        projectTrusted: await trustManager.isTrusted(cwd),
      }));
      const search = typeof cliArguments.listModels === 'string' ? cliArguments.listModels : undefined;
      process.stdout.write(`${await formatConfiguredModelList(createConfiguredProviders(), search)}\n`);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const applicationMode = resolveCliApplicationMode(cliArguments, {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });
  if (applicationMode === 'rpc') {
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
      tools: cliArguments.tools,
      excludeTools: cliArguments.excludeTools,
      noBuiltinTools: cliArguments.noBuiltinTools,
      noTools: cliArguments.noTools,
    });
    return;
  }
  const jsonOutput = applicationMode === 'json' ? reserveProcessStdoutForJson() : undefined;
  const printMode = applicationMode === 'print' || applicationMode === 'json';
  let pipedInput: string | undefined;
  if (printMode && process.stdin.isTTY !== true) {
    try { pipedInput = await readPipedStdin(); }
    catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
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
  const trustManager = new ProjectTrustManager();
  await trustManager.load();
  let settingsResolution = await loadAgentSettings({
    cwd: workspaceCwd,
    projectTrusted: await trustManager.isTrusted(workspaceCwd),
  });
  reportAgentSettingsDiagnostics(settingsResolution);
  const reloadAgentSettings = async (): Promise<void> => {
    settingsResolution = await loadAgentSettings({
      cwd: workspaceCwd,
      projectTrusted: await trustManager.isTrusted(workspaceCwd),
    });
    reportAgentSettingsDiagnostics(settingsResolution);
  };
  const sessionDirectory = resolveStartupSessionDirectory(
    cliArguments,
    workspaceCwd,
    process.env,
    undefined,
    settingsResolution.settings.sessionDir,
  );
  const store = new JsonlSessionStore(sessionDirectory, !cliArguments.noSession);
  const sessionManager = new SessionManager();
  sessionManager.setCompactionSettings(resolveAgentCompactionSettings(settingsResolution.settings));
  if (!cliArguments.noSession) {
    sessionManager.setStore(store);
    await sessionManager.loadAllSessions();
  }

  const configuredTheme = cliArguments.theme ?? settingsResolution.settings.theme;
  const theme = await ThemeManager.load(configuredTheme === 'system' ? 'auto' : configuredTheme).catch(error => {
    console.error(`Thème ignoré : ${error instanceof Error ? error.message : String(error)}`);
    return ThemeManager.load('dark');
  });
  const fullscreenSupported = !printMode && FullscreenUI.isSupported();
  const terminalMode = resolveTerminalMode(
    rawArguments,
    process.env,
    fullscreenSupported,
    settingsResolution.settings.tuiMode,
  );
  const fullscreenTerminal = !printMode && terminalMode === 'fullscreen'
    ? new FullscreenUI({ title: 'AiHarness CLI', theme })
    : null;
  const terminal: TerminalUI = fullscreenTerminal ?? new TerminalUI({ title: 'AiHarness CLI', theme });
  let streamWriter: ReturnType<TerminalUI['startStreaming']> | null = null;
  let isStreaming = false;
  let isMultiLineMode = false;
  let shuttingDown = false;
  let activeAbortController: AbortController | null = null;
  let inputDriver: InputDriver = {
    prompt: () => undefined,
    close: () => undefined,
    setPrompt: () => undefined,
  };
  const reportError = (message: string): void => {
    if (printMode) process.stderr.write(`Error: ${message}\n`);
    else terminal.showError(message);
  };
  const reportOutput = (message: string): void => {
    if (!printMode) terminal.writeOutput(message);
  };

  const createResourceManager = (): ResourceManager => new ResourceManager({
    cwd: workspaceCwd,
    agentDir: settingsResolution.agentDir,
    projectTrusted: settingsResolution.projectTrusted,
    globalSkillPaths: resolveAgentResourcePaths(settingsResolution, 'skills', undefined, 'global'),
    projectSkillPaths: resolveAgentResourcePaths(settingsResolution, 'skills', undefined, 'project'),
    globalPromptPaths: resolveAgentResourcePaths(settingsResolution, 'prompts', undefined, 'global'),
    projectPromptPaths: resolveAgentResourcePaths(settingsResolution, 'prompts', undefined, 'project'),
  });
  let resourceManager = createResourceManager();
  const resourceLoadResult = await resourceManager.loadAll();
  for (const error of resourceLoadResult.errors) reportError(`Ressource : ${error.message}`);

  const workspaceDescriptor = await workspaceManager.describe(
    workspaceCwd,
    settingsResolution.projectTrusted,
  );

  const extensionRegistry = new ExtensionRegistry();
  extensionRegistry.attachSessionManager(sessionManager);
  await registerWorkspaceTools(extensionRegistry, workspaceManager, {
    shellPath: () => settingsResolution.settings.shellPath,
    shellCommandPrefix: () => settingsResolution.settings.shellCommandPrefix,
  });
  let instructionSystemPrompt = '';
  const reloadInstructionPrompt = async (): Promise<void> => {
    const resolved = await resolveInstructionPrompt({
      cwd: workspaceCwd,
      projectTrusted: await trustManager.isTrusted(workspaceCwd),
      noContextFiles: cliArguments.noContextFiles,
      systemPromptInput: cliArguments.systemPrompt,
      appendSystemPromptInputs: cliArguments.appendSystemPrompts,
    });
    instructionSystemPrompt = resolved.systemPrompt;
    for (const diagnostic of resolved.diagnostics) {
      const message = `Instruction ignorée (${diagnostic.path}) : ${diagnostic.message}`;
      if (printMode) process.stderr.write(`Warning: ${message}\n`);
      else terminal.writeOutput(`Avertissement : ${message}`);
    }
  };
  try {
    await reloadInstructionPrompt();
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    await extensionRegistry.shutdown();
    process.exitCode = 2;
    jsonOutput?.restore();
    return;
  }
  const extensionLoader = new ExtensionLoader(extensionRegistry, {
    paths: () => configuredExtensionPaths(cliArguments.extensions, settingsResolution),
    isProjectTrusted: () => trustManager.isTrustedSync(workspaceCwd),
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
    await reloadInstructionPrompt();
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

  const selectedTools = () => {
    const registered = extensionRegistry.getTools();
    const unknown = unknownToolNames(registered, cliArguments.tools, cliArguments.excludeTools);
    if (unknown.length) throw new Error(`Unknown tool name(s): ${unknown.join(', ')}.`);
    const configuredDefaults = resolveAgentDefaultTools(
      settingsResolution.settings.defaultTools,
      DEFAULT_CODING_TOOL_NAMES,
    );
    return selectRegisteredTools(registered, {
      allowedTools: cliArguments.tools,
      excludedTools: cliArguments.excludeTools,
      defaultTools: configuredDefaults ?? DEFAULT_CODING_TOOL_NAMES,
      builtInExtensionId: 'builtin:workspace-tools',
      includeNonBuiltInByDefault: true,
      noBuiltInTools: cliArguments.noBuiltinTools,
      noTools: cliArguments.noTools,
    });
  };
  try { selectedTools(); }
  catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    await extensionRegistry.shutdown();
    process.exitCode = 2;
    jsonOutput?.restore();
    return;
  }

  const effectiveModelSettings = applyAgentModelSettings({
    provider: cliArguments.provider,
    model: cliArguments.model,
    models: cliArguments.models,
    apiKey: cliArguments.apiKey,
  }, settingsResolution.settings);

  const commandHandler = new CommandHandler(
    sessionManager,
    store,
    terminal,
    extensionRegistry,
    trustManager,
    {
      cwd: workspaceCwd,
      workspaceId: workspaceDescriptor.id,
      enabledToolNames: () => selectedTools().map(tool => tool.name),
      modelPatterns: effectiveModelSettings.modelPatterns,
      settingsInfo: () => formatAgentSettingsSummary(settingsResolution),
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
    await extensionRegistry.shutdown();
    process.exitCode = 2;
    jsonOutput?.restore();
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
    await extensionRegistry.shutdown();
    process.exitCode = 1;
    jsonOutput?.restore();
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
    await extensionRegistry.shutdown();
    process.exitCode = 2;
    jsonOutput?.restore();
    return;
  }

  const keyBindings = new KeyBindingManager();
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
    await extensionRegistry.shutdown();
    jsonOutput?.restore();
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
      content: message.content,
      timestamp: message.timestamp,
    })),
    ...(sessionManager.get(currentSessionId)?.commands ?? []).map(command => ({
      type: 'command' as const,
      content: `$ ${command.command}\n${command.output ?? ''}\n[${command.status}${command.exitCode === undefined ? '' : ` · exit ${command.exitCode}`}]`,
      timestamp: command.timestamp,
    })),
  ].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  for (const entry of startupHistory) {
    terminal.addTranscriptEntry({ type: entry.type, content: entry.content });
  }

  const shellController = new InteractiveShellController(sessionManager, terminal, {
    getSessionId: () => currentSessionId,
    getCwd: () => workspaceCwd,
    isTrusted: cwd => trustManager.isTrusted(cwd),
    reportError,
  }, {
    shellPath: () => settingsResolution.settings.shellPath,
    commandPrefix: () => settingsResolution.settings.shellCommandPrefix,
  });

  const sessionPrompt = (): string => {
    const title = sessionManager.get(currentSessionId)?.title;
    return title ? `${title}: ` : '> ';
  };

  const refreshPrompt = (): void => {
    inputDriver.setPrompt(sessionPrompt());
    inputDriver.prompt();
  };

  const shutdown = (message: string, exitCode?: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    activeAbortController?.abort();
    shellController.abort();
    streamWriter?.cancel();
    inputDriver?.close();
    terminal.exitMessage(message);
    void shellController.close().finally(() => extensionRegistry.shutdown()).finally(() => {
      if (exitCode !== undefined) process.exit(exitCode);
    });
  };

  const interrupt = (): void => {
    if (shellController.abort()) {
      terminal.addTranscriptEntry({ type: 'system', content: '[Commande interrompue]' });
      return;
    }

    if (activeAbortController) {
      activeAbortController.abort();
      streamWriter?.cancel();
      isStreaming = false;
      streamWriter = null;
      keyBindings.setStreaming(false);
      terminal.addTranscriptEntry({ type: 'system', content: '[Interrompu]' });
      refreshPrompt();
      return;
    }

    if (isMultiLineMode) {
      terminal.cancelMultiLineEditor();
      isMultiLineMode = false;
      refreshPrompt();
      return;
    }

    shutdown('Au revoir ! 👋', terminalMode === 'fullscreen' ? 0 : undefined);
  };

  /** Process a command or conversation message. */
  async function processInput(
    input: string,
    options: { allowCommands?: boolean; imageBlocks?: MessageContentBlock[] } = {},
  ): Promise<string | undefined> {
    let trimmed = input.trim();
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
      const [resourceCommand, ...resourceArgs] = trimmed.slice(1).split(/\s+/);
      if (resourceCommand === 'skills') {
        const skills = resourceManager.listSkills();
        reportOutput(skills.length
          ? skills.map(skill => `• ${skill.name} — ${skill.description}${skill.disableModelInvocation ? ' [explicite uniquement]' : ''}`).join('\n')
          : 'Aucun skill découvert.');
        refreshPrompt();
        return undefined;
      }
      if (resourceCommand === 'prompts') {
        const prompts = resourceManager.listPrompts();
        reportOutput(prompts.length
          ? prompts.map(prompt => `• /${prompt.name}${prompt.description ? ` — ${prompt.description}` : ''}`).join('\n')
          : 'Aucun prompt découvert.');
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

      const providerName = String((provider as unknown as { config?: { type?: string } }).config?.type ?? 'unknown');
      const providerModel = (provider as unknown as { config?: { model?: string } }).config?.model;
      const agentHook = await extensionRegistry.runBefore('before:agent', {
        sessionId: currentSessionId,
        provider: providerName,
        input: trimmed,
      });
      if (agentHook.cancelled) {
        throw new Error(agentHook.reason ?? "Requête annulée par un hook d'extension.");
      }
      const userInput = agentHook.data.input.trim();
      if (!userInput) throw new Error("Requête annulée : le hook d'extension a produit une entrée vide.");
      const userBlocks: MessageContentBlock[] = [
        { type: 'text', text: userInput },
        ...(options.imageBlocks ?? []),
      ];
      if (!printMode) terminal.addTranscriptEntry({ type: 'user', content: userInput });
      await jsonOutput?.events.startAgent(userInput, userBlocks);
      await sessionManager.addMessage(currentSessionId, {
        role: 'user',
        content: userInput,
        blocks: userBlocks,
      });
      if (!printMode) terminal.displayUserMessage(userInput);

      const operationController = new AbortController();
      activeAbortController = operationController;
      await extensionRegistry.emit('agent:start', { sessionId: currentSessionId, provider: providerName });

      let activeToolCall: ToolCall | undefined;
      let activeToolOutput = '';
      const finalContent = await runToolLoop({
        sessionManager,
        sessionId: currentSessionId,
        extensionRegistry,
        tools: toChatToolDefinitions(selectedTools()),
        toolContext: {
          sessionManager,
          currentSessionId,
          provider,
          providerName,
          cwd: workspaceCwd,
          workspaceId: workspaceDescriptor.id,
          projectTrusted: await trustManager.isTrusted(workspaceCwd),
          onProcessOutput: chunk => {
            if (!activeToolCall) return;
            activeToolOutput = truncateToolTail(activeToolOutput + chunk).content;
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
          const event = jsonOutput?.events.toolExecutionStart(call);
          if (!printMode) {
            terminal.addTranscriptEntry({ type: 'command', content: `[Tool] ${call.name}` });
            terminal.displayCommand('tool', `${call.name}(${JSON.stringify(call.input)})`);
          }
          return event;
        },
        onToolResult: result => {
          const event = jsonOutput?.events.toolExecutionEnd(result);
          activeToolCall = undefined;
          activeToolOutput = '';
          if (!printMode) terminal.displayCommand(result.call.name, result.content);
          return event;
        },
        onTurnEnd: () => jsonOutput?.events.endTurn(),
        onFinalResponse: content => {
          if (!printMode && content) terminal.addTranscriptEntry({ type: 'assistant', content });
        },
        signal: operationController.signal,
      });

      await extensionRegistry.emit('agent:end', {
        sessionId: currentSessionId,
        contentLength: finalContent.length,
      });
      await jsonOutput?.events.endAgent();
      return finalContent;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Une erreur inconnue est survenue.';
      await jsonOutput?.events.failAgent(error, activeAbortController?.signal.aborted ?? false);
      await extensionRegistry.emit('agent:error', { sessionId: currentSessionId, error: errorMessage });
      if (printMode) throw error;
      if (!isStreaming && !activeAbortController?.signal.aborted) reportError(errorMessage);
      return undefined;
    } finally {
      isStreaming = false;
      streamWriter = null;
      activeAbortController = null;
      keyBindings.setStreaming(false);
      if (!printMode && !shuttingDown) refreshPrompt();
    }
  }

  /** Shared line-oriented multi-line editor and regular input dispatcher. */
  async function handleLine(input: string): Promise<void> {
    const trimmed = input.trim();

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

  const completeCommands = (input: string): string[] => {
    if (!input.startsWith('/') || input.includes(' ')) return [];
    const names = [
      ...commandHandler.getCommandNames(),
      'skills',
      'prompts',
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
      if (applicationMode === 'print') process.stdout.write(`${finalContent ?? ''}\n`);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    } finally {
      let cleanupError: unknown;
      try { await extensionRegistry.shutdown(); }
      catch (error) { cleanupError = error ?? new Error('Extension shutdown failed.'); }
      try { await jsonOutput?.flush(); }
      catch (error) { cleanupError ??= error ?? new Error('JSON output flush failed.'); }
      jsonOutput?.restore();
      if (cleanupError) throw cleanupError;
    }
    return;
  }

  if (fullscreenTerminal) {
    const fullscreenInput = new FullscreenInput(fullscreenTerminal, {
      onLine: handleLine,
      onInterrupt: interrupt,
      onExit: () => shutdown('Au revoir ! 👋', 0),
      onError: error => terminal.showError(error.message),
      complete: completeCommands,
      onExternalEditor: async currentInput => {
        fullscreenTerminal.leave();
        try {
          return await editInExternalEditor(currentInput, settingsResolution.settings.externalEditor);
        } finally {
          fullscreenTerminal.enter();
        }
      },
    });
    inputDriver = fullscreenInput;
    if (settingsResolution.settings.quietStartup !== true) terminal.welcome();
    fullscreenInput.setPrompt(sessionPrompt());
    fullscreenInput.start();
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: sessionPrompt(),
      completer: (line: string): [string[], string] => [completeCommands(line), line],
    });
    inputDriver = {
      prompt: () => rl.prompt(),
      close: () => rl.close(),
      setPrompt: prompt => rl.setPrompt(prompt),
    };
    terminal.setReadline(rl);
    if (settingsResolution.settings.quietStartup !== true) terminal.welcome();

    rl.on('line', input => {
      void handleLine(input).catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
    });
    rl.on('keypress', (_text, key) => {
      if (key?.ctrl && key.name === 'g') {
        const currentInput = rl.line;
        rl.write(null, { ctrl: true, name: 'u' });
        void editInExternalEditor(currentInput, settingsResolution.settings.externalEditor)
          .then(content => { if (content) rl.write(content); })
          .catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (!keyBindings.handleKeypress(key) && key?.ctrl && key.name === 'c') interrupt();
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
  console.error(chalk.red('Erreur fatale :'), error);
  process.exitCode = 1;
});
