import type { ChatResponse } from './index.js';
import type { Message, MessageContentBlock, ToolCall } from '../types/index.js';
import { gatewayReplayHistory, sealGatewayCall, sealGatewayResponse } from './gateway-replay.js';
const PREFIX = 'ai-harness:anthropic-oauth:v1:';
function call(call: ToolCall, map: (value: string | undefined) => string | undefined): ToolCall {
  const { thoughtSignature, ...copy } = call, value = map(thoughtSignature); return { ...copy, ...(value === undefined ? {} : { thoughtSignature: value }) };
}
function blocks(values: MessageContentBlock[] | undefined, map: (value: string | undefined) => string | undefined): MessageContentBlock[] | undefined {
  return values?.map(block => {
    if (block.type === 'tool_call') return { type: 'tool_call', ...call(block, map) };
    if (block.type === 'reasoning') { const { thinkingSignature, ...copy } = block, value = map(block.thinkingSignature); return { ...copy, ...(value === undefined ? {} : { thinkingSignature: value }) }; }
    if (block.type === 'text') { const { textSignature, ...copy } = block, value = map(block.textSignature); return { ...copy, ...(value === undefined ? {} : { textSignature: value }) }; }
    return structuredClone(block);
  });
}
const prefix = (value: string | undefined): string | undefined => value === undefined ? undefined : PREFIX + value;
export function anthropicOAuthHistory(messages: readonly Message[], scope?: string): Message[] {
  const unprefix = (value: string | undefined) => value?.startsWith(PREFIX) ? value.slice(PREFIX.length) : undefined;
  return gatewayReplayHistory(messages.map(message => ({ ...structuredClone(message), ...(message.blocks ? { blocks: blocks(message.blocks, unprefix) } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(value => call(value, unprefix)) } : {}) })), scope);
}
export function sealAnthropicOAuthCall(value: ToolCall, scope?: string): ToolCall { return call(sealGatewayCall(value, scope), prefix); }
export function sealAnthropicOAuthResponse(value: ChatResponse, scope?: string): ChatResponse {
  const sealed = sealGatewayResponse(value, scope); return { ...sealed, ...(sealed.blocks ? { blocks: blocks(sealed.blocks, prefix) } : {}), ...(sealed.toolCalls ? { toolCalls: sealed.toolCalls.map(value => call(value, prefix)) } : {}) };
}
/** Raw API-key/OAuth consumers never forward a native grant envelope as a vendor signature. */
export function withoutAnthropicOAuthReplay(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'assistant') return message;
    const signatures = [...(message.toolCalls?.map(value => value.thoughtSignature) ?? []), ...(message.blocks?.map(value => value.type === 'reasoning' ? value.thinkingSignature : value.type === 'text' ? value.textSignature : value.type === 'tool_call' ? value.thoughtSignature : undefined) ?? [])];
    return signatures.some(value => value?.startsWith(PREFIX)) ? gatewayReplayHistory([message])[0] : message;
  });
}
