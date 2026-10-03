import type { AiProvider, ChatOptions, ChatResponse, ChatToolDefinition } from '../providers/index.js';
import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  ExtensionRegistry,
  ExtensionRuntimeContext,
} from '../extensions/extension-registry.js';
import type { Message, MessageContentBlock, Session } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { AgentAbortError, runToolLoop } from './tool-loop.js';
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
  allowedSkills?: string[];
  allowedExtensions?: string[];
}

export interface AgentRuntimeOptions {
  sessionManager: SessionManager;
  extensionRegistry: ExtensionRegistry;
  resolveProvider(name: string): AiProvider | undefined | Promise<AiProvider | undefined>;
  journal?: AgentEventJournal;
  isProjectTrusted?(cwd: string): boolean | Promise<boolean>;
  onUsage?(provider: string, model: string | undefined, usage: NonNullable<ChatResponse['usage']>): number | undefined;
  onNotification?(category: 'completion' | 'attention', run: AgentRunSnapshot): void | Promise<void>;
}

interface ActiveRun {
  snapshot: AgentRunSnapshot;
  controller: AbortController;
  completion: Promise<void>;
  resolveCompletion(): void;
}

interface PendingInteraction {
  runId: string;
  sessionId: string;
  request: ExtensionInteractionSnapshot;
  settle(response: ExtensionInteractionResponse): void;
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

function interactionRequest(value: ExtensionInteractionRequest): ExtensionInteractionRequest {
  const title = String(value.title ?? '').trim().slice(0, 200);
  if (!title) throw new Error('Extension interaction title is required.');
  if (!['confirm', 'input', 'select', 'editor', 'custom'].includes(value.kind)) {
    throw new Error('Unsupported extension interaction kind.');
  }
  const boundedOptions = value.options?.slice(0, 100).map(option => ({
    value: String(option.value).slice(0, 500),
    label: String(option.label).slice(0, 500),
    ...(option.description ? { description: String(option.description).slice(0, 2_000) } : {}),
  }));
  const fieldNames = new Set<string>();
  const boundedFields = value.fields?.slice(0, 50).map(field => {
    const name = String(field.name);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name) || fieldNames.has(name)) {
      throw new Error('Extension interaction field names must be unique identifiers.');
    }
    if (!['text', 'textarea', 'select', 'checkbox'].includes(field.type)) {
      throw new Error('Unsupported extension interaction field type.');
    }
    fieldNames.add(name);
    return {
      name,
      label: String(field.label).slice(0, 500),
      type: field.type,
      ...(field.required ? { required: true } : {}),
      ...(field.placeholder ? { placeholder: String(field.placeholder).slice(0, 1_000) } : {}),
      ...(field.options ? { options: field.options.slice(0, 100).map(option => ({
        value: String(option.value).slice(0, 500), label: String(option.label).slice(0, 500),
      })) } : {}),
    };
  });
  return {
    kind: value.kind,
    title,
    ...(value.message ? { message: String(value.message).slice(0, 10_000) } : {}),
    ...(value.placeholder ? { placeholder: String(value.placeholder).slice(0, 1_000) } : {}),
    ...(boundedOptions?.length ? { options: boundedOptions } : {}),
    ...(boundedFields?.length ? { fields: boundedFields } : {}),
    ...(value.output ? { output: String(value.output).slice(0, 100_000) } : {}),
    ...(value.ansi ? { ansi: true } : {}),
  };
}

function cloneSnapshot(snapshot: AgentRunSnapshot): AgentRunSnapshot {
  return structuredClone(snapshot);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AgentAbortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AgentAbortError());
    }, { once: true });
  });
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

  constructor(options: AgentRuntimeOptions) {
    this.sessionManager = options.sessionManager;
    this.extensionRegistry = options.extensionRegistry;
    this.resolveProvider = options.resolveProvider;
    this.journal = options.journal ?? new AgentEventJournal();
    this.isProjectTrusted = options.isProjectTrusted ?? (() => false);
    this.onUsage = options.onUsage;
    this.onNotification = options.onNotification;
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
    const existing = this.getSessionRun(request.sessionId);
    if (existing && !['completed', 'failed', 'stopped'].includes(existing.phase)) {
      throw new Error('Un agent est déjà actif pour cette session.');
    }

    const hook = await this.extensionRegistry.runBefore('before:agent', {
      sessionId: request.sessionId,
      provider: request.provider,
      input: request.input,
    });
    if (hook.cancelled) throw new Error(hook.reason || "Exécution annulée par une extension.");
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
      model: request.model ?? session.model,
      phase: 'queued',
      steerQueue: [],
      followUpQueue: [],
      lastSequence: this.journal.lastSequence(session.id),
    };
    const active: ActiveRun = { snapshot, controller, completion, resolveCompletion };
    await this.sessionManager.update(session.id, {
      cwd: request.cwd,
      workspaceId: request.workspaceId,
      agentId: request.agentId ?? runId,
      ...(request.persistSettings === false ? {} : {
        model: request.model,
        thinking: request.thinking,
        toolPreset: request.toolPreset,
      }),
      ...(request.systemPrompt ? { metadata: { ...session.metadata, systemPrompt: request.systemPrompt } } : {}),
    });
    await this.sessionManager.addMessage(session.id, {
      role: 'user',
      content: hook.data.input,
      blocks: request.blocks?.length ? request.blocks : [{ type: 'text', text: hook.data.input }],
      agentId: request.agentId ?? runId,
      metadata: { queueKind: 'initial' },
    }, { signal: controller.signal });
    this.runs.set(runId, active);
    this.sessionRuns.set(session.id, runId);
    this.publish(active, 'run.queued', { input: hook.data.input });

    void this.execute(active, request, provider).finally(() => {
      active.resolveCompletion();
    });
    return cloneSnapshot(snapshot);
  }

  getRun(runId: string): AgentRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? cloneSnapshot(run.snapshot) : undefined;
  }

  getSessionRun(sessionId: string): AgentRunSnapshot | undefined {
    const runId = this.sessionRuns.get(sessionId);
    return runId ? this.getRun(runId) : undefined;
  }

  listRunning(): AgentRunSnapshot[] {
    return [...this.runs.values()]
      .filter(run => !['completed', 'failed', 'stopped'].includes(run.snapshot.phase))
      .map(run => cloneSnapshot(run.snapshot));
  }

  publishSessionEvent(sessionId: string, type: AgentEventType, data: unknown): AgentEvent {
    const run = this.getSessionRun(sessionId);
    return this.journal.publish(sessionId, type, data, run?.id);
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
      content: content.trim(),
      ...(blocks?.length ? { blocks: structuredClone(blocks) } : {}),
      createdAt: new Date().toISOString(),
    };
    if (kind === 'steer') run.snapshot.steerQueue.push(message);
    else run.snapshot.followUpQueue.push(message);
    this.publish(run, 'queue.updated', {
      steer: run.snapshot.steerQueue,
      followUp: run.snapshot.followUpQueue,
    });
    return cloneSnapshot(run.snapshot);
  }

  clearQueue(runId: string, kind?: QueuedAgentMessage['kind']): AgentRunSnapshot {
    const run = this.requireActive(runId);
    if (!kind || kind === 'steer') run.snapshot.steerQueue = [];
    if (!kind || kind === 'follow-up') run.snapshot.followUpQueue = [];
    this.publish(run, 'queue.updated', {
      steer: run.snapshot.steerQueue,
      followUp: run.snapshot.followUpQueue,
    });
    return cloneSnapshot(run.snapshot);
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
    const normalized = validateInteractionResponse(pending.request, response);
    this.interactions.delete(requestId);
    run.snapshot.extensionRequest = undefined;
    pending.settle(normalized);
    this.publish(run, 'extension.ui', { action: 'resolved', requestId, cancelled: response.cancelled === true });
    return cloneSnapshot(run.snapshot);
  }

  stop(runId: string): AgentRunSnapshot {
    const run = this.requireActive(runId);
    run.controller.abort();
    this.cancelInteractions(run);
    run.snapshot.retry = undefined;
    run.snapshot.activeTool = undefined;
    run.snapshot.extensionRequest = undefined;
    run.snapshot.completedAt = new Date().toISOString();
    this.setPhase(run, 'stopped');
    this.publish(run, 'run.stopped', { completedAt: run.snapshot.completedAt });
    return cloneSnapshot(run.snapshot);
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
      while (hasPrompt) {
        await this.executePrompt(run, request, provider);
        if (run.controller.signal.aborted) throw new AgentAbortError();
        const next = run.snapshot.followUpQueue.shift() ?? run.snapshot.steerQueue.shift();
        if (next) {
          this.publish(run, 'queue.updated', {
            steer: run.snapshot.steerQueue,
            followUp: run.snapshot.followUpQueue,
          });
          await this.sessionManager.addMessage(run.snapshot.sessionId, {
            role: 'user',
            content: next.content,
            blocks: next.blocks?.length ? next.blocks : [{ type: 'text', text: next.content }],
            agentId: request.agentId ?? run.snapshot.id,
            metadata: { queueKind: next.kind },
          }, { signal: run.controller.signal });
          this.setPhase(run, 'prompting');
        } else {
          hasPrompt = false;
        }
      }

      run.snapshot.completedAt = new Date().toISOString();
      this.setPhase(run, 'completed');
      this.publish(run, 'run.completed', { completedAt: run.snapshot.completedAt });
      void Promise.resolve(this.onNotification?.('completion', cloneSnapshot(run.snapshot))).catch(() => undefined);
    } catch (error) {
      run.snapshot.completedAt = new Date().toISOString();
      run.snapshot.retry = undefined;
      run.snapshot.activeTool = undefined;
      run.snapshot.extensionRequest = undefined;
      this.cancelInteractions(run);
      if (run.controller.signal.aborted || error instanceof AgentAbortError) {
        if (run.snapshot.phase !== 'stopped') {
          this.setPhase(run, 'stopped');
          this.publish(run, 'run.stopped', { completedAt: run.snapshot.completedAt });
        }
      } else {
        run.snapshot.error = error instanceof Error ? error.message : String(error);
        this.setPhase(run, 'failed');
        this.publish(run, 'run.failed', { message: run.snapshot.error });
        void Promise.resolve(this.onNotification?.('attention', cloneSnapshot(run.snapshot))).catch(() => undefined);
      }
    }
  }

  private async executePrompt(
    run: ActiveRun,
    request: StartAgentRunRequest,
    provider: AiProvider,
  ): Promise<void> {
    const tools = this.selectTools(request.toolPreset, request.allowedTools, request.allowedExtensions);
    await runToolLoop({
      sessionManager: this.sessionManager,
      sessionId: run.snapshot.sessionId,
      extensionRegistry: this.extensionRegistry,
      toolContext: await this.toolContext(run, provider, request),
      provider: run.snapshot.provider,
      tools,
      maxToolRounds: request.maxToolRounds,
      signal: run.controller.signal,
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
        const baseOptions: ChatOptions = {
          model: request.model,
          systemPrompt: request.systemPrompt,
          thinking,
          tools: definitions,
          signal: run.controller.signal,
        };
        const hook = await this.extensionRegistry.runBefore('before:provider', {
          provider: run.snapshot.provider,
          model: request.model,
          messages: currentMessages.length ? currentMessages : messages,
          options: baseOptions,
        });
        if (hook.cancelled) throw new Error(hook.reason || 'Appel provider annulé par une extension.');
        return this.streamProvider(run, provider, hook.data.messages, hook.data.options, request.maxRetries ?? 2);
      },
    });
  }

  private async streamProvider(
    run: ActiveRun,
    provider: AiProvider,
    messages: Message[],
    options: ChatOptions,
    maxRetries: number,
  ): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      let hadDelta = false;
      try {
        this.setPhase(run, 'streaming');
        run.snapshot.retry = undefined;
        run.snapshot.error = undefined;
        const messageId = `stream:${run.snapshot.id}:${crypto.randomUUID()}`;
        run.snapshot.partialMessage = { id: messageId, content: '' };
        this.publish(run, 'message.start', { attempt: attempt + 1, model: options.model, messageId });
        const response = await new Promise<ChatResponse>((resolve, reject) => {
          let content = '';
          let reasoning = '';
          let settled = false;
          const complete = (response?: ChatResponse): void => {
            if (settled) return;
            settled = true;
            resolve(response ? {
              ...response,
              ...(response.reasoning || !reasoning ? {} : { reasoning }),
            } : { content, ...(reasoning ? { reasoning } : {}) });
          };
          const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          void provider.streamChat(
            messages,
            (chunk, event) => {
              if (chunk) {
                hadDelta = true;
                content += chunk;
                run.snapshot.partialMessage = { id: messageId, content };
                this.publish(run, 'message.delta', { content: chunk, messageId });
              }
              if (event?.type === 'reasoning_delta') {
                const delta = typeof (event.data as { content?: unknown } | undefined)?.content === 'string'
                  ? String((event.data as { content: string }).content)
                  : '';
                if (delta) {
                  hadDelta = true;
                  reasoning += delta;
                  run.snapshot.partialMessage = { id: messageId, content, reasoning };
                  this.publish(run, 'reasoning.delta', { content: delta, messageId });
                }
              }
              if (event?.type === 'tool_call') this.publish(run, 'tool.progress', event.data);
            },
            complete,
            fail,
            options,
          ).then(() => complete()).catch(fail);
        });
        run.snapshot.partialMessage = undefined;
        run.snapshot.retry = undefined;
        return response;
      } catch (error) {
        if (run.controller.signal.aborted) throw new AgentAbortError();
        if (hadDelta || attempt >= maxRetries) throw error;
        run.snapshot.partialMessage = undefined;
        const delayMs = Math.min(5_000, 500 * 2 ** attempt);
        run.snapshot.retry = {
          attempt: attempt + 1,
          max: maxRetries + 1,
          delayMs,
          message: error instanceof Error ? error.message : String(error),
          scheduledAt: new Date().toISOString(),
        };
        this.publish(run, 'retry.scheduled', run.snapshot.retry);
        await delay(delayMs, run.controller.signal);
      }
    }
  }

  private async flushSteering(run: ActiveRun, request: StartAgentRunRequest): Promise<void> {
    const queued = run.snapshot.steerQueue.splice(0);
    if (!queued.length) return;
    this.publish(run, 'queue.updated', {
      steer: run.snapshot.steerQueue,
      followUp: run.snapshot.followUpQueue,
    });
    for (const message of queued) {
      await this.sessionManager.addMessage(run.snapshot.sessionId, {
        role: 'user',
        content: message.content,
        blocks: [{ type: 'text', text: message.content }],
        agentId: request.agentId ?? run.snapshot.id,
        metadata: { queueKind: 'steer' },
      }, { signal: run.controller.signal });
    }
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

  /** Return the exact registered tools available under a session preset. */
  getTools(
    preset: Session['toolPreset'],
    allowedTools?: string[],
    allowedExtensions?: string[],
  ): ReturnType<ExtensionRegistry['getTools']> {
    if (preset === 'chat-only') return [];
    const readOnly = new Set([
      'read_file', 'list_files', 'search_files', 'git_status', 'git_diff', 'load_skill', 'spawn_subagent',
    ]);
    const toolAllowlist = allowedTools === undefined ? undefined : new Set(allowedTools);
    const extensionAllowlist = allowedExtensions === undefined ? undefined : new Set(allowedExtensions);
    return this.extensionRegistry.getTools()
      .filter(tool => preset !== 'read-only' || readOnly.has(tool.name))
      .filter(tool => !toolAllowlist || toolAllowlist.has(tool.name))
      .filter(tool => !extensionAllowlist
        || tool.extensionId.startsWith('server:')
        || tool.extensionId.startsWith('builtin:')
        || extensionAllowlist.has(tool.extensionId));
  }

  private selectTools(
    preset: Session['toolPreset'],
    allowedTools?: string[],
    allowedExtensions?: string[],
  ): ChatToolDefinition[] {
    return this.getTools(preset, allowedTools, allowedExtensions)
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      }));
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
    const normalized = interactionRequest(request);
    const snapshot: ExtensionInteractionSnapshot = {
      ...normalized,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    run.snapshot.extensionRequest = snapshot;
    this.publish(run, 'extension.ui', { action: 'request', request: snapshot });
    void Promise.resolve(this.onNotification?.('attention', cloneSnapshot(run.snapshot))).catch(() => undefined);
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
    const event = this.journal.publish(run.snapshot.sessionId, type, data, run.snapshot.id);
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
