#!/usr/bin/env node
// ============================================================
// AiHarness CLI - Regular readline and fullscreen TUI entry point
// ============================================================

import {
  ExtensionRegistry,
  JsonlSessionStore,
  registerWorkspaceTools,
  SessionManager,
  WorkspaceManager,
} from '@ai-harness/core';
import type { ChatResponse } from '@ai-harness/core';
import readline from 'readline';
import chalk from 'chalk';
import { CommandHandler } from './commands/handler.js';
import { TerminalUI } from './tui/terminal-ui.js';
import { FullscreenUI } from './tui/fullscreen-ui.js';
import { FullscreenInput } from './tui/fullscreen-input.js';
import { resolveTerminalMode } from './tui/mode.js';
import { KeyBindingManager } from './utils/keybinding-manager.js';
import { ExtensionLoader, getExtensionPaths } from './extensions/extension-loader.js';
import { runToolLoop } from './agent/tool-loop.js';
import { ResourceManager } from './resources/resource-manager.js';
import { editInExternalEditor } from './utils/system-integration.js';
import { runRpcMode } from './rpc/rpc-server.js';
import { ProjectTrustManager } from './security/project-trust.js';
import { ThemeManager } from './tui/theme-manager.js';

interface InputDriver {
  prompt(): void;
  close(): void;
  setPrompt(prompt: string): void;
}

async function main(): Promise<void> {
  if (process.argv.includes('--rpc')) {
    await runRpcMode();
    return;
  }

  const noSession = process.argv.includes('--no-session');
  const store = new JsonlSessionStore(undefined, !noSession);
  const sessionManager = new SessionManager();
  if (!noSession) {
    sessionManager.setStore(store);
    await sessionManager.loadAllSessions();
  }

  const cliArgs = process.argv.slice(2);
  const themeIndex = cliArgs.indexOf('--theme');
  const themeArgument = cliArgs.find(argument => argument.startsWith('--theme='))?.slice('--theme='.length)
    || (themeIndex >= 0 ? cliArgs[themeIndex + 1] : undefined);
  const theme = await ThemeManager.load(themeArgument).catch(error => {
    console.error(`Thème ignoré : ${error instanceof Error ? error.message : String(error)}`);
    return ThemeManager.load('dark');
  });
  const fullscreenSupported = FullscreenUI.isSupported();
  const terminalMode = resolveTerminalMode(cliArgs, process.env, fullscreenSupported);
  const fullscreenTerminal = terminalMode === 'fullscreen'
    ? new FullscreenUI({ title: 'AiHarness CLI', theme })
    : null;
  const terminal: TerminalUI = fullscreenTerminal ?? new TerminalUI({ title: 'AiHarness CLI', theme });
  let streamWriter: ReturnType<TerminalUI['startStreaming']> | null = null;
  let isStreaming = false;
  let isMultiLineMode = false;
  let shuttingDown = false;
  let activeAbortController: AbortController | null = null;
  let inputDriver: InputDriver;

  const trustManager = new ProjectTrustManager();
  await trustManager.load();

  const resourceManager = new ResourceManager();
  const resourceLoadResult = await resourceManager.loadAll();
  for (const error of resourceLoadResult.errors) terminal.showError(`Ressource : ${error.message}`);

  const workspaceManager = new WorkspaceManager({
    allowedRoots: [process.cwd()],
    defaultCwd: process.cwd(),
  });
  await workspaceManager.initialize();
  const workspaceCwd = await workspaceManager.getDefaultCwd();
  const workspaceDescriptor = await workspaceManager.describe(
    workspaceCwd,
    await trustManager.isTrusted(workspaceCwd),
  );

  const extensionRegistry = new ExtensionRegistry();
  extensionRegistry.attachSessionManager(sessionManager);
  await registerWorkspaceTools(extensionRegistry, workspaceManager);
  const extensionLoader = new ExtensionLoader(extensionRegistry, {
    paths: getExtensionPaths(process.argv.slice(2)),
    isProjectTrusted: () => trustManager.isTrustedSync(workspaceCwd),
  });
  const registerSkillTool = async (): Promise<void> => {
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
    const resources = await resourceManager.loadAll();
    for (const error of resources.errors) terminal.showError(`Ressource : ${error.message}`);
    const result = await extensionLoader.reload();
    for (const failure of result.errors) {
      terminal.showError(`Extension ${failure.path}: ${failure.error.message}`);
    }
    await registerSkillTool();
  });
  const extensionLoadResult = await extensionLoader.loadAll();
  for (const failure of extensionLoadResult.errors) {
    terminal.showError(`Extension ${failure.path}: ${failure.error.message}`);
  }
  await registerSkillTool();

  const commandHandler = new CommandHandler(
    sessionManager,
    store,
    terminal,
    extensionRegistry,
    trustManager,
    { cwd: workspaceCwd, workspaceId: workspaceDescriptor.id },
  );
  const keyBindings = new KeyBindingManager();
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

  let currentSessionId: string;
  const existingSessions = sessionManager.list();
  if (existingSessions.length > 0) {
    currentSessionId = existingSessions[0].id;
  } else {
    currentSessionId = (await sessionManager.create({
      title: 'Nouvelle conversation',
      cwd: workspaceCwd,
      workspaceId: workspaceDescriptor.id,
    })).id;
  }

  let ctx = commandHandler.getContext();
  ctx.currentSessionId = currentSessionId;
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

  // Seed the TUI viewport with the active persisted conversation.
  for (const message of sessionManager.get(currentSessionId)?.messages ?? []) {
    if (message.role === 'user' || message.role === 'assistant') {
      terminal.addTranscriptEntry({ type: message.role, content: message.content });
    }
  }

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
    streamWriter?.cancel();
    inputDriver?.close();
    terminal.exitMessage(message);
    void extensionRegistry.shutdown().finally(() => {
      if (exitCode !== undefined) process.exit(exitCode);
    });
  };

  const interrupt = (): void => {
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
  async function processInput(input: string): Promise<void> {
    let trimmed = input.trim();
    if (!trimmed) {
      inputDriver.prompt();
      return;
    }

    if (trimmed.startsWith('/')) {
      const [resourceCommand, ...resourceArgs] = trimmed.slice(1).split(/\s+/);
      if (resourceCommand === 'skills') {
        const skills = resourceManager.listSkills();
        terminal.writeOutput(skills.length
          ? skills.map(skill => `• ${skill.name} — ${skill.description}${skill.disableModelInvocation ? ' [explicite uniquement]' : ''}`).join('\n')
          : 'Aucun skill découvert.');
        refreshPrompt();
        return;
      }
      if (resourceCommand === 'prompts') {
        const prompts = resourceManager.listPrompts();
        terminal.writeOutput(prompts.length
          ? prompts.map(prompt => `• /${prompt.name}${prompt.description ? ` — ${prompt.description}` : ''}`).join('\n')
          : 'Aucun prompt découvert.');
        refreshPrompt();
        return;
      }
      if (resourceCommand.startsWith('skill:')) {
        try {
          trimmed = resourceManager.invokeSkill(resourceCommand.slice('skill:'.length), resourceArgs.join(' '));
        } catch (error) {
          terminal.showError(error instanceof Error ? error.message : String(error));
          refreshPrompt();
          return;
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
          return;
        }
      }
    }

    const provider = ctx.provider;
    try {
      if (!provider) {
        terminal.showError('Aucun provider IA configuré. Utilisez /provider.');
        return;
      }

      if (!provider.validateConfig()) {
        const providerName = (provider as unknown as { config?: { type?: string } }).config?.type ?? 'inconnu';
        terminal.showError(`Le provider « ${providerName} » n’est pas configuré.`);
        return;
      }

      const currentSession = sessionManager.get(currentSessionId);
      if (!currentSession) {
        terminal.showError('Aucune session active. Créez-en une avec /new.');
        return;
      }

      const providerName = String((provider as unknown as { config?: { type?: string } }).config?.type ?? 'unknown');
      const providerModel = (provider as unknown as { config?: { model?: string } }).config?.model;
      const agentHook = await extensionRegistry.runBefore('before:agent', {
        sessionId: currentSessionId,
        provider: providerName,
        input: trimmed,
      });
      if (agentHook.cancelled) {
        terminal.writeOutput(agentHook.reason ?? "Requête annulée par un hook d'extension.");
        return;
      }
      const userInput = agentHook.data.input.trim();
      if (!userInput) {
        terminal.writeOutput("Requête annulée : le hook d'extension a produit une entrée vide.");
        return;
      }
      terminal.addTranscriptEntry({ type: 'user', content: userInput });
      await sessionManager.addMessage(currentSessionId, { role: 'user', content: userInput });
      terminal.displayUserMessage(userInput);

      const operationController = new AbortController();
      activeAbortController = operationController;
      await extensionRegistry.emit('agent:start', { sessionId: currentSessionId, provider: providerName });

      const finalContent = await runToolLoop({
        sessionManager,
        sessionId: currentSessionId,
        extensionRegistry,
        toolContext: {
          sessionManager,
          currentSessionId,
          provider,
          providerName,
          cwd: workspaceCwd,
          workspaceId: workspaceDescriptor.id,
          projectTrusted: await trustManager.isTrusted(workspaceCwd),
          notify: (message, level = 'info') => {
            if (level === 'error') terminal.showError(message);
            else terminal.writeOutput(message);
          },
        },
        streamTurn: async (messages, tools) => {
          const providerHook = await extensionRegistry.runBefore('before:provider', {
            provider: providerName,
            model: providerModel,
            messages,
            options: {
              model: providerModel,
              tools,
              thinking: ctx.thinkingLevel,
              signal: operationController.signal,
            },
          });
          if (providerHook.cancelled) {
            throw new Error(providerHook.reason ?? "Appel provider annulé par un hook d'extension.");
          }
          const callStartedAt = Date.now();
          await extensionRegistry.emit('provider:call:start', {
            provider: providerHook.data.provider,
            model: providerHook.data.model,
          });
          streamWriter = terminal.startStreaming();
          isStreaming = true;
          keyBindings.setStreaming(true);
          let streamedContent = '';

          const response = await new Promise<ChatResponse>((resolve, reject) => {
            provider.streamChat(
              providerHook.data.messages,
              chunk => {
                if (!isStreaming || !streamWriter) return;
                streamWriter.write(chunk);
                streamedContent += chunk;
              },
              result => {
                isStreaming = false;
                keyBindings.setStreaming(false);
                streamWriter?.finish();
                resolve(result ?? { content: streamedContent });
              },
              error => {
                isStreaming = false;
                keyBindings.setStreaming(false);
                void extensionRegistry.emit('provider:call:error', { provider: providerHook.data.provider, error: error.message });
                reject(error);
              },
              { ...providerHook.data.options, signal: operationController.signal },
            ).catch(reject);
          });

          await extensionRegistry.emit('provider:call:end', {
            provider: providerHook.data.provider,
            tokensUsed: response.usage?.totalTokens,
            durationMs: Date.now() - callStartedAt,
          });
          return { ...response, content: streamedContent || response.content };
        },
        onToolCall: call => {
          terminal.addTranscriptEntry({ type: 'command', content: `[Tool] ${call.name}` });
          terminal.displayCommand('tool', `${call.name}(${JSON.stringify(call.input)})`);
        },
        onToolResult: result => terminal.displayCommand(result.call.name, result.content),
        onFinalResponse: content => {
          if (content) terminal.addTranscriptEntry({ type: 'assistant', content });
        },
        signal: operationController.signal,
      });

      await extensionRegistry.emit('agent:end', {
        sessionId: currentSessionId,
        contentLength: finalContent.length,
      });
    } catch (error) {
      if (!isStreaming && !activeAbortController?.signal.aborted) {
        const errorMessage = error instanceof Error ? error.message : 'Une erreur inconnue est survenue.';
        terminal.showError(errorMessage);
        void extensionRegistry.emit('agent:error', { sessionId: currentSessionId, error: errorMessage });
      }
    } finally {
      isStreaming = false;
      streamWriter = null;
      activeAbortController = null;
      keyBindings.setStreaming(false);
      if (!shuttingDown) refreshPrompt();
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
      ...resourceManager.listSkills().map(skill => `skill:${skill.name}`),
      ...resourceManager.listPrompts().map(prompt => prompt.name),
    ];
    return names.map(name => `/${name}`).filter(name => name.startsWith(input));
  };

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
          return await editInExternalEditor(currentInput);
        } finally {
          fullscreenTerminal.enter();
        }
      },
    });
    inputDriver = fullscreenInput;
    terminal.welcome();
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
    terminal.welcome();

    rl.on('line', input => {
      void handleLine(input).catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
    });
    rl.on('keypress', (_text, key) => {
      if (key?.ctrl && key.name === 'g') {
        const currentInput = rl.line;
        rl.write(null, { ctrl: true, name: 'u' });
        void editInExternalEditor(currentInput)
          .then(content => { if (content) rl.write(content); })
          .catch(error => terminal.showError(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (!keyBindings.handleKeypress(key) && key?.ctrl && key.name === 'c') interrupt();
    });
    rl.prompt();
  }

  process.on('SIGINT', interrupt);
  process.on('SIGTERM', () => shutdown('Arrêt en cours…', 0));
  process.on('exit', () => fullscreenTerminal?.leave());
}

main().catch(error => {
  process.stdout.write('\u001b[?25h\u001b[?1049l');
  console.error(chalk.red('Erreur fatale :'), error);
  process.exit(1);
});
