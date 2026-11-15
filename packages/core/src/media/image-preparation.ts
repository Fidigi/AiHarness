import { Worker } from 'node:worker_threads';
import type { AiProvider } from '../providers/index.js';
import { getProviderPublishedModel } from '../providers/provider-model-metadata.js';
import type { MessageContentBlock } from '../types/index.js';
import type { ImageProcessingInput, ImageResizeLimits, ProcessedImage } from './image-processing.js';
export type { ImageResizeLimits } from './image-processing.js';
type ImageBlock = Extract<MessageContentBlock, { type: 'image' }>;
export type PreparedModelImage = { ok: true; image: ImageBlock; hints: string[]; resized: boolean; originalWidth?: number; originalHeight?: number }
  | { ok: false; message: string };
const defaults: Readonly<ImageResizeLimits> = Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 });
const omitted = (): PreparedModelImage => ({ ok: false, message: '[Image omitted: could not be converted or resized below the inline image size limit.]' });
let active = 0;
const waiting = new Set<() => void>();
async function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted(); if (waiting.size >= 16) throw new Error('Image preparation is busy.');
  while (active >= 2) await new Promise<void>((resolve, reject) => {
    const done = () => { waiting.delete(done); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { waiting.delete(done); signal.removeEventListener('abort', abort); reject(signal.reason); }; waiting.add(done); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted(); active++;
  return () => { active--; for (const next of waiting) next(); };
}
async function process(input: ImageProcessingInput, signal: AbortSignal): Promise<ProcessedImage | null> {
  const release = await acquire(signal); let worker: Worker | undefined;
  try {
    signal.throwIfAborted(); worker = new Worker(new URL('./image-worker.js', import.meta.url), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    return await new Promise<ProcessedImage | null>((resolve, reject) => {
      const abort = () => reject(signal.reason), done = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      worker!.once('error', error => { done(); reject(error); });
      worker!.once('exit', () => { done(); resolve(null); });
      worker!.on('message', (message: unknown) => { if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'image.prepared') { done(); resolve((message as { value: ProcessedImage | null }).value); } });
      if (signal.aborted) abort();
    });
  } finally { if (worker) void worker.terminate().catch(() => undefined).finally(release); else release(); }
}

/** Explicit model-owned inline preparation. No source URLs/files/network, journal mutation or history rewrite. */
export async function prepareModelImage(
  provider: AiProvider, model: string, image: ImageBlock,
  options: { autoResize?: boolean } = {}, signal?: AbortSignal,
): Promise<PreparedModelImage> {
  signal?.throwIfAborted();
  const metadata = getProviderPublishedModel(provider.getProviderType(), model, provider);
  if (metadata?.capabilities.imageInput === false) return { ok: false, message: '[Image omitted: selected model does not support image input.]' };
  const limits = { ...defaults, ...metadata?.inputLimits?.images?.resize };
  if (!Number.isSafeInteger(limits.maxWidth) || limits.maxWidth < 1 || limits.maxWidth > 8192
    || !Number.isSafeInteger(limits.maxHeight) || limits.maxHeight < 1 || limits.maxHeight > 8192
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 16 * 1024 * 1024
    || !Number.isSafeInteger(limits.jpegQuality) || limits.jpegQuality < 1 || limits.jpegQuality > 100) return omitted();
  if (!image || typeof image.url !== 'string' || typeof image.mediaType !== 'string' || image.mediaType.length > 256 || image.url.length > 14 * 1024 * 1024) return omitted();
  const match = /^data:([^;,]{1,256});base64,([A-Za-z0-9+/]*={0,2})$/u.exec(image.url);
  if (!match || !match[2] || match[2].length % 4 !== 0) return omitted();
  const bytes = Buffer.from(match[2], 'base64'); if (bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== match[2]) return omitted();
  const deadline = AbortSignal.timeout(15000), requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const result = await process({ bytes, mimeType: image.mediaType, limits, autoResize: options.autoResize !== false }, requestSignal);
    signal?.throwIfAborted(); if (!result) return omitted();
    return { ok: true, image: { ...image, mediaType: result.mimeType, url: `data:${result.mimeType};base64,${result.data}`, size: Buffer.from(result.data, 'base64').length,
      ...(result.width ? { width: result.width, height: result.height } : {}) }, hints: result.hints, resized: result.resized,
      originalWidth: result.originalWidth, originalHeight: result.originalHeight };
  } catch { signal?.throwIfAborted(); return omitted(); }
}
