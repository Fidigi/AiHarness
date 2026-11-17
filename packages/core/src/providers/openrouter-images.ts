import type { TokenUsage } from '../types/index.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { SPECIALIZED_MODEL_LIMITS, validateGeneratedImages, type GeneratedImage } from './specialized-models.js';
import { openRouterImagePricing } from './openrouter-images-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export type NativeImageContent = { type: 'text'; text: string } | ({ type: 'image' } & GeneratedImage);
export interface NativeImageRequest { model: string; input: NativeImageContent[] }
export interface NativeImageResult {
  api: string; provider: string; model: string; output: NativeImageContent[];
  timestamp: number; responseId?: string; usage?: TokenUsage; stopReason: 'stop' | 'error' | 'aborted'; errorMessage?: string;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new Error('Invalid OpenRouter image response.'); }
export function copyNativeImageRequest(value: NativeImageRequest): NativeImageRequest {
  const request = copySessionCustomValue(value, SPECIALIZED_MODEL_LIMITS.responseBytes);
  if (!record(request) || Object.keys(request).some(key => !['model', 'input'].includes(key))
    || typeof request.model !== 'string' || !request.model.trim() || Buffer.byteLength(request.model) > 500
    || !Array.isArray(request.input) || !request.input.length || request.input.length > 16) throw new Error('Invalid native image request.');
  let textBytes = 0;
  const images: GeneratedImage[] = [];
  const input = request.input.map((part): NativeImageContent => {
    if (!record(part)) throw new Error('Invalid native image request.');
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length && Object.keys(part).every(key => ['type', 'text'].includes(key))) {
      textBytes += Buffer.byteLength(part.text);
      // Native wire sanitation: remove unpaired surrogates, retain valid pairs.
      return { type: 'text', text: part.text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') };
    }
    if (part.type !== 'image' || Object.keys(part).some(key => !['type', 'mediaType', 'data'].includes(key))) throw new Error('Invalid native image request.');
    const image = validateGeneratedImages([{ mediaType: part.mediaType, data: part.data }])[0];
    images.push(image); return { type: 'image', ...image };
  });
  if (textBytes > SPECIALIZED_MODEL_LIMITS.inputBytes) throw new Error('Invalid native image request.');
  if (images.length) validateGeneratedImages(images);
  return { model: request.model, input };
}
export function openRouterImagesBody(request: NativeImageRequest, textOutput: boolean): unknown {
  return { model: request.model, messages: [{ role: 'user', content: request.input.map(part => part.type === 'text'
    ? { type: 'text', text: part.text } : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }) }],
    stream: false, modalities: textOutput ? ['image', 'text'] : ['image'] };
}
export function openRouterImagesOutput(body: unknown): { output: NativeImageContent[]; responseId?: string } {
  if (!record(body) || !Array.isArray(body.choices) || !body.choices.length || !record(body.choices[0]) || !record(body.choices[0].message)) invalid();
  const message = body.choices[0].message;
  if (message.refusal || (Array.isArray(message.tool_calls) && message.tool_calls.length)) invalid();
  const output: NativeImageContent[] = [];
  if (message.content !== undefined && message.content !== null) {
    if (typeof message.content !== 'string' || Buffer.byteLength(message.content) > SPECIALIZED_MODEL_LIMITS.inputBytes) invalid();
    if (message.content) output.push({ type: 'text', text: message.content });
  }
  if (message.images !== undefined) {
    if (!Array.isArray(message.images) || message.images.length > SPECIALIZED_MODEL_LIMITS.images) invalid();
    const images = message.images.map((item: unknown) => {
      if (!record(item)) invalid();
      const url = typeof item.image_url === 'string' ? item.image_url : record(item.image_url) ? item.image_url.url : undefined;
      if (typeof url !== 'string' || !url.startsWith('data:')) invalid();
      const separator = url.indexOf(';base64,');
      if (separator < 0) invalid();
      return { mediaType: url.slice(5, separator), data: url.slice(separator + 8) };
    });
    if (images.length) output.push(...validateGeneratedImages(images).map(image => ({ type: 'image' as const, ...image })));
  }
  if (!output.length) invalid();
  if (body.id !== undefined && (typeof body.id !== 'string' || !body.id.length || Buffer.byteLength(body.id) > 500)) invalid();
  return { output, ...(typeof body.id === 'string' ? { responseId: body.id } : {}) };
}
export function openRouterImagesUsage(value: unknown, model: string): TokenUsage | undefined {
  return openRouterUsage(value, openRouterImagePricing(model), 'openrouter-images');
}
