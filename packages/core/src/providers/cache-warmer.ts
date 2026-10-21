import { normalizeProviderUsage, type AiProvider, type ChatOptions, type ChatResponse } from './index.js';
import type { Message, ModelPricing, TokenUsage } from '../types/index.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { captureProviderMessages, prepareProviderPayload } from '../agent/provider-request-payload.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { calculatePublishedModelCost } from './model-metadata.js';
import { sessionEntryPath } from '../sessions/session-context.js';
import { estimateCanonicalProviderRequest } from '../agent/provider-request-estimate.js';
import { awaitAgentAdmission } from '../agent/prestart-admission.js';

export type CacheWarmingMode = 'off' | 'streaming' | 'idle';
export interface CacheWarmingDecision {
  phase: 'streaming' | 'idle';
  warmCost: number;
  missCost: number;
  continuationProbability: number;
  expectedSavings: number;
  economicsAvailable: boolean;
  action: 'warm' | 'stop';
}
export interface CacheWarmingStatus {
  state: 'inactive' | 'scheduled' | 'refreshing';
  reason?: string;
  nextWarmAt?: number;
  decision?: CacheWarmingDecision;
  extensionOverride?: boolean;
}
export interface CacheWarmRequest {
  provider: AiProvider;
  providerName: string;
  model: string;
  messages: Message[];
  options: ChatOptions;
  ttlSeconds: number;
  pricing: ModelPricing;
  isCurrent(): boolean;
  isAuthorized?(): boolean | Promise<boolean>;
}
interface ActiveWarm {
  request: CacheWarmRequest;
  controller: AbortController;
  detach(): void;
  startedAt: number;
  phase: 'streaming' | 'idle';
  delay: number;
  ttl: number;
  next: number;
  deadline: number;
  promptTokens: number;
  extensionOverride?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
  return Number.isFinite(ttlMs) && ttlMs > 10_000 ? Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000))) : undefined;
}
export function evaluateCacheWarming(promptTokens: number, pricing: ModelPricing,
  phase: CacheWarmingDecision['phase']): CacheWarmingDecision {
  const hit = promptTokens * (pricing.cacheReadPerMillion ?? 0) / 1_000_000;
  const miss = promptTokens * ((pricing.cacheWritePerMillion ?? 0) > 0
    ? pricing.cacheWritePerMillion! : pricing.inputPerMillion ?? 0) / 1_000_000;
  const warmCost = hit + (pricing.outputPerMillion ?? 0) / 1_000_000;
  const missCost = Math.max(0, miss - hit);
  const continuationProbability = phase === 'idle' ? 0.15 : 1;
  const expectedSavings = continuationProbability * missCost - warmCost;
  const economicsAvailable = promptTokens > 0 && (hit > 0 || miss > 0);
  return { phase, warmCost, missCost, continuationProbability, expectedSavings, economicsAvailable,
    action: economicsAvailable && expectedSavings >= 0.05 ? 'warm' : 'stop' };
}

/** One request prefix, one timer, no tools or model-context entries. Mirrors Pi 1.2.0's policy. */
export class CacheWarmer {
  private active?: ActiveWarm;
  private inactive: CacheWarmingStatus = { state: 'inactive', reason: 'waiting for first request' };
  private pending = new Set<Promise<void>>();
  mode: CacheWarmingMode = 'streaming';
  constructor(private readonly manager: SessionManager, private readonly sessionId: string,
    private readonly decide: (decision: CacheWarmingDecision, signal: AbortSignal) => Promise<'warm' | 'stop'> = async decision => decision.action,
    private readonly onUsage?: (usage: TokenUsage, provider: string, model: string) => void | Promise<void>) {}

  get status(): CacheWarmingStatus {
    const run = this.active;
    if (!run) return { ...this.inactive, ...(this.inactive.decision ? { decision: { ...this.inactive.decision } } : {}) };
    return { state: run.timer ? 'scheduled' : 'refreshing', nextWarmAt: run.next, decision: this.evaluate(run),
      ...(run.extensionOverride ? { extensionOverride: true } : {}) };
  }
  setMode(mode: CacheWarmingMode): void {
    if (!['off', 'streaming', 'idle'].includes(mode)) throw new Error('Invalid cache warming mode.');
    this.mode = mode;
    if (mode === 'off' || mode === 'streaming' && this.active?.phase === 'idle') this.cancel('cache warming disabled');
  }
  start(request: CacheWarmRequest): void {
    this.cancel('waiting for eligible request');
    if (this.mode === 'off' || request.options.signal?.aborted) return;
    const ttl = request.ttlSeconds * 1000;
    const delay = getCacheWarmingDelayMs(ttl);
    if (delay === undefined || ttl > 86_400_000) return;
    const prepared = prepareProviderPayload({ provider: request.providerName, model: request.model,
      messages: request.messages, options: request.options }, value => value, request.options.signal).data;
    const estimate = estimateCanonicalProviderRequest(prepared.messages, prepared.options);
    const controller = new AbortController();
    const abort = (): void => this.cancel('request aborted');
    request.options.signal?.addEventListener('abort', abort, { once: true });
    const run: ActiveWarm = { request: { ...request, messages: prepared.messages, options: prepared.options,
      pricing: copySessionCustomValue(request.pricing) as ModelPricing }, controller,
      detach: () => request.options.signal?.removeEventListener('abort', abort), startedAt: Date.now(),
      phase: 'streaming', ttl, delay, next: 0, deadline: 0,
      promptTokens: estimate.unknownMedia ? 0 : estimate.estimatedTokens };
    this.active = run;
    this.schedule(run);
  }
  /** A failed/stopped run must never transition into idle background billing. */
  async settle(success: boolean): Promise<void> {
    const run = this.active;
    if (run && success && this.mode === 'idle') { run.phase = 'idle'; run.detach(); }
    else this.cancel('agent run settled');
    if (run && Date.now() >= run.startedAt + 30 * 60_000 && run.phase === 'idle') this.cancel('30-minute idle safety limit');
    await Promise.all([...this.pending]);
  }
  cancel(reason = 'inactive'): void {
    const run = this.active;
    this.active = undefined;
    if (run) { if (run.timer) clearTimeout(run.timer); run.detach(); run.controller.abort(); }
    this.inactive = { state: 'inactive', reason };
  }
  async dispose(): Promise<void> { this.cancel(); await Promise.all([...this.pending]); }
  private current(run: ActiveWarm): boolean {
    if (this.active !== run || run.controller.signal.aborted) return false;
    if (this.mode === 'off' || !run.request.isCurrent()) { this.cancel('conversation context changed'); return false; }
    return true;
  }
  private evaluate(run: ActiveWarm): CacheWarmingDecision {
    const messages = this.manager.get(this.sessionId)?.messages ?? [];
    const usage = [...messages].reverse().find(message => message.role === 'assistant')?.usage;
    const observed = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
    // A smaller/compacted prefix cannot inherit the economics of an older large request.
    return evaluateCacheWarming(Math.min(run.promptTokens, observed || run.promptTokens), run.request.pricing, run.phase);
  }
  private schedule(run: ActiveWarm): void {
    if (!this.current(run)) return;
    run.next = Date.now() + run.delay;
    run.deadline = run.next + Math.floor((run.ttl - run.delay) / 2);
    if (run.next > run.startedAt + (run.phase === 'idle' ? 30 : 60) * 60_000) {
      this.cancel('cache warming safety limit'); return;
    }
    run.timer = setTimeout(() => {
      const work = this.refresh(run).catch(() => { if (this.active === run) this.cancel('cache warming unavailable'); });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    }, run.delay);
    run.timer.unref?.();
  }
  private async refresh(run: ActiveWarm): Promise<void> {
    run.timer = undefined;
    if (!this.current(run)) return;
    if (Date.now() > run.deadline) { this.cancel('cache refresh deadline missed'); return; }
    const decision = this.evaluate(run);
    let action = decision.action;
    try { action = await awaitAgentAdmission(() => this.decide({ ...decision }, run.controller.signal), run.controller.signal); } catch { /* Fall back to the economic decision. */ }
    if (!this.current(run)) return;
    if (Date.now() > run.deadline) { this.cancel('cache refresh deadline missed'); return; }
    run.extensionOverride = action !== decision.action;
    if (action !== 'warm') { this.cancel(run.extensionOverride ? 'extension decision' : 'expected savings below threshold');
      this.inactive.decision = decision; this.inactive.extensionOverride = run.extensionOverride; return; }
    if (run.request.isAuthorized && !await awaitAgentAdmission(() => run.request.isAuthorized!(), run.controller.signal)) {
      this.cancel('provider unavailable'); return;
    }
    if (!this.current(run)) return;
    if (Date.now() > run.deadline) { this.cancel('cache refresh deadline missed'); return; }
    const source = this.manager.get(this.sessionId);
    const parentEntryId = source?.activeLeafId;
    if (!parentEntryId) { this.cancel('cache source unavailable'); return; }
    let response: ChatResponse | undefined;
    let failure: unknown;
    let accepting = true;
    try {
      const request = run.request;
      await request.provider.streamChat(captureProviderMessages(request.messages), () => undefined,
        result => { if (accepting) response = result; }, error => { if (accepting) failure = error; },
        { ...request.options, maxTokens: 1, maxRetries: 0, signal: run.controller.signal });
    } catch { failure = true; }
    finally { accepting = false; }
    // A successful completed request is durable billing, even if its owner was cancelled meanwhile.
    const usage = !failure && response ? normalizeProviderUsage(response.usage) : undefined;
    if (usage && this.manager.get(this.sessionId) === source) {
      const request = run.request;
      try { void Promise.resolve(this.onUsage?.(usage, request.providerName, response?.model ?? request.model)).catch(() => undefined); }
      catch { /* Preserve durable billing if an observer fails. */ }
      const cost = usage.costUsd ?? calculatePublishedModelCost(request.providerName, response?.model ?? request.model, usage);
      if (cost !== undefined) usage.costUsd = cost;
      const entries = await this.manager.getRawEntries(this.sessionId);
      const receiptParent = this.current(run) && sessionEntryPath(entries, source?.activeLeafId).entries.some(entry => entry.id === parentEntryId)
        ? source!.activeLeafId! : parentEntryId;
      await this.manager.recordProviderUsage(this.sessionId, {
        provider: request.providerName, model: response?.model ?? request.model, usage,
        ...(action !== decision.action ? { extensionOverride: true } : {}),
      }, receiptParent, source);
    }
    if (failure || !response) { if (this.active === run) this.cancel('cache warming unavailable'); return; }
    if (this.current(run)) this.schedule(run);
  }
}

const warmers = new WeakMap<SessionManager, Map<string, CacheWarmer>>();
export function getSessionCacheWarmer(manager: SessionManager, sessionId: string,
  decide?: ConstructorParameters<typeof CacheWarmer>[2], onUsage?: ConstructorParameters<typeof CacheWarmer>[3]): CacheWarmer {
  let sessions = warmers.get(manager);
  if (!sessions) { sessions = new Map(); warmers.set(manager, sessions); }
  let warmer = sessions.get(sessionId);
  if (!warmer) { warmer = new CacheWarmer(manager, sessionId, decide, onUsage); sessions.set(sessionId, warmer); }
  return warmer;
}
export function getSessionCacheWarmingStatus(manager: SessionManager, sessionId: string): CacheWarmingStatus {
  return warmers.get(manager)?.get(sessionId)?.status ?? { state: 'inactive', reason: 'waiting for first request' };
}
export async function settleSessionCacheWarmer(manager: SessionManager, sessionId: string, success: boolean): Promise<void> {
  await warmers.get(manager)?.get(sessionId)?.settle(success);
}
export async function disposeSessionCacheWarmers(manager: SessionManager): Promise<void> {
  const sessions = warmers.get(manager); warmers.delete(manager);
  await Promise.all([...sessions?.values() ?? []].map(warmer => warmer.dispose()));
}
