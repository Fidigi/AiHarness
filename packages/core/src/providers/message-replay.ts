import type { Message, MessageContentBlock } from '../types/index.js';

/** Pi-style request projection only: raw history is never edited or authenticated here. */
export function projectAssistantReplay(message: Message, provider: string, model: string, api?: string): Message {
  if (message.role !== 'assistant'
    || message.provider === provider && message.model === model && message.api === api) return message;
  const withoutThought = <T extends { thoughtSignature?: string }>(value: T): Omit<T, 'thoughtSignature'> => {
    const { thoughtSignature: _signature, ...rest } = value;
    return rest;
  };
  const blocks = message.blocks?.flatMap((block): MessageContentBlock[] => {
    if (block.type === 'reasoning') return block.redacted || !block.text.trim() ? [] : [{ type: 'text', text: block.text }];
    if (block.type === 'text') return [{ type: 'text', text: block.text }];
    if (block.type === 'tool_call') return [withoutThought(block)];
    return [block];
  });
  // Legacy partial rich blocks may omit the compatibility answer entirely.
  if (blocks && !message.blocks?.some(block => block.type === 'text') && message.content) blocks.push({ type: 'text', text: message.content });
  return { ...message,
    ...(blocks ? { blocks, content: blocks.filter(block => block.type === 'text').map(block => block.text).join('') } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(withoutThought) } : {}),
  };
}
