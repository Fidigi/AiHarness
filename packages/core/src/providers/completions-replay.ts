import type { Message, MessageContentBlock, ToolCall } from '../types/index.js';
import { projectAssistantReplay } from './message-replay.js';
import { responseItemHash } from './openai-responses.js';

type Item = Record<string, unknown>;
const record = (value: unknown): value is Item => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = ['reasoning_content', 'reasoning', 'reasoning_text'] as const;
function detail(value: unknown): value is Item {
  if (!record(value) || value.id !== undefined && value.id !== null && typeof value.id !== 'string'
    || value.format !== undefined && typeof value.format !== 'string' || value.index !== undefined && typeof value.index !== 'number') return false;
  return value.type === 'reasoning.encrypted' ? typeof value.data === 'string'
    : value.type === 'reasoning.summary' ? typeof value.summary === 'string'
      : value.type === 'reasoning.text' && typeof value.text === 'string'
        && (value.signature === undefined || value.signature === null || typeof value.signature === 'string');
}
function signedDetails(signature: string | undefined): Item[] | undefined {
  if (!signature) return undefined;
  try { const parsed: unknown = JSON.parse(signature); return Array.isArray(parsed) && parsed.length > 0 && parsed.every(detail) ? parsed : undefined; }
  catch { return undefined; }
}
function legacyDetail(signature: string | undefined): Item | undefined {
  if (!signature) return undefined;
  try { const parsed: unknown = JSON.parse(signature); return detail(parsed) && parsed.type === 'reasoning.encrypted'
    && typeof parsed.id === 'string' && parsed.id.length > 0 && typeof parsed.data === 'string' && parsed.data.length > 0 ? parsed : undefined; }
  catch { return undefined; }
}

/** Independently admitted C mechanics; the caller owns the actual body and marker policy. */
export function applyCompletionHistory(body: Item, messages: Message[], provider: string, requiresReasoning: boolean, normalizeReasoningMarker: boolean): void {
  const model = String(body.model), assistants = messages.filter(message => message.role === 'assistant'), tools = messages.filter(message => message.role === 'tool');
  const ids = new Map<string, string>(); let assistantIndex = 0, toolIndex = 0;
  if (Array.isArray(body.messages)) body.messages = body.messages.flatMap((value): Item[] => {
    if (!record(value)) return [];
    if (value.role === 'assistant') {
      const original = assistants[assistantIndex++]; if (!original || original.metadata?.outputError) return [];
      const same = original.provider === provider && original.api === 'openai-completions' && original.model === model;
      const projected = projectAssistantReplay(original, provider, model, 'openai-completions'), blocks = projected.blocks ?? [];
      const text = blocks.flatMap(block => block.type === 'text' && block.text.trim() ? [block.text] : []).join('')
        || (!blocks.some(block => block.type === 'text') ? projected.content : '');
      const calls = projected.toolCalls?.length ? projected.toolCalls : blocks.flatMap(block => block.type === 'tool_call' ? [block] : []);
      const thinking = blocks.filter(block => block.type === 'reasoning');
      const signed = thinking.map(block => signedDetails(block.thinkingSignature)).find(value => value !== undefined);
      const legacy = calls.map(call => legacyDetail(call.thoughtSignature)).filter((value): value is Item => value !== undefined);
      const preserved = signed ?? (legacy.length ? legacy : undefined), result: Item = { role: 'assistant', content: text || null };
      if (calls.length) result.tool_calls = calls.map(call => {
        let id = call.id;
        if (!same && id.includes('|')) {
          const split = id.indexOf('|'), callId = id.slice(0, split).replace(/[^a-zA-Z0-9_-]/g, '_'), itemId = id.slice(split + 1).replace(/[^a-zA-Z0-9_-]/g, '_');
          id = itemId ? `${callId}_${itemId}` : callId;
          if (id.length > 40) { const hash = responseItemHash(call.id).slice(0, 8); id = `${callId.slice(0, Math.max(1, 40 - hash.length - 1))}_${hash}`; }
        }
        ids.set(call.id, id); return { id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } };
      });
      if (preserved) result.reasoning_details = preserved;
      else {
        const visible = thinking.filter(block => block.text.trim()), first = visible[0]?.thinkingSignature;
        const field = normalizeReasoningMarker && first === 'reasoning' ? 'reasoning_content' : first;
        if (field && fields.some(value => value === field)) result[field] = visible.map(block => block.text).join('\n');
      }
      if (requiresReasoning && result.reasoning_content === undefined) result.reasoning_content = '';
      return text || calls.length ? [result] : [];
    }
    if (value.role === 'tool') {
      const original = tools[toolIndex++], result = { ...value }; delete result.name;
      if (typeof result.tool_call_id === 'string') result.tool_call_id = ids.get(result.tool_call_id) ?? result.tool_call_id;
      if (result.content === '' && !original?.blocks?.some(block => block.type === 'image')) result.content = '(no tool output)';
      return [result];
    }
    return [{ ...value }];
  });
  if (body.tool_choice === 'auto') delete body.tool_choice;
  if (Array.isArray(body.messages)) {
    const values = body.messages as Item[]; let leading = 0;
    while (values[leading]?.role === 'system') leading++;
    if (leading > 1) body.messages = [{ role: 'system', content: values.slice(0, leading).map(value => value.content).filter(Boolean).join('\n\n') }, ...values.slice(leading)];
  }
}

/** Pinned C streaming coalesces one text and one thinking block, unlike contiguous Google blocks. */
export function createCompletionCapture(normalizeReasoningMarker: boolean, invalidResponse: string) {
  const slots: Array<MessageContentBlock | number> = [], toolIndexes = new Set<number>();
  let text: Extract<MessageContentBlock, { type: 'text' }> | undefined, thought: Extract<MessageContentBlock, { type: 'reasoning' }> | undefined;
  let details: Item[] | undefined;
  const thinking = (signature: string) => { if (!thought) { thought = { type: 'reasoning', text: '', thinkingSignature: signature }; slots.push(thought); } return thought; };
  return {
    accept(value: unknown, complete = false): void {
      if (!record(value)) return;
      if (typeof value.content === 'string' && value.content) { if (!text) { text = { type: 'text', text: '' }; slots.push(text); } text.text += value.content; }
      const field = fields.find(field => typeof value[field] === 'string' && value[field]);
      if (field) thinking(normalizeReasoningMarker && field === 'reasoning' ? 'reasoning_content' : field).text += value[field] as string;
      if (Array.isArray(value.tool_calls)) for (const [position, call] of value.tool_calls.entries()) if (record(call)) {
        const index = complete ? position : call.index;
        if (typeof index === 'number' && !toolIndexes.has(index)) { toolIndexes.add(index); slots.push(index); }
      }
      if (Array.isArray(value.reasoning_details)) for (const incoming of value.reasoning_details) if (detail(incoming)) {
        thinking(''); details ??= []; const last = details.at(-1);
        if (last && (incoming.type === 'reasoning.text' || incoming.type === 'reasoning.summary') && last.type === incoming.type) {
          const field = incoming.type === 'reasoning.text' ? 'text' : 'summary'; last[field] = String(last[field]) + String(incoming[field]);
          if (incoming.type === 'reasoning.text') last.signature ||= incoming.signature;
          last.id ??= incoming.id; last.format ||= incoming.format; last.index ??= incoming.index;
        } else details.push({ ...incoming });
      }
    },
    finish(calls: ToolCall[] = []): MessageContentBlock[] {
      if (thought && details !== undefined) thought.thinkingSignature = JSON.stringify(details);
      const indexes = [...toolIndexes].sort((a, b) => a - b);
      return slots.map((slot): MessageContentBlock => {
        if (typeof slot !== 'number') return { ...slot };
        const call = calls[indexes.indexOf(slot)]; if (!call) throw new Error(invalidResponse);
        return { type: 'tool_call', ...call };
      });
    },
  };
}
