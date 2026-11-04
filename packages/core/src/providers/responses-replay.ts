import type { Message, MessageContentBlock, ToolCall } from '../types/index.js';
import { projectAssistantReplay } from './message-replay.js';
import { responseItemHash } from './openai-responses.js';

export type ResponsesReplayOwner = { provider: string; api: string; model: string };
type Item = Record<string, unknown>;
const record = (value: unknown): value is Item => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw new Error('Invalid native Responses continuation.'); };
const reasoningText = (item: Item): string => {
  const text = (value: unknown) => Array.isArray(value) ? value.flatMap(part => record(part) && typeof part.text === 'string' ? [part.text] : []).join('\n\n') : '';
  return text(item.summary) || text(item.content);
};

/** Completed native items only; terminal Azure encryption backfills by item ID, never overwrites a signature. */
export function createResponsesReplayCapture() {
  const items = new Map<number, Item>();
  let bytes = 0;
  const save = (index: unknown, value: unknown) => {
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= 1024 || !record(value)) return invalid();
    const encoded = JSON.stringify(value), previous = items.get(Number(index));
    bytes += Buffer.byteLength(encoded) - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0);
    if (bytes > 4 * 1024 * 1024) return invalid();
    items.set(Number(index), JSON.parse(encoded) as Item);
  };
  return {
    accept(event: Item): void {
      if (event.type === 'response.output_item.added') {
        if (!Number.isInteger(event.output_index) || Number(event.output_index) < 0 || Number(event.output_index) >= 1024) invalid();
      }
      if (event.type === 'response.output_item.done') {
        if (items.has(Number(event.output_index))) invalid();
        save(event.output_index, event.item);
      }
      if (['response.completed', 'response.done', 'response.incomplete'].includes(String(event.type))) {
        const output = record(event.response) ? event.response.output : undefined;
        if (output === undefined) return;
        if (!Array.isArray(output) || output.length > 1024) return invalid();
        for (const [index, value] of output.entries()) {
          if (!record(value)) return invalid();
          const matched = typeof value.id === 'string' ? [...items].find(([, item]) => item.id === value.id && item.type === value.type) : undefined;
          if (matched) {
            const [slot, previous] = matched;
            if (value.type === 'reasoning' && !previous.encrypted_content && typeof value.encrypted_content === 'string') {
              save(slot, { ...previous, encrypted_content: value.encrypted_content });
            }
          } else {
            if (items.has(index)) return invalid();
            save(index, value);
          }
        }
      }
    },
    finish(calls: ToolCall[]): MessageContentBlock[] {
      const blocks: MessageContentBlock[] = [];
      for (const item of [...items].sort(([left], [right]) => left - right).map(([, item]) => item)) {
        if (item.type === 'reasoning') {
          blocks.push({ type: 'reasoning', text: reasoningText(item), thinkingSignature: JSON.stringify(item) });
        } else if (item.type === 'message') {
          const text = Array.isArray(item.content) ? item.content.flatMap(part => !record(part) ? []
            : part.type === 'output_text' && typeof part.text === 'string' ? [part.text]
              : part.type === 'refusal' && typeof part.refusal === 'string' ? [part.refusal] : []).join('') : '';
          blocks.push({ type: 'text', text, ...(typeof item.id === 'string' ? { textSignature: JSON.stringify({ v: 1, id: item.id,
            ...(['commentary', 'final_answer'].includes(String(item.phase)) ? { phase: item.phase } : {}) }) } : {}) });
        } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          const id = typeof item.call_id === 'string' && typeof item.id === 'string' ? `${item.call_id}|${item.id}` : item.call_id ?? item.id;
          const call = calls.find(call => call.id === id);
          if (!call) return invalid();
          blocks.push({ type: 'tool_call', ...call });
        }
      }
      // Existing argument-done/terminal authority also supports unsigned tools without item-done frames.
      blocks.push(...calls.filter(call => !blocks.some(block => block.type === 'tool_call' && block.id === call.id))
        .map(call => ({ type: 'tool_call' as const, ...call })));
      return blocks;
    },
  };
}

/** Replace only native rich assistant slots; all existing user/tool/image preparation remains owning code. */
export function applyResponsesReplay(body: { input: Item[] }, messages: Message[], owner: ResponsesReplayOwner): void {
  const input: Item[] = [];
  let cursor = 0;
  for (const [index, original] of messages.entries()) {
    const messageIndex = index - (messages[0]?.role === 'system' ? 1 : 0);
    const count = original.role === 'assistant' && original.toolCalls?.length ? original.toolCalls.length + (original.content ? 1 : 0) : 1;
    const legacy = body.input.slice(cursor, cursor + count); cursor += count;
    if (original.role !== 'assistant') { input.push(...legacy); continue; }
    if (original.metadata?.outputError) continue;
    const message = projectAssistantReplay(original, owner.provider, owner.model, owner.api);
    if (!message.blocks || message.blocks.some(block => block.type === 'image')) { input.push(...legacy); continue; }
    let textIndex = 0;
    const text = (value: string, signature?: string) => {
      let id: string | undefined, phase: unknown;
      if (signature && !signature.startsWith('{')) id = signature;
      else if (signature) {
        try {
          const parsed: unknown = JSON.parse(signature);
          if (record(parsed) && parsed.v === 1 && typeof parsed.id === 'string') { id = parsed.id; phase = parsed.phase; }
        } catch { /* Expurgated/malformed opaque data is not repaired. */ }
      }
      // Wire correlation IDs are not fabricated opaque signatures.
      if (id && id.length > 64) id = `msg_${responseItemHash(id)}`;
      if (!id) id = `msg_pi_${messageIndex}${textIndex ? `_${textIndex}` : ''}`;
      textIndex++;
      input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value, annotations: [] }], status: 'completed', id,
        ...(['commentary', 'final_answer'].includes(String(phase)) ? { phase } : {}) });
    };
    const seen = new Set<string>();
    const call = (value: ToolCall) => {
      seen.add(value.id);
      input.push({ type: 'function_call', call_id: value.id, name: value.name, arguments: JSON.stringify(value.input) });
    };
    for (const block of message.blocks) {
      if (block.type === 'reasoning' && block.thinkingSignature) {
        try {
          const item: unknown = JSON.parse(block.thinkingSignature);
          if (record(item) && item.type === 'reasoning') input.push(item);
        } catch { /* Credential redaction/export omission never authorizes reconstructing opaque bytes. */ }
      } else if (block.type === 'text') text(block.text, block.textSignature);
      else if (block.type === 'tool_call') call(block);
    }
    if (!message.blocks.some(block => block.type === 'text') && message.content) text(message.content);
    for (const value of message.toolCalls ?? []) if (!seen.has(value.id)) call(value);
  }
  body.input = input;
}
