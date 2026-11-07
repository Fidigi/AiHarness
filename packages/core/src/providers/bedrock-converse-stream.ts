import { crc32 } from 'node:zlib';
import { parseProviderToolArguments } from './tool-arguments.js';
import { bedrockRedactedBytes, bedrockReplayBlocks } from './bedrock-replay.js';
import type { ChatResponse, StreamChunkCallback } from './index.js';
type BedrockUsage = NonNullable<ChatResponse['usage']>;

const MAX_FRAME = 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_TRANSPORT = 64 * 1024 * 1024;
const MAX_EVENTS = 100_000;
const MAX_BLOCKS = 1_024;
function invalid(): never { throw new Error('Invalid Bedrock event stream.'); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Bedrock request aborted.');
}

function eventHeaders(bytes: Buffer): Map<string, string> {
  const headers = new Map<string, string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0, count = 0;
  while (offset < bytes.length) {
    if (++count > 256) invalid();
    const length = bytes[offset++];
    if (!length || offset + length + 1 > bytes.length) invalid();
    const name = decoder.decode(bytes.subarray(offset, offset + length)); offset += length;
    const type = bytes[offset++];
    if (headers.has(name)) invalid();
    // AWS EventStream scalar types. Only UTF-8 string values carry protocol tags.
    let size = [0, 0, 1, 2, 4, 8, -1, -1, 8, 16][type];
    if (size === undefined) invalid();
    if (size === -1) {
      if (offset + 2 > bytes.length) invalid();
      size = bytes.readUInt16BE(offset); offset += 2;
    }
    if (offset + size > bytes.length) invalid();
    headers.set(name, type === 7 ? decoder.decode(bytes.subarray(offset, offset + size)) : '');
    offset += size;
  }
  return headers;
}

/** Decode bounded AWS EventStream frames, including both CRCs, before publishing their JSON. */
async function* events(response: Response, signal?: AbortSignal): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
  if (!response.body) invalid();
  const reader = response.body.getReader();
  let frame: Buffer = Buffer.alloc(12), written = 0, transport = 0, output = 0, count = 0;
  try {
    while (true) {
      active(signal);
      let abort!: () => void;
      const withdrawn = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Bedrock request aborted.')); });
      signal?.addEventListener('abort', abort, { once: true });
      let read: Awaited<ReturnType<typeof reader.read>>;
      try { active(signal); read = await Promise.race([reader.read(), withdrawn]); }
      finally { signal?.removeEventListener('abort', abort); }
      active(signal);
      if (read.done) break;
      transport += read.value.byteLength;
      if (transport > MAX_TRANSPORT) throw new Error('The Bedrock stream exceeded its transport limit.');
      let offset = 0;
      while (offset < read.value.length) {
        active(signal);
        const size = Math.min(frame.length - written, read.value.length - offset);
        frame.set(read.value.subarray(offset, offset + size), written); written += size; offset += size;
        if (written !== frame.length) continue;
        if (frame.length === 12) {
          if (crc32(frame.subarray(0, 8)) !== frame.readUInt32BE(8)) invalid();
          const total = frame.readUInt32BE(0), headerLength = frame.readUInt32BE(4);
          if (total > MAX_FRAME) throw new Error('The Bedrock stream exceeded its event limit.');
          if (total < 16 || headerLength > 64 * 1024 || headerLength > total - 16) invalid();
          const expanded = Buffer.alloc(total); frame.copy(expanded); frame = expanded;
          continue;
        }
        if (++count > MAX_EVENTS) throw new Error('The Bedrock stream exceeded its event-count limit.');
        if (crc32(frame.subarray(0, -4)) !== frame.readUInt32BE(frame.length - 4)) invalid();
        const headerLength = frame.readUInt32BE(4);
        let headers: Map<string, string>;
        try { headers = eventHeaders(frame.subarray(12, 12 + headerLength)); } catch { invalid(); }
        if (headers.get(':message-type') === 'exception' || headers.get(':message-type') === 'error') {
          throw new Error('Bedrock streaming error.');
        }
        const type = headers.get(':event-type');
        if (headers.get(':message-type') !== 'event' || !type
          || (headers.has(':content-type') && headers.get(':content-type') !== 'application/json')) invalid();
        const payload = frame.subarray(12 + headerLength, -4);
        output += payload.length;
        if (output > MAX_OUTPUT) throw new Error('The Bedrock stream exceeded its output limit.');
        let data: unknown;
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { invalid(); }
        if (!record(data)) invalid();
        frame = Buffer.alloc(12); written = 0;
        yield { type, data };
      }
    }
    if (written) invalid();
  } finally {
    void reader.cancel('bedrock-stream-finished').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* An uncooperative pending read may still own the lock. */ }
  }
}

function usage(value: unknown): BedrockUsage | undefined {
  const counter = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  // ChatResponse requires both counters. Omit incomplete usage rather than inventing a missing zero.
  if (!record(value) || !counter(value.inputTokens) || !counter(value.outputTokens)) return undefined;
  return { promptTokens: value.inputTokens, completionTokens: value.outputTokens,
    totalTokens: counter(value.totalTokens) ? value.totalTokens : Math.min(Number.MAX_SAFE_INTEGER, value.inputTokens + value.outputTokens),
    ...(counter(value.cacheReadInputTokens) ? { cacheReadTokens: value.cacheReadInputTokens } : {}),
    ...(counter(value.cacheWriteInputTokens) ? { cacheWriteTokens: value.cacheWriteInputTokens } : {}) };
}

type Block = { kind?: 'text' | 'reasoning' | 'tool'; stopped: boolean; id?: string; name?: string; json: string; bytes: number;
  text?: string; signature?: string; redacted?: Buffer[] };

/** ConverseStream text/reasoning and deferred tools, with opt-in exact-owner signed capture. */
export async function consumeBedrockStream(response: Response, model: string, onChunk: StreamChunkCallback, signal?: AbortSignal,
  normalizeUsage: (value: unknown) => BedrockUsage | undefined = usage, captureReplay = false): Promise<ChatResponse> {
  let started = false, stopped = false, metadata = false, content = '', reasoning = '';
  let nativeStop: string | undefined;
  let stopReason: ChatResponse['stopReason'], tokens: BedrockUsage | undefined;
  const blocks = new Map<number, Block>();
  const blockAt = (data: Record<string, unknown>, create = false): Block => {
    const index = data.contentBlockIndex;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= MAX_BLOCKS) invalid();
    let block = blocks.get(index);
    if (!block && create) {
      if (captureReplay && index !== blocks.size) invalid();
      block = { stopped: false, json: '', bytes: 0 }; blocks.set(index, block);
    }
    if (!block || block.stopped) invalid();
    return block;
  };
  for await (const { type, data } of events(response, signal)) {
    active(signal);
    if (type === 'messageStart') {
      if (started || stopped || data.role !== 'assistant') invalid();
      started = true; continue;
    }
    if (!started) invalid();
    if (type === 'metadata') {
      if (!stopped || metadata) invalid();
      metadata = true; tokens = normalizeUsage(data.usage); continue;
    }
    if (stopped) invalid();
    switch (type) {
      case 'contentBlockStart': {
        const index = data.contentBlockIndex;
        if (typeof index !== 'number' || blocks.has(index) || !record(data.start)) invalid();
        const block = blockAt(data, true), tool = data.start.toolUse;
        if (tool !== undefined) {
          if (!record(tool) || typeof tool.toolUseId !== 'string' || !tool.toolUseId || tool.toolUseId.length > 500
            || typeof tool.name !== 'string' || !tool.name || tool.name.length > 500) invalid();
          block.kind = 'tool'; block.id = tool.toolUseId; block.name = tool.name;
        }
        break;
      }
      case 'contentBlockDelta': {
        const block = blockAt(data, true), delta = data.delta;
        if (!record(delta)) invalid();
        if (Object.keys(delta).length !== 1) invalid();
        const kind = typeof delta.text === 'string' ? 'text' : record(delta.toolUse) ? 'tool' : record(delta.reasoningContent) ? 'reasoning' : invalid();
        if (block.kind && block.kind !== kind) invalid();
        if (kind === 'tool') {
          if (!block.id || !record(delta.toolUse) || typeof delta.toolUse.input !== 'string') invalid();
          block.bytes += Buffer.byteLength(delta.toolUse.input);
          if (block.bytes > MAX_FRAME) throw new Error('The Bedrock tool input exceeded its output limit.');
          block.json += delta.toolUse.input;
        } else if (kind === 'text') {
          if (captureReplay) block.text = (block.text ?? '') + (delta.text as string);
          content += delta.text as string;
          if (delta.text) await onChunk(delta.text as string, { type: 'text_delta' });
        } else {
          const thought = delta.reasoningContent as Record<string, unknown>;
          if (captureReplay) {
            if (Object.keys(thought).length !== 1 || !['text', 'signature', 'redactedContent'].some(key => typeof thought[key] === 'string')) invalid();
            block.bytes += Buffer.byteLength(JSON.stringify(thought));
            if (block.bytes > MAX_OUTPUT) invalid();
            if (thought.redactedContent !== undefined) {
              if (block.text !== undefined || block.signature !== undefined) invalid();
              (block.redacted ??= []).push(bedrockRedactedBytes(thought.redactedContent));
            } else {
              if (block.redacted) invalid();
              if (typeof thought.text === 'string') block.text = (block.text ?? '') + thought.text;
              if (typeof thought.signature === 'string') block.signature = (block.signature ?? '') + thought.signature;
            }
          }
          if (thought.text !== undefined && typeof thought.text !== 'string') invalid();
          if (typeof thought.text === 'string' && thought.text) {
            reasoning += thought.text;
            await onChunk('', { type: 'reasoning_delta', data: { content: thought.text } });
          }
        }
        block.kind = kind; break;
      }
      case 'contentBlockStop': blockAt(data).stopped = true; break;
      case 'messageStop':
        if ([...blocks.values()].some(block => !block.stopped)) invalid();
        if (!['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'model_context_window_exceeded'].includes(String(data.stopReason))) {
          throw new Error('Bedrock streaming error.');
        }
        if (data.stopReason === 'max_tokens' || data.stopReason === 'model_context_window_exceeded') stopReason = 'length';
        nativeStop = String(data.stopReason);
        stopped = true; break;
      default: invalid();
    }
  }
  active(signal);
  if (!started || !stopped) invalid();
  const calls = [...blocks.values()].filter(block => block.kind === 'tool').map(block => ({
    id: block.id!, name: block.name!, input: parseProviderToolArguments(block.json),
  }));
  if (new Set(calls.map(call => call.id)).size !== calls.length) invalid();
  const replay = captureReplay ? bedrockReplayBlocks([...blocks.values()].map(block => {
    if (block.kind === 'text') return { text: block.text ?? '' };
    if (block.kind === 'tool') return { toolUse: { toolUseId: block.id, name: block.name, input: calls.find(call => call.id === block.id)!.input } };
    if (block.kind !== 'reasoning') invalid();
    return { reasoningContent: block.redacted ? { redactedContent: Buffer.concat(block.redacted).toString('base64') }
      : { reasoningText: { text: block.text ?? '', ...(block.signature ? { signature: block.signature } : {}) } } };
  }), 'assistant', nativeStop) : undefined;
  for (const call of calls) { active(signal); await onChunk('', { type: 'tool_call', data: captureReplay ? structuredClone(call) : call }); }
  active(signal);
  return { content, api: 'bedrock-converse-stream', model, ...(reasoning ? { reasoning } : {}), ...(replay?.length ? { blocks: replay } : {}),
    ...(stopReason ? { stopReason } : {}), ...(tokens ? { usage: tokens } : {}), ...(calls.length ? { toolCalls: calls } : {}) };
}
