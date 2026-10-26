import type { AiProvider } from './index.js';
import type { ModelPricing, TokenUsage } from '../types/index.js';
import { copyQuestionClassificationRequest, copyQuestionAnswers, type QuestionClassificationRequest, type QuestionClassificationResult } from './classification-questions.js';
import { calculatePublishedModelCost } from './model-metadata.js';

/** AiHarness-owned SDK contract. Descriptors never contain endpoints or credentials. */
export type SpecializedModelType = 'classifier' | 'image';
export interface SpecializedModel { id: string; type: SpecializedModelType; provider: string; model: string; virtual?: boolean; imageInput?: boolean;
  name?: string; api?: string; contextWindow?: number; pricing?: ModelPricing }
export interface ClassificationRequest { model: string; input: string; labels: string[]; images?: GeneratedImage[] }
export interface ClassificationResult { label: string; usage?: TokenUsage }
export interface ImageGenerationRequest { model: string; prompt: string; count?: number; size?: '256x256' | '512x512' | '1024x1024' }
export interface GeneratedImage { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }
export interface ImageGenerationResult { images: GeneratedImage[]; usage?: TokenUsage }
/** The host SDK may bind an operation's physical API independently of its model ID. */
export interface SpecializedModelOptions { signal?: AbortSignal; api?: string }
/** Observed provider accounting may survive an invalid answer; no response body or cause is retained. */
export class SpecializedModelError extends Error {
  readonly usage?: Readonly<TokenUsage>;
  constructor(message: string, usage?: TokenUsage) {
    super(message);
    this.name = 'SpecializedModelError';
    const copied = safeUsage(usage);
    this.usage = copied ? Object.freeze(copied) : undefined;
  }
}
export type SpecializedModelRequest = ClassificationRequest | QuestionClassificationRequest | ImageGenerationRequest;
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
  if (!object(value) || Object.keys(value).some(key => !['model', 'input', 'labels', 'images'].includes(key))
    || !text(value.model, 500) || !text(value.input, SPECIALIZED_MODEL_LIMITS.inputBytes)
    || !Array.isArray(value.labels) || !value.labels.length || value.labels.length > SPECIALIZED_MODEL_LIMITS.labels
    || !value.labels.every(label => text(label, 500)) || new Set(value.labels).size !== value.labels.length) {
    throw new Error('Invalid classification request.');
  }
  if (value.images !== undefined) validateGeneratedImages(value.images, SPECIALIZED_MODEL_LIMITS.images);
}
function copyClassificationRequest(request: ClassificationRequest): ClassificationRequest {
  validateClassificationRequest(request);
  return { model: request.model, input: request.input, labels: [...request.labels],
    ...(request.images === undefined ? {} : { images: validateGeneratedImages(request.images, SPECIALIZED_MODEL_LIMITS.images) }) };
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
        const name = typeof candidate.name === 'string' ? this.redact(candidate.name) : undefined;
        const api = typeof candidate.api === 'string' ? this.redact(candidate.api) : undefined;
        const priceKeys = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const;
        const prices = candidate.pricing;
        const pricing = object(prices) && ['inputPerMillion', 'outputPerMillion'].every(key => typeof prices[key] === 'number')
          && priceKeys.every(key => prices[key] === undefined || (typeof prices[key] === 'number' && Number.isFinite(prices[key]) && prices[key] >= 0 && prices[key] <= Number.MAX_SAFE_INTEGER))
          ? Object.fromEntries(priceKeys.filter(key => prices[key] !== undefined).map(key => [key, prices[key]])) as unknown as ModelPricing : undefined;
        return [{ id, type, provider, model, ...(text(name, 500) ? { name } : {}),
          ...(api && /^[a-z][a-z0-9-]{0,63}$/u.test(api) ? { api } : {}),
          ...(typeof candidate.contextWindow === 'number' && Number.isSafeInteger(candidate.contextWindow) && candidate.contextWindow > 0 ? { contextWindow: candidate.contextWindow } : {}),
          ...(pricing ? { pricing } : {}), ...(candidate.virtual === true ? { virtual: true } : {}),
          ...(candidate.imageInput === true ? { imageInput: true } : {}) }];
      });
    } catch { throw new Error('Specialized model metadata is unavailable.'); }
  }
  getAvailableOfType(type: SpecializedModelType): SpecializedModel[] {
    try { return this.provider.validateConfig() ? this.getModelsOfType(type) : []; }
    catch { throw new Error('Specialized model availability is unavailable.'); }
  }
  getModelOfType(type: SpecializedModelType): SpecializedModel | undefined { return this.getAvailableOfType(type)[0]; }
  async classify(request: ClassificationRequest, options: SpecializedModelOptions = {}): Promise<ClassificationResult> {
    request = copyClassificationRequest(request);
    const initialModel = this.resolve('classifier', request.model);
    if (request.images && initialModel.imageInput !== true) throw new Error('Classification model does not support image input.');
    return this.bounded(options.signal, async signal => {
      const transformed = this.before ? await this.before('classifier', request, signal) : request;
      validateClassificationRequest(transformed);
      if (signal.aborted) throw new Error('Cancelled.');
      request = copyClassificationRequest(transformed);
      const model = this.resolve('classifier', request.model);
      if (request.images && model.imageInput !== true) throw new Error('Classification model does not support image input.');
      const result = await this.provider.classify({ ...request, model: model.model }, { signal, ...(model.api ? { api: model.api } : {}) });
      if (!object(result) || !request.labels.includes(result.label)) throw new Error('Invalid classification result.');
      const usage = safeUsage(result.usage);
      if (usage && usage.costUsd === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        usage.costUsd = calculatePublishedModelCost(model.provider, model.model, usage);
      }
      return { label: this.redact(result.label), usage };
    });
  }
  async classifyQuestions(request: QuestionClassificationRequest, options: SpecializedModelOptions = {}): Promise<QuestionClassificationResult> {
    request = copyQuestionClassificationRequest(request);
    const initial = this.resolve('classifier', request.model);
    if (request.images && initial.imageInput !== true) throw new Error('Classification model does not support image input.');
    return this.bounded(options.signal, async signal => {
      const transformed = this.before ? await this.before('classifier', request, signal) : request;
      if (signal.aborted) throw new Error('Cancelled.');
      request = copyQuestionClassificationRequest(transformed);
      const model = this.resolve('classifier', request.model);
      if (request.images && model.imageInput !== true) throw new Error('Classification model does not support image input.');
      const result = await this.provider.classifyQuestions({ ...request, model: model.model }, { signal, ...(model.api ? { api: model.api } : {}) });
      const answers = copyQuestionAnswers(result.answers, request.questions);
      const usage = safeUsage(result.usage);
      if (usage && usage.costUsd === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        usage.costUsd = calculatePublishedModelCost(model.provider, model.model, usage);
      }
      const scrub = (value: string | number | boolean) => typeof value === 'string' ? this.redact(value) : value;
      return { answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [this.redact(id), {
        value: scrub(answer.value), probabilities: answer.probabilities.map(item => ({ value: scrub(item.value), probability: item.probability })),
      }])), usage };
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
    catch (error) {
      const message = 'Specialized model operation failed or was cancelled.';
      throw error instanceof SpecializedModelError ? new SpecializedModelError(message, error.usage) : new Error(message);
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
  }
}
