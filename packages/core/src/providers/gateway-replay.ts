import { createHash } from 'node:crypto';
import type { ChatResponse } from './index.js';
import type { Message, MessageContentBlock, ToolCall } from '../types/index.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function gatewayReplayScope(provider: string, api: string, model: string, endpoint: string, key: string, headers: Readonly<Record<string, string>>): string {
  const entries = Object.entries(headers).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(['gateway-v1', provider, api, model, endpoint, key, entries])).digest('hex');
}
function seal(scope: string | undefined, kind: string, value?: string): string | undefined {
  return scope ? JSON.stringify({ v: 1, scope, kind, ...(value === undefined ? {} : { value }) }) : undefined;
}
function unseal(source: string | undefined, scope: string | undefined, kind: string): { owned: boolean; value?: string } {
  if (!scope || !source || Buffer.byteLength(source) > 4 * 1024 * 1024) return { owned: false };
  try { const value: unknown = JSON.parse(source);
    if (record(value) && value.v === 1 && value.scope === scope && value.kind === kind && (value.value === undefined || typeof value.value === 'string')) {
      return { owned: true, ...(typeof value.value === 'string' ? { value: value.value } : {}) };
    }
  } catch { /* Redaction or foreign/unscoped data never reconstructs opaque authority. */ }
  return { owned: false };
}
export function sealGatewayCall(call: ToolCall, scope?: string): ToolCall {
  const { thoughtSignature, ...copy } = call;
  const signature = seal(scope, 'tool', thoughtSignature); return { ...copy, ...(signature ? { thoughtSignature: signature } : {}) };
}
export function sealGatewayResponse(response: ChatResponse, scope?: string): ChatResponse {
  const blocks = response.blocks?.flatMap((block): MessageContentBlock[] => {
    if (block.type === 'tool_call') return [{ type: 'tool_call', ...sealGatewayCall(block, scope) }];
    if (block.type === 'text') { const { textSignature, ...copy } = block; const signature = seal(scope, 'text', textSignature); return [{ ...copy, ...(signature ? { textSignature: signature } : {}) }]; }
    if (block.type !== 'reasoning') return [structuredClone(block)];
    const { thinkingSignature, ...copy } = block;
    if (copy.redacted && !scope) return [];
    const signature = seal(scope, 'reasoning', thinkingSignature); return [{ ...copy, ...(signature ? { thinkingSignature: signature } : {}) }];
  });
  return { ...response, ...(blocks ? { blocks } : {}), ...(response.toolCalls ? { toolCalls: response.toolCalls.map(call => sealGatewayCall(call, scope)) } : {}) };
}
/** Existing native codecs consume only an owned unwrapped projection; caller history never changes. */
export function gatewayReplayHistory(messages: readonly Message[], scope?: string): Message[] {
  return messages.map(original => {
    const message = structuredClone(original); if (message.role !== 'assistant') return message;
    let owned = false;
    const tool = (call: ToolCall): ToolCall => { const { thoughtSignature, ...copy } = call; const decoded = unseal(thoughtSignature, scope, 'tool'); owned ||= decoded.owned;
      return { ...copy, ...(decoded.value === undefined ? {} : { thoughtSignature: decoded.value }) }; };
    message.toolCalls = message.toolCalls?.map(tool);
    message.blocks = message.blocks?.flatMap((block): MessageContentBlock[] => {
      if (block.type === 'tool_call') return [{ type: 'tool_call', ...tool(block) }];
      if (block.type === 'text') { const { textSignature, ...copy } = block; const decoded = unseal(textSignature, scope, 'text'); owned ||= decoded.owned;
        return [{ ...copy, ...(decoded.value === undefined ? {} : { textSignature: decoded.value }) }]; }
      if (block.type !== 'reasoning') return [block];
      const { thinkingSignature, ...copy } = block, decoded = unseal(thinkingSignature, scope, 'reasoning'); owned ||= decoded.owned;
      if (copy.redacted && !decoded.owned) return [];
      return [{ ...copy, ...(decoded.value === undefined ? {} : { thinkingSignature: decoded.value }) }];
    });
    // Also routes foreign IDs through the existing native codec's public fallback mapping.
    if (!owned) message.api = 'gateway-foreign';
    return message;
  });
}
