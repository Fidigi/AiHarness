import type { Message, MessageContentBlock } from '../types/index.js';

export interface GoogleResponsePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: unknown };
}

/** Called after native envelope/part validation; a signature alone is not a thought marker. */
export function googleResponseBlocks(parts: readonly GoogleResponsePart[]): MessageContentBlock[] {
  return parts.flatMap((part, index): MessageContentBlock[] => [
    ...(part.text === undefined ? [] : part.thought === true
      ? [{ type: 'reasoning' as const, text: part.text, ...(part.thoughtSignature ? { thinkingSignature: part.thoughtSignature } : {}) }]
      : [{ type: 'text' as const, text: part.text, ...(part.thoughtSignature ? { textSignature: part.thoughtSignature } : {}) }]),
    ...(part.functionCall ? [{ type: 'tool_call' as const,
      id: typeof part.functionCall.id === 'string' && part.functionCall.id ? part.functionCall.id : `gemini-${index}-${part.functionCall.name}`,
      name: part.functionCall.name, input: part.functionCall.args ?? {}, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) }] : []),
  ]);
}

/** Pinned streaming block assembly: retain the last nonempty signature within a contiguous text/thought block. */
export function appendGoogleResponseBlocks(blocks: MessageContentBlock[], incoming: readonly MessageContentBlock[]): void {
  for (const block of incoming) {
    const previous = blocks.at(-1);
    if (block.type === 'text' && previous?.type === 'text') {
      previous.text += block.text;
      if (block.textSignature) previous.textSignature = block.textSignature;
    } else if (block.type === 'reasoning' && previous?.type === 'reasoning') {
      previous.text += block.text;
      if (block.thinkingSignature) previous.thinkingSignature = block.thinkingSignature;
    } else {
      if (blocks.length >= 1024) throw new Error('The provider response exceeded the content-block limit.');
      blocks.push({ ...block });
    }
  }
}

// Google TYPE_BYTES replay follows the pinned structural base64 check, not signature authentication.
function signature(value: string | undefined): string | undefined {
  return value && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
}

/** History has already crossed the exact provider/API/model projection boundary. */
export function googleReplayParts(message: Message): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  const calls = new Set<string>();
  for (const block of message.blocks ?? []) {
    if (block.type === 'text' || block.type === 'reasoning') {
      if (block.type === 'reasoning' && block.redacted) continue;
      const opaque = signature(block.type === 'text' ? block.textSignature : block.thinkingSignature);
      if (!block.text.trim() && !opaque) continue;
      parts.push({ text: block.text, ...(block.type === 'reasoning' ? { thought: true } : {}), ...(opaque ? { thoughtSignature: opaque } : {}) });
    } else if (block.type === 'tool_call') {
      calls.add(block.id);
      const opaque = signature(block.thoughtSignature);
      parts.push({ functionCall: { id: block.id, name: block.name, args: block.input ?? {} }, ...(opaque ? { thoughtSignature: opaque } : {}) });
    }
  }
  if (!message.blocks?.some(block => block.type === 'text') && message.content) parts.push({ text: message.content });
  for (const call of message.toolCalls ?? []) if (!calls.has(call.id)) {
    const opaque = signature(call.thoughtSignature);
    parts.push({ functionCall: { id: call.id, name: call.name, args: call.input ?? {} }, ...(opaque ? { thoughtSignature: opaque } : {}) });
  }
  return parts;
}
