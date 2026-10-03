import type { AiProvider, ChatOptions } from '../providers/index.js';
import { ProviderFactory } from '../providers/index.js';
import type { Message, ProviderConfig, Session } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { EventEmitter, type EventHandler, type EventMap } from '../utils/event-emitter.js';

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
}

export interface ExtensionInteractionResponse {
  cancelled: boolean;
  value?: unknown;
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
  notify(message: string, level?: ExtensionLogLevel): void;
  requestInteraction?(request: ExtensionInteractionRequest): Promise<ExtensionInteractionResponse>;
}

export interface ExtensionCommand {
  description: string;
  usage?: string;
  handler(args: string, context: ExtensionRuntimeContext): void | string | Promise<void | string>;
}

export interface ExtensionToolResult<TDetails = unknown> {
  content: string;
  details?: TDetails;
  isError?: boolean;
}

export interface ExtensionTool<TInput = Record<string, unknown>, TDetails = unknown> {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
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

export interface BeforeHookMap {
  'before:agent': BeforeAgentData;
  'before:provider': BeforeProviderData;
  'before:tool': BeforeToolData;
}

export interface HookCancellation {
  cancel: true;
  reason?: string;
}

export type BeforeHookResult<T> = void | false | Partial<T> | HookCancellation;
export type BeforeHookHandler<T> = (data: Readonly<T>) => BeforeHookResult<T> | Promise<BeforeHookResult<T>>;

export interface BeforeHookExecution<T> {
  data: T;
  cancelled: boolean;
  reason?: string;
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

type StoredBeforeHook = BeforeHookHandler<any>;

const SESSION_EVENTS: Array<keyof EventMap> = [
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
  private readonly commands = new Map<string, Owned<ExtensionCommand>>();
  private readonly tools = new Map<string, Owned<ExtensionTool>>();
  private readonly providers = new Map<string, Owned<ExtensionProvider>>();
  private readonly uiComponents = new Map<string, Owned<ExtensionUIComponent>>();
  private readonly beforeHooks = new Map<keyof BeforeHookMap, Array<Owned<StoredBeforeHook>>>();
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly lifecycle = new EventEmitter<EventMap>();
  readonly events = new EventEmitter<Record<string, unknown>>();
  private detachSessionEvents?: () => void;
  private reloadHandler?: () => Promise<void>;

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

    for (const cleanup of [...extension.cleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error(`[ExtensionRegistry] Cleanup failed for "${id}":`, error);
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
      if (restoreErrors.length) {
        throw new AggregateError([error], `Extension reload failed and rollback was incomplete: ${restoreErrors.join('; ')}`);
      }
      throw error;
    }
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
    if (signal?.aborted) throw new Error(`Tool execution aborted: ${name}`);

    const hook = await this.runBefore('before:tool', { tool: tool.name, input, context });
    if (hook.cancelled) {
      throw new Error(hook.reason || `Tool execution cancelled by extension hook: ${tool.name}`);
    }

    await this.emit('tool:call', { tool: tool.name, input: hook.data.input });
    try {
      const result = await tool.execute(hook.data.input as Record<string, unknown>, hook.data.context, signal);
      await this.emit('tool:result', {
        tool: tool.name,
        isError: Boolean(result.isError),
        contentLength: result.content.length,
      });
      return result;
    } catch (error) {
      await this.emit('tool:error', {
        tool: tool.name,
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
  ): Promise<BeforeHookExecution<BeforeHookMap[K]>> {
    let transformed = { ...data } as BeforeHookMap[K];
    for (const entry of this.beforeHooks.get(event) ?? []) {
      let result: BeforeHookResult<BeforeHookMap[K]>;
      try {
        result = await entry.value(transformed);
      } catch (error) {
        throw new Error(
          `Extension hook "${String(event)}" failed in "${entry.owner}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (result === false) return { data: transformed, cancelled: true };
      if (result && 'cancel' in result && result.cancel === true) {
        return { data: transformed, cancelled: true, reason: result.reason };
      }
      if (result) transformed = { ...transformed, ...result };
    }
    return { data: transformed, cancelled: false };
  }

  attachSessionManager(sessionManager: SessionManager): void {
    this.detachSessionEvents?.();
    const detach: Array<() => void> = [];

    for (const event of SESSION_EVENTS) {
      const handler: EventHandler<any> = data => this.lifecycle.emit(event as any, data);
      sessionManager.on(event as any, handler);
      detach.push(() => sessionManager.off(event as any, handler));
    }
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
    await this.emit('system:shutdown');
    this.detachSessionEvents?.();
    this.detachSessionEvents = undefined;
    await this.unloadAll();
    this.lifecycle.clear();
  }

  private createApi(extension: LoadedExtension): ExtensionAPI {
    return {
      registerCommand: (name, command) => {
        const normalized = this.normalizeName(name);
        this.assertAvailable(this.commands, normalized, 'command');
        this.commands.set(normalized, { owner: extension.id, value: command });
        extension.cleanups.push(() => this.removeOwned(this.commands, normalized, extension.id));
      },
      registerTool: tool => {
        const normalized = this.normalizeName(tool.name);
        this.assertAvailable(this.tools, normalized, 'tool');
        this.tools.set(normalized, { owner: extension.id, value: { ...tool, name: normalized } });
        extension.cleanups.push(() => this.removeOwned(this.tools, normalized, extension.id));
      },
      registerProvider: (type, provider) => {
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
        const normalized = this.normalizeName(component.name);
        this.assertAvailable(this.uiComponents, normalized, 'UI component');
        this.uiComponents.set(normalized, { owner: extension.id, value: { ...component, name: normalized } });
        extension.cleanups.push(() => this.removeOwned(this.uiComponents, normalized, extension.id));
      },
      on: (event, handler) => {
        this.lifecycle.on(event, handler);
        const unsubscribe = () => this.lifecycle.off(event, handler);
        extension.cleanups.push(unsubscribe);
        return unsubscribe;
      },
      before: (event, handler) => {
        const hooks = this.beforeHooks.get(event) ?? [];
        const entry: Owned<StoredBeforeHook> = { owner: extension.id, value: handler };
        hooks.push(entry);
        this.beforeHooks.set(event, hooks);
        const unsubscribe = () => {
          const current = this.beforeHooks.get(event)?.filter(candidate => candidate !== entry) ?? [];
          if (current.length) this.beforeHooks.set(event, current);
          else this.beforeHooks.delete(event);
        };
        extension.cleanups.push(unsubscribe);
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
