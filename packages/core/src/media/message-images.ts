import type { AiProvider } from '../providers/index.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { VirtualModelRegistry, VirtualModelContext } from '../providers/virtual-models.js';
import { awaitAgentAdmission } from '../agent/prestart-admission.js';
import { isValidModelId } from '../providers/model-catalog.js';
import type { Message, MessageContentBlock } from '../types/index.js';
import { prepareModelImage } from './image-preparation.js';

/** Pinned conversation policy: last successful physical response, not speculative routing. */
export async function resolveRoutedImageTarget(
  manager: SessionManager, sessionId: string, models: VirtualModelRegistry,
  resolveProvider: VirtualModelContext['resolveProvider'], signal?: AbortSignal,
): Promise<{ provider: AiProvider; model: string } | undefined> {
  const session = manager.get(sessionId), leaf = session?.activeLeafId;
  const latest = [...manager.getEffectiveContext(sessionId)].reverse().find(entry => entry.type === 'message'
    && entry.role === 'assistant' && !entry.metadata?.outputError);
  if (latest?.type !== 'message' || !isValidModelId(latest.provider) || !isValidModelId(latest.model)
    || models.get(latest.provider, latest.model)) return undefined;
  const provider = await awaitAgentAdmission(() => resolveProvider(latest.provider!), signal ?? new AbortController().signal);
  signal?.throwIfAborted();
  if (manager.get(sessionId) !== session || session?.activeLeafId !== leaf) throw new Error('Image preparation context changed.');
  return provider && !models.get(latest.provider, latest.model) ? { provider, model: latest.model } : undefined;
}

/** Outgoing conversation policy only: retain journal bytes and assistant output. */
export function blockMessageImages(messages: Message[]): Message[] {
  const note = 'Image reading is disabled.';
  return messages.map(message => {
    if (!['user', 'tool'].includes(message.role) || !message.blocks?.some(block => block.type === 'image')) return message;
    const blocks = message.blocks.map(block => block.type === 'image' ? { type: 'text' as const, text: note } : block)
      .filter((block, index, all) => !(block.type === 'text' && block.text === note && index > 0
        && all[index - 1].type === 'text' && (all[index - 1] as { text: string }).text === note));
    if (message.content && !message.blocks.some(block => block.type === 'text')) blocks.unshift({ type: 'text', text: message.content });
    return { ...message, content: `${message.content}${message.content ? '\n' : ''}${note}`, blocks };
  });
}

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
