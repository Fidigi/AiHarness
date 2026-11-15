import type { AiProvider } from '../providers/index.js';
import type { MessageContentBlock } from '../types/index.js';
import { prepareModelImage } from './image-preparation.js';

/** Normalize only new input, after caller hooks and before its first journal append. Never rewrites history. */
export async function prepareMessageImages(
  provider: AiProvider, model: string | undefined, content: string, blocks: MessageContentBlock[] | undefined,
  kind: 'prompt' | 'tool', options: { autoResize?: boolean } = {}, signal?: AbortSignal,
): Promise<{ content: string; blocks: MessageContentBlock[] | undefined }> {
  if (!blocks?.some(block => block.type === 'image')) return { content, blocks };
  const prepared: MessageContentBlock[] = [], hints: string[] = [];
  for (const block of blocks) {
    signal?.throwIfAborted();
    if (block.type !== 'image') { prepared.push(block); continue; }
    const result = await prepareModelImage(provider, model ?? provider.getConfiguredModel() ?? '', block, options, signal);
    signal?.throwIfAborted();
    if (result.ok) { prepared.push(result.image); hints.push(...result.hints); }
    else if (kind === 'tool') prepared.push(block);
    else hints.push(result.message);
  }
  if (hints.length) {
    // Adding a text hint must not suppress the adapter's compatibility-content fallback.
    if (content && !prepared.some(block => block.type === 'text')) prepared.unshift({ type: 'text', text: content });
    const note = hints.join('\n'); content += `${content ? '\n' : ''}${note}`; prepared.push({ type: 'text', text: note });
  }
  return { content, blocks: prepared };
}
