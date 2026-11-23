import { isDeepStrictEqual } from 'node:util';
import { copyLoadout, type SessionLoadout } from '../sessions/session-context-state.js';
import type { SessionEntry } from '../sessions/session-manager.js';
import type { Message } from '../types/index.js';
import type { ChatToolDefinition } from './index.js';

export interface ToolHistoryUpdate { before?: string; removed: string[]; added: ChatToolDefinition[] }
export interface ProviderToolHistory { current: ChatToolDefinition[]; initial: ChatToolDefinition[]; updates: ToolHistoryUpdate[] }
/** Owned active ancestry only; this data never grants tool execution or provider policy. */
export function buildProviderToolHistory(provider: string, model: string, messages: readonly Message[], path: readonly SessionEntry[], currentTools: readonly ChatToolDefinition[]): ProviderToolHistory {
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
  const current = structuredClone([...currentTools]);
  if (!frames.length) frames.push({ tools: current });
  else if (!isDeepStrictEqual(frames.at(-1)!.tools, current)) {
    if (frames.at(-1)!.before === undefined) frames[frames.length - 1] = { tools: current };
    else frames.push({ tools: current });
  }
  const initial = frames[0].tools, updates: ToolHistoryUpdate[] = []; let previous = initial;
  for (const frame of frames.slice(1)) {
    const byName = new Map(frame.tools.map(tool => [tool.name, tool]));
    const removed = previous.filter(tool => !byName.has(tool.name)).map(tool => tool.name);
    const added = frame.tools.filter(tool => !previous.some(old => old.name === tool.name && isDeepStrictEqual(old, tool)));
    if (removed.length || added.length) updates.push({ before: frame.before, removed, added });
    previous = frame.tools;
  }
  return { current, initial, updates };
}
