import { AiProvider, type ChatOptions, type ChatResponse, type StreamChunkCallback, type ThinkingLevel } from './index.js';
import type { Message, ModelCatalogEntry, ProviderModelCatalog } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { captureProviderMessages } from '../agent/provider-request-payload.js';
import { awaitAgentAdmission } from '../agent/prestart-admission.js';
import { clampPublishedThinkingLevel, getSupportedThinkingLevels } from './model-metadata.js';
import { isValidModelId } from './model-catalog.js';

export interface PhysicalModelSelection { provider: string; id: string; thinkingLevel?: ThinkingLevel }
export type VirtualModelReason = 'user' | 'continuation' | 'retry' | 'direct';
export interface VirtualModelRequest {
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  reason: VirtualModelReason;
  previous?: PhysicalModelSelection;
  failed?: PhysicalModelSelection & { error: string };
  state?: unknown;
  messages: Message[];
  signal: AbortSignal;
}
export interface VirtualModelContext {
  /** Explicit host resolver; no discovery, credential files or implicit provider construction. */
  resolveProvider(name: string): AiProvider | undefined | Promise<AiProvider | undefined>;
}
export interface VirtualModelDefinition {
  provider: string;
  id: string;
  name?: string;
  thinkingLevels?: readonly ThinkingLevel[];
  input?: readonly ('text' | 'image')[];
  contextWindow?: number;
  maxOutputTokens?: number;
  route(request: VirtualModelRequest, context: VirtualModelContext):
    (PhysicalModelSelection & { state?: unknown }) | Promise<PhysicalModelSelection & { state?: unknown }>;
}

/** Selection-only provider. Physical calls must go through streamProviderTurn. */
export class VirtualSelectionProvider extends AiProvider {
  constructor(private readonly registry: VirtualModelRegistry, provider: string) {
    super({ type: provider, model: registry.list().find(model => model.provider === provider)?.id });
  }
  validateConfig(): boolean { return this.registry.list().some(model => model.provider === this.getProviderType()); }
  override canDiscoverModels(): boolean { return false; }
  override async getAvailableModels(): Promise<string[]> { return this.registry.list().filter(model => model.provider === this.getProviderType()).map(model => model.id); }
  async chat(_messages: Message[], _options?: ChatOptions): Promise<ChatResponse> { throw new VirtualModelRoutingError(); }
  async streamChat(_messages: Message[], _chunk: StreamChunkCallback, _complete?: (response?: ChatResponse) => void,
    _error?: (error: Error) => void, _options?: ChatOptions): Promise<void> { throw new VirtualModelRoutingError(); }
}

export class VirtualModelRoutingError extends Error {
  constructor() { super('Virtual model routing failed.'); this.name = 'VirtualModelRoutingError'; }
}

/** Resume only witnessed successful physical work on the active branch; never guess credentials or a model. */
export async function resolveVirtualModelFallback(
  manager: SessionManager, sessionId: string, models: VirtualModelRegistry,
  resolveProvider: VirtualModelContext['resolveProvider'],
  requested?: { provider: string; id?: string }, signal?: AbortSignal,
): Promise<{ provider: AiProvider; selection: PhysicalModelSelection; virtual: PhysicalModelSelection } | undefined> {
  const session = manager.get(sessionId), leaf = session?.activeLeafId;
  if (!session) return undefined;
  const entries = await manager.getActiveBranchEntries(sessionId);
  signal?.throwIfAborted();
  const message = [...entries].reverse().find(entry => entry.type === 'message' && entry.role === 'assistant'
    && !entry.metadata?.outputError);
  if (message?.type !== 'message') return undefined;
  const virtual = message.metadata?.selection as PhysicalModelSelection | undefined;
  if (!virtual || !isValidModelId(virtual.provider) || !isValidModelId(virtual.id)
    || requested && (requested.provider !== virtual.provider || requested.id !== undefined && requested.id !== virtual.id)
    || requested?.id === undefined && session.model !== undefined && session.model !== virtual.id
    || models.get(virtual.provider, virtual.id)) return undefined;
  if (!isValidModelId(message.provider) || !isValidModelId(message.model)
    || message.provider === virtual.provider && message.model === virtual.id
    || models.get(message.provider, message.model)) throw new VirtualModelRoutingError();
  const provider = await awaitAgentAdmission(() => resolveProvider(message.provider!), signal ?? new AbortController().signal);
  signal?.throwIfAborted();
  if (manager.get(sessionId) !== session || session.activeLeafId !== leaf
    || models.get(virtual.provider, virtual.id) || !provider?.validateConfig()) throw new VirtualModelRoutingError();
  const thinking = message.metadata?.thinkingLevel;
  const thinkingLevel = typeof thinking === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)
    ? thinking as ThinkingLevel : 'off';
  return { provider, virtual: { provider: virtual.provider, id: virtual.id }, selection: {
    provider: message.provider, id: message.model,
    thinkingLevel: clampPublishedThinkingLevel(thinkingLevel, getSupportedThinkingLevels(message.provider, message.model, undefined, provider)),
  } };
}

/** Native registrations belong to an extension generation, never the global ProviderFactory. */
export class VirtualModelRegistry {
  private readonly models = new Map<string, VirtualModelDefinition>();
  private key(provider: string, id: string): string { return JSON.stringify([provider, id]); }
  get(provider: string, id: string | undefined): VirtualModelDefinition | undefined {
    return id ? this.models.get(this.key(provider, id)) : undefined;
  }
  register(definition: VirtualModelDefinition): () => void {
    const values: Record<string, unknown> = {};
    for (const key of ['provider', 'id', 'name', 'thinkingLevels', 'input', 'contextWindow', 'maxOutputTokens', 'route']) {
      const property = Object.getOwnPropertyDescriptor(definition, key);
      if (property && !('value' in property)) throw new VirtualModelRoutingError();
      if (property) values[key] = property.value;
    }
    const { provider, id, route } = values;
    if (typeof provider !== 'string' || !/^[a-z][a-z0-9:_-]{0,127}$/.test(provider)
      || !isValidModelId(id) || id !== id.trim() || typeof route !== 'function') throw new VirtualModelRoutingError();
    const metadata = copySessionCustomValue(Object.fromEntries(Object.entries(values).filter(([key, value]) => key !== 'route' && value !== undefined))) as Omit<VirtualModelDefinition, 'route'>;
    const levels = metadata.thinkingLevels ?? ['off'];
    if (!Array.isArray(levels) || !levels.length || levels.length > 7 || new Set(levels).size !== levels.length
      || levels.some(level => !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level))
      || metadata.name !== undefined && (!isValidModelId(metadata.name))
      || ['contextWindow', 'maxOutputTokens'].some(key => values[key] !== undefined
        && (typeof values[key] !== 'number' || !Number.isSafeInteger(values[key]) || (values[key] as number) < 1))) throw new VirtualModelRoutingError();
    const input = metadata.input ?? ['text', 'image'];
    if (!Array.isArray(input) || !input.length || input.length > 2 || input.some(type => type !== 'text' && type !== 'image')
      || new Set(input).size !== input.length) throw new VirtualModelRoutingError();
    const captured = Object.freeze({ ...metadata, input: Object.freeze([...input]), thinkingLevels: Object.freeze([...levels]), route: route as VirtualModelDefinition['route'] });
    const key = this.key(provider, id);
    if (!this.models.has(key) && this.models.size >= 256) throw new VirtualModelRoutingError();
    this.models.set(key, captured);
    return () => { if (this.models.get(key) === captured) this.models.delete(key); };
  }
  list(): VirtualModelDefinition[] { return [...this.models.values()]; }
  descriptors(available: (provider: string) => boolean): ModelCatalogEntry[] {
    return this.list().map(model => ({ key: `${model.provider}:${model.id}`, provider: model.provider,
      id: model.id, name: model.name ?? model.id, source: 'virtual', available: available(model.provider), enabled: true,
      capabilities: { reasoning: model.thinkingLevels!.some(level => level !== 'off'), imageInput: model.input!.includes('image'), toolCalls: true },
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    }));
  }

  overlayCatalog(catalog: ProviderModelCatalog[]): ProviderModelCatalog[] {
    const result = catalog.map(group => ({ ...group, models: [...group.models] }));
    for (const model of this.descriptors(provider => result.find(group => group.provider === provider)?.configured ?? true)) {
      let group = result.find(group => group.provider === model.provider);
      if (!group) { group = { provider: model.provider, configured: true, models: [] }; result.push(group); }
      group.models = [...group.models.filter(candidate => candidate.id !== model.id), model];
    }
    return result;
  }

  async resolve(options: {
    definition: VirtualModelDefinition; messages: Message[]; thinking?: ThinkingLevel; reason: VirtualModelReason;
    failed?: VirtualModelRequest['failed']; signal?: AbortSignal; context: VirtualModelContext;
    sessionManager?: SessionManager; sessionId?: string;
  }): Promise<{ provider: AiProvider; selection: PhysicalModelSelection }> {
    const { definition, sessionManager: manager, sessionId } = options;
    const signal = options.signal ?? new AbortController().signal;
    const session = sessionId ? manager?.get(sessionId) : undefined;
    const leaf = session?.activeLeafId;
    const current = (): void => {
      signal.throwIfAborted();
      if (this.get(definition.provider, definition.id) !== definition
        || session && (manager?.get(session.id) !== session || session.activeLeafId !== leaf)) throw new VirtualModelRoutingError();
    };
    current();
    const entries = session && manager ? await manager.getActiveBranchEntries(session.id) : [];
    current();
    const key = this.key(definition.provider, definition.id);
    const stateEntry = options.reason === 'direct' ? undefined : [...entries].reverse().find(entry => entry.type === 'custom'
      && entry.customType === 'provider.router_state' && (entry.data as { key?: unknown } | undefined)?.key === key);
    const state = stateEntry?.type === 'custom' ? copySessionCustomValue((stateEntry.data as { state?: unknown }).state) : undefined;
    const previousMessage = [...options.messages].reverse().find(message => message.role === 'assistant'
      && message.provider && message.model && !message.metadata?.outputError);
    const previous = previousMessage ? { provider: previousMessage.provider!, id: previousMessage.model!,
      ...(typeof previousMessage.metadata?.thinkingLevel === 'string' ? { thinkingLevel: previousMessage.metadata.thinkingLevel as ThinkingLevel } : {}) } : undefined;
    const request: VirtualModelRequest = { model: { provider: definition.provider, id: definition.id },
      thinkingLevel: clampPublishedThinkingLevel(options.thinking ?? 'off', definition.thinkingLevels!),
      reason: options.reason, ...(previous ? { previous } : {}), ...(options.failed ? { failed: { ...options.failed } } : {}),
      state, messages: captureProviderMessages(options.messages), signal };
    let result: PhysicalModelSelection & { state?: unknown };
    try { result = await awaitAgentAdmission(() => definition.route(request, options.context), signal); }
    catch { signal.throwIfAborted(); throw new VirtualModelRoutingError(); }
    current();
    const rawState = result && Object.getOwnPropertyDescriptor(result, 'state');
    if (rawState && !('value' in rawState)) throw new VirtualModelRoutingError();
    let selection: PhysicalModelSelection;
    try {
      const identity: Record<string, unknown> = {};
      for (const name of ['provider', 'id', 'thinkingLevel']) {
        const property = Object.getOwnPropertyDescriptor(result, name);
        if (property && !('value' in property)) throw new Error();
        if (property?.value !== undefined) identity[name] = property.value;
      }
      selection = copySessionCustomValue(identity) as unknown as PhysicalModelSelection;
      if (!isValidModelId(selection.provider) || !isValidModelId(selection.id)
        || this.get(selection.provider, selection.id)
        || selection.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(selection.thinkingLevel)) throw new Error();
    } catch { throw new VirtualModelRoutingError(); }
    const provider = await awaitAgentAdmission(() => options.context.resolveProvider(selection.provider), signal);
    current();
    if (!provider?.validateConfig()) throw new VirtualModelRoutingError();
    selection.thinkingLevel = clampPublishedThinkingLevel(selection.thinkingLevel ?? 'off', getSupportedThinkingLevels(selection.provider, selection.id, undefined, provider));
    if (options.reason !== 'direct' && session && manager && rawState?.value !== undefined) {
      const copied = copySessionCustomValue(rawState.value, 64 * 1024);
      await manager.appendCustomEntry(session.id, 'provider.router_state', { key, state: copied }, { signal, expectedLeafId: leaf ?? null });
      signal.throwIfAborted();
      if (this.get(definition.provider, definition.id) !== definition) throw new VirtualModelRoutingError();
    }
    return { provider, selection };
  }
}
