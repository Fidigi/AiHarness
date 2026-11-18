import type { Message, MessageContentBlock } from '../types/index.js';
import { assertCompactionTranscript } from './compaction-generation.js';

/** Preserve public block data, never retained full outputs, download links or
 * provider-private replay fields. Tool input remains arbitrary public JSON. */
function summaryBlock(block: MessageContentBlock): MessageContentBlock | undefined {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text };
    case 'reasoning': return undefined;
    case 'image': return { type: 'image', mediaType: block.mediaType, url: block.url,
      name: block.name, size: block.size, width: block.width, height: block.height };
    case 'tool_call': return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
    case 'tool_result': return { type: 'tool_result', toolCallId: block.toolCallId,
      name: block.name, content: block.content, isError: block.isError, truncated: block.truncated };
    case 'command': return { type: 'command', command: block.command, cwd: block.cwd,
      output: block.output, status: block.status, exitCode: block.exitCode, durationMs: block.durationMs,
      excludedFromContext: block.excludedFromContext, truncated: block.truncated };
    default: return undefined;
  }
}

/** Internal inert-text renderer shared with branch summaries. */
export function summaryMessageText(message: Pick<Message, 'content' | 'blocks'>): string {
  const text = message.blocks?.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '';
  if (!text || message.content.startsWith(text)) return message.content;
  if (!message.content || text.startsWith(message.content)) return text;
  return `${message.content}\n${text}`;
}

/** Summary-provider projection only. Canonical preparation, estimates, cuts,
 * raw history and trusted caller-owned summary callbacks keep their contracts.
 * Retain the original canonical admission ceiling before removing private data. */
export function getSummaryModelMessages(messages: readonly Message[]): Message[] {
  assertCompactionTranscript(messages);
  const owned = structuredClone(messages);
  const projected = owned.map(message => {
    const blocks = message.blocks?.flatMap(block => { const result = summaryBlock(block); return result ? [result] : []; });
    // Preserve differing rich/compatibility text without duplicating identical views.
    const content = summaryMessageText({ content: message.content, blocks });
    return {
      id: message.id, role: message.role, content, timestamp: message.timestamp,
      ...(blocks !== undefined ? { blocks } : {}),
      ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls.map(call => ({ id: call.id, name: call.name, input: call.input })) } : {}),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.isError !== undefined ? { isError: message.isError } : {}),
    };
  });
  assertCompactionTranscript(projected);
  return projected;
}
