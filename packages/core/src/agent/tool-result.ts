import type { ExtensionToolResult } from '../extensions/extension-registry.js';
import type { MessageContentBlock } from '../types/index.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';

export interface OwnedToolResult {
  content: string;
  structuredContent?: unknown;
  blocks: Array<Extract<MessageContentBlock, { type: 'text' | 'image' }>>;
  isError: boolean;
}

/** Admit inert owned data before redaction, persistence, nested delivery or provider projection. */
export function ownToolResult(result: ExtensionToolResult, redact: (text: string) => string = text => text): OwnedToolResult {
  const invalid = (): never => { throw new Error('Tool result is invalid or exceeds its limit.'); };
  const field = (key: string): unknown => {
    const property = Object.getOwnPropertyDescriptor(result, key);
    if (property && !('value' in property)) return invalid();
    return property?.value;
  };
  if (!result || typeof result !== 'object') return invalid();
  const text = field('content');
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) return invalid();
  let content = redact(text);
  const rawStructured = field('structuredContent');
  let structuredContent: unknown;
  if (rawStructured !== undefined) {
    const copy = copySessionCustomValue(rawStructured, 256 * 1024);
    // Redact raw strings/keys before JSON escaping, including quoted secrets.
    const scrub = (value: unknown): unknown => {
      if (typeof value === 'string') return redact(value);
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), scrub(item)]));
      const encoded = String(value); return redact(encoded) === encoded ? value : '[REDACTED]';
    };
    try { structuredContent = copySessionCustomValue(scrub(copy), 256 * 1024); } catch { structuredContent = '[REDACTED]'; }
    const rendered = `[Structured result]\n${JSON.stringify(structuredContent)}`;
    if (!content.includes(rendered)) content = `${rendered}${content ? `\n${content}` : ''}`;
  }
  const rawBlocks = field('blocks');
  const blocks = rawBlocks === undefined ? [] : copySessionCustomValue(rawBlocks, 4 * 1024 * 1024) as OwnedToolResult['blocks'];
  if (!Array.isArray(blocks) || blocks.length > 64) return invalid();
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      if (Object.keys(block).some(key => !['type', 'text'].includes(key))) return invalid();
      block.text = redact(block.text); content += `${content ? '\n' : ''}${block.text}`;
    } else if (block.type === 'image' && typeof block.url === 'string' && typeof block.mediaType === 'string') {
      if (Object.keys(block).some(key => !['type', 'mediaType', 'name', 'size', 'url', 'width', 'height'].includes(key))) return invalid();
      for (const key of ['size', 'width', 'height'] as const) if (block[key] !== undefined
        && (typeof block[key] !== 'number' || !Number.isSafeInteger(block[key]) || block[key]! < 0)) return invalid();
      block.url = redact(block.url);
      if (block.name !== undefined) { if (typeof block.name !== 'string' || block.name.length > 1000) return invalid(); block.name = redact(block.name); }
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mediaType)
        || !block.url.startsWith(`data:${block.mediaType};base64,`)
        || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(block.url)) return invalid();
    } else return invalid();
  }
  if (Buffer.byteLength(content) + Buffer.byteLength(JSON.stringify(blocks)) > 4 * 1024 * 1024) return invalid();
  const error = field('isError');
  if (error !== undefined && typeof error !== 'boolean') return invalid();
  return { content, blocks, isError: error === true,
    ...(rawStructured !== undefined ? { structuredContent } : {}) };
}
