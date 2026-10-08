import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import {
  agentToolExposure,
  collectToolSearchLoadedNames,
  createAgentToolLoadout,
  CredentialRedactor,
  DEFAULT_CODING_TOOL_NAMES,
  ExtensionRegistry,
  JsonlSessionStore,
  loadAgentSettings,
  McpSessionHost,
  normalizeProviderUsage,
  PluginService,
  ProjectTrustManager,
  SessionManager,
  WorkspaceManager,
  registerWorkspaceTools,
  resolveInstructionPrompt,
  resolvePreTrustAgentDirectory,
  resolveProjectTrust,
  resolveAgentCompactionSettings,
  resolveAgentDefaultTools,
  resolveAgentResourcePaths,
  resolveAgentThinkingLevel,
  selectAgentResourcePaths,
  selectRegisteredTools,
  isDeclaredToolExposure,
  toChatToolDefinitions,
  TOOL_SEARCH_TOOL_NAME,
  unknownToolNames,
  type AiProvider,
  type ChatResponse,
  type Message,
  type ResolvedAgentSettings,
  type ThinkingLevel,
} from '@ai-harness/core';
import { reserveProcessStdoutForJsonLines } from '../cli/json-output.js';
import { ExtensionLoader } from '../extensions/extension-loader.js';
import {
  applyAgentModelSettings,
  createConfiguredProviders,
  resolveStartupProvider,
} from '../providers/configured-providers.js';
import { createCliProviderRuntime } from '../providers/provider-runtime.js';
import { resolveStartupSession, resolveStartupSessionDirectory } from '../sessions/startup-session.js';
import { ResourceManager } from '../resources/resource-manager.js';
import { RpcExtensionUiBridge } from './rpc-extension-ui.js';
import { isRpcCommandRequest, RpcController, rpcParseError } from './rpc-controller.js';

const MAX_PENDING_RPC_REQUESTS = 256;

export interface RpcRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id?: string | number;
  result?: unknown;
  error?: { code: string; message: string };
  event?: string;
  data?: unknown;
}

export interface RpcContext {
  sessionManager: SessionManager;
  providers: Map<string, AiProvider>;
  defaultProviderName?: string;
  defaultThinking?: ThinkingLevel;
  systemPrompt?: string;
  emit(response: RpcResponse): void | Promise<void>;
}

export interface RpcStartupOptions {
  noSession?: boolean;
  sessionDir?: string;
  provider?: string;
  model?: string;
  models?: string[];
  apiKey?: string;
  thinking?: ThinkingLevel;
  systemPrompt?: string;
  appendSystemPrompts?: string[];
  noContextFiles?: boolean;
  continueSession?: boolean;
  session?: string;
  sessionId?: string;
  fork?: string;
  name?: string;
  extensions?: string[];
  skills?: string[];
  promptTemplates?: string[];
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  tools?: string[];
  excludeTools?: string[];
  noBuiltinTools?: boolean;
  noTools?: boolean;
  projectTrust?: boolean;
  input?: Readable;
  output?: (record: Record<string, unknown>) => void | Promise<void>;
  /** Internal process-local redactor shared with the CLI composition root. */
  credentialRedactor?: CredentialRedactor;
}

export async function handleRpcRequest(request: RpcRequest, context: RpcContext): Promise<RpcResponse> {
  const params = request.params ?? {};
  switch (request.method) {
    case 'system.ping':
      return { id: request.id, result: { ok: true } };
    case 'session.list':
      return { id: request.id, result: context.sessionManager.list() };
    case 'session.create': {
      const session = await context.sessionManager.create({ title: typeof params.title === 'string' ? params.title : undefined });
      return { id: request.id, result: session };
    }
    case 'session.get': {
      const sessionId = String(params.sessionId ?? '');
      const session = context.sessionManager.get(sessionId) ?? await context.sessionManager.loadFromStore(sessionId);
      if (!session) throw new Error(`Session introuvable : ${sessionId}`);
      return { id: request.id, result: session };
    }
    case 'session.delete': {
      const deletedCount = await context.sessionManager.deleteWithForks(String(params.sessionId ?? ''));
      return { id: request.id, result: { deletedCount } };
    }
    case 'provider.list':
      return { id: request.id, result: [...context.providers.keys()] };
    case 'chat.send': {
      const sessionId = String(params.sessionId ?? '');
      const content = String(params.content ?? '').trim();
      const providerName = String(params.provider ?? context.defaultProviderName ?? 'mock');
      if (!content) throw new Error('Le contenu du message est requis.');
      const session = context.sessionManager.get(sessionId) ?? await context.sessionManager.loadFromStore(sessionId);
      if (!session) throw new Error(`Session introuvable : ${sessionId}`);
      const provider = context.providers.get(providerName);
      if (!provider) throw new Error(`Provider indisponible : ${providerName}`);
      await context.sessionManager.addMessage(sessionId, { role: 'user', content });
      const messages = context.sessionManager.get(sessionId)!.messages.map(message => ({ ...message })) as Message[];
      let streamed = '';
      let emitTail = Promise.resolve();
      const response = await new Promise<ChatResponse>((resolve, reject) => {
        provider.streamChat(
          messages,
          chunk => {
            if (!chunk) return;
            streamed += chunk;
            emitTail = emitTail.then(() => context.emit({
              event: 'text_delta', data: { requestId: request.id, sessionId, content: chunk },
            }));
            return emitTail;
          },
          result => resolve({
            ...result,
            content: streamed || result?.content || '',
          }),
          reject,
          {
            model: typeof params.model === 'string' ? params.model : undefined,
            thinking: context.defaultThinking,
            systemPrompt: context.systemPrompt,
          },
        ).catch(reject);
      });
      await emitTail;
      if (response.content) await context.sessionManager.addMessage(sessionId, {
        role: 'assistant',
        content: response.content,
        provider: providerName,
        model: response.model ?? (typeof params.model === 'string' ? params.model : provider.getConfiguredModel()),
        usage: normalizeProviderUsage(response.usage),
      });
      await context.emit({ event: 'message_end', data: { requestId: request.id, sessionId, ...response } });
      return { id: request.id, result: response };
    }
    default:
      return { id: request.id, error: { code: 'METHOD_NOT_FOUND', message: `Méthode inconnue : ${request.method}` } };
  }
}

/** Read strict LF-framed JSONL without treating U+2028/U+2029 as delimiters. */
async function* jsonLines(input: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  }
  buffer += decoder.end();
  if (buffer) yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
}

function reportSettingsDiagnostics(
  settings: ResolvedAgentSettings,
  redact: (value: string) => string,
): void {
  for (const diagnostic of settings.diagnostics) {
    const field = diagnostic.setting ? ` [${diagnostic.setting}]` : '';
    process.stderr.write(`${redact(`Warning: Settings ignored (${diagnostic.path})${field}: ${diagnostic.message}`)}\n`);
  }
}

function rpcExtensionPaths(paths: readonly string[], settings: ResolvedAgentSettings): string[] {
  return [
    ...paths,
    ...selectAgentResourcePaths(resolveAgentResourcePaths(settings, 'extensions'))
      .filter(entry => !entry.includes('builtin:')),
  ];
}

/**
 * JSONL stdin/stdout composition root for headless integrations. This module
 * owns framing and startup; RpcController owns stateful command execution.
 */
export async function runRpcMode(options: RpcStartupOptions = {}): Promise<void> {
  const redactor = options.credentialRedactor ?? new CredentialRedactor();
  redactor.add(options.apiKey);
  redactor.addEnvironment(process.env);
  const reservedOutput = options.output ? undefined : reserveProcessStdoutForJsonLines(
    () => redactor.createStream(),
    value => redactor.redact(value),
  );
  const outputSink = options.output ?? reservedOutput!.write;
  let outputTail: Promise<void> = Promise.resolve();
  let outputFailure: unknown;
  const output = (record: Record<string, unknown>): Promise<void> => {
    const operation = outputTail.then(async () => {
      if (outputFailure) throw outputFailure;
      await outputSink(redactor.redactJson(record));
    });
    outputTail = operation.then(
      () => undefined,
      error => { outputFailure ??= error ?? new Error('RPC output delivery failed.'); },
    );
    void operation.catch(() => undefined);
    return operation;
  };
  const input = options.input ?? process.stdin;
  const extensionUi = new RpcExtensionUiBridge(
    output,
    value => redactor.redact(value),
    value => redactor.redactJson(value),
  );
  const sessionManager = new SessionManager({
    redactText: value => redactor.redact(value),
    redactJson: value => redactor.redactJson(value),
  });
  const extensionRegistry = new ExtensionRegistry();
  let controller: RpcController | undefined;
  let mcpHost: McpSessionHost | undefined;
  const stopForSignal = (): void => {
    if (controller) void controller.close().catch(() => undefined);
    input.destroy();
  };
  if (input === process.stdin) {
    process.once('SIGINT', stopForSignal);
    process.once('SIGTERM', stopForSignal);
  }

  let runError: unknown;
  try {
    extensionRegistry.attachSessionManager(sessionManager);

    const cwd = process.cwd();
    const workspaceManager = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd });
    await workspaceManager.initialize();
    const canonicalCwd = await workspaceManager.getDefaultCwd();
    const trustManager = new ProjectTrustManager(
      path.join(resolvePreTrustAgentDirectory(canonicalCwd), 'trust.json'),
    );
    await trustManager.load();
    const bootstrapSettings = await loadAgentSettings({ cwd: canonicalCwd, projectTrusted: false });
    const projectTrust = await resolveProjectTrust({
      cwd: canonicalCwd,
      trustManager,
      override: options.projectTrust,
      defaultProjectTrust: bootstrapSettings.settings.defaultProjectTrust,
      includeContextFiles: !options.noContextFiles,
    });
    const projectTrusted = projectTrust.trusted;
    const projectResourcesTrusted = projectTrust.resourceTrusted;
    const settingsResolution = await loadAgentSettings({
      cwd: canonicalCwd,
      projectTrusted: projectResourcesTrusted,
    });
    mcpHost = new McpSessionHost({
      agentDir: settingsResolution.agentDir,
      trustManager,
      resolveWorkingDirectory: (configured, base) => workspaceManager.resolve(configured, {
        base,
        kind: 'directory',
      }),
    });
    reportSettingsDiagnostics(settingsResolution, value => redactor.redact(value));
    const workspaceDescriptor = await workspaceManager.describe(canonicalCwd, projectTrusted);
    const pluginService = new PluginService(
      workspaceManager,
      trustManager,
      path.join(settingsResolution.agentDir, 'plugins.json'),
      settingsResolution.agentDir,
    );
    if (settingsResolution.agentDirTrusted) await pluginService.load();
    const packageContext = {
      cwd: canonicalCwd,
      projectId: workspaceDescriptor.id,
      projectTrusted: projectResourcesTrusted,
    };
    let packageSkills: Awaited<ReturnType<PluginService['getEnabledResourceLocations']>> = [];
    let packagePrompts: Awaited<ReturnType<PluginService['getEnabledResourceLocations']>> = [];
    let packageExtensions: Awaited<ReturnType<PluginService['getEnabledExtensionFiles']>> = [];
    if (settingsResolution.agentDirTrusted) {
      try {
        [packageSkills, packagePrompts, packageExtensions] = await Promise.all([
          pluginService.getEnabledResourceLocations('skill', packageContext),
          pluginService.getEnabledResourceLocations('prompt', packageContext),
          pluginService.getEnabledExtensionFiles(packageContext),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${redactor.redact(`Warning: Package resources ignored: ${message}`)}\n`);
      }
    }
    const sessionDirectory = resolveStartupSessionDirectory(
      {
        session: options.session,
        sessionDir: options.sessionDir,
      },
      canonicalCwd,
      process.env,
      undefined,
      settingsResolution.settings.sessionDir,
    );
    if (!options.noSession) {
      sessionManager.setStore(new JsonlSessionStore(sessionDirectory));
      await sessionManager.loadAllSessions();
    }

    const instructions = await resolveInstructionPrompt({
      cwd: canonicalCwd,
      agentDir: settingsResolution.agentDir,
      agentDirTrusted: settingsResolution.agentDirTrusted,
      projectTrusted: projectResourcesTrusted,
      noContextFiles: options.noContextFiles,
      systemPromptInput: options.systemPrompt,
      appendSystemPromptInputs: options.appendSystemPrompts,
    });
    for (const diagnostic of instructions.diagnostics) {
      process.stderr.write(`${redactor.redact(`Warning: Instruction ignored (${diagnostic.path}): ${diagnostic.message}`)}\n`);
    }
    const resourceManager = new ResourceManager({
      cwd: canonicalCwd,
      agentDir: settingsResolution.agentDir,
      agentDirTrusted: settingsResolution.agentDirTrusted,
      projectTrusted: projectResourcesTrusted,
      strictSkills: true,
      globalSkillPaths: resolveAgentResourcePaths(settingsResolution, 'skills', undefined, 'global'),
      projectSkillPaths: resolveAgentResourcePaths(settingsResolution, 'skills', undefined, 'project'),
      globalPromptPaths: resolveAgentResourcePaths(settingsResolution, 'prompts', undefined, 'global'),
      projectPromptPaths: resolveAgentResourcePaths(settingsResolution, 'prompts', undefined, 'project'),
      globalPackageSkillPaths: packageSkills.filter(item => item.scope === 'global').map(item => item.path),
      projectPackageSkillPaths: packageSkills.filter(item => item.scope === 'project').map(item => item.path),
      globalPackagePromptPaths: packagePrompts.filter(item => item.scope === 'global').map(item => item.path),
      projectPackagePromptPaths: packagePrompts.filter(item => item.scope === 'project').map(item => item.path),
      skillPaths: options.skills,
      promptPaths: options.promptTemplates,
      disableSkills: options.noSkills,
      disablePrompts: options.noPromptTemplates,
    });
    const resourceLoadResult = await resourceManager.loadAll();
    for (const failure of resourceLoadResult.errors) {
      process.stderr.write(`${redactor.redact(`Resource: ${failure.message}`)}\n`);
    }
    await registerWorkspaceTools(extensionRegistry, workspaceManager, {
      shellPath: settingsResolution.settings.shellPath,
      shellCommandPrefix: settingsResolution.settings.shellCommandPrefix,
    });
    const providerRuntime = await createCliProviderRuntime(
      settingsResolution.agentDir,
      settingsResolution.settings,
      process.env,
      undefined,
      settingsResolution.agentDirTrusted,
      [],
      redactor,
    );
    if (!options.noSession) await sessionManager.loadAllSessions();
    const providers = createConfiguredProviders(process.env, {
      credentials: providerRuntime.values,
      network: providerRuntime.network,
    });
    const effectiveModels = applyAgentModelSettings({
      provider: options.provider,
      model: options.model,
      models: options.models,
      apiKey: options.apiKey,
    }, settingsResolution.settings);
    const startup = await resolveStartupProvider(providers, effectiveModels.selection);
    const startupModel = startup.model ?? startup.provider.getConfiguredModel();
    const startupThinking = options.thinking
      ?? startup.thinkingLevel
      ?? resolveAgentThinkingLevel(settingsResolution.settings, startup.providerName, startupModel);
    sessionManager.setCompactionSettings(resolveAgentCompactionSettings(
      settingsResolution.settings,
      startup.providerName,
      startupModel,
    ));
    const extensionLoader = new ExtensionLoader(extensionRegistry, {
      paths: [...rpcExtensionPaths(options.extensions ?? [], settingsResolution), ...packageExtensions],
      isProjectTrusted: () => projectResourcesTrusted,
    });
    const extensionLoadResult = await extensionLoader.loadAll();
    for (const failure of extensionLoadResult.errors) {
      process.stderr.write(`${redactor.redact(`Extension ${failure.path}: ${failure.error.message}`)}\n`);
    }
    const registeredTools = extensionRegistry.getTools();
    const unknownTools = unknownToolNames(registeredTools, options.tools, options.excludeTools)
      .filter(name => !name.startsWith('mcp__') && name !== TOOL_SEARCH_TOOL_NAME);
    if (unknownTools.length) throw new Error(`Unknown tool name(s): ${unknownTools.join(', ')}.`);
    const configuredDefaults = resolveAgentDefaultTools(
      settingsResolution.settings.defaultTools,
      DEFAULT_CODING_TOOL_NAMES,
    );
    const toolSelectionOptions = {
      allowedTools: options.tools,
      excludedTools: options.excludeTools,
      defaultTools: configuredDefaults ?? DEFAULT_CODING_TOOL_NAMES,
      builtInExtensionId: 'builtin:workspace-tools',
      includeNonBuiltInByDefault: true,
      noBuiltInTools: options.noBuiltinTools,
      noTools: options.noTools,
    };
    const selectedStaticTools = selectRegisteredTools(registeredTools, toolSelectionOptions);
    const selectedTools = selectedStaticTools.filter(tool => isDeclaredToolExposure(agentToolExposure(tool)));

    const startupSession = await resolveStartupSession({
      sessionManager,
      args: {
        continueSession: options.continueSession ?? false,
        resume: false,
        session: options.session,
        sessionId: options.sessionId,
        fork: options.fork,
        sessionDir: sessionDirectory,
        name: options.name,
        noSession: options.noSession ?? false,
      },
      cwd: canonicalCwd,
      interactive: false,
    });

    const customContext: RpcContext = {
      sessionManager,
      providers,
      defaultProviderName: startup.providerName,
      defaultThinking: startupThinking,
      systemPrompt: instructions.systemPrompt,
      emit: response => output(response as Record<string, unknown>),
    };
    controller = new RpcController({
      provider: startup.provider,
      providers,
      sessionManager,
      sessionId: startupSession.id,
      sessionDir: options.noSession ? undefined : sessionDirectory
        ?? path.join(process.env.HOME || '.', '.ai-harness', 'sessions'),
      extensionRegistry,
      resourceManager,
      providerName: startup.providerName,
      model: startupModel,
      systemPrompt: instructions.systemPrompt,
      tools: toChatToolDefinitions(selectedTools),
      prepareDynamicTools: async (sessionId, signal) => {
        try {
          const session = sessionManager.get(sessionId);
          const suppressAllTools = options.tools?.length === 0
            || (options.noTools && options.tools === undefined);
          const prepared = session?.toolPreset === 'chat-only' || suppressAllTools
            ? mcpHost!.getPreparedTools(sessionId, 'chat-only')
            : await mcpHost!.prepareForPrompt({
                sessionId,
                cwd: session?.cwd ?? canonicalCwd,
                preset: session?.toolPreset,
                signal,
              });
          const loadout = createAgentToolLoadout({
            staticTools: registeredTools,
            dynamicSource: {
              directTools: prepared.tools,
              hasPotentialSearchableTools: prepared.hasPotentialDiscoverableTools ?? false,
              currentSearchableTools: () => prepared.currentDiscoverableTools?.()
                ?? prepared.discoverableTools ?? [],
              waitForSearchableTools: searchSignal => prepared.waitForDiscoverableTools?.(searchSignal)
                ?? Promise.resolve(prepared.discoverableTools ?? []),
              has: name => prepared.has(name),
            },
            selection: { ...toolSelectionOptions, preset: session?.toolPreset },
            initialLoadedTools: collectToolSearchLoadedNames(
              await sessionManager.getRawEntries(sessionId),
              session?.activeLeafId,
            ),
          });
          return {
            tools: toChatToolDefinitions(loadout.getTools()),
            resolveTools: () => toChatToolDefinitions(loadout.getTools()),
            execute: (name, input, context, executionSignal) => {
              if (loadout.isToolSearch(name)) {
                return loadout.executeToolSearch(input, context, executionSignal);
              }
              if (loadout.isDynamicTool(name)) {
                return prepared.execute(name, input, context, executionSignal);
              }
              return extensionRegistry.executeTool(name, input, context, executionSignal);
            },
            isHosted: name => loadout.isToolSearch(name) || loadout.isDynamicTool(name),
            getActivatedTools: (name, result) => loadout.activatedTools(name, result),
            release: () => signal.aborted
              ? mcpHost!.releaseSession(sessionId)
              : mcpHost!.finishPrompt(sessionId),
          };
        } catch (error) {
          if (signal.aborted) await mcpHost!.releaseSession(sessionId);
          else mcpHost!.finishPrompt(sessionId);
          throw error;
        }
      },
      thinking: startupThinking,
      scopedModelPatterns: effectiveModels.modelPatterns,
      redactText: value => redactor.redact(value),
      redactJson: value => redactor.redactJson(value),
      createTextRedactor: () => redactor.createStream(),
      steeringMode: settingsResolution.settings.steeringMode,
      followUpMode: settingsResolution.settings.followUpMode,
      retryEnabled: settingsResolution.settings.retry?.enabled,
      retryMaxRetries: settingsResolution.settings.retry?.maxRetries,
      retryDelayMs: settingsResolution.settings.retry?.baseDelayMs,
      retryMaxDelayMs: settingsResolution.settings.retry?.maxAgentDelayMs,
      enableSkillCommands: settingsResolution.settings.enableSkillCommands,
      summarizationRetryDelayMs: settingsResolution.settings.retry?.baseDelayMs,
      toolContext: {
        sessionManager,
        provider: startup.provider,
        providerName: startup.providerName,
        currentSessionId: '',
        cwd: canonicalCwd,
        projectTrusted,
        notify: (message, level = 'info') => extensionUi.notify(message, level),
        requestInteraction: request => extensionUi.request(request),
      },
    }, output);
    await controller.initialize();

    const handleLine = async (line: string): Promise<void> => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        await output(rpcParseError(error) as unknown as Record<string, unknown>);
        return;
      }

      if (extensionUi.handleResponse(parsed)) return;

      if (isRpcCommandRequest(parsed)) {
        const response = await controller!.handle(parsed);
        if (response) await output(response as unknown as Record<string, unknown>);
        return;
      }

      const request = parsed as Partial<RpcRequest>;
      if (!request || typeof request !== 'object' || typeof request.method !== 'string' || !request.method) {
        await output({ error: { code: 'INVALID_REQUEST', message: 'The type or method field is required.' } });
        return;
      }
      try {
        await output(await handleRpcRequest(request as RpcRequest, customContext) as unknown as Record<string, unknown>);
      } catch (error) {
        await output({
          id: request.id,
          error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
        });
      }
    };

    const pending = new Set<Promise<void>>();
    let taskFailure: unknown;
    for await (const line of jsonLines(input)) {
      if (taskFailure) throw taskFailure;
      while (pending.size >= MAX_PENDING_RPC_REQUESTS) {
        await Promise.race([...pending].map(task => task.catch(() => undefined)));
        if (taskFailure) throw taskFailure;
      }
      const task = handleLine(line);
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        error => {
          pending.delete(task);
          taskFailure ??= error ?? new Error('RPC request task failed.');
        },
      );
    }
    await Promise.allSettled([...pending]);
    if (taskFailure) throw taskFailure;
    await controller.drain();
  } catch (error) {
    runError = error ?? new Error('RPC mode failed.');
  }

  if (input === process.stdin) {
    process.off('SIGINT', stopForSignal);
    process.off('SIGTERM', stopForSignal);
  }
  let cleanupError: unknown;
  try { extensionUi.close(); } catch (error) { cleanupError = error ?? new Error('RPC UI cleanup failed.'); }
  try { await controller?.close(); } catch (error) { cleanupError ??= error ?? new Error('RPC controller cleanup failed.'); }
  try { await mcpHost?.shutdown(); } catch (error) { cleanupError ??= error ?? new Error('MCP shutdown failed.'); }
  try { await extensionRegistry.shutdown(); } catch (error) { cleanupError ??= error ?? new Error('Extension shutdown failed.'); }
  try {
    await outputTail;
    if (outputFailure) throw outputFailure;
    await reservedOutput?.flush();
  } catch (error) {
    cleanupError ??= error ?? new Error('RPC output flush failed.');
  }
  reservedOutput?.restore();
  if (runError && cleanupError && runError !== cleanupError) {
    const runMessage = runError instanceof Error ? runError.message : String(runError);
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new AggregateError(
      [runError, cleanupError],
      `RPC mode failed: ${runMessage}; cleanup failed: ${cleanupMessage}`,
    );
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
}
