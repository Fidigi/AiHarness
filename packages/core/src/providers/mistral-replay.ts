import type { Message, MessageContentBlock, ToolCall } from '../types/index.js';
import { projectAssistantReplay } from './message-replay.js';
import { responseItemHash } from './openai-responses.js';

type Item = Record<string, unknown>;

/** Mistral's independent native projection; constructor/profile admission belongs to the caller. */
export function mistralReplayMessages(messages: Message[], provider: string, model: string, imagesAllowed: boolean, systemPrompt?: string): Item[] {
  const ids = new Map<string, string>(), owners = new Map<string, string>();
  const foreignId = (id: string): string => {
    const prior = ids.get(id); if (prior) return prior;
    const normalized = id.replace(/[^a-zA-Z0-9]/g, ''), seed = normalized || id;
    for (let attempt = 0; ; attempt++) {
      const candidate = attempt === 0 && normalized.length === 9 ? normalized
        : responseItemHash(attempt === 0 ? seed : `${seed}:${attempt}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 9);
      if (!owners.has(candidate) || owners.get(candidate) === id) { ids.set(id, candidate); owners.set(candidate, id); return candidate; }
    }
  };
  const imageParts = (message: Message, placeholder: string): Item[] => {
    const result: Item[] = []; let omitted = false;
    for (const block of message.blocks ?? []) {
      if (block.type === 'text') { result.push({ type: 'text', text: block.text }); omitted = block.text === placeholder; }
      else if (block.type === 'image') {
        if (imagesAllowed) result.push({ type: 'image_url', image_url: block.url });
        else if (!omitted) result.push({ type: 'text', text: placeholder });
        omitted = !imagesAllowed;
      }
    }
    if (!message.blocks?.some(block => block.type === 'text') && message.content) result.unshift({ type: 'text', text: message.content });
    return result;
  };
  const result: Item[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  for (const original of messages) {
    if (original.role === 'assistant') {
      if (original.metadata?.outputError) continue;
      const same = original.provider === provider && original.api === 'mistral-conversations' && original.model === model;
      const message = projectAssistantReplay(original, provider, model, 'mistral-conversations');
      const content = (message.blocks ?? []).flatMap<Item>(block => block.type === 'text' && block.text.trim() ? [{ type: 'text', text: block.text }]
        : block.type === 'reasoning' && !block.redacted && block.text.trim() ? [{ type: 'thinking', thinking: [{ type: 'text', text: block.text }] }] : []);
      if (!message.blocks?.some(block => block.type === 'text') && message.content) content.push({ type: 'text', text: message.content });
      const calls = message.toolCalls?.length ? message.toolCalls : message.blocks?.flatMap(block => block.type === 'tool_call' ? [block] : []) ?? [];
      const toolCalls = calls.map(call => ({ id: same ? call.id : foreignId(call.id), type: 'function', index: 0, function: { name: call.name, arguments: JSON.stringify(call.input) } }));
      if (content.length || toolCalls.length) result.push({ role: 'assistant', prefix: false, ...(content.length ? { content } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else if (original.role === 'tool') {
      const parts = imageParts(original, '(tool image omitted: model does not support images)');
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
      const images = parts.filter(part => part.type === 'image_url');
      result.push({ role: 'tool', tool_call_id: ids.get(original.toolCallId ?? original.id) ?? original.toolCallId ?? original.id,
        ...(original.name ? { name: original.name } : {}), content: [{ type: 'text', text: (original.isError ? '[tool error] ' : '') + (text || (images.length ? '(see attached image)' : '(no tool output)')) }, ...images] });
    } else if (original.role === 'user' && original.blocks?.some(block => block.type === 'image')) {
      const content = imageParts(original, '(image omitted: model does not support images)');
      if (content.length) result.push({ role: 'user', content });
    } else result.push({ role: original.role, content: original.content });
  }
  let leading = 0; while (result[leading]?.role === 'system') leading++;
  return leading > 1 ? [{ role: 'system', content: result.slice(0, leading).map(value => value.content).filter(Boolean).join('\n\n') }, ...result.slice(leading)] : result;
}

/** Mistral coalesces adjacent nonempty text/thinking, breaking at tools; no opaque signature is emitted. */
export function createMistralCapture() {
  const slots: Array<MessageContentBlock | number> = [], indexes = new Set<number>();
  let current: Extract<MessageContentBlock, { type: 'text' | 'reasoning' }> | undefined;
  return {
    append(type: 'text' | 'reasoning', text: string): void {
      if (!text) return;
      let block = current;
      if (!block || block.type !== type) { block = type === 'text' ? { type: 'text', text: '' } : { type: 'reasoning', text: '' }; slots.push(block); }
      block.text += text; current = block;
    },
    tool(index: number): void { current = undefined; if (!indexes.has(index)) { indexes.add(index); slots.push(index); } },
    finish(calls: ToolCall[]): MessageContentBlock[] {
      const ordered = [...indexes].sort((a, b) => a - b);
      return slots.map(slot => typeof slot === 'number' ? { type: 'tool_call', ...calls[ordered.indexOf(slot)]! } : { ...slot });
    },
  };
}
