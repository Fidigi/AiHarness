import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderConfig, ModelPricing } from '../types/index.js';
import type { ThinkingLevel } from './index.js';
import { atomicWriteStableFile } from '../security/stable-file.js';
import { RADIUS_MODELS, type RadiusModelProfile } from './radius-models.js';
import { radiusBase } from './radius.js';

export interface RadiusProviderConfig extends ProviderConfig {
  /** Account discovery/issuer origin; inference baseUrl is an explicit optional proxy override. */
  gateway?: string;
  /** Explicit application-owned directory only; never inferred from HOME or another provider store. */
  catalogueDirectory?: string;
}
export interface RadiusDiscoveryOptions { signal?: AbortSignal; allowNetwork?: boolean }
interface Snapshot { baseUrl: string; models: readonly RadiusModelProfile[] }
const MAX_BYTES = 1024 * 1024, DEFAULT_GATEWAY = 'https://radius.pi.dev';
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function bounded(value: unknown, max = 500): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000; }
function invalid(): never { throw new RadiusCatalogueError(); }
export class RadiusCatalogueError extends Error { constructor() { super('Radius catalogue is unavailable.'); this.name = 'RadiusCatalogueError'; } }
function safeUrl(value: unknown): URL {
  if (!bounded(value, 2000)) invalid();
  let url: URL; try { url = new URL(value); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
  return url;
}
function gatewayUrl(value = DEFAULT_GATEWAY): string {
  return safeUrl(/^https?:\/\//iu.test(value) ? value : `https://${value}`).toString().replace(/\/+$/u, '');
}
function costs(value: unknown): Required<ModelPricing> {
  if (!record(value)) return invalid();
  const result: Required<ModelPricing> = { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 };
  for (const [raw, field] of [['input', 'inputPerMillion'], ['output', 'outputPerMillion'], ['cacheRead', 'cacheReadPerMillion'], ['cacheWrite', 'cacheWritePerMillion']] as const) {
    const number = value[raw]; if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) invalid(); result[field] = number;
  }
  return result;
}
function model(value: unknown): RadiusModelProfile {
  if (!record(value) || !bounded(value.id) || !bounded(value.name) || typeof value.reasoning !== 'boolean'
    || !positive(value.contextWindow) || !positive(value.maxTokens) || !Array.isArray(value.input)
    || !value.input.length || value.input.length > 2 || value.input.some(input => !['text', 'image'].includes(input))
    || new Set(value.input).size !== value.input.length) return invalid();
  const pricing = costs(value.cost);
  const tiers = record(value.cost) ? value.cost.tiers : undefined;
  if (tiers !== undefined && (!Array.isArray(tiers) || tiers.length > 32)) invalid();
  const pricingTiers = (tiers as unknown[] | undefined ?? []).map(tier => {
    if (!record(tier) || !positive(tier.inputTokensAbove)) return invalid();
    return Object.freeze({ inputTokensAbove: tier.inputTokensAbove, ...costs(tier) });
  });
  let thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>> | undefined;
  if (value.thinkingLevelMap !== undefined) {
    if (!record(value.thinkingLevelMap)) invalid(); thinkingLevelMap = {};
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const mapped = value.thinkingLevelMap[level]; if (mapped === undefined) continue;
      if (mapped !== null && !bounded(mapped, 64)) invalid(); thinkingLevelMap[level] = mapped;
    }
  }
  let imageResizeLimits: RadiusModelProfile['imageResizeLimits'];
  if (record(value.inputLimits) && record(value.inputLimits.images) && value.inputLimits.images.resize !== undefined) {
    const limits = value.inputLimits.images.resize;
    if (!record(limits) || !positive(limits.maxWidth) || !positive(limits.maxHeight) || !positive(limits.maxBytes)
      || !positive(limits.jpegQuality) || limits.jpegQuality > 100) invalid();
    imageResizeLimits = Object.freeze({ maxWidth: limits.maxWidth, maxHeight: limits.maxHeight, maxBytes: limits.maxBytes, jpegQuality: limits.jpegQuality });
  }
  return Object.freeze({ id: value.id, name: value.name, api: 'pi-messages', reasoning: value.reasoning,
    contextWindow: value.contextWindow, maxOutputTokens: value.maxTokens, declaredInput: Object.freeze([...value.input]) as readonly ('text' | 'image')[],
    ...(thinkingLevelMap ? { thinkingLevelMap: Object.freeze(thinkingLevelMap) } : {}),
    ...(Object.values(pricing).some(price => price > 0) ? { pricing: Object.freeze(pricing) } : {}),
    pricingTiers: Object.freeze(pricingTiers), ...(imageResizeLimits ? { imageResizeLimits } : {}) });
}
function raw(snapshot: Snapshot): object {
  const price = (value?: Readonly<ModelPricing>) => ({ input: value?.inputPerMillion ?? 0, output: value?.outputPerMillion ?? 0,
    cacheRead: value?.cacheReadPerMillion ?? 0, cacheWrite: value?.cacheWritePerMillion ?? 0 });
  return { baseUrl: snapshot.baseUrl, models: snapshot.models.map(model => ({ id: model.id, name: model.name, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens, input: model.declaredInput, thinkingLevelMap: model.thinkingLevelMap,
    cost: { ...price(model.pricing), ...(model.pricingTiers.length ? { tiers: model.pricingTiers.map(tier => ({ inputTokensAbove: tier.inputTokensAbove, ...price(tier) })) } : {}) },
    ...(model.imageResizeLimits ? { inputLimits: { images: { resize: model.imageResizeLimits } } } : {}) })) };
}
/** One account-scoped P catalogue, not a general model-store or credential framework. */
export class RadiusCatalogue {
  readonly gateway: string;
  private readonly overrideBase?: string;
  private readonly scope: string;
  private readonly file?: string;
  private snapshot?: Snapshot;
  private digest: string;
  constructor(config: RadiusProviderConfig, key?: string) {
    this.gateway = gatewayUrl(config.gateway);
    this.overrideBase = config.baseUrl ? radiusBase(config.baseUrl) : undefined;
    this.scope = createHash('sha256').update(JSON.stringify([this.gateway, this.overrideBase, key])).digest('hex');
    this.digest = JSON.stringify(raw({ baseUrl: this.baseUrl, models: this.models }));
    if (config.catalogueDirectory !== undefined && key) {
      if (!bounded(config.catalogueDirectory, 4000)) invalid();
      const directory = path.resolve(config.catalogueDirectory); this.file = path.join(directory, `${this.scope}.json`);
      let fd: number | undefined;
      try {
        const parent = lstatSync(directory); if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
        fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const status = fstatSync(fd); if (!status.isFile() || status.nlink !== 1 || status.size > MAX_BYTES || (status.mode & 0o077) !== 0) invalid();
        const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count;
        }
        if (length > MAX_BYTES) invalid();
        const cached: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
        if (!record(cached) || cached.version !== 1 || cached.scope !== this.scope || !Number.isSafeInteger(cached.checkedAt) || (cached.checkedAt as number) < 0) invalid();
        this.snapshot = this.parse(cached.snapshot); this.digest = JSON.stringify(raw(this.snapshot));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new RadiusCatalogueError();
      } finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  get known(): boolean { return this.snapshot !== undefined; }
  get models(): readonly RadiusModelProfile[] { return this.snapshot?.models ?? (this.gateway === DEFAULT_GATEWAY ? RADIUS_MODELS : []); }
  get baseUrl(): string { return this.overrideBase ?? this.snapshot?.baseUrl ?? `${this.gateway}/v1`; }
  parse(value: unknown): Snapshot {
    if (!record(value) || !Array.isArray(value.models) || value.models.length > 500) return invalid();
    const endpoint = safeUrl(value.baseUrl);
    // A catalogue must not send its Bearer to an unconfigured origin. An explicit proxy remains caller authority.
    if (!this.overrideBase && endpoint.origin !== new URL(this.gateway).origin) invalid();
    const baseUrl = this.overrideBase ?? endpoint.toString().replace(/\/+$/u, '').replace(/\/messages$/u, '');
    const models = value.models.map(model); if (new Set(models.map(model => model.id)).size !== models.length) invalid();
    return Object.freeze({ baseUrl, models: Object.freeze(models) });
  }
  async publish(value: unknown, signal: AbortSignal, guard: () => void): Promise<boolean> {
    const snapshot = this.parse(value), digest = JSON.stringify(raw(snapshot));
    signal.throwIfAborted(); guard();
    if (this.file) {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await atomicWriteStableFile(this.file, JSON.stringify({ version: 1, scope: this.scope, checkedAt: Date.now(), snapshot: raw(snapshot) }), {
        overwrite: true, mode: 0o600, maxBytes: MAX_BYTES, beforeCommit: async () => { signal.throwIfAborted(); guard(); },
      });
    }
    signal.throwIfAborted(); guard(); const changed = !this.snapshot || digest !== this.digest;
    this.snapshot = snapshot; this.digest = digest; return changed;
  }
}
/** Bounded cancellable config reads, including uncooperative custom fetch/body implementations. */
export async function readRadiusCatalogue(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) invalid();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => { void reader.cancel('radius-catalogue-aborted').catch(() => undefined); reject(new RadiusCatalogueError()); }; });
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const value = await Promise.race([reader.read(), cancelled]); signal.throwIfAborted();
      if (value.done) break; bytes += value.value.byteLength; if (bytes > MAX_BYTES) invalid(); chunks.push(value.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { return invalid(); }
  finally { signal.removeEventListener('abort', abort); void reader.cancel('radius-catalogue-settled').catch(() => undefined); try { reader.releaseLock(); } catch { /* Pending hostile reads cannot delay retirement. */ } }
}
