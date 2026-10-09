import type { AiProvider, ChatResponse, ChatToolDefinition } from '../providers/index.js';
import type { CredentialRedactionStream } from '../providers/credentials.js';
import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  ExtensionRegistry,
  ExtensionRuntimeContext,
  ExtensionToolResult,
} from '../extensions/extension-registry.js';
import type { Message, MessageContentBlock, Session } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { AgentQueueMode } from '../config/agent-settings.js';
import type { McpSessionHost, PreparedMcpTools } from '../mcp/session-host.js';
import { toChatToolDefinitions } from '../tools/tool-selection.js';
import {
  collectToolSearchLoadedNames,
  createAgentToolLoadout,
} from '../tools/tool-search.js';
import { streamProviderTurn } from './provider-turn.js';
import { AgentAbortError, runToolLoop } from './tool-loop.js';
import {
  AgentMessageQueue,
  type AgentMessageQueueBatch,
  type AgentMessageQueueKind,
} from './message-queue.js';
import {
  AgentEventJournal,
  type AgentEvent,
  type AgentEventType,
  type AgentPhase,
  type AgentRunSnapshot,
  type AgentStateSnapshot,
  type ExtensionInteractionSnapshot,
  type QueuedAgentMessage,
} from './events.js';

import type { CodemodeSettings } from '../tools/codemode.js';

export interface StartAgentRunRequest {
  sessionId: string;
  cwd: string;
  workspaceId?: string;
  provider: string;
  input: string;
  blocks?: MessageContentBlock[];
  model?: string;
  thinking?: Session['thinking'];
  toolPreset?: Session['toolPreset'];
  /** False when the transport already persisted explicit settings and only passes effective values. */
  persistSettings?: boolean;
  systemPrompt?: string;
  maxToolRounds?: number;
  maxRetries?: number;
  agentId?: string;
  allowedTools?: string[];
  excludedTools?: string[];
  codemode?: CodemodeSettings;
  allowedSkills?: string[];
  allowedExtensions?: string[];
  steeringMode?: AgentQueueMode;
  followUpMode?: AgentQueueMode;
}

export interface AgentRuntimeOptions {
  sessionManager: SessionManager;
  extensionRegistry: ExtensionRegistry;
  resolveProvider(name: string): AiProvider | undefined | Promise<AiProvider | undefined>;
  journal?: AgentEventJournal;
  isProjectTrusted?(cwd: string): boolean | Promise<boolean>;
  onUsage?(provider: string, model: string | undefined, usage: NonNullable<ChatResponse['usage']>): number | undefined;
  onNotification?(category: 'completion' | 'attention', run: AgentRunSnapshot): void | Promise<void>;
  /** Scrub process-local credentials before errors or extension output reach memory, sessions, or APIs. */
  redactText?(value: string): string;
  redactJson?<T>(value: T): T;
  createTextRedactor?(): CredentialRedactionStream;
  /** Optional shared persistent MCP host used by CLI/RPC/Web adapters. */
  mcpHost?: McpSessionHost;
}

interface ActiveRun {
  snapshot: AgentRunSnapshot;
  controller: AbortController;
  completion: Promise<void>;
  resolveCompletion(): void;
  settled: boolean;
  queue: AgentMessageQueue<QueuedAgentMessage>;
}

interface PendingInteraction {
  runId: string;
  sessionId: string;
  request: ExtensionInteractionSnapshot;
  settle(response: ExtensionInteractionResponse): void;
}

interface PreparedRunTools {
  definitions(): ChatToolDefinition[];
  execute(
    name: string,
    input: unknown,
    context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): Promise<ExtensionToolResult>;
  activatedTools(name: string, result: ExtensionToolResult): string[] | undefined;
  resultMetadata(name: string, result: ExtensionToolResult): Record<string, unknown> | undefined;
}

function invalidInteractionResponse(message: string): never {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_EXTENSION_INTERACTION_RESPONSE' });
}

function validateInteractionResponse(
  request: ExtensionInteractionSnapshot,
  response: ExtensionInteractionResponse,
): ExtensionInteractionResponse {
  if (response.cancelled === true) return { cancelled: true };
  const value = response.value;
  if (request.kind === 'confirm') {
    if (typeof value !== 'boolean') invalidInteractionResponse('Confirmation response must be a boolean.');
  } else if (request.kind === 'input' || request.kind === 'editor') {
    if (typeof value !== 'string') invalidInteractionResponse('Text interaction response must be a string.');
  } else if (request.kind === 'select') {
    if (typeof value !== 'string' || !request.options?.some(option => option.value === value)) {
      invalidInteractionResponse('Select interaction response is not an available option.');
    }
  } else {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalidInteractionResponse('Custom interaction response must be an object.');
    }
    const record = value as Record<string, unknown>;
    const fields = new Map((request.fields ?? []).map(field => [field.name, field]));
    if (Object.keys(record).some(name => !fields.has(name))) invalidInteractionResponse('Custom interaction response contains an unknown field.');
    for (const field of fields.values()) {
      const fieldValue = record[field.name];
      if (field.required && (fieldValue === undefined || fieldValue === '')) {
        invalidInteractionResponse(`Custom interaction field is required: ${field.name}`);
      }
      if (fieldValue === undefined) continue;
      if (field.type === 'checkbox' && typeof fieldValue !== 'boolean') {
        invalidInteractionResponse(`Custom checkbox field must be boolean: ${field.name}`);
      }
      if (field.type !== 'checkbox' && typeof fieldValue !== 'string') {
        invalidInteractionResponse(`Custom text field must be a string: ${field.name}`);
      }
      if (field.type === 'select' && !field.options?.some(option => option.value === fieldValue)) {
        invalidInteractionResponse(`Custom select field is not an available option: ${field.name}`);
      }
    }
  }
  return { cancelled: false, value: structuredClone(value) };
}

function interactionRequest(
  value: ExtensionInteractionRequest,
  redactText: (value: string) => string,
): ExtensionInteractionRequest {
  const redact = (input: unknown, limit: number): string => redactText(String(input ?? '').slice(0, limit));
  const title = redact(value.title, 200).trim();
  if (!title) throw new Error('Extension interaction title is required.');
  if (!['confirm', 'input', 'select', 'editor', 'custom'].includes(value.kind)) {
    throw new Error('Unsupported extension interaction kind.');
  }
  const boundedOptions = value.options?.slice(0, 100).map(option => ({
    value: redact(option.value, 500),
    label: redact(option.label, 500),
    ...(option.description ? { description: redact(option.description, 2_000) } : {}),
  }));
  const fieldNames = new Set<string>();
  const boundedFields = value.fields?.slice(0, 50).map(field => {
    const name = redact(field.name, 100);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name) || fieldNames.has(name)) {
      throw new Error('Extension interaction field names must be unique identifiers.');
    }
    if (!['text', 'textarea', 'select', 'checkbox'].includes(field.type)) {
      throw new Error('Unsupported extension interaction field type.');
    }
    fieldNames.add(name);
    return {
      name,
      label: redact(field.label, 500),
      type: field.type,
      ...(field.required ? { required: true } : {}),
      ...(field.placeholder ? { placeholder: redact(field.placeholder, 1_000) } : {}),
      ...(field.options ? { options: field.options.slice(0, 100).map(option => ({
        value: redact(option.value, 500), label: redact(option.label, 500),
      })) } : {}),
    };
  });
  return {
    kind: value.kind,
    title,
    ...(value.message ? { message: redact(value.message, 10_000) } : {}),
    ...(value.placeholder ? { placeholder: redact(value.placeholder, 1_000) } : {}),
    ...(boundedOptions?.length ? { options: boundedOptions } : {}),
    ...(boundedFields?.length ? { fields: boundedFields } : {}),
    ...(value.output ? { output: redact(value.output, 100_000) } : {}),
    ...(value.ansi ? { ansi: true } : {}),
  };
}

function cloneSnapshot(snapshot: AgentRunSnapshot): AgentRunSnapshot {
  return structuredClone(snapshot);
}

/** Detached multi-turn agent runtime shared by all HTTP transports. */
export class AgentRuntime {
  readonly journal: AgentEventJournal;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly sessionRuns = new Map<string, string>();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly sessionManager: SessionManager;
  private readonly extensionRegistry: ExtensionRegistry;
  private readonly resolveProvider: AgentRuntimeOptions['resolveProvider'];
  private readonly isProjectTrusted: NonNullable<AgentRuntimeOptions['isProjectTrusted']>;
  private readonly onUsage?: AgentRuntimeOptions['onUsage'];
  private readonly onNotification?: AgentRuntimeOptions['onNotification'];
  private readonly redactText: (value: string) => string;
  private readonly redactJson: <T>(value: T) => T;
  private readonly createTextRedactor?: () => CredentialRedactionStream;
  private readonly mcpHost?: McpSessionHost;

  constructor(options: AgentRuntimeOptions) {
    this.sessionManager = options.sessionManager;
    this.extensionRegistry = options.extensionRegistry;
    this.resolveProvider = options.resolveProvider;
    this.journal = options.journal ?? new AgentEventJournal();
    this.isProjectTrusted = options.isProjectTrusted ?? (() => false);
    this.onUsage = options.onUsage;
    this.onNotification = options.onNotification;
    this.redactText = options.redactText ?? (value => value);
    this.redactJson = options.redactJson ?? (value => value);
    this.createTextRedactor = options.createTextRedactor;
    this.mcpHost = options.mcpHost;
  }

  async start(request: StartAgentRunRequest): Promise<AgentRunSnapshot> {
    if (!request.input.trim()) throw new Error('Le message ne peut pas être vide.');
    const session = this.sessionManager.get(request.sessionId);
    if (!session) throw new Error('Session introuvable.');
    if (!await this.isProjectTrusted(request.cwd)) {
      throw Object.assign(new Error('Le workspace doit être approuvé avant de lancer un agent.'), {
        code: 'PROJECT_TRUST_REQUIRED',
        status: 409,
      });
    }
    const existingId = this.sessionRuns.get(request.sessionId);
    const existing = existingId ? this.runs.get(existingId) : undefined;
    if (existing && !existing.settled) {
      throw new Error('Un agent est déjà actif pour cette session.');
    }

    const effectiveRequest: StartAgentRunRequest = {
      ...request,
      provider: this.redactText(request.provider),
      input: this.redactText(request.input),
      blocks: request.blocks ? this.redactJson(request.blocks) : undefined,
      model: request.model ? this.redactText(request.model) : undefined,
      systemPrompt: request.systemPrompt ? this.redactText(request.systemPrompt) : undefined,
      allowedTools: request.allowedTools?.map(value => this.redactText(value)),
      excludedTools: request.excludedTools?.map(value => this.redactText(value)),
      allowedSkills: request.allowedSkills?.map(value => this.redactText(value)),
      allowedExtensions: request.allowedExtensions?.map(value => this.redactText(value)),
    };
    const hook = await this.extensionRegistry.runBefore('before:agent', {
      sessionId: effectiveRequest.sessionId,
      provider: this.redactText(effectiveRequest.provider),
      input: effectiveRequest.input,
    });
    if (hook.cancelled) throw new Error(this.redactText(hook.reason || "Exécution annulée par une extension."));
    hook.data = this.redactJson(hook.data);
    effectiveRequest.input = hook.data.input;
    const providerName = hook.data.provider;
    const provider = await this.resolveProvider(providerName);
    if (!provider?.validateConfig()) throw new Error(`Provider indisponible : ${providerName}`);

    const runId = crypto.randomUUID();
    const controller = new AbortController();
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    const snapshot: AgentRunSnapshot = {
      id: runId,
      sessionId: session.id,
      workspaceId: request.workspaceId ?? session.workspaceId,
      cwd: request.cwd,
      provider: providerName,
      model: effectiveRequest.model ?? session.model,
      phase: 'queued',
      steerQueue: [],
      followUpQueue: [],
      lastSequence: this.journal.lastSequence(session.id),
    };
    const active: ActiveRun = {
      snapshot,
      controller,
      completion,
      resolveCompletion,
      settled: false,
      queue: new AgentMessageQueue({
        steeringMode: request.steeringMode,
        followUpMode: request.followUpMode,
      }),
    };
    await this.sessionManager.update(session.id, {
      cwd: request.cwd,
      workspaceId: request.workspaceId,
      agentId: effectiveRequest.agentId ?? runId,
      ...(effectiveRequest.persistSettings === false ? {} : {
        model: effectiveRequest.model,
        thinking: request.thinking,
        toolPreset: request.toolPreset,
        ...(effectiveRequest.systemPrompt !== undefined
          ? { metadata: { ...session.metadata, systemPrompt: effectiveRequest.systemPrompt } }
          : {}),
      }),
    });
    this.runs.set(runId, active);
    this.sessionRuns.set(session.id, runId);
    this.publish(active, 'run.queued', { input: hook.data.input });

    void this.execute(active, effectiveRequest, provider).finally(() => {
      active.settled = true;
      active.resolveCompletion();
    });
    return this.redactJson(cloneSnapshot(snapshot));
  }

  getRun(runId: string): AgentRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? this.redactJson(cloneSnapshot(run.snapshot)) : undefined;
  }

  getSessionRun(sessionId: string): AgentRunSnapshot | undefined {
    const runId = this.sessionRuns.get(sessionId);
    return runId ? this.getRun(runId) : undefined;
  }

  listRunning(): AgentRunSnapshot[] {
    return [...this.runs.values()]
      .filter(run => !['completed', 'failed', 'stopped'].includes(run.snapshot.phase))
      .map(run => this.redactJson(cloneSnapshot(run.snapshot)));
  }

  publishSessionEvent(sessionId: string, type: AgentEventType, data: unknown): AgentEvent {
    const run = this.getSessionRun(sessionId);
    return this.journal.publish(sessionId, type, this.redactJson(data), run?.id);
  }

  requestExtensionInteraction(
    sessionId: string,
    request: ExtensionInteractionRequest,
  ): Promise<ExtensionInteractionResponse> {
    const runId = this.sessionRuns.get(sessionId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || ['completed', 'failed', 'stopped'].includes(run.snapshot.phase)) {
      throw new Error('An active agent run is required for an extension interaction.');
    }
    return this.requestInteraction(run, request);
  }

  snapshot(sessionId: string): AgentStateSnapshot {
    return {
      sessionId,
      lastSequence: this.journal.lastSequence(sessionId),
      run: this.getSessionRun(sessionId),
    };
  }

  async wait(runId: string): Promise<AgentRunSnapshot | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    await run.completion;
    return this.getRun(runId);
  }

  enqueue(
    runId: string,
    kind: QueuedAgentMessage['kind'],
    content: string,
    blocks?: MessageContentBlock[],
  ): AgentRunSnapshot {
    const run = this.requireActive(runId);
    if (!content.trim()) throw new Error('Le message de file ne peut pas être vide.');
    const message: QueuedAgentMessage = {
      id: crypto.randomUUID(),
      kind,
      content: this.redactText(content.trim()),
      ...(blocks?.length ? { blocks: this.redactJson(structuredClone(blocks)) } : {}),
      createdAt: new Date().toISOString(),
    };
    try {
      run.queue.enqueue(kind, message);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        status: 409,
        code: 'AGENT_QUEUE_FULL',
      });
    }
    this.publishQueue(run);
    return this.redactJson(cloneSnapshot(run.snapshot));
  }

  clearQueue(runId: string, kind?: QueuedAgentMessage['kind']): AgentRunSnapshot {
    const run = this.requireActive(runId);
    run.queue.clear(kind);
    this.publishQueue(run);
    return this.redactJson(cloneSnapshot(run.snapshot));
  }

  respondToInteraction(
    sessionId: string,
    requestId: string,
    response: ExtensionInteractionResponse,
  ): AgentRunSnapshot {
    const pending = this.interactions.get(requestId);
    if (!pending || pending.sessionId !== sessionId) throw new Error('Extension interaction not found.');
    const run = this.runs.get(pending.runId);
    if (!run) throw new Error('Extension run not found.');
    let serialized: string | undefined;
    try { serialized = response.value === undefined ? undefined : JSON.stringify(response.value); }
    catch { throw new Error('Extension interaction response must be JSON serializable.'); }
    if (serialized && Buffer.byteLength(serialized, 'utf8') > 100_000) {
      throw new Error('Extension interaction response is too large.');
    }
    const normalized = this.redactJson(validateInteractionResponse(pending.request, response));
    this.interactions.delete(requestId);
    run.snapshot.extensionRequest = undefined;
    pending.settle(normalized);
    this.publish(run, 'extension.ui', { action: 'resolved', requestId, cancelled: response.cancelled === true });
    return this.redactJson(cloneSnapshot(run.snapshot));
  }

  stop(runId: string): AgentRunSnapshot {
    const run = this.requireActive(runId);
    run.controller.abort();
    this.cancelInteractions(run);
    run.snapshot.retry = undefined;
    run.snapshot.activeTool = undefined;
    run.snapshot.extensionRequest = undefined;
    // The HTTP acknowledgement can report stopped immediately, but the journal's
    // terminal event must follow durable interrupted-tool accounting and cleanup.
    run.snapshot.phase = 'stopped';
    return this.redactJson(cloneSnapshot(run.snapshot));
  }

  private async execute(
    run: ActiveRun,
    request: StartAgentRunRequest,
    provider: AiProvider,
  ): Promise<void> {
    run.snapshot.startedAt = new Date().toISOString();
    this.setPhase(run, 'prompting');
    this.publish(run, 'run.started', { cwd: run.snapshot.cwd, provider: run.snapshot.provider });

    try {
      let hasPrompt = true;
      let initial = true;
      let queued: QueuedAgentMessage[] = [];
      while (hasPrompt) {
        const preparedTools = await this.prepareRunTools(run, request);
        if (initial) {
          await this.persistInitial(run, request);
          initial = false;
        } else {
          await this.persistQueued(run, request, queued);
          queued = [];
        }
        await this.executePrompt(run, request, provider, preparedTools);
        if (run.controller.signal.aborted) throw new AgentAbortError();
        const batch = this.takeNextQueued(run);
        if (batch) {
          queued = batch.items;
          this.setPhase(run, 'prompting');
        } else {
          hasPrompt = false;
        }
      }

      run.snapshot.completedAt = new Date().toISOString();
      run.snapshot.extensionRequest = undefined;
      this.cancelInteractions(run);
      this.setPhase(run, 'completed');
      this.publish(run, 'run.completed', { completedAt: run.snapshot.completedAt });
      void Promise.resolve(this.onNotification?.(
        'completion',
        this.redactJson(cloneSnapshot(run.snapshot)),
      )).catch(() => undefined);
    } catch (error) {
      run.snapshot.completedAt = new Date().toISOString();
      run.snapshot.retry = undefined;
      run.snapshot.activeTool = undefined;
      run.snapshot.extensionRequest = undefined;
      this.cancelInteractions(run);
      if (run.controller.signal.aborted || error instanceof AgentAbortError) {
        this.setPhase(run, 'stopped');
        this.publish(run, 'run.stopped', { completedAt: run.snapshot.completedAt });
      } else {
        run.snapshot.error = this.redactText(error instanceof Error ? error.message : String(error));
        this.setPhase(run, 'failed');
        this.publish(run, 'run.failed', { message: run.snapshot.error });
        void Promise.resolve(this.onNotification?.(
          'attention',
          this.redactJson(cloneSnapshot(run.snapshot)),
        )).catch(() => undefined);
      }
    } finally {
      if (run.controller.signal.aborted) {
        await this.mcpHost?.releaseSession(run.snapshot.sessionId);
      } else {
        this.mcpHost?.finishPrompt(run.snapshot.sessionId);
      }
    }
  }

  private async executePrompt(
    run: ActiveRun,
    request: StartAgentRunRequest,
    provider: AiProvider,
    preparedTools: PreparedRunTools,
  ): Promise<void> {
    await runToolLoop({
      sessionManager: this.sessionManager,
      sessionId: run.snapshot.sessionId,
      extensionRegistry: this.extensionRegistry,
      toolContext: await this.toolContext(run, provider, request),
      provider: run.snapshot.provider,
      tools: preparedTools.definitions(),
      resolveTools: () => preparedTools.definitions(),
      executeTool: (name, input, context, signal) => preparedTools.execute(
        name, input, context, signal,
      ),
      getActivatedTools: (name, result) => preparedTools.activatedTools(name, result),
      getToolResultMetadata: (name, result) => preparedTools.resultMetadata(name, result),
      maxToolRounds: request.maxToolRounds,
      signal: run.controller.signal,
      redactText: this.redactText,
      onTurnStart: () => this.setPhase(run, 'prompting'),
      onToolCall: call => {
        run.snapshot.activeTool = {
          id: call.id,
          name: call.name,
          input: structuredClone(call.input),
          startedAt: new Date().toISOString(),
        };
        this.setPhase(run, 'tool');
        this.publish(run, 'tool.started', call);
      },
      onCodemodeProgress: progress => {
        const tool = run.snapshot.activeTool;
        if (!tool || tool.name !== 'codemode' || tool.id !== progress.parentId) return;
        const calls = tool.nestedCalls ?? [];
        const index = calls.findIndex(call => call.id === progress.call.id);
        if (index >= 0) calls[index] = structuredClone(progress.call);
        else if (calls.length < 64) calls.push(structuredClone(progress.call));
        tool.nestedCalls = calls;
        this.publish(run, 'tool.progress', { kind: 'codemode', ...progress });
      },
      onToolUsage: usage => {
        this.onUsage?.(run.snapshot.provider, undefined, { promptTokens: usage.inputTokens ?? 0,
          completionTokens: usage.outputTokens ?? 0, totalTokens: usage.totalTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, costUsd: usage.costUsd });
      },
      onToolResult: result => {
        run.snapshot.activeTool = undefined;
        this.publish(run, result.isError ? 'tool.failed' : 'tool.completed', result);
      },
      onUsage: response => {
        if (!response.usage) return;
        const costUsd = this.onUsage?.(run.snapshot.provider, response.model ?? request.model, response.usage);
        if (costUsd !== undefined) response.usage.costUsd = costUsd;
      },
      onFinalResponse: (content, response) => {
        this.publish(run, 'message.completed', {
          content,
          model: response.model,
          usage: response.usage,
        });
      },
      streamTurn: async (messages, definitions) => {
        await this.flushSteering(run, request);
        const currentMessages = this.effectiveMessages(run.snapshot.sessionId);
        const thinking = request.thinking === 'max' ? 'xhigh' : request.thinking;
        let messageId = '';
        let content = '';
        let reasoning = '';
        const response = await streamProviderTurn({
          provider,
          providerName: run.snapshot.provider,
          model: request.model,
          sessionId: run.snapshot.sessionId,
          messages: currentMessages.length ? currentMessages : messages,
          tools: definitions,
          systemPrompt: request.systemPrompt,
          thinking,
          signal: run.controller.signal,
          extensionRegistry: this.extensionRegistry,
          maxRetries: request.maxRetries ?? 2,
          retryDelayMs: 500,
          retryMaxDelayMs: 5_000,
          redactText: this.redactText,
          redactJson: this.redactJson,
          createTextRedactor: this.createTextRedactor,
          onStart: (_provider, model) => {
            this.setPhase(run, 'streaming');
            run.snapshot.retry = undefined;
            run.snapshot.error = undefined;
            messageId = `stream:${run.snapshot.id}:${crypto.randomUUID()}`;
            run.snapshot.partialMessage = { id: messageId, content: '' };
            this.publish(run, 'message.start', { attempt: 1, model, messageId });
          },
          onTextDelta: delta => {
            content += delta;
            run.snapshot.partialMessage = { id: messageId, content, ...(reasoning ? { reasoning } : {}) };
            this.publish(run, 'message.delta', { content: delta, messageId });
          },
          onReasoningDelta: delta => {
            reasoning += delta;
            run.snapshot.partialMessage = { id: messageId, content, reasoning };
            this.publish(run, 'reasoning.delta', { content: delta, messageId });
          },
          onProviderEvent: event => {
            if (event.type === 'tool_call') this.publish(run, 'tool.progress', event.data);
          },
          onRetryStart: ({ attempt, maxAttempts, delayMs, error }) => {
            run.snapshot.partialMessage = undefined;
            run.snapshot.retry = {
              attempt,
              max: maxAttempts,
              delayMs,
              message: this.redactText(error instanceof Error ? error.message : String(error)),
              scheduledAt: new Date().toISOString(),
            };
            this.publish(run, 'retry.scheduled', run.snapshot.retry);
          },
          onError: () => {
            run.snapshot.partialMessage = undefined;
          },
        });
        run.snapshot.partialMessage = undefined;
        run.snapshot.retry = undefined;
        return response;
      },
    });
  }

  private async flushSteering(run: ActiveRun, request: StartAgentRunRequest): Promise<void> {
    await this.persistQueued(run, request, this.takeQueued(run, 'steer'));
  }

  private async persistInitial(run: ActiveRun, request: StartAgentRunRequest): Promise<void> {
    await this.sessionManager.addMessage(run.snapshot.sessionId, {
      role: 'user',
      content: request.input,
      blocks: request.blocks?.length ? request.blocks : [{ type: 'text', text: request.input }],
      agentId: request.agentId ?? run.snapshot.id,
      metadata: { queueKind: 'initial' },
    }, { signal: run.controller.signal });
  }

  private async persistQueued(
    run: ActiveRun,
    request: StartAgentRunRequest,
    queued: QueuedAgentMessage[],
  ): Promise<void> {
    for (const message of queued) {
      await this.sessionManager.addMessage(run.snapshot.sessionId, {
        role: 'user',
        content: message.content,
        blocks: message.blocks?.length ? message.blocks : [{ type: 'text', text: message.content }],
        agentId: request.agentId ?? run.snapshot.id,
        metadata: { queueKind: message.kind },
      }, { signal: run.controller.signal });
    }
  }

  private takeQueued(run: ActiveRun, kind: AgentMessageQueueKind): QueuedAgentMessage[] {
    const queued = run.queue.take(kind);
    if (queued.length) this.publishQueue(run);
    return queued;
  }

  private takeNextQueued(run: ActiveRun): AgentMessageQueueBatch<QueuedAgentMessage> | undefined {
    const queued = run.queue.takeNext();
    if (queued) this.publishQueue(run);
    return queued;
  }

  private publishQueue(run: ActiveRun): void {
    const queued = run.queue.snapshot();
    run.snapshot.steerQueue = queued.steering;
    run.snapshot.followUpQueue = queued.followUp;
    this.publish(run, 'queue.updated', {
      steer: run.snapshot.steerQueue,
      followUp: run.snapshot.followUpQueue,
    });
  }

  private effectiveMessages(sessionId: string): Message[] {
    return this.sessionManager.getEffectiveContext(sessionId)
      .filter(entry => entry.type === 'message')
      .map(entry => ({
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
      }));
  }

  /** Return declarations currently active for a session, including branch-restored search matches. */
  getTools(
    preset: Session['toolPreset'],
    allowedTools?: string[],
    allowedExtensions?: string[],
    sessionId?: string,
  ): ReturnType<ExtensionRegistry['getTools']> {
    const prepared = sessionId ? this.mcpHost?.getPreparedTools(sessionId, preset) : undefined;
    return this.createToolLoadout(
      sessionId,
      { preset, allowedTools, allowedExtensions },
      prepared,
    ).getTools();
  }

  private createToolLoadout(
    sessionId: string | undefined,
    selection: {
      preset?: Session['toolPreset'];
      allowedTools?: string[];
      excludedTools?: string[];
      allowedExtensions?: string[];
      codemode?: CodemodeSettings;
    },
    mcp?: PreparedMcpTools,
    initialLoadedTools?: Iterable<string>,
  ) {
    const loaded = initialLoadedTools ?? (sessionId
      ? collectToolSearchLoadedNames(this.sessionManager.getEffectiveContext(sessionId))
      : []);
    return createAgentToolLoadout({
      staticTools: this.extensionRegistry.getTools(),
      currentStaticTools: () => this.extensionRegistry.getTools(),
      codemode: selection.codemode,
      redactText: this.redactText,
      selection,
      initialLoadedTools: loaded,
      dynamicSource: mcp ? {
        directTools: mcp.tools,
        hasPotentialSearchableTools: mcp.hasPotentialDiscoverableTools ?? false,
        currentSearchableTools: () => mcp.currentDiscoverableTools?.() ?? mcp.discoverableTools ?? [],
        waitForSearchableTools: signal => mcp.waitForDiscoverableTools?.(signal)
          ?? Promise.resolve(mcp.discoverableTools ?? []),
        has: name => mcp.has(name),
      } : undefined,
    });
  }

  private async prepareRunTools(
    run: ActiveRun,
    request: StartAgentRunRequest,
  ): Promise<PreparedRunTools> {
    let mcp: PreparedMcpTools | undefined;
    if (this.mcpHost && request.toolPreset !== 'chat-only' && request.allowedTools?.length !== 0) {
      mcp = await this.mcpHost.prepareForPrompt({
        sessionId: run.snapshot.sessionId,
        cwd: run.snapshot.cwd,
        preset: request.toolPreset,
        signal: run.controller.signal,
      });
    }
    const session = this.sessionManager.get(run.snapshot.sessionId);
    const loadedTools = collectToolSearchLoadedNames(
      await this.sessionManager.getRawEntries(run.snapshot.sessionId),
      session?.activeLeafId,
    );
    const loadout = this.createToolLoadout(run.snapshot.sessionId, {
      preset: request.toolPreset,
      allowedTools: request.allowedTools,
      excludedTools: request.excludedTools,
      allowedExtensions: request.allowedExtensions,
      codemode: request.codemode,
    }, mcp, loadedTools);
    const execute: PreparedRunTools['execute'] = (name, input, context, signal) => {
        if (loadout.isCodemode(name)) {
          return this.extensionRegistry.executeHostedTool(name, input, context,
            (hostInput, hostContext, hostSignal) => loadout.executeCodemode(hostInput, hostContext, execute, hostSignal), signal);
        }
        if (loadout.isToolSearch(name)) {
          return this.extensionRegistry.executeHostedTool(
            name,
            input,
            context,
            (hostInput, hostContext, hostSignal) => loadout.executeToolSearch(
              hostInput, hostContext, hostSignal,
            ),
            signal,
          );
        }
        if (mcp && loadout.isDynamicTool(name)) {
          return this.extensionRegistry.executeHostedTool(
            name,
            input,
            context,
            (hostInput, hostContext, hostSignal) => mcp!.execute(
              name, hostInput, hostContext, hostSignal,
            ),
            signal,
          );
        }
        return this.extensionRegistry.executeTool(name, input, context, signal);
    };
    return {
      definitions: () => toChatToolDefinitions(loadout.getTools()),
      execute,
      resultMetadata: (name, result) => loadout.resultMetadata(name, result),
      activatedTools: (name, result) => loadout.activatedTools(name, result),
    };
  }

  private async toolContext(
    run: ActiveRun,
    provider: AiProvider,
    request: StartAgentRunRequest,
  ): Promise<ExtensionRuntimeContext> {
    return {
      sessionManager: this.sessionManager,
      currentSessionId: run.snapshot.sessionId,
      provider,
      providerName: run.snapshot.provider,
      toolPreset: request.toolPreset,
      allowedSkills: request.allowedSkills ? [...request.allowedSkills] : undefined,
      cwd: run.snapshot.cwd,
      workspaceId: run.snapshot.workspaceId,
      projectTrusted: await this.isProjectTrusted(run.snapshot.cwd),
      notify: (message, level = 'info') => this.publish(run, 'notice', { message, level }),
      requestInteraction: request => this.requestInteraction(run, request),
    };
  }

  private requestInteraction(
    run: ActiveRun,
    request: ExtensionInteractionRequest,
  ): Promise<ExtensionInteractionResponse> {
    if (run.snapshot.extensionRequest) throw new Error('An extension interaction is already pending for this run.');
    const normalized = interactionRequest(request, this.redactText);
    const snapshot: ExtensionInteractionSnapshot = {
      ...normalized,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    run.snapshot.extensionRequest = snapshot;
    this.publish(run, 'extension.ui', { action: 'request', request: snapshot });
    void Promise.resolve(this.onNotification?.(
      'attention',
      this.redactJson(cloneSnapshot(run.snapshot)),
    )).catch(() => undefined);
    return new Promise(resolve => {
      let settled = false;
      const settle = (response: ExtensionInteractionResponse): void => {
        if (settled) return;
        settled = true;
        run.controller.signal.removeEventListener('abort', abort);
        resolve(response);
      };
      const abort = (): void => {
        this.interactions.delete(snapshot.id);
        run.snapshot.extensionRequest = undefined;
        settle({ cancelled: true });
      };
      this.interactions.set(snapshot.id, {
        runId: run.snapshot.id,
        sessionId: run.snapshot.sessionId,
        request: snapshot,
        settle,
      });
      run.controller.signal.addEventListener('abort', abort, { once: true });
    });
  }

  private cancelInteractions(run: ActiveRun): void {
    for (const [id, pending] of this.interactions) {
      if (pending.runId !== run.snapshot.id) continue;
      this.interactions.delete(id);
      pending.settle({ cancelled: true });
    }
  }

  private setPhase(run: ActiveRun, phase: AgentPhase): void {
    run.snapshot.phase = phase;
    this.publish(run, 'run.phase', { phase });
  }

  private publish<T>(run: ActiveRun, type: Parameters<AgentEventJournal['publish']>[1], data: T): void {
    const event = this.journal.publish(
      run.snapshot.sessionId,
      type,
      this.redactJson(data),
      run.snapshot.id,
    );
    run.snapshot.lastSequence = event.sequence;
  }

  private requireActive(runId: string): ActiveRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Exécution introuvable.');
    if (['completed', 'failed', 'stopped'].includes(run.snapshot.phase)) {
      throw new Error('Cette exécution est terminée.');
    }
    return run;
  }
}
