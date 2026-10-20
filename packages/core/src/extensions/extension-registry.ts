import type { AiProvider, ChatOptions } from '../providers/index.js';
import type { BeforeSpecializedModel, SpecializedModelType, SpecializedModelRequest } from '../providers/specialized-models.js';
import { ProviderFactory } from '../providers/index.js';
import { AI_HARNESS_EXTENSION_API_VERSION } from '../public-api-version.js';
import type { CodemodeProgress, Message, MessageContentBlock, ProviderConfig, Session } from '../types/index.js';
import { SessionManager, type SessionCompactionEvent } from '../sessions/session-manager.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { copySessionBranchEvent } from '../sessions/session-branch-admission.js';
import type { SessionBranchEvent } from '../sessions/session-branch-admission.js';
import type { BranchSummaryEvent, BranchSummaryOutput } from '../sessions/branch-summarization.js';
import { copyBranchSummaryEvent, copyBranchSummaryOutput } from '../sessions/session-branch-summary.js';
import type { AgentToolExposure, AgentToolNamespace } from '../tools/tool-selection.js';
import type { ToolProgressInput } from '../agent/tool-progress.js';
import { awaitAgentAdmission } from '../agent/prestart-admission.js';
import { copyExecutionHookPatch, copyExtensionResult, isExecutionHook, type AgentRunTrigger, type ExtensionCustomTrigger, type ExecutionHookName } from './execution-hooks.js';
export type { AgentRunTrigger, ExtensionCustomTrigger } from './execution-hooks.js';
import { EventEmitter, type EventHandler, type EventMap } from '../utils/event-emitter.js';

import { validateExtensionOption, type ExtensionOption, type ExtensionOptionDescriptor, type ExtensionOptionValue } from './startup-options.js';
export type { ExtensionOption, ExtensionOptionDescriptor, ExtensionOptionValue } from './startup-options.js';

export type ExtensionLogLevel = 'info' | 'success' | 'warning' | 'error';

export type ExtensionInteractionKind = 'confirm' | 'input' | 'select' | 'editor' | 'custom';

export interface ExtensionInteractionOption {
  value: string;
  label: string;
  description?: string;
}

export interface ExtensionInteractionField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox';
  required?: boolean;
  placeholder?: string;
  options?: ExtensionInteractionOption[];
}

/** Declarative interaction contract. It intentionally has no HTML or executable client payload. */
export interface ExtensionInteractionRequest {
  kind: ExtensionInteractionKind;
  title: string;
  message?: string;
  placeholder?: string;
  options?: ExtensionInteractionOption[];
  fields?: ExtensionInteractionField[];
  output?: string;
  ansi?: boolean;
  /** Optional host-side timeout for dialog interactions, in milliseconds. */
  timeoutMs?: number;
  /** Optional cancellation signal; never serialized to clients. */
  signal?: AbortSignal;
}

export interface ExtensionInteractionResponse {
  cancelled: boolean;
  value?: unknown;
}

/** Full replacement of display/schema only; cancellation and deadline remain attached to the original request. */
export type ExtensionInteractionUpdate = Omit<ExtensionInteractionRequest, 'signal' | 'timeoutMs'>;

/** Optional on adapters; detached hosts issue these capabilities, never accept caller-owned IDs. */
export interface ExtensionInteractionControls {
  readonly id: string;
  update(request: ExtensionInteractionUpdate): boolean;
  close(): boolean;
}

export type ExtensionInteractionPromise = Promise<ExtensionInteractionResponse> & Partial<ExtensionInteractionControls>;
export type ExtensionInteractionHandle = Promise<ExtensionInteractionResponse> & ExtensionInteractionControls;

/** Optional adapter-owned plain-text UI; absence means these methods are unavailable. */
export interface ExtensionRuntimeUI {
  readonly mode: 'rpc';
  readonly capabilities: {
    readonly dialogs: readonly ['select', 'confirm', 'input', 'editor'];
    readonly presentation: readonly ['setStatus', 'setWidget', 'setTitle', 'setEditorText'];
    readonly custom: false;
    readonly terminal: false;
  };
  setStatus(key: string, text?: string): void;
  setWidget(key: string, lines?: readonly string[]): void;
  setTitle(text?: string): void;
  setEditorText(text?: string): void;
}

export interface ExtensionRuntimeContext {
  sessionManager: SessionManager;
  currentSessionId?: string;
  provider?: AiProvider;
  providerName?: string;
  toolPreset?: Session['toolPreset'];
  /** Optional profile restrictions inherited by child-agent tools. */
  allowedSkills?: string[];
  /** Explicit canonical workspace context for server-hosted tools. */
  cwd?: string;
  workspaceId?: string;
  projectTrusted?: boolean;
  /** Host-owned fresh authorization for native mutations; boolean remains the legacy fallback. */
  isProjectTrusted?(cwd: string): boolean | Promise<boolean>;
  notify(message: string, level?: ExtensionLogLevel): void;
  /** Host correlation/sink installed by the shared tool loop, never by guest source. */
  toolCallId?: string;
  onCodemodeProgress?(progress: CodemodeProgress): void;
  /** Bounded display-only snapshots. Await to apply downstream backpressure. */
  onProgress?(progress: ToolProgressInput): Promise<void>;
  /** Host-authorized, cancellation-bound nested tools. No model/guest-supplied authority. */
  executeTool?(name: string, input: unknown): Promise<ExtensionToolResult>;
  beforeSpecializedModel?: BeforeSpecializedModel;
  /** Optional raw subprocess output sink; awaiting it applies downstream backpressure. */
  onProcessOutput?(chunk: string): void | Promise<void>;
  /** Host-owned path where the same complete subprocess stream is retained. */
  processOutputPath?: string;
  requestInteraction?(request: ExtensionInteractionRequest): ExtensionInteractionPromise;
  /** RPC presentation intents only; never terminal control sequences or input execution. */
  ui?: ExtensionRuntimeUI;
}

export interface ExtensionCommand {
  description: string;
  usage?: string;
  handler(args: string, context: ExtensionRuntimeContext): void | string | Promise<void | string>;
}

const toolAdmissions = new WeakMap<ExtensionRuntimeContext, () => void>();
/** Internal host binding, deliberately not a transformable context field or root export. */
export function bindHostToolAdmission(context: ExtensionRuntimeContext, validate: () => void): void {
  toolAdmissions.set(context, validate);
}

export interface ExtensionToolResult<TDetails = unknown> {
  content: string;
  /** Additive bounded JSON result, also supplied to text-only models as JSON text. */
  structuredContent?: unknown;
  blocks?: Array<Extract<MessageContentBlock, { type: 'text' | 'image' }>>;
  details?: TDetails;
  isError?: boolean;
}

export interface ExtensionTool<TInput = Record<string, unknown>, TDetails = unknown> {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /** Direct by default; codemode/deferred tools are loaded through tool_search. */
  exposure?: AgentToolExposure;
  /** Optional metadata used by deferred ranking and future nested runtimes. */
  namespace?: AgentToolNamespace;
  /** Trusted registration opt-in to bounded parallel batches; omitted means serial. */
  readOnly?: boolean;
  execute(
    input: TInput,
    context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): ExtensionToolResult<TDetails> | Promise<ExtensionToolResult<TDetails>>;
}

export interface ExtensionProvider {
  defaultConfig?: Omit<ProviderConfig, 'type'>;
  create(config: ProviderConfig): AiProvider;
}

export interface ExtensionUIContext {
  currentSessionId?: string;
  provider?: string;
}

export interface ExtensionUIComponent {
  name: string;
  placement?: 'header' | 'status';
  /** Plain text only. Browser clients must never interpret this value as markup. */
  render(context: ExtensionUIContext): string;
}

export interface BeforeAgentData {
  sessionId: string;
  provider: string;
  input: string;
  /** Host-owned startup lifetime; absent for legacy direct registry callers. */
  readonly signal?: AbortSignal;
  /** Absent for legacy callers; equivalent to a user trigger. */
  readonly trigger?: AgentRunTrigger;
}

export interface BeforeProviderData {
  provider: string;
  model?: string;
  messages: Message[];
  options: ChatOptions;
}

export interface BeforeToolData {
  tool: string;
  input: unknown;
  context: ExtensionRuntimeContext;
}

export interface ExtensionTurnEvent {
  readonly sessionId: string;
  readonly round: number;
  readonly trigger: AgentRunTrigger;
  readonly toolCount: number;
  readonly context: ExtensionRuntimeContext;
  readonly signal: AbortSignal;
  /** Last defined continuation wins; null explicitly clears it. */
  continuation?: ExtensionCustomTrigger | null;
}

export interface BeforeHookMap {
  /** Final assistant text only: never usage, reasoning, model or tool-call authority. */
  'before:message': { readonly sessionId?: string; content: string; readonly signal: AbortSignal };
  /** Public top-level tool result only; host metadata and completed effects are conserved. */
  'before:tool:result': { readonly sessionId: string; readonly tool: string; result: ExtensionToolResult; readonly signal: AbortSignal };
  'before:turn:end': ExtensionTurnEvent;
  'before:agent:settle': ExtensionTurnEvent;
  'before:agent': BeforeAgentData;
  'before:provider': BeforeProviderData;
  'before:tool': BeforeToolData;
  /** Ordered cancel-only admission; private journal data and destination rewrites are excluded. */
  'before:session:branch': SessionBranchEvent;
  /** Explicit summary work only: cancel or replace output, never rewrite its source/target. */
  'before:session:summary': BranchSummaryEvent;
  /** Output-only final compaction replacement/veto; no cut/accounting/provider authority. */
  'before:session:compaction': SessionCompactionEvent;
  /** Native/virtual SDK requests are not conversational provider turns. */
  'before:model': { type: SpecializedModelType; request: SpecializedModelRequest; context: ExtensionRuntimeContext; signal: AbortSignal };
}

export interface HookCancellation {
  cancel: true;
  reason?: string;
}

export type BeforeHookResult<T> = void | false | HookCancellation
  | (T extends ExtensionTurnEvent ? { continuation: ExtensionCustomTrigger | null }
    : T extends BeforeHookMap['before:message'] ? { content: string }
    : T extends BeforeHookMap['before:tool:result'] ? { result: Omit<ExtensionToolResult, 'details'> }
    : T extends SessionBranchEvent ? never : T extends BranchSummaryEvent ? BranchSummaryOutput
    : T extends SessionCompactionEvent ? { summary: string } : Partial<T>);
export type BeforeHookHandler<T> = (data: Readonly<T>) => BeforeHookResult<T> | Promise<BeforeHookResult<T>>;

export interface BeforeHookExecution<T> {
  data: T;
  cancelled: boolean;
  reason?: string;
  /** Present only for before:session:summary; a detached validated override. */
  summary?: BranchSummaryOutput;
  compactionSummary?: string;
}

export interface ExtensionInfo {
  id: string;
  commands: string[];
  tools: string[];
  providers: string[];
  uiComponents: string[];
  hooks: Array<keyof BeforeHookMap>;
}

export interface ExtensionAPI {
  /** Major version of this AiHarness-owned extension contract. */
  readonly version: typeof AI_HARNESS_EXTENSION_API_VERSION;
  /** Register an owned long startup option; disposing or unloading removes it. */
  registerOption(name: string, option: ExtensionOption): () => void;
  /** Reads only this extension's options. Explicit values are ready after startup parsing. */
  getOption(name: string): ExtensionOptionValue | undefined;
  registerCommand(name: string, command: ExtensionCommand): void;
  registerTool(tool: ExtensionTool): void;
  registerProvider(type: string, provider: ExtensionProvider): void;
  registerUI(component: ExtensionUIComponent): void;
  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void;
  before<K extends keyof BeforeHookMap>(event: K, handler: BeforeHookHandler<BeforeHookMap[K]>): () => void;
  events: EventEmitter<Record<string, unknown>>;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

interface Owned<T> {
  owner: string;
  value: T;
}

interface LoadedExtension {
  id: string;
  factory: ExtensionFactory;
  cleanups: Array<() => void | Promise<void>>;
}

type StoredBeforeHook = BeforeHookHandler<BeforeHookMap[keyof BeforeHookMap]>;
type SessionEvent = 'session:create' | 'session:delete' | 'session:update' | 'session:switch'
  | 'message:add' | 'message:clear' | 'compaction:start' | 'compaction:end' | 'compaction:error';

const LIFECYCLE_EVENTS: Record<keyof EventMap, true> = {
  'session:create': true, 'session:delete': true, 'session:update': true, 'session:switch': true,
  'message:add': true, 'message:clear': true, 'compaction:start': true, 'compaction:end': true, 'compaction:error': true,
  'agent:start': true, 'agent:end': true, 'agent:error': true,
  'provider:call:start': true, 'provider:call:end': true, 'provider:call:error': true,
  'tool:call': true, 'tool:result': true, 'tool:error': true, 'system:ready': true, 'system:shutdown': true,
};
const BEFORE_EVENTS: Record<keyof BeforeHookMap, true> = {
  'before:agent': true, 'before:provider': true, 'before:tool': true, 'before:model': true,
  'before:session:branch': true, 'before:session:summary': true, 'before:session:compaction': true,
  'before:message': true, 'before:tool:result': true, 'before:turn:end': true, 'before:agent:settle': true,
};

const SESSION_EVENTS: SessionEvent[] = [
  'session:create',
  'session:delete',
  'session:update',
  'session:switch',
  'message:add',
  'message:clear',
  'compaction:start',
  'compaction:end',
  'compaction:error',
];

/** Runtime registry for extension commands, tools, providers and lifecycle hooks. */
export class ExtensionRegistry {
  private readonly startupOptions = new Map<string, Owned<ExtensionOption>>();
  private startupOptionValues: Readonly<Record<string, ExtensionOptionValue>> = Object.freeze({});
  private readonly commands = new Map<string, Owned<ExtensionCommand>>();
  private readonly tools = new Map<string, Owned<ExtensionTool>>();
  private readonly providers = new Map<string, Owned<ExtensionProvider>>();
  private readonly uiComponents = new Map<string, Owned<ExtensionUIComponent>>();
  private readonly beforeHooks = new Map<keyof BeforeHookMap, Array<Owned<StoredBeforeHook>>>();
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly lifecycle = new EventEmitter<EventMap>();
  readonly events = new EventEmitter<Record<string, unknown>>();
  private detachSessionEvents?: () => void;
  private sessionBindingGeneration = Symbol();
  private shuttingDown = false;
  private readonly branchManagers = new Map<SessionManager, { references: number; detach: () => void }>();
  private reloadHandler?: () => Promise<void>;
  private executionHookLifetime = new AbortController();

  async load(id: string, factory: ExtensionFactory): Promise<void> {
    const normalizedId = id.trim();
    if (!normalizedId) throw new Error('Extension id is required');
    if (this.loaded.has(normalizedId)) throw new Error(`Extension already loaded: ${normalizedId}`);

    const extension: LoadedExtension = { id: normalizedId, factory, cleanups: [] };
    this.loaded.set(normalizedId, extension);
    const api = this.createApi(extension);

    try {
      const cleanup = await factory(api);
      if (cleanup) extension.cleanups.push(cleanup);
    } catch (error) {
      await this.unload(normalizedId);
      throw error;
    }
  }

  async unload(id: string): Promise<boolean> {
    const extension = this.loaded.get(id);
    if (!extension) return false;
    this.loaded.delete(id);
    this.refreshBranchBindings();
    this.retireExecutionHooks();

    for (const cleanup of [...extension.cleanups].reverse()) {
      try {
        await cleanup();
      } catch {
        console.error('[ExtensionRegistry] Extension cleanup failed.');
      }
    }
    return true;
  }

  async unloadAll(): Promise<void> {
    for (const id of [...this.loaded.keys()].reverse()) await this.unload(id);
    this.events.clear();
  }

  /**
   * Replace a loader-owned set transactionally. If any candidate fails, every
   * partial registration is removed and the previous factories are restored.
   */
  async replaceManaged(
    previousIds: Iterable<string>,
    candidates: Array<{ id: string; factory: ExtensionFactory }>,
  ): Promise<void> {
    const previousOptionValues = this.startupOptionValues;
    const previous = [...new Set(previousIds)]
      .map(id => this.loaded.get(id))
      .filter((item): item is LoadedExtension => Boolean(item))
      .map(item => ({ id: item.id, factory: item.factory }));
    const candidateIds = new Set(candidates.map(candidate => candidate.id));
    if (candidateIds.size !== candidates.length) throw new Error('Duplicate extension module id in reload candidate');

    for (const item of [...previous].reverse()) await this.unload(item.id);
    const loadedCandidates: string[] = [];
    try {
      for (const candidate of candidates) {
        await this.load(candidate.id, candidate.factory);
        loadedCandidates.push(candidate.id);
      }
    } catch (error) {
      for (const id of loadedCandidates.reverse()) await this.unload(id);
      const restoreErrors: string[] = [];
      for (const item of previous) {
        try { await this.load(item.id, item.factory); }
        catch (restoreError) {
          restoreErrors.push(`${item.id}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
      }
      const restoredValues = Object.fromEntries(Object.entries(previousOptionValues).filter(([name, value]) =>
        this.startupOptions.get(name)?.value.type === typeof value,
      ));
      this.setOptionValues(restoredValues);
      if (restoreErrors.length) {
        throw new AggregateError([error], `Extension reload failed and rollback was incomplete: ${restoreErrors.join('; ')}`);
      }
      throw error;
    }
  }

  getOptions(): ExtensionOptionDescriptor[] {
    return [...this.startupOptions].map(([name, entry]) => ({ ...entry.value, name, extensionId: entry.owner }));
  }

  /** Host-only, atomic assignment after strict parsing; defaults are resolved by getOption. */
  setOptionValues(values: Readonly<Record<string, ExtensionOptionValue>>): void {
    if (Object.keys(values).length > 256) throw new Error('Too many extension option values.');
    for (const [name, value] of Object.entries(values)) {
      const option = this.startupOptions.get(name)?.value;
      if (!option || typeof value !== option.type || (typeof value === 'string'
        && (!value || value.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(value)))) {
        throw new Error('Invalid extension startup option value.');
      }
    }
    this.startupOptionValues = Object.freeze({ ...values });
  }

  getCommand(name: string): ExtensionCommand | undefined {
    return this.commands.get(this.normalizeName(name))?.value;
  }

  getCommands(): Array<{ name: string; description: string; usage?: string; extensionId: string }> {
    return [...this.commands.entries()].map(([name, entry]) => ({
      name,
      description: entry.value.description,
      usage: entry.value.usage,
      extensionId: entry.owner,
    }));
  }

  getTools(): Array<ExtensionTool & { extensionId: string }> {
    return [...this.tools.values()].map(entry => ({ ...entry.value, extensionId: entry.owner }));
  }

  async executeTool(
    name: string,
    input: unknown,
    context: ExtensionRuntimeContext,
    signal?: AbortSignal,
  ): Promise<ExtensionToolResult> {
    const tool = this.tools.get(this.normalizeName(name))?.value;
    if (!tool) throw new Error(`Unknown extension tool: ${name}`);
    return this.executeHostedTool(
      tool.name,
      input,
      context,
      (hostInput, hostContext, hostSignal) => tool.execute(
        hostInput as Record<string, unknown>, hostContext, hostSignal,
      ),
      signal,
    );
  }

  /** Apply the same hooks/events to a session-hosted tool that is not in the static registry. */
  async executeHostedTool(
    name: string,
    input: unknown,
    context: ExtensionRuntimeContext,
    execute: (
      input: unknown,
      context: ExtensionRuntimeContext,
      signal?: AbortSignal,
    ) => ExtensionToolResult | Promise<ExtensionToolResult>,
    signal?: AbortSignal,
  ): Promise<ExtensionToolResult> {
    if (signal?.aborted) throw new Error(`Tool execution aborted: ${name}`);
    const hostToolCallId = context.toolCallId;
    const hostProgress = context.onProgress;
    const hostExecuteTool = context.executeTool;
    const admission = toolAdmissions.get(context);
    const hook = await this.runBefore('before:tool', { tool: name, input, context }, signal);
    if (signal?.aborted) throw new Error(`Tool execution aborted: ${name}`);
    if (hook.cancelled) {
      throw new Error(hook.reason || `Tool execution cancelled by extension hook: ${name}`);
    }

    await this.emit('tool:call', { tool: name, input: hook.data.input });
    try {
      // Hooks may transform inputs/context, not replace host correlation or the
      // bounded progress sink. Nested codemode contexts have no outer call ID.
      admission?.();
      const executionContext = { ...hook.data.context, toolCallId: hostToolCallId,
        onProgress: hostToolCallId ? hostProgress : undefined, executeTool: hostExecuteTool };
      if (signal?.aborted) throw new Error(`Tool execution aborted: ${name}`);
      const result = await execute(hook.data.input, executionContext, signal);
      await this.emit('tool:result', {
        tool: name,
        isError: Boolean(result.isError),
        contentLength: result.content.length,
      });
      return result;
    } catch (error) {
      await this.emit('tool:error', {
        tool: name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getUIComponents(): Array<ExtensionUIComponent & { extensionId: string }> {
    return [...this.uiComponents.values()].map(entry => ({ ...entry.value, extensionId: entry.owner }));
  }

  getProviderDefinitions(): Array<{ type: string; definition: ExtensionProvider; extensionId: string }> {
    return [...this.providers.entries()].map(([type, entry]) => ({
      type,
      definition: entry.value,
      extensionId: entry.owner,
    }));
  }

  list(): ExtensionInfo[] {
    return [...this.loaded.keys()].map(id => ({
      id,
      commands: [...this.commands.entries()].filter(([, entry]) => entry.owner === id).map(([name]) => name),
      tools: [...this.tools.entries()].filter(([, entry]) => entry.owner === id).map(([name]) => name),
      providers: [...this.providers.entries()].filter(([, entry]) => entry.owner === id).map(([name]) => name),
      uiComponents: [...this.uiComponents.entries()].filter(([, entry]) => entry.owner === id).map(([name]) => name),
      hooks: [...this.beforeHooks.entries()]
        .filter(([, hooks]) => hooks.some(entry => entry.owner === id))
        .map(([event]) => event),
    }));
  }

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    this.lifecycle.on(event, handler);
    return () => this.lifecycle.off(event, handler);
  }

  emit<K extends keyof EventMap>(
    event: K,
    ...args: EventMap[K] extends void ? [] | [data: EventMap[K]] : [data: EventMap[K]]
  ): Promise<void> {
    return this.lifecycle.emit(event, ...args);
  }

  /** Runs transform hooks in registration order and stops at the first cancellation. */
  async runBefore<K extends keyof BeforeHookMap>(
    event: K,
    data: BeforeHookMap[K],
    hostSignal?: AbortSignal,
  ): Promise<BeforeHookExecution<BeforeHookMap[K]>> {
    if (isExecutionHook(event)) {
      return this.runExecutionBefore(event, data as BeforeHookMap[ExecutionHookName]) as unknown as Promise<BeforeHookExecution<BeforeHookMap[K]>>;
    }
    if (event === 'before:session:branch') {
      return this.runBranchBefore(data as SessionBranchEvent) as unknown as Promise<BeforeHookExecution<BeforeHookMap[K]>>;
    }
    if (event === 'before:session:summary') {
      return this.runSummaryBefore(data as BranchSummaryEvent) as unknown as Promise<BeforeHookExecution<BeforeHookMap[K]>>;
    }
    if (event === 'before:session:compaction') {
      return this.runCompactionBefore(data as SessionCompactionEvent) as unknown as Promise<BeforeHookExecution<BeforeHookMap[K]>>;
    }
    let transformed = { ...data } as BeforeHookMap[K];
    const agentSignal = event === 'before:agent' ? (data as BeforeHookMap['before:agent']).signal : undefined;
    const signal = hostSignal ?? (event === 'before:model' ? (data as BeforeHookMap['before:model']).signal
      : event === 'before:provider' ? (data as BeforeHookMap['before:provider']).options.signal : agentSignal);
    for (const entry of this.beforeHooks.get(event) ?? []) {
      if (signal?.aborted) return { data: transformed, cancelled: true };
      let result: BeforeHookResult<BeforeHookMap[K]>;
      try {
        const handler = entry.value as unknown as BeforeHookHandler<BeforeHookMap[K]>;
        if (agentSignal) transformed = { ...transformed, signal: agentSignal };
        result = agentSignal ? await awaitAgentAdmission(() => handler(transformed), agentSignal) : await handler(transformed);
      } catch (error) {
        if (agentSignal?.aborted) return { data: transformed, cancelled: true };
        throw new Error(
          `Extension hook "${String(event)}" failed in "${entry.owner}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (signal?.aborted || result === false) return { data: transformed, cancelled: true };
      if (result && 'cancel' in result && result.cancel === true) {
        return { data: transformed, cancelled: true, reason: result.reason };
      }
      if (result) transformed = { ...transformed, ...result };
      if (agentSignal) transformed = { ...transformed, signal: agentSignal };
    }
    return { data: transformed, cancelled: false };
  }

  private retireExecutionHooks(): void {
    const previous = this.executionHookLifetime;
    this.executionHookLifetime = new AbortController();
    previous.abort();
  }

  private async runExecutionBefore(event: ExecutionHookName, data: BeforeHookMap[ExecutionHookName]): Promise<BeforeHookExecution<BeforeHookMap[ExecutionHookName]>> {
    const signal = AbortSignal.any([data.signal, this.executionHookLifetime.signal]);
    let transformed = { ...data };
    for (const entry of [...this.beforeHooks.get(event) ?? []]) {
      if (signal.aborted) return { data: transformed, cancelled: true };
      try {
        // Per-handler copies prevent mutation without an explicit validated return.
        let view = { ...transformed, signal };
        if ('result' in view) view = { ...view, result: copyExtensionResult(view.result) };
        if ('trigger' in view) view = { ...view, trigger: { ...view.trigger } };
        if ('continuation' in view && view.continuation) view = { ...view, continuation: { ...view.continuation } };
        const result = await awaitAgentAdmission(() => (entry.value as unknown as BeforeHookHandler<BeforeHookMap[ExecutionHookName]>)(Object.freeze(view)), signal);
        if (signal.aborted || result === false) return { data: transformed, cancelled: true };
        if (result === undefined) continue;
        if (result && typeof result === 'object' && Object.hasOwn(result, 'cancel')) {
          return { data: transformed, cancelled: true, reason: this.copyBranchCancellation(result) };
        }
        transformed = { ...transformed, ...copyExecutionHookPatch(event, result) };
      } catch {
        if (signal.aborted) return { data: transformed, cancelled: true };
        throw new Error('Extension execution hook failed.');
      }
    }
    return { data: transformed, cancelled: signal.aborted };
  }

  private async runBranchBefore(data: SessionBranchEvent): Promise<BeforeHookExecution<SessionBranchEvent>> {
    const captured = copySessionBranchEvent(data);
    for (const entry of [...this.beforeHooks.get('before:session:branch') ?? []]) {
      if (captured.signal.aborted) return { data: captured, cancelled: true };
      const handler = entry.value as unknown as BeforeHookHandler<SessionBranchEvent>;
      const result = await handler(captured);
      if (captured.signal.aborted || result === false) return { data: captured, cancelled: true };
      if (result === undefined) continue;
      return { data: captured, cancelled: true, reason: this.copyBranchCancellation(result) };
    }
    return { data: captured, cancelled: false };
  }

  private copyBranchCancellation(result: unknown): string | undefined {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Session branch hook result is invalid.');
    let cancelled = false, reason: string | undefined;
    for (const key of Reflect.ownKeys(result)) {
      const property = Object.getOwnPropertyDescriptor(result, key);
      if (!property || !('value' in property)) throw new Error('Session branch hook result is invalid.');
      if (key === 'cancel' && property.value === true) cancelled = true;
      else if (key === 'reason' && (property.value === undefined || typeof property.value === 'string'
        && Buffer.byteLength(property.value) <= 4_096 && !property.value.includes('\0'))) reason = property.value;
      else throw new Error('Session branch hook result is invalid.');
    }
    if (!cancelled) throw new Error('Session branch hook result is invalid.');
    return reason;
  }

  private async runSummaryBefore(data: BranchSummaryEvent): Promise<BeforeHookExecution<BranchSummaryEvent>> {
    const captured = copyBranchSummaryEvent(data);
    let summary: BranchSummaryOutput | undefined;
    for (const entry of [...this.beforeHooks.get('before:session:summary') ?? []]) {
      if (captured.signal.aborted) return { data: captured, cancelled: true };
      const handler = entry.value as unknown as BeforeHookHandler<BranchSummaryEvent>;
      const result = await handler(captured);
      if (captured.signal.aborted || result === false) return { data: captured, cancelled: true };
      if (result === undefined) continue;
      if (result && typeof result === 'object' && Object.hasOwn(result, 'cancel')) {
        return { data: captured, cancelled: true, reason: this.copyBranchCancellation(result) };
      }
      summary = copyBranchSummaryOutput(result, captured.maxOutputBytes);
    }
    return { data: captured, cancelled: false, ...(summary ? { summary } : {}) };
  }

  private async runCompactionBefore(data: SessionCompactionEvent): Promise<BeforeHookExecution<SessionCompactionEvent>> {
    const values: Record<string, unknown> = {};
    for (const key of ['sessionId', 'firstKeptEntryId', 'summary', 'maxOutputBytes', 'signal']) {
      const property = Object.getOwnPropertyDescriptor(data, key);
      if (!property || !('value' in property)) throw new Error('Compaction hook event is invalid.');
      values[key] = property.value;
    }
    if (typeof values.sessionId !== 'string' || typeof values.firstKeptEntryId !== 'string'
      || typeof values.summary !== 'string' || typeof values.maxOutputBytes !== 'number'
      || !Number.isSafeInteger(values.maxOutputBytes) || values.maxOutputBytes < 1 || values.maxOutputBytes > 1024 * 1024
      || !(values.signal instanceof AbortSignal)) throw new Error('Compaction hook event is invalid.');
    const captured = Object.freeze(values) as unknown as SessionCompactionEvent;
    let compactionSummary: string | undefined;
    for (const entry of [...this.beforeHooks.get('before:session:compaction') ?? []]) {
      if (captured.signal.aborted) return { data: captured, cancelled: true };
      const result = await (entry.value as unknown as BeforeHookHandler<SessionCompactionEvent>)(captured);
      if (captured.signal.aborted || result === false) return { data: captured, cancelled: true };
      if (result === undefined) continue;
      if (result && typeof result === 'object' && Object.hasOwn(result, 'cancel')) {
        return { data: captured, cancelled: true, reason: this.copyBranchCancellation(result) };
      }
      const copied = copySessionCustomValue(result) as { summary: string };
      if (!copied || Object.keys(copied).length !== 1 || typeof copied.summary !== 'string'
        || !copied.summary.trim() || Buffer.byteLength(copied.summary) > captured.maxOutputBytes) throw new Error('Compaction hook result is invalid.');
      compactionSummary = copied.summary;
    }
    return { data: captured, cancelled: false, compactionSummary };
  }

  private connectBranchManager(manager: SessionManager): () => void {
    const detachBranch = manager.onBeforeBranch(async event => {
      const result = await this.runBefore('before:session:branch', event);
      return result.cancelled ? false : undefined;
    });
    try {
      const detachSummary = manager.onBeforeBranchSummary(async event => {
        const result = await this.runBefore('before:session:summary', event);
        return result.cancelled ? false : result.summary;
      });
      try {
        const detachCompaction = manager.onBeforeCompaction(async event => {
          const result = await this.runBefore('before:session:compaction', event);
          return result.cancelled ? false : result.compactionSummary !== undefined ? { summary: result.compactionSummary } : undefined;
        });
        return () => { detachBranch(); detachSummary(); detachCompaction(); };
      } catch (error) { detachSummary(); throw error; }
    } catch (error) { detachBranch(); throw error; }
  }

  private refreshBranchBindings(): void {
    for (const manager of [...this.branchManagers.keys()]) manager.retirePendingBranchOperations();
  }

  /** Independent owned lease: SDK borrowing must not steal a host's lifecycle binding. */
  attachSessionBranchHooks(manager: SessionManager): () => void {
    if (this.shuttingDown) throw new Error('Extension registry is shutting down.');
    if (!(manager instanceof SessionManager)) throw new Error('Session branch manager is invalid.');
    let binding = this.branchManagers.get(manager);
    if (!binding) {
      if (this.branchManagers.size >= 128) throw new Error('Session branch manager limit reached.');
      binding = { references: 1, detach: () => undefined };
      this.branchManagers.set(manager, binding);
      try {
        const detach = this.connectBranchManager(manager);
        if (this.branchManagers.get(manager) !== binding) {
          detach(); throw new Error('Session branch binding was retired.');
        }
        binding.detach = detach;
      } catch (error) {
        if (this.branchManagers.get(manager) === binding) this.branchManagers.delete(manager);
        throw error;
      }
    } else {
      if (binding.references >= 256) throw new Error('Session branch binding lease limit reached.');
      binding.references++;
    }
    const owned = binding;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      if (this.branchManagers.get(manager) !== owned || --owned.references !== 0) return;
      this.branchManagers.delete(manager);
      owned.detach();
    };
  }

  attachSessionManager(sessionManager: SessionManager): void {
    const generation = this.sessionBindingGeneration = Symbol();
    const detachBranch = this.attachSessionBranchHooks(sessionManager);
    if (generation !== this.sessionBindingGeneration) { detachBranch(); throw new Error('Session branch binding was retired.'); }
    const previous = this.detachSessionEvents;
    this.detachSessionEvents = undefined;
    previous?.();
    if (generation !== this.sessionBindingGeneration) { detachBranch(); throw new Error('Session branch binding was retired.'); }
    const detach: Array<() => void> = [detachBranch];

    const attach = <K extends SessionEvent>(event: K): void => {
      const handler: EventHandler<EventMap[K]> = data => this.lifecycle.emit(event, data);
      sessionManager.on(event, handler);
      detach.push(() => sessionManager.off(event, handler));
    };
    for (const event of SESSION_EVENTS) attach(event);
    this.detachSessionEvents = () => detach.forEach(remove => remove());
  }

  setReloadHandler(handler: () => Promise<void>): void {
    this.reloadHandler = handler;
  }

  async reload(): Promise<void> {
    if (!this.reloadHandler) throw new Error('Extension reload is not configured');
    await this.reloadHandler();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.sessionBindingGeneration = Symbol();
    try {
      const bindings = [...this.branchManagers.values()];
      this.branchManagers.clear();
      for (const binding of bindings) binding.detach();
      await this.emit('system:shutdown');
      this.detachSessionEvents?.();
      this.detachSessionEvents = undefined;
      await this.unloadAll();
      this.lifecycle.clear();
    } finally { this.shuttingDown = false; }
  }

  private createApi(extension: LoadedExtension): ExtensionAPI {
    const active = (): void => {
      if (this.loaded.get(extension.id) !== extension) throw new Error('Extension registration has been retired.');
    };
    return {
      version: AI_HARNESS_EXTENSION_API_VERSION,
      registerOption: (name, metadata) => {
        if (!this.loaded.has(extension.id) || this.loaded.get(extension.id) !== extension) {
          throw new Error('Cannot register startup options for an unloaded extension.');
        }
        const option = validateExtensionOption(name, metadata);
        if (this.startupOptions.size >= 256
          || [...this.startupOptions.values()].filter(entry => entry.owner === extension.id).length >= 32) {
          throw new Error('Extension startup option limit exceeded.');
        }
        this.assertAvailable(this.startupOptions, name, 'startup option');
        const entry = { owner: extension.id, value: option };
        this.startupOptions.set(name, entry);
        const dispose = (): void => {
          if (this.startupOptions.get(name) !== entry) return;
          this.startupOptions.delete(name);
          const values = { ...this.startupOptionValues };
          delete values[name];
          this.startupOptionValues = Object.freeze(values);
        };
        extension.cleanups.push(dispose);
        return dispose;
      },
      getOption: name => {
        const entry = this.startupOptions.get(name);
        if (!entry || entry.owner !== extension.id || this.loaded.get(extension.id) !== extension) return undefined;
        return Object.hasOwn(this.startupOptionValues, name) ? this.startupOptionValues[name] : entry.value.default;
      },
      registerCommand: (name, command) => {
        active();
        const normalized = this.normalizeName(name);
        this.assertAvailable(this.commands, normalized, 'command');
        this.commands.set(normalized, { owner: extension.id, value: command });
        extension.cleanups.push(() => this.removeOwned(this.commands, normalized, extension.id));
      },
      registerTool: tool => {
        active();
        const normalized = this.normalizeName(tool.name);
        this.assertAvailable(this.tools, normalized, 'tool');
        this.tools.set(normalized, { owner: extension.id, value: { ...tool, name: normalized } });
        extension.cleanups.push(() => this.removeOwned(this.tools, normalized, extension.id));
      },
      registerProvider: (type, provider) => {
        active();
        const normalized = this.normalizeName(type);
        this.assertAvailable(this.providers, normalized, 'provider');
        const unregister = ProviderFactory.register(normalized, provider.create);
        this.providers.set(normalized, { owner: extension.id, value: provider });
        extension.cleanups.push(() => {
          this.removeOwned(this.providers, normalized, extension.id);
          unregister();
        });
      },
      registerUI: component => {
        active();
        const normalized = this.normalizeName(component.name);
        this.assertAvailable(this.uiComponents, normalized, 'UI component');
        this.uiComponents.set(normalized, { owner: extension.id, value: { ...component, name: normalized } });
        extension.cleanups.push(() => this.removeOwned(this.uiComponents, normalized, extension.id));
      },
      on: (event, handler) => {
        active();
        if (!Object.hasOwn(LIFECYCLE_EVENTS, event)) throw new Error('Unsupported native lifecycle event.');
        this.lifecycle.on(event, handler);
        const unsubscribe = () => this.lifecycle.off(event, handler);
        extension.cleanups.push(unsubscribe);
        return unsubscribe;
      },
      before: (event, handler) => {
        const sessionEvent = event === 'before:session:branch' || event === 'before:session:summary' || event === 'before:session:compaction';
        if (sessionEvent && this.loaded.get(extension.id) !== extension) {
          throw new Error('Cannot register branch hooks for an unloaded extension.');
        }
        active();
        if (!Object.hasOwn(BEFORE_EVENTS, event)) throw new Error('Unsupported native execution hook.');
        const hooks = this.beforeHooks.get(event) ?? [];
        if ((sessionEvent || isExecutionHook(event)) && hooks.length >= 256) throw new Error('Session branch extension hook limit reached.');
        const entry: Owned<StoredBeforeHook> = {
          owner: extension.id,
          value: handler as unknown as StoredBeforeHook,
        };
        hooks.push(entry);
        this.beforeHooks.set(event, hooks);
        if (sessionEvent) this.refreshBranchBindings();
        const unsubscribe = () => {
          const previous = this.beforeHooks.get(event) ?? [];
          const current = previous.filter(candidate => candidate !== entry);
          if (previous.length === current.length) return;
          if (current.length) this.beforeHooks.set(event, current);
          else this.beforeHooks.delete(event);
          if (sessionEvent) this.refreshBranchBindings();
          if (isExecutionHook(event)) this.retireExecutionHooks();
        };
        extension.cleanups.push(unsubscribe);
        if (isExecutionHook(event)) this.retireExecutionHooks();
        return unsubscribe;
      },
      events: this.events,
    };
  }

  private normalizeName(name: string): string {
    const normalized = name.trim().toLowerCase().replace(/^\//, '');
    if (!/^[a-z][a-z0-9:_-]*$/.test(normalized)) {
      throw new Error(`Invalid extension registration name: ${name}`);
    }
    return normalized;
  }

  private assertAvailable<T>(registry: Map<string, Owned<T>>, name: string, kind: string): void {
    if (registry.has(name)) throw new Error(`Extension ${kind} already registered: ${name}`);
  }

  private removeOwned<T>(registry: Map<string, Owned<T>>, name: string, owner: string): void {
    if (registry.get(name)?.owner === owner) registry.delete(name);
  }
}
