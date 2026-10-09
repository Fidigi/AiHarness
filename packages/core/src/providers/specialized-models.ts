import type { AiProvider } from './index.js';
import type { TokenUsage } from '../types/index.js';
import { calculatePublishedModelCost } from './model-metadata.js';

/** AiHarness-owned SDK contract. Descriptors never contain endpoints or credentials. */
export type SpecializedModelType = 'classifier' | 'image';
export interface SpecializedModel { id: string; type: SpecializedModelType; provider: string; model: string; virtual?: boolean }
export interface ClassificationRequest { model: string; input: string; labels: string[] }
export interface ClassificationResult { label: string; usage?: TokenUsage }
export interface ImageGenerationRequest { model: string; prompt: string; count?: number; size?: '256x256' | '512x512' | '1024x1024' }
export interface GeneratedImage { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }
export interface ImageGenerationResult { images: GeneratedImage[]; usage?: TokenUsage }
export interface SpecializedModelOptions { signal?: AbortSignal }
export type SpecializedModelRequest = ClassificationRequest | ImageGenerationRequest;
export type BeforeSpecializedModel = (type: SpecializedModelType, request: SpecializedModelRequest, signal: AbortSignal) => Promise<SpecializedModelRequest>;
export const SPECIALIZED_MODEL_LIMITS = Object.freeze({ models: 100, inputBytes: 32_768, labels: 100,
  images: 4, imageBytes: 8 * 1024 * 1024, responseBytes: 12 * 1024 * 1024, timeoutMs: 10_000 });

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum;
}
export function validateClassificationRequest(value: unknown): asserts value is ClassificationRequest {
  if (!object(value) || Object.keys(value).some(key => !['model', 'input', 'labels'].includes(key))
    || !text(value.model, 500) || !text(value.input, SPECIALIZED_MODEL_LIMITS.inputBytes)
    || !Array.isArray(value.labels) || !value.labels.length || value.labels.length > SPECIALIZED_MODEL_LIMITS.labels
    || !value.labels.every(label => text(label, 500)) || new Set(value.labels).size !== value.labels.length) {
    throw new Error('Invalid classification request.');
  }
}
export function validateImageGenerationRequest(value: unknown): asserts value is ImageGenerationRequest {
  if (!object(value) || Object.keys(value).some(key => !['model', 'prompt', 'count', 'size'].includes(key))
    || !text(value.model, 500) || !text(value.prompt, SPECIALIZED_MODEL_LIMITS.inputBytes)
    || (value.count !== undefined && (!Number.isSafeInteger(value.count) || Number(value.count) < 1 || Number(value.count) > SPECIALIZED_MODEL_LIMITS.images))
    || (value.size !== undefined && !['256x256', '512x512', '1024x1024'].includes(String(value.size)))) {
    throw new Error('Invalid image generation request.');
  }
}
function safeUsage(value: unknown): TokenUsage | undefined {
  if (!object(value)) return undefined;
  const usage: TokenUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'] as const) {
    const item = value[key];
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= Number.MAX_SAFE_INTEGER) usage[key] = item;
  }
  return Object.keys(usage).length ? usage : undefined;
}
export function validateGeneratedImages(value: unknown, count = 4): GeneratedImage[] {
  if (!Array.isArray(value) || !value.length || value.length > count) throw new Error('Invalid image result.');
  let bytes = 0;
  return value.map(image => {
    if (!object(image) || !['image/png', 'image/jpeg', 'image/webp'].includes(String(image.mediaType))
      || !text(image.data, SPECIALIZED_MODEL_LIMITS.responseBytes) || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.data)) {
      throw new Error('Invalid image result.');
    }
    const binary = Buffer.from(image.data, 'base64');
    bytes += binary.length;
    const valid = image.mediaType === 'image/png' ? binary.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : image.mediaType === 'image/jpeg' ? binary[0] === 255 && binary[1] === 216 && binary[2] === 255
      : binary.subarray(0, 4).toString() === 'RIFF' && binary.subarray(8, 12).toString() === 'WEBP';
    if (!valid || bytes > SPECIALIZED_MODEL_LIMITS.imageBytes) throw new Error('Invalid or oversized image result.');
    return { mediaType: image.mediaType as GeneratedImage['mediaType'], data: image.data };
  });
}

/** A live, credential-private provider bridge shared by SDK and every code-mode host. */
export class SpecializedModels {
  constructor(private readonly provider: AiProvider, private readonly redact: (value: string) => string = value => value,
    private readonly before?: BeforeSpecializedModel) {}
  getModelsOfType(type: SpecializedModelType): SpecializedModel[] {
    if (!['classifier', 'image'].includes(type)) throw new Error('Invalid specialized model type.');
    try {
      const candidates = this.provider.getSpecializedModels();
      const provider = this.redact(this.provider.getProviderType());
      if (!Array.isArray(candidates) || candidates.length > SPECIALIZED_MODEL_LIMITS.models || !text(provider, 500)) {
        throw new Error('Invalid model metadata.');
      }
      const seen = new Set<string>();
      return candidates.flatMap(candidate => {
        if (!object(candidate) || candidate.type !== type || !text(candidate.id, 500) || !text(candidate.model, 500)) return [];
        const id = this.redact(candidate.id); const model = this.redact(candidate.model);
        if (!text(id, 500) || !text(model, 500) || seen.has(id)) return [];
        seen.add(id);
        return [{ id, type, provider, model, ...(candidate.virtual === true ? { virtual: true } : {}) }];
      });
    } catch { throw new Error('Specialized model metadata is unavailable.'); }
  }
  getAvailableOfType(type: SpecializedModelType): SpecializedModel[] {
    try { return this.provider.validateConfig() ? this.getModelsOfType(type) : []; }
    catch { throw new Error('Specialized model availability is unavailable.'); }
  }
  getModelOfType(type: SpecializedModelType): SpecializedModel | undefined { return this.getAvailableOfType(type)[0]; }
  async classify(request: ClassificationRequest, options: SpecializedModelOptions = {}): Promise<ClassificationResult> {
    validateClassificationRequest(request);
    this.resolve('classifier', request.model);
    return this.bounded(options.signal, async signal => {
      const transformed = this.before ? await this.before('classifier', request, signal) : request;
      validateClassificationRequest(transformed);
      if (signal.aborted) throw new Error('Cancelled.');
      request = transformed;
      const model = this.resolve('classifier', request.model);
      const result = await this.provider.classify({ ...request, model: model.model }, { signal });
      if (!object(result) || !request.labels.includes(result.label)) throw new Error('Invalid classification result.');
      const usage = safeUsage(result.usage);
      if (usage && usage.costUsd === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        usage.costUsd = calculatePublishedModelCost(model.provider, model.model, usage);
      }
      return { label: this.redact(result.label), usage };
    });
  }
  async generateImages(request: ImageGenerationRequest, options: SpecializedModelOptions = {}): Promise<ImageGenerationResult> {
    validateImageGenerationRequest(request);
    this.resolve('image', request.model);
    return this.bounded(options.signal, async signal => {
      const transformed = this.before ? await this.before('image', request, signal) : request;
      validateImageGenerationRequest(transformed);
      if (signal.aborted) throw new Error('Cancelled.');
      request = transformed;
      const model = this.resolve('image', request.model);
      const result = await this.provider.generateImages({ ...request, model: model.model }, { signal });
      return { images: validateGeneratedImages(result.images, request.count ?? 1), usage: safeUsage(result.usage) };
    });
  }
  private resolve(type: SpecializedModelType, id: string): SpecializedModel {
    const model = this.getAvailableOfType(type).find(model => model.id === id);
    if (!model) throw new Error('Specialized model is not available.');
    return model;
  }
  private async bounded<T>(external: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), SPECIALIZED_MODEL_LIMITS.timeoutMs);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Specialized model operation cancelled or timed out.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw new Error('Cancelled.'); return operation(signal); }), cancelled]); }
    catch { throw new Error('Specialized model operation failed or was cancelled.'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
  }
}
