import type { AnthropicChatOptions } from './index.js';
import type { MessageContentBlock } from '../types/index.js';
const NAMES = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'KillShell', 'NotebookEdit', 'Skill', 'Task', 'TaskOutput', 'TodoWrite', 'WebFetch', 'WebSearch'];
const canonical = new Map(NAMES.map(name => [name.toLowerCase(), name]));
const wireName = (name: string): string => canonical.get(name.toLowerCase()) ?? name;
/** Captured before I/O; later caller mutation cannot change tool attribution. */
export function anthropicOAuthNames(tools: AnthropicChatOptions['tools']): (name: string) => string {
  const names = new Map<string, string>(), wire = new Set<string>();
  for (const tool of tools ?? []) { const name = wireName(tool.name); if (wire.has(name)) throw new Error('Ambiguous Anthropic OAuth tool names.'); wire.add(name); names.set(tool.name.toLowerCase(), tool.name); }
  return name => names.get(name.toLowerCase()) ?? name;
}
export function anthropicOAuthHeaders(headers: Record<string, string>, key: string, betas: readonly string[]): Record<string, string> {
  const result = new Headers(headers); result.delete('x-api-key'); result.set('authorization', `Bearer ${key}`);
  result.set('accept', 'application/json'); result.set('anthropic-dangerous-direct-browser-access', 'true'); result.set('user-agent', 'claude-cli/2.1.280'); result.set('x-app', 'cli');
  result.set('anthropic-beta', [...new Set([...(result.get('anthropic-beta')?.split(',').map(value => value.trim()).filter(Boolean) ?? []), 'claude-code-20250219', 'oauth-2025-04-20', ...betas])].join(','));
  return Object.fromEntries(result);
}
/** Only the exact native Anthropic adapter selects this policy; no token-prefix/provider-label inference. */
export function prepareAnthropicOAuthBody(body: Record<string, unknown>, options?: AnthropicChatOptions): void {
  const cache = options?.cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(options?.cacheRetention === 'long' ? { ttl: '1h' } : {}) };
  const system = typeof body.system === 'string' && body.system ? [{ type: 'text', text: body.system, ...(cache ? { cache_control: cache } : {}) }] : Array.isArray(body.system) ? body.system : [];
  body.system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", ...(cache ? { cache_control: cache } : {}) }, ...system];
  const rename = (tool: Record<string, unknown>): void => { if (typeof tool.name === 'string') tool.name = wireName(tool.name); };
  if (Array.isArray(body.tools)) for (const tool of body.tools) rename(tool);
  if (body.tool_choice && typeof body.tool_choice === 'object') rename(body.tool_choice as Record<string, unknown>);
  if (Array.isArray(body.messages)) for (const message of body.messages) if (Array.isArray(message.content)) for (const block of message.content) {
    if (block.type === 'tool_use') rename(block);
    if (block.type === 'tool_addition' && block.tool?.definition) rename(block.tool.definition);
    if (block.type === 'tool_removal' && block.tool) rename(block.tool);
  }
}
export function anthropicOAuthBlocks(blocks: MessageContentBlock[] | undefined, name: ((name: string) => string) | undefined): MessageContentBlock[] | undefined {
  return name ? blocks?.map(block => block.type === 'tool_call' ? { ...block, name: name(block.name) } : block) : blocks;
}
