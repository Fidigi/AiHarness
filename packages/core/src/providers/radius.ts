import { createHash } from 'node:crypto';
import type { ChatOptions, ChatResponse, StreamChunkCallback } from './index.js';
import type { Message, MessageContentBlock, TokenUsage, ToolCall } from '../types/index.js';
import { validateGeneratedImages } from './specialized-models.js';
import { radiusModel, type RadiusModelProfile } from './radius-models.js';

const API = 'pi-messages', MAX_OUTPUT = 4 * 1024 * 1024, MAX_EVENT = 1024 * 1024;
export interface RadiusChatOptions extends ChatOptions {
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}
export interface RadiusOwner { provider: string; model: string; scope?: string }
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max = MAX_OUTPUT): value is string { return typeof value === 'string' && Buffer.byteLength(value) <= max; }
function invalid(): never { throw new RadiusProtocolError('Invalid Radius stream.'); }
export class RadiusProtocolError extends Error {
  readonly usage?: Readonly<TokenUsage>;
  constructor(message: string, usage?: TokenUsage) { super(message); this.name = 'RadiusProtocolError'; if (usage) this.usage = Object.freeze({ ...usage }); }
}
export function radiusBase(value = 'https://radius.pi.dev/v1'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Radius endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Radius endpoint.');
  url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/messages$/u, '') || '/v1';
  return url.toString().replace(/\/$/u, '');
}
export function radiusScope(provider: string, base: string, model: string, key: string, headers: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(headers).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash('sha256').update(JSON.stringify([API, provider, base, model, key, ...(entries.length ? [entries] : [])])).digest('hex');
}
function seal(owner: RadiusOwner, kind: string, signature?: string, content?: string): string | undefined {
  if (!owner.scope) return undefined;
  return JSON.stringify({ v: 1, scope: owner.scope, kind, ...(signature ? { signature } : {}), ...(content === undefined ? {} : { content }) });
}
function open(value: unknown, owner: RadiusOwner, kind: string): RecordValue | undefined {
  if (!owner.scope || !text(value, MAX_OUTPUT) || value.includes('[REDACTED]')) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (record(parsed) && parsed.v === 1 && parsed.scope === owner.scope && parsed.kind === kind
      && (parsed.signature === undefined || text(parsed.signature, MAX_EVENT) && !!parsed.signature.trim())
      && (parsed.content === undefined || text(parsed.content, MAX_EVENT))) return parsed;
  } catch { /* No opaque replay authority follows from malformed/foreign metadata. */ }
  return undefined;
}
function imageContent(message: Message): RecordValue[] {
  const images = (message.blocks ?? []).filter(block => block.type === 'image').map(block => {
    const match = /^data:([^;,]+);base64,(.+)$/su.exec(block.url);
    if (!match || match[1] !== block.mediaType) throw new Error('Radius requires inline images.');
    return { mediaType: block.mediaType, data: match[2] };
  });
  if (images.length) validateGeneratedImages(images);
  return images.map(image => ({ type: 'image', mimeType: image.mediaType, data: image.data }));
}
function content(message: Message, owner: RadiusOwner): RecordValue[] {
  if (message.role !== 'assistant') {
    const blocks = (message.blocks ?? []).filter(block => block.type === 'text').map(block => ({ type: 'text', text: block.text }));
    return [...(blocks.length ? blocks : message.content ? [{ type: 'text', text: message.content }] : []), ...imageContent(message)];
  }
  const same = message.provider === owner.provider && message.model === owner.model && message.api === API;
  const blocks: RecordValue[] = [];
  for (const block of message.blocks ?? []) {
    if (block.type === 'text') {
      const privateData = same ? open(block.textSignature, owner, 'text') : undefined;
      blocks.push({ type: 'text', text: block.text, ...(privateData?.signature ? { textSignature: privateData.signature } : {}) });
    } else if (block.type === 'reasoning') {
      const privateData = same ? open(block.thinkingSignature, owner, block.redacted ? 'redacted' : 'thinking') : undefined;
      if (privateData) blocks.push({ type: 'thinking', thinking: block.redacted ? privateData.content ?? '' : block.text,
        ...(block.redacted ? { redacted: true } : {}), ...(privateData.signature ? { thinkingSignature: privateData.signature } : {}) });
      else if (!block.redacted && block.text.trim()) blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_call') blocks.push(tool(block, same, owner));
  }
  if (!message.blocks?.some(block => block.type === 'text') && message.content) blocks.push({ type: 'text', text: message.content });
  for (const call of message.toolCalls ?? []) if (!blocks.some(block => block.type === 'toolCall' && block.id === call.id)) blocks.push(tool(call, same, owner));
  return blocks;
}
function tool(call: ToolCall, same: boolean, owner: RadiusOwner): RecordValue {
  const privateData = same ? open(call.thoughtSignature, owner, 'tool') : undefined;
  return { type: 'toolCall', id: call.id, name: call.name, arguments: call.input,
    ...(privateData?.signature ? { thoughtSignature: privateData.signature } : {}) };
}
export function radiusBody(messages: Message[], options: RadiusChatOptions, owner: RadiusOwner, profile: RadiusModelProfile = radiusModel(owner.model)): RecordValue {
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens)) throw new Error('Invalid Radius output limit.');
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw new Error('Invalid Radius temperature.');
  if (options.thinking !== undefined && (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.thinking)
    || !profile.reasoning && options.thinking !== 'off')) throw new Error('Invalid Radius thinking level.');
  if (options.cacheRetention !== undefined && !['none', 'short', 'long'].includes(options.cacheRetention)) throw new Error('Invalid Radius cache retention.');
  if (!profile.declaredInput.includes('image') && messages.some(message => message.blocks?.some(block => block.type === 'image'))) throw new Error('Radius model does not support images.');
  if (options.tools && options.tools.length > 128) throw new Error('Radius tool limit exceeded.');
  const system = [options.systemPrompt, ...messages.filter(message => message.role === 'system').map(message => message.content)].filter(value => value !== undefined && value !== '');
  const toolNames = new Map(messages.flatMap(message => [
    ...(message.toolCalls ?? []), ...(message.blocks ?? []).filter((block): block is Extract<MessageContentBlock, { type: 'tool_call' }> => block.type === 'tool_call'),
  ].map(call => [call.id, call.name] as const)));
  let choice = options.toolChoice;
  if (choice !== undefined && !['auto', 'none', 'required'].includes(String(choice))) {
    if (!record(choice) || choice.type !== 'function' || !record(choice.function) || !text(choice.function.name, 128)) throw new Error('Invalid Radius tool choice.');
    const name = choice.function.name;
    if (!options.tools?.some(tool => tool.name === name)) throw new Error('Invalid Radius tool choice.');
    choice = { type: 'function', function: { name } };
  }
  const context = { ...(system.length ? { systemPrompt: system.join('\n\n') } : {}),
    messages: messages.filter(message => message.role !== 'system').map(message => {
      const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : 0;
      const parts = content(message, owner);
      if (message.role === 'tool') {
        if (!text(message.toolCallId, 500) || !message.toolCallId) throw new Error('Invalid Radius tool result.');
        return { role: 'toolResult', toolCallId: message.toolCallId, toolName: message.name ?? toolNames.get(message.toolCallId) ?? 'tool', content: parts, isError: message.isError === true, timestamp };
      }
      return { role: message.role, content: parts, timestamp, ...(message.role === 'assistant' ? {
        api: message.api ?? 'unknown', provider: message.provider ?? 'unknown', model: message.model ?? 'unknown',
        stopReason: parts.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop',
        // Pi requires history counters. Unknown history placeholders are not response accounting.
        usage: { input: message.usage?.inputTokens ?? 0, output: message.usage?.outputTokens ?? 0,
          cacheRead: message.usage?.cacheReadTokens ?? 0, cacheWrite: message.usage?.cacheWriteTokens ?? 0, totalTokens: message.usage?.totalTokens ?? 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: message.usage?.costUsd ?? 0 } },
      } : {}) };
    }),
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) } : {}),
  };
  return { model: owner.model, context, options: { temperature: options.temperature, maxTokens: options.maxTokens,
    reasoning: options.thinking === 'off' ? undefined : options.thinking, cacheRetention: options.cacheRetention,
    sessionId: options.sessionId, toolChoice: choice } };
}
function usage(value: unknown): TokenUsage | undefined {
  if (!record(value)) return undefined;
  const result: TokenUsage = {};
  for (const [source, target] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cacheReadTokens'], ['cacheWrite', 'cacheWriteTokens'], ['totalTokens', 'totalTokens']] as const) {
    const raw = value[source]; if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) result[target] = raw;
  }
  if (record(value.cost) && typeof value.cost.total === 'number' && Number.isFinite(value.cost.total) && value.cost.total >= 0) result.costUsd = value.cost.total;
  return Object.keys(result).length ? result : undefined;
}
interface Block { kind: 'text' | 'thinking' | 'toolcall'; value: string; bytes: number; ended: boolean; id?: string; name?: string; signature?: string; redacted?: boolean; call?: ToolCall }
/** P has its own terminal authority and opaque scope. No A/C/R grant is borrowed. */
export async function readRadiusStream(response: Response, owner: RadiusOwner, signal: AbortSignal, onChunk: StreamChunkCallback): Promise<ChatResponse> {
  const reader = response.body?.getReader(); if (!reader) invalid();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => { void reader.cancel('radius-aborted').catch(() => undefined); reject(new RadiusProtocolError('Radius request aborted.')); }; });
  signal.addEventListener('abort', abort, { once: true });
  const active = async <T>(work: Promise<T>): Promise<T> => { signal.throwIfAborted(); const result = await Promise.race([work, cancelled]); signal.throwIfAborted(); return result; };
  const blocks = new Map<number, Block>(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, events = 0, started = false;
  const event = async (raw: string): Promise<ChatResponse | undefined> => {
    if (Buffer.byteLength(raw) > MAX_EVENT || ++events > 100_000) invalid();
    const data = raw.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') return undefined;
    const value: unknown = JSON.parse(data); if (!record(value) || typeof value.type !== 'string') invalid();
    if (value.type === 'error') throw new RadiusProtocolError('Radius request failed.', usage(value.usage));
    if (value.type === 'done') {
      if (!started || !['stop', 'length', 'toolUse'].includes(String(value.reason)) || [...blocks.values()].some(block => !block.ended)) invalid();
      const ordered: MessageContentBlock[] = [];
      for (const [, block] of [...blocks].sort(([a], [b]) => a - b)) {
        if (block.kind === 'text') ordered.push({ type: 'text', text: block.value, ...(block.signature ? { textSignature: seal(owner, 'text', block.signature) } : {}) });
        else if (block.kind === 'thinking') {
          if (!block.redacted || owner.scope) ordered.push({ type: 'reasoning', text: block.redacted ? '' : block.value,
            ...(block.redacted ? { redacted: true } : {}), thinkingSignature: seal(owner, block.redacted ? 'redacted' : 'thinking', block.signature, block.redacted ? block.value : undefined) });
        } else if (value.reason !== 'length') ordered.push({ type: 'tool_call', ...block.call!, ...(block.signature ? { thoughtSignature: seal(owner, 'tool', block.signature) } : {}) });
      }
      const calls = ordered.filter((block): block is Extract<MessageContentBlock, { type: 'tool_call' }> => block.type === 'tool_call');
      if ((value.reason === 'toolUse') !== (calls.length > 0) || calls.length > 64 || Buffer.byteLength(JSON.stringify(ordered)) > MAX_OUTPUT) invalid();
      const observed = usage(value.usage), input = observed?.inputTokens, output = observed?.outputTokens, total = observed?.totalTokens;
      const normalized = input !== undefined && output !== undefined && total !== undefined
        && total >= input + output + (observed?.cacheReadTokens ?? 0) + (observed?.cacheWriteTokens ?? 0)
        ? { promptTokens: input, completionTokens: output, totalTokens: total, cacheReadTokens: observed?.cacheReadTokens,
          cacheWriteTokens: observed?.cacheWriteTokens, costUsd: observed?.costUsd } : undefined;
      return { provider: owner.provider, model: owner.model, api: API, content: ordered.filter(block => block.type === 'text').map(block => block.text).join(''),
        reasoning: ordered.filter((block): block is Extract<MessageContentBlock, { type: 'reasoning' }> => block.type === 'reasoning' && !block.redacted).map(block => block.text).join(''), blocks: ordered,
        ...(calls.length ? { toolCalls: calls.map(({ id, name, input, thoughtSignature }) => ({ id, name, input, ...(thoughtSignature ? { thoughtSignature } : {}) })) } : {}),
        ...(value.reason === 'length' ? { stopReason: 'length' } : {}), ...(normalized ? { usage: normalized } : {}),
        ...(['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value.providerThinkingLevel)) ? { providerThinkingLevel: value.providerThinkingLevel as ChatResponse['providerThinkingLevel'] } : {}) };
    }
    if (value.type === 'start') { if (started) invalid(); started = true; return undefined; }
    if (!started || !Number.isSafeInteger(value.contentIndex) || (value.contentIndex as number) < 0 || (value.contentIndex as number) >= 256) invalid();
    const index = value.contentIndex as number, existing = blocks.get(index);
    if (['text_start', 'thinking_start', 'toolcall_start'].includes(value.type)) {
      if (existing) invalid();
      if (value.type === 'toolcall_start' && (!text(value.id, 500) || !value.id || !text(value.toolName, 128) || !value.toolName)) invalid();
      blocks.set(index, { kind: value.type === 'text_start' ? 'text' : value.type === 'thinking_start' ? 'thinking' : 'toolcall', value: '', bytes: 0, ended: false,
        ...(value.type === 'toolcall_start' ? { id: value.id as string, name: value.toolName as string } : {}) }); return undefined;
    }
    if (!existing || existing.ended) invalid();
    const prefix = existing.kind === 'toolcall' ? 'toolcall' : existing.kind;
    if (value.type === `${prefix}_delta`) {
      if (!text(value.delta)) invalid(); existing.bytes += Buffer.byteLength(value.delta);
      if (existing.bytes > MAX_OUTPUT) invalid(); existing.value += value.delta;
      if (existing.kind === 'text') await active(Promise.resolve(onChunk(value.delta, { type: 'text_delta' })));
    } else if (value.type === `${prefix}_end`) {
      existing.ended = true;
      if (existing.kind === 'toolcall') {
        const call = value.toolCall;
        if (!record(call) || call.id !== existing.id || call.name !== existing.name || !record(call.arguments)) invalid();
        existing.call = { id: existing.id!, name: existing.name!, input: call.arguments };
        if (call.thoughtSignature !== undefined) { if (!text(call.thoughtSignature, MAX_EVENT) || !call.thoughtSignature.trim()) invalid(); existing.signature = call.thoughtSignature; }
      } else {
        if (!text(value.content)) invalid(); existing.value = value.content;
        if (value.contentSignature !== undefined) { if (!text(value.contentSignature, MAX_EVENT) || !value.contentSignature.trim()) invalid(); existing.signature = value.contentSignature; }
        if (existing.kind === 'thinking') {
          if (value.redacted !== undefined && typeof value.redacted !== 'boolean') invalid();
          existing.redacted = value.redacted === true;
          // P reveals redaction only at block end: never stream potentially opaque deltas.
          if (!existing.redacted && existing.value) await active(Promise.resolve(onChunk('', { type: 'reasoning_delta', data: { content: existing.value } })));
        }
      }
    } else invalid();
    return undefined;
  };
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await active(reader.read());
      if (item.done) break;
      bytes += item.value.byteLength; if (bytes > 64 * 1024 * 1024) invalid();
      buffer += decoder.decode(item.value, { stream: true });
      let split: RegExpExecArray | null;
      while ((split = /\r?\n\r?\n/u.exec(buffer))) {
        const raw = buffer.slice(0, split.index); buffer = buffer.slice(split.index + split[0].length);
        const result = await event(raw); if (result) return result;
      }
      if (Buffer.byteLength(buffer) > MAX_EVENT) invalid();
    }
    buffer += decoder.decode();
    if (buffer.trim()) { const result = await event(buffer); if (result) return result; }
    throw new RadiusProtocolError('Invalid Radius stream.');
  } catch (error) {
    if (error instanceof RadiusProtocolError) throw error;
    throw new RadiusProtocolError(signal.aborted ? 'Radius request aborted.' : 'Invalid Radius stream.');
  } finally {
    signal.removeEventListener('abort', abort); void reader.cancel('radius-settled').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A hostile read may remain pending after bounded cancellation. */ }
  }
}
