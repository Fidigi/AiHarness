import type { ActiveToolSnapshot, ToolProgressSnapshot, ToolProgressValue } from '@ai-harness/core';

// Browser-only defense at API/session boundaries. Do not import Core's Node producer.
const CONTENT_BYTES = 16_384;
const DETAILS_BYTES = 8_192;
const NODES = 256;

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function identifier(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}
function count(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function text(value: string, limit: number): string {
  // Never encode/stringify an unbounded original. Bound UTF-8 by code point.
  let bytes = 0;
  let result = '';
  for (const point of value) {
    const safe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(point)
      || (point.length === 1 && /[\ud800-\udfff]/u.test(point)) ? '\uFFFD' : point;
    const code = safe.codePointAt(0)!;
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > limit) break;
    bytes += size;
    result += safe;
  }
  return result;
}
function details(value: unknown): { value: ToolProgressValue; truncated: boolean } {
  let budget = DETAILS_BYTES;
  let nodes = 0;
  let scanned = 0;
  let truncated = false;
  const seen = new Set<object>();
  const string = (input: string): string => {
    // Six bytes per source code unit safely covers JSON escaping overhead.
    const result = text(input, Math.max(0, Math.floor((budget - 2) / 6)));
    budget -= result.length * 6 + 2;
    truncated ||= result !== input;
    return result;
  };
  const visit = (input: unknown, depth: number): ToolProgressValue => {
    if (++nodes > NODES || depth > 6 || budget < 16) { truncated = true; return null; }
    budget -= 8;
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') return string(input);
    if (!input || typeof input !== 'object' || seen.has(input)) { truncated = true; return null; }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        const length = own(input, 'length');
        if (!count(length)) { truncated = true; return null; }
        const output: ToolProgressValue[] = [];
        for (let i = 0; i < length; i++) {
          if (++scanned > NODES || nodes >= NODES || budget < 16) { truncated = true; break; }
          const entry = Object.getOwnPropertyDescriptor(input, String(i));
          if (entry && !('value' in entry)) truncated = true;
          output.push(visit(entry && 'value' in entry ? entry.value : null, depth + 1));
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) { truncated = true; return null; }
      const output: { [key: string]: ToolProgressValue } = Object.create(null) as { [key: string]: ToolProgressValue };
      // Our descriptor/node/string work is bounded; JS proxy enumeration itself is not sandboxed.
      for (const key in input) {
        if (++scanned > NODES || nodes >= NODES || budget < 16) { truncated = true; break; }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor) || ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)) {
          truncated = true; continue;
        }
        const name = string(key);
        output[name] = visit(descriptor.value, depth + 1);
      }
      return output;
    } catch { truncated = true; return null; }
  };
  return { value: visit(value, 0), truncated };
}

/** Same v1 public shape for live snapshots, SSE and persisted terminal metadata.
 * No nested identity, usage, price, activation or store field gains authority. */
export function normalizeToolProgress(value: unknown, toolCallId: string, toolName: string): ToolProgressSnapshot | undefined {
  if (!identifier(toolCallId, 512) || !identifier(toolName, 256) || own(value, 'version') !== 1
    || own(value, 'toolCallId') !== toolCallId || own(value, 'toolName') !== toolName) return undefined;
  const sequence = own(value, 'sequence');
  const status = own(value, 'status');
  const durationMs = own(value, 'durationMs');
  const omittedUpdates = own(value, 'omittedUpdates');
  const truncated = own(value, 'truncated');
  const content = own(value, 'content');
  if (!count(sequence, 1) || !count(omittedUpdates) || typeof durationMs !== 'number'
    || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > Number.MAX_SAFE_INTEGER
    || typeof truncated !== 'boolean' || (content !== undefined && typeof content !== 'string')
    || (status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'cancelled')) return undefined;
  const result: ToolProgressSnapshot = { version: 1, toolCallId, toolName, sequence, status, durationMs, omittedUpdates, truncated };
  if (typeof content === 'string') {
    result.content = text(content, CONTENT_BYTES);
    result.truncated ||= result.content !== content;
  }
  const reported = own(value, 'details');
  if (reported !== undefined) {
    const bounded = details(reported);
    result.details = bounded.value;
    result.truncated ||= bounded.truncated;
  }
  return result;
}

/** Only enrich an existing host-started invocation. The caller owns session/run
 * epochs and event watermarks; removed/terminal state stays authoritative. */
export function applyToolProgress(tool: ActiveToolSnapshot | undefined, value: unknown): ActiveToolSnapshot | undefined {
  if (!tool || tool.name === 'codemode' || own(value, 'kind') !== 'tool' || own(value, 'parentId') !== undefined) return tool;
  const next = normalizeToolProgress(value, tool.id, tool.name);
  if (!next || next.status !== 'running') return tool;
  const previous = normalizeToolProgress(tool.progress, tool.id, tool.name);
  if (previous && (previous.status !== 'running' || next.sequence <= previous.sequence || next.durationMs < previous.durationMs)) return tool;
  return { ...tool, progress: next };
}

/** Serialize only our bounded, detached JSON-shaped copy, never producer objects. */
export function toolProgressDetailsText(progress: ToolProgressSnapshot): string {
  const id = own(progress, 'toolCallId');
  const name = own(progress, 'toolName');
  const safe = typeof id === 'string' && typeof name === 'string' ? normalizeToolProgress(progress, id, name) : undefined;
  return safe?.details == null ? '' : JSON.stringify(safe.details, null, 2);
}
