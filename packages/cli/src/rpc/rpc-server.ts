import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import {
  DEFAULT_CODING_TOOL_NAMES,
  ExtensionRegistry,
  JsonlSessionStore,
  loadPiSettings,
  normalizeProviderUsage,
  ProjectTrustManager,
  SessionManager,
  WorkspaceManager,
  registerWorkspaceTools,
  resolveInstructionPrompt,
  resolvePiCompactionSettings,
  resolvePiDefaultTools,
  resolvePiResourcePaths,
  resolvePiThinkingLevel,
  selectPiResourcePaths,
  selectRegisteredTools,
  toChatToolDefinitions,
  unknownToolNames,
  type AiProvider,
  type ChatResponse,
  type Message,
  type ResolvedPiSettings,
  type ThinkingLevel,
} from '@ai-harness/core';
import { reserveProcessStdoutForJsonLines } from '../cli/json-output.js';
import { ExtensionLoader } from '../extensions/extension-loader.js';
import {
  applyPiModelSettings,
  createConfiguredProviders,
  resolveStartupProvider,
} from '../providers/configured-providers.js';
import { resolveStartupSession, resolveStartupSessionDirectory } from '../sessions/startup-session.js';
import { ResourceManager } from '../resources/resource-manager.js';
import { RpcExtensionUiBridge } from './rpc-extension-ui.js';
import { isPiRpcRequest, PiRpcController, piRpcParseError } from './pi-rpc-server.js';

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
  tools?: string[];
  excludeTools?: string[];
  noBuiltinTools?: boolean;
  noTools?: boolean;
  input?: Readable;
  output?: (record: Record<string, unknown>) => void | Promise<void>;
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

function reportSettingsDiagnostics(settings: ResolvedPiSettings): void {
  for (const diagnostic of settings.diagnostics) {
    const field = diagnostic.setting ? ` [${diagnostic.setting}]` : '';
    process.stderr.write(`Warning: Settings ignored (${diagnostic.path})${field}: ${diagnostic.message}\n`);
  }
}

function rpcExtensionPaths(paths: readonly string[], settings: ResolvedPiSettings): string[] {
  return [
    ...paths,
    ...selectPiResourcePaths(resolvePiResourcePaths(settings, 'extensions'))
      .filter(entry => !entry.includes('builtin:')),
  ];
}

/** JSONL stdin/stdout RPC mode for headless integrations. */
export async function runRpcMode(options: RpcStartupOptions = {}): Promise<void> {
  const reservedOutput = options.output ? undefined : reserveProcessStdoutForJsonLines();
  const outputSink = options.output ?? reservedOutput!.write;
  let outputTail: Promise<void> = Promise.resolve();
  let outputFailure: unknown;
  const output = (record: Record<string, unknown>): Promise<void> => {
    const operation = outputTail.then(async () => {
      if (outputFailure) throw outputFailure;
      await outputSink(record);
    });
    outputTail = operation.then(
      () => undefined,
      error => { outputFailure ??= error ?? new Error('RPC output delivery failed.'); },
    );
    void operation.catch(() => undefined);
    return operation;
  };
  const input = options.input ?? process.stdin;
  const extensionUi = new RpcExtensionUiBridge(output);
  const sessionManager = new SessionManager();
  const extensionRegistry = new ExtensionRegistry();
  let controller: PiRpcController | undefined;
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
    const trustManager = new ProjectTrustManager();
    await trustManager.load();
    const projectTrusted = await trustManager.isTrusted(canonicalCwd);
    const settingsResolution = await loadPiSettings({ cwd: canonicalCwd, projectTrusted });
    reportSettingsDiagnostics(settingsResolution);
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
      projectTrusted,
      noContextFiles: options.noContextFiles,
      systemPromptInput: options.systemPrompt,
      appendSystemPromptInputs: options.appendSystemPrompts,
    });
    for (const diagnostic of instructions.diagnostics) {
      process.stderr.write(`Warning: Instruction ignored (${diagnostic.path}): ${diagnostic.message}\n`);
    }
    const resourceManager = new ResourceManager({
      cwd: canonicalCwd,
      agentDir: settingsResolution.agentDir,
      projectTrusted,
      globalSkillPaths: resolvePiResourcePaths(settingsResolution, 'skills', undefined, 'global'),
      projectSkillPaths: resolvePiResourcePaths(settingsResolution, 'skills', undefined, 'project'),
      globalPromptPaths: resolvePiResourcePaths(settingsResolution, 'prompts', undefined, 'global'),
      projectPromptPaths: resolvePiResourcePaths(settingsResolution, 'prompts', undefined, 'project'),
    });
    const resourceLoadResult = await resourceManager.loadAll();
    for (const failure of resourceLoadResult.errors) {
      process.stderr.write(`Resource: ${failure.message}\n`);
    }
    await registerWorkspaceTools(extensionRegistry, workspaceManager, {
      shellPath: settingsResolution.settings.shellPath,
      shellCommandPrefix: settingsResolution.settings.shellCommandPrefix,
    });
    const providers = createConfiguredProviders();
    const effectiveModels = applyPiModelSettings({
      provider: options.provider,
      model: options.model,
      models: options.models,
      apiKey: options.apiKey,
    }, settingsResolution.settings);
    const startup = await resolveStartupProvider(providers, effectiveModels.selection);
    const startupModel = startup.model ?? startup.provider.getConfiguredModel();
    const startupThinking = options.thinking
      ?? startup.thinkingLevel
      ?? resolvePiThinkingLevel(settingsResolution.settings, startup.providerName, startupModel);
    sessionManager.setCompactionSettings(resolvePiCompactionSettings(
      settingsResolution.settings,
      startup.providerName,
      startupModel,
    ));
    const extensionLoader = new ExtensionLoader(extensionRegistry, {
      paths: rpcExtensionPaths(options.extensions ?? [], settingsResolution),
      isProjectTrusted: () => trustManager.isTrustedSync(canonicalCwd),
    });
    const extensionLoadResult = await extensionLoader.loadAll();
    for (const failure of extensionLoadResult.errors) {
      process.stderr.write(`Extension ${failure.path}: ${failure.error.message}\n`);
    }
    const registeredTools = extensionRegistry.getTools();
    const unknownTools = unknownToolNames(registeredTools, options.tools, options.excludeTools);
    if (unknownTools.length) throw new Error(`Unknown tool name(s): ${unknownTools.join(', ')}.`);
    const configuredDefaults = resolvePiDefaultTools(
      settingsResolution.settings.defaultTools,
      DEFAULT_CODING_TOOL_NAMES,
    );
    const selectedTools = selectRegisteredTools(registeredTools, {
      allowedTools: options.tools,
      excludedTools: options.excludeTools,
      defaultTools: configuredDefaults ?? DEFAULT_CODING_TOOL_NAMES,
      builtInExtensionId: 'builtin:workspace-tools',
      includeNonBuiltInByDefault: true,
      noBuiltInTools: options.noBuiltinTools,
      noTools: options.noTools,
    });

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
    controller = new PiRpcController({
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
      thinking: startupThinking,
      scopedModelPatterns: effectiveModels.modelPatterns,
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
        await output(piRpcParseError(error) as unknown as Record<string, unknown>);
        return;
      }

      if (extensionUi.handleResponse(parsed)) return;

      if (isPiRpcRequest(parsed)) {
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
  } catch (error) {
    runError = error ?? new Error('RPC mode failed.');
  } finally {
    if (input === process.stdin) {
      process.off('SIGINT', stopForSignal);
      process.off('SIGTERM', stopForSignal);
    }
    let cleanupError: unknown;
    try { extensionUi.close(); } catch (error) { cleanupError = error ?? new Error('RPC UI cleanup failed.'); }
    try { await controller?.close(); } catch (error) { cleanupError ??= error ?? new Error('RPC controller cleanup failed.'); }
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
}
