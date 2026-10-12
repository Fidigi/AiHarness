import { open } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceManager } from '../security/workspace-manager.js';
import type { MessageContentBlock } from '../types/index.js';

const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

type ImageBlock = Extract<MessageContentBlock, { type: 'image' }>;

export interface PromptFileLimits {
  maxFiles?: number;
  maxTextBytes?: number;
  maxImageBytes?: number;
  maxTotalBytes?: number;
}

export interface LoadedPromptFiles {
  /** Text files and image references, ready to prepend to the user's prompt. */
  text: string;
  /** Data-backed image blocks consumed by the shared provider/session pipeline. */
  images: ImageBlock[];
  files: Array<{ path: string; size: number; mediaType: string }>;
}

function imageMediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const header = bytes.subarray(0, 6).toString('ascii');
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation aborted.');
}

async function readBoundedFile(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Prompt input must be a regular file.');
    if (info.size > maxBytes) throw new Error(`Prompt file exceeds the ${maxBytes} byte input limit.`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Prompt file exceeds the ${maxBytes} byte input limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/**
 * Load CLI-style @file inputs through the canonical workspace boundary. Text
 * and image handling lives in Core so every Node host can reuse the same size,
 * path, and MIME checks.
 */
export async function loadPromptFiles(
  workspaceManager: WorkspaceManager,
  cwd: string,
  requestedPaths: readonly string[],
  limits: PromptFileLimits = {},
  signal?: AbortSignal,
): Promise<LoadedPromptFiles> {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTextBytes = limits.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const maxImageBytes = limits.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (![maxFiles, maxTextBytes, maxImageBytes, maxTotalBytes]
    .every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Prompt file limits must be positive safe integers.');
  }
  if (requestedPaths.length > maxFiles) throw new Error(`At most ${maxFiles} prompt files are allowed.`);

  const canonicalCwd = await workspaceManager.resolve(cwd, { kind: 'directory' });
  const textParts: string[] = [];
  const images: ImageBlock[] = [];
  const files: LoadedPromptFiles['files'] = [];
  let totalBytes = 0;

  for (const requestedPath of requestedPaths) {
    throwIfAborted(signal);
    const filePath = await workspaceManager.resolve(requestedPath, { base: canonicalCwd, kind: 'file' });
    const bytes = await readBoundedFile(filePath, Math.max(maxTextBytes, maxImageBytes), signal);
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) throw new Error(`Prompt files exceed the ${maxTotalBytes} byte total limit.`);
    if (bytes.length === 0) continue;

    throwIfAborted(signal);
    const mediaType = imageMediaType(bytes);
    const displayPath = path.relative(canonicalCwd, filePath).split(path.sep).join('/') || path.basename(filePath);
    const escapedPath = xmlAttribute(displayPath);

    if (mediaType) {
      if (bytes.length > maxImageBytes) throw new Error(`Prompt image exceeds the ${maxImageBytes} byte limit: ${displayPath}`);
      images.push({
        type: 'image',
        mediaType,
        name: path.basename(displayPath),
        size: bytes.length,
        url: `data:${mediaType};base64,${bytes.toString('base64')}`,
      });
      textParts.push(`<file name="${escapedPath}"></file>\n`);
      files.push({ path: displayPath, size: bytes.length, mediaType });
      continue;
    }

    if (bytes.length > maxTextBytes) throw new Error(`Prompt text file exceeds the ${maxTextBytes} byte limit: ${displayPath}`);
    if (bytes.includes(0)) throw new Error(`Unsupported binary prompt file: ${displayPath}`);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Prompt file is not valid UTF-8 text or a supported image: ${displayPath}`);
    }
    if (content.startsWith('\ufeff')) content = content.slice(1);
    textParts.push(`<file name="${escapedPath}">\n${content}\n</file>\n`);
    files.push({ path: displayPath, size: bytes.length, mediaType: 'text/plain' });
  }

  return { text: textParts.join(''), images, files };
}
