import type { MessageContentBlock } from '../types/index.js';
import { parseProviderToolArguments } from './tool-arguments.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validFinish = (value: unknown): boolean => typeof value === 'string'
  && ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'pause_turn'].includes(value);
function invalid(): never { throw new Error('Invalid Anthropic response.'); }
function validateEnvelope(value: Record<string, unknown>): void {
  if (value.error || (value.type !== undefined && value.type !== 'message')
    || (value.role !== undefined && value.role !== 'assistant')) invalid();
}

export function anthropicResponseToolInput(value: unknown): Record<string, unknown> {
  if (!record(value)) invalid();
  return value;
}
function validateBlock(value: unknown, complete: boolean): void {
  if (!record(value)) invalid();
  if (value.type === 'text') {
    if ((complete || value.text !== undefined) && typeof value.text !== 'string') invalid();
  } else if (value.type === 'thinking') {
    if ((complete || value.thinking !== undefined) && typeof value.thinking !== 'string') invalid();
    if (value.signature !== undefined && typeof value.signature !== 'string') invalid();
  } else if (value.type === 'redacted_thinking') {
    if (typeof value.data !== 'string') invalid();
  } else if (value.type === 'tool_use') {
    if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name) invalid();
    if (complete || value.input !== undefined) anthropicResponseToolInput(value.input);
  } else invalid();
}
function contentBlock(value: unknown): MessageContentBlock {
  validateBlock(value, true);
  const block = value as Record<string, unknown>;
  if (block.type === 'text') return { type: 'text', text: block.text as string };
  if (block.type === 'thinking') return { type: 'reasoning', text: block.thinking as string,
    ...(typeof block.signature === 'string' ? { thinkingSignature: block.signature } : {}) };
  if (block.type === 'redacted_thinking') return { type: 'reasoning', text: '[Reasoning redacted]',
    redacted: true, thinkingSignature: block.data as string };
  return { type: 'tool_call', id: block.id as string, name: block.name as string, input: block.input };
}
export function validateAnthropicResponse(value: unknown, fallback?: (value: Record<string, unknown>) => boolean): MessageContentBlock[] {
  if (!record(value)) invalid();
  validateEnvelope(value);
  if (!Array.isArray(value.content) || value.content.length > 1024 || !validFinish(value.stop_reason)) invalid();
  let output = false;
  return value.content.flatMap(block => {
    if (record(block) && block.type === 'fallback') {
      if (output || !fallback?.(block)) invalid();
      return [];
    }
    output = true;
    return [contentBlock(block)];
  });
}

/** Ordered native content is released only after complete blocks and terminal authority. */
export function anthropicResponseStreamValidator(fallback?: (value: Record<string, unknown>) => boolean): { validate(value: unknown): void; finish(): MessageContentBlock[] } {
  let started = false, finished = false, stopped = false;
  const blocks: Array<Record<string, unknown>> = [], open = new Set<number>(), argumentsJson = new Map<number, string>();
  return {
    validate(value) {
      if (!record(value) || typeof value.type !== 'string') invalid();
      if (value.type === 'ping') return;
      if (stopped) invalid();
      if (value.type === 'message_start') {
        if (started || !record(value.message)) invalid();
        validateEnvelope(value.message);
        started = true;
      } else if (value.type === 'message_delta') {
        if (!started || !record(value.delta)) invalid();
        if (value.delta.stop_reason !== undefined && value.delta.stop_reason !== null) {
          if (finished || open.size || !validFinish(value.delta.stop_reason)) invalid();
          finished = true;
        }
      } else if (value.type === 'message_stop') {
        if (!started || !finished) invalid();
        stopped = true;
      } else if (['content_block_start', 'content_block_delta', 'content_block_stop'].includes(value.type)) {
        const index = value.index as number;
        if (!started || finished || !Number.isSafeInteger(index) || index < 0 || index >= 1024) invalid();
        if (value.type === 'content_block_start') {
          if (index !== blocks.length) invalid();
          const marker = record(value.content_block) && value.content_block.type === 'fallback';
          if (marker) {
            if (blocks.some(block => block.type !== 'fallback') || open.size || !fallback?.(value.content_block as Record<string, unknown>)) invalid();
          } else validateBlock(value.content_block, false);
          const block = { ...value.content_block as Record<string, unknown> };
          if (block.type === 'text') block.text ??= '';
          if (block.type === 'thinking') block.thinking ??= '';
          blocks.push(block); open.add(index);
        } else {
          if (!open.has(index)) invalid();
          if (value.type === 'content_block_stop') { open.delete(index); return; }
          const delta = value.delta, block = blocks[index]!;
          if (!record(delta)) invalid();
          const key = delta.type === 'text_delta' && block.type === 'text' ? 'text'
            : delta.type === 'thinking_delta' && block.type === 'thinking' ? 'thinking'
              : delta.type === 'signature_delta' && block.type === 'thinking' ? 'signature' : undefined;
          if (key) {
            if (typeof delta[key] !== 'string') invalid();
            block[key] = String(block[key] ?? '') + delta[key];
          } else if (delta.type === 'input_json_delta' && block.type === 'tool_use' && typeof delta.partial_json === 'string') {
            argumentsJson.set(index, (argumentsJson.get(index) ?? '') + delta.partial_json);
          } else invalid();
        }
      } else invalid();
    },
    finish() {
      if (!started || !finished || !stopped || open.size) invalid();
      return blocks.flatMap((block, index) => block.type === 'fallback' ? [] : [contentBlock(block.type === 'tool_use'
        ? { ...block, input: argumentsJson.get(index) ? parseProviderToolArguments(argumentsJson.get(index)!) : block.input ?? {} } : block)]);
    },
  };
}
export function assertAnthropicResponseActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Anthropic request aborted.');
}
