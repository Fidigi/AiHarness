import { isDeepStrictEqual } from 'node:util';
import { copyLoadout } from '../sessions/session-context-state.js';
import type { SessionLoadout } from '../sessions/session-context-state.js';
import type { SessionEntry } from '../sessions/session-manager.js';
import type { Message } from '../types/index.js';
import type { AnthropicChatOptions, ChatOptions, ChatToolDefinition } from './index.js';
import { anthropicInlineTools, applyAnthropicProfileToolDeclarations } from './anthropic-profiles.js';

interface Update { before?: string; removed: string[]; added: ChatToolDefinition[] }
interface History { owner: object; model: string; current: ChatToolDefinition[]; initial: ChatToolDefinition[]; native: boolean; updates: Update[] }
const owners = new WeakSet<object>(), requests = new WeakMap<ChatOptions, History>();
/** First-party constructors only. Historical definitions are data, never current execution authority. */
export function registerAnthropicToolHistory(owner: object): void { owners.add(owner); }
export function supportsAnthropicToolHistory(owner: object, model: string): boolean { return owners.has(owner) && anthropicInlineTools(model, 1); }
export function readAnthropicToolHistory(owner: object, options: ChatOptions | undefined, model: string): History | undefined {
  const value = options && requests.get(options);
  if (!value || value.owner !== owner || value.model !== model) return undefined;
  if (!isDeepStrictEqual(value.current, structuredClone(options?.tools ?? []))) throw new Error('Invalid Anthropic tool history.');
  return value;
}
export function copyAnthropicToolHistory(owner: object, options: ChatOptions | undefined, delegate: object, owned: ChatOptions): void {
  const value = options && requests.get(options);
  if (value?.owner === owner && owners.has(owner) && owners.has(delegate) && value.model === owned.model) requests.set(owned, { ...value, owner: delegate });
}
/** Active ancestry is supplied by the existing manager, after hooks/current loadout publication. */
export function attachAnthropicToolHistory(owner: object, options: ChatOptions, provider: string, model: string, messages: readonly Message[], path: readonly SessionEntry[]): string | undefined {
  if (!supportsAnthropicToolHistory(owner, model)) return undefined;
  const visible = new Set(messages.filter(message => message.role === 'assistant' && !message.metadata?.outputError
    && (message.content.trim() || message.toolCalls?.length || message.blocks?.length)).map(message => message.id));
  const compaction = path.map(entry => entry.type).lastIndexOf('compaction');
  let state: Partial<SessionLoadout> = {}, start = 0;
  const frames: Array<{ before?: string; tools: ChatToolDefinition[] }> = [];
  if (compaction >= 0) {
    const entry = path[compaction]; start = compaction + 1;
    if (entry.type === 'compaction' && entry.checkpoint?.loadout) state = entry.checkpoint.loadout;
    if (state.provider === provider && state.model === model) frames.push({ before: messages.find(message => visible.has(message.id))?.id, tools: structuredClone(copyLoadout(state as SessionLoadout).tools) });
  }
  const next = new Map<number, string>(); let following: string | undefined;
  for (let index = path.length - 1; index >= start; index--) {
    if (following) next.set(index, following);
    const entry = path[index]; if (entry.type === 'message' && visible.has(entry.id)) following = entry.id;
  }
  for (let index = start; index < path.length; index++) {
    const entry = path[index]; if (entry.type !== 'loadout') continue;
    state = { ...state, ...entry.changes };
    if (state.provider !== provider || state.model !== model) { frames.length = 0; continue; }
    const tools = structuredClone(copyLoadout(state as SessionLoadout).tools);
    if (!frames.length || !isDeepStrictEqual(frames.at(-1)!.tools, tools)) {
      const frame = { before: next.get(index), tools };
      // No visible assistant observed intervening attempts: only their final loadout applies.
      if (frames.length && frames.at(-1)!.before === frame.before) frames[frames.length - 1] = frame;
      else frames.push(frame);
    }
  }
  const current = structuredClone(options.tools ?? []);
  if (!frames.length) frames.push({ tools: current });
  else if (!isDeepStrictEqual(frames.at(-1)!.tools, current)) {
    if (frames.at(-1)!.before === undefined) frames[frames.length - 1] = { tools: current };
    else frames.push({ tools: current });
  }
  const initial = frames[0].tools, updates: Update[] = []; let previous = initial;
  for (const frame of frames.slice(1)) {
    const byName = new Map(frame.tools.map(tool => [tool.name, tool]));
    const removed = previous.filter(tool => !byName.has(tool.name)).map(tool => tool.name);
    const added = frame.tools.filter(tool => !previous.some(old => old.name === tool.name && isDeepStrictEqual(old, tool)));
    if (removed.length || added.length) updates.push({ before: frame.before, removed, added });
    previous = frame.tools;
  }
  const value: History = { owner, model, current, initial, native: initial.length > 0, updates };
  requests.set(options, value);
  // The ordinary estimate already counts current tools. Count the complete historical
  // wire addition conservatively as model text, never as ignored private metadata.
  return value.native && updates.length ? JSON.stringify({ initial, updates }) : undefined;
}
/** Called before cache/managed controls; updates never split a tool use/result group. */
export function projectAnthropicToolHistory(body: Record<string, unknown>, messages: readonly Message[], history: History | undefined): void {
  if (!history?.native || !Array.isArray(body.messages)) return;
  body.tools = history.initial.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  const source = messages.filter(message => message.role !== 'system'), indices = new Map<string, number>(); let cursor = 0;
  for (const [index, row] of body.messages.entries()) {
    if (row.role === 'system') continue;
    const message = source[cursor++]; if (message?.role === 'assistant') indices.set(message.id, index);
  }
  const insertions = new Map<number, unknown[]>();
  for (const update of history.updates) {
    const index = update.before === undefined ? body.messages.length : indices.get(update.before);
    if (index === undefined) throw new Error('Invalid Anthropic tool history.');
    const scratch: Record<string, unknown> = { model: body.model, tools: update.added.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) };
    applyAnthropicProfileToolDeclarations(scratch, true, { tools: update.added } as AnthropicChatOptions, false);
    const content = [...update.removed.map(name => ({ type: 'tool_removal', tool: { type: 'tool_reference', name } })),
      ...(scratch.tools as Array<Record<string, unknown>>).map(definition => ({ type: 'tool_addition', tool: { type: 'tool_definition', definition } }))];
    const rows = insertions.get(index) ?? []; rows.push({ role: 'system', content }); insertions.set(index, rows);
  }
  body.messages = body.messages.flatMap((row: unknown, index: number) => [...(insertions.get(index) ?? []), row]).concat(insertions.get(body.messages.length) ?? []);
}
