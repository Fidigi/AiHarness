import type { MessageContentBlock } from '../types/index.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new Error('Invalid Bedrock signed response.'); }
const text = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value) <= 16 * 1024 * 1024;

/** Blob encoding is structural validation only; it does not authenticate the provider's bytes. */
export function bedrockRedactedBytes(value: unknown): Buffer {
  if (!text(value) || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) invalid();
  const bytes = Buffer.from(value as string, 'base64');
  if (bytes.toString('base64') !== value) invalid();
  return bytes;
}

/** Admit opaque reasoning only with a recognized terminal; plain legacy JSON remains compatible. */
export function bedrockReplayBlocks(content: unknown, role: unknown, stopReason: unknown): MessageContentBlock[] | undefined {
  if (!Array.isArray(content) || content.length > 1024) invalid();
  const signed = content.some(block => record(block) && block.reasoningContent !== undefined);
  if (signed && (role !== 'assistant' || !['end_turn', 'tool_use', 'stop_sequence', 'max_tokens', 'model_context_window_exceeded'].includes(String(stopReason)))) invalid();
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return undefined;
  const calls = new Set<string>();
  return content.map((block): MessageContentBlock => {
    if (!record(block)) invalid();
    const kinds = ['text', 'reasoningContent', 'toolUse'].filter(key => block[key] !== undefined);
    if (kinds.length !== 1) invalid();
    if (block.text !== undefined) {
      if (!text(block.text)) invalid();
      return { type: 'text', text: block.text as string };
    }
    if (block.toolUse !== undefined) {
      const call = block.toolUse;
      if (!record(call) || typeof call.toolUseId !== 'string' || !call.toolUseId || call.toolUseId.length > 500
        || typeof call.name !== 'string' || !call.name || call.name.length > 500 || !record(call.input) || calls.has(call.toolUseId)) invalid();
      calls.add(call.toolUseId as string);
      return { type: 'tool_call', id: call.toolUseId as string, name: call.name as string, input: call.input as Record<string, unknown> };
    }
    const thought = block.reasoningContent;
    if (!record(thought)) invalid();
    if (thought.redactedContent !== undefined) {
      if (thought.reasoningText !== undefined) invalid();
      return { type: 'reasoning', text: '', redacted: true, thinkingSignature: bedrockRedactedBytes(thought.redactedContent).toString('base64') };
    }
    const visible = thought.reasoningText;
    if (!record(visible) || !text(visible.text) || (visible.signature !== undefined && !text(visible.signature))) invalid();
    return { type: 'reasoning', text: visible.text as string,
      ...(typeof visible.signature === 'string' && visible.signature ? { thinkingSignature: visible.signature } : {}) };
  });
}
