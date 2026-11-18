import { isDeepStrictEqual } from 'node:util';
import type { ChatToolDefinition } from '../providers/index.js';
import type { SessionEntry, MessageEntry } from './session-manager.js';
import { copySessionCustomValue } from './session-custom-data.js';

/** Private historical request data, not authority to load code, credentials or tools. */
export interface SessionLoadout {
  provider: string;
  model: string | null;
  systemPrompt: string;
  tools: ChatToolDefinition[];
  thinking: string | null;
}
export interface SessionContextEdit { targetEntryId: string; replacement?: string }
export interface SessionFileOperations { read: string[]; written: string[]; edited: string[]; truncated: boolean }
export interface SessionCompactionCheckpoint {
  loadout?: SessionLoadout;
  fileOperations: SessionFileOperations;
  /** The retained suffix begins within this user span, rather than at a new user prompt. */
  splitUserEntryId?: string;
}

const fail = (): never => { throw new Error('Session context data is invalid.'); };
const bounded = (value: unknown, bytes: number): value is string => typeof value === 'string'
  && !value.includes('\0') && Buffer.byteLength(value) <= bytes;

/** Descriptor-safe admission before redactors or JSON serializers see new input. */
export function copyContextEdit(value: SessionContextEdit): SessionContextEdit {
  const copy = copySessionCustomValue(value) as SessionContextEdit;
  if (!copy || Object.keys(copy).some(key => key !== 'targetEntryId' && key !== 'replacement')
    || !bounded(copy.targetEntryId, 256) || !copy.targetEntryId
    || (copy.replacement !== undefined && !bounded(copy.replacement, 512 * 1024))) return fail();
  return copy;
}

export function copyLoadout(value: SessionLoadout): SessionLoadout {
  const copy = copySessionCustomValue(value) as SessionLoadout;
  if (!copy || Object.keys(copy).some(key => !['provider', 'model', 'systemPrompt', 'tools', 'thinking'].includes(key))
    || !bounded(copy.provider, 128) || !copy.provider || (copy.model !== null && !bounded(copy.model, 500))
    || !bounded(copy.systemPrompt, 512 * 1024) || (copy.thinking !== null && !bounded(copy.thinking, 32))
    || !Array.isArray(copy.tools) || copy.tools.length > 1024) return fail();
  const names = new Set<string>();
  for (const tool of copy.tools) {
    if (!tool || !bounded(tool.name, 256) || !tool.name || names.has(tool.name)
      || !bounded(tool.description, 64 * 1024) || !tool.parameters || typeof tool.parameters !== 'object') return fail();
    names.add(tool.name);
  }
  return copy;
}

/** Rebuild field-replacement deltas in ancestry order; compaction checkpoints are complete bases. */
export function reconstructLoadout(path: readonly SessionEntry[]): SessionLoadout | undefined {
  let state: Partial<SessionLoadout> = {};
  let found = false;
  for (const entry of path) {
    if (entry.type === 'compaction' && entry.checkpoint?.loadout) {
      state = structuredClone(entry.checkpoint.loadout); found = true;
    } else if (entry.type === 'loadout') {
      state = { ...state, ...structuredClone(entry.changes) }; found = true;
    }
  }
  return found ? copyLoadout(state as SessionLoadout) : undefined;
}

export function loadoutChanges(previous: SessionLoadout | undefined, next: SessionLoadout): Partial<SessionLoadout> {
  const changes: Partial<SessionLoadout> = {};
  for (const key of ['provider', 'model', 'systemPrompt', 'tools', 'thinking'] as const) {
    if (!previous || !isDeepStrictEqual(previous[key], next[key])) Object.assign(changes, { [key]: next[key] });
  }
  return changes;
}

/** Edits affect model payload only. Replacements cannot fabricate tool calls or change their correlation. */
export function applyContextEdits(messages: readonly MessageEntry[], path: readonly SessionEntry[]): MessageEntry[] {
  const edits = new Map(path.filter(entry => entry.type === 'context_edit').map(entry => [entry.targetEntryId, entry]));
  return messages.flatMap(message => {
    const command = message.metadata?.sourceCommandId;
    const edit = edits.get(typeof command === 'string' ? command : message.id);
    if (!edit) return [message];
    if (edit.replacement === undefined) return [];
    return [{ ...message, content: edit.replacement, blocks: [
      ...(message.blocks?.filter(block => block.type === 'tool_call') ?? []),
      { type: 'text' as const, text: edit.replacement },
    ], metadata: undefined }];
  });
}

/** Cumulative, bounded successful native file-tool provenance. Never infer effects from arbitrary shell text. */
export function collectFileOperations(path: readonly SessionEntry[]): SessionFileOperations {
  const sets = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
  let truncated = false, fileBytes = 0;
  const add = (kind: keyof typeof sets, file: string): void => {
    if (sets[kind].has(file)) return;
    if (!bounded(file, 4096) || !file || sets[kind].size >= 256 || fileBytes + Buffer.byteLength(file) > 64 * 1024) { truncated = true; return; }
    fileBytes += Buffer.byteLength(file);
    sets[kind].add(file);
  };
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const entry of path) {
    if (entry.type === 'compaction' && entry.checkpoint) {
      for (const kind of ['read', 'written', 'edited'] as const) for (const file of entry.checkpoint.fileOperations[kind]) add(kind, file);
      truncated ||= entry.checkpoint.fileOperations.truncated;
    }
    if (entry.type !== 'message') continue;
    if (entry.role === 'assistant') {
      for (const call of entry.toolCalls ?? entry.blocks?.flatMap(block => block.type === 'tool_call' ? [block] : []) ?? []) calls.set(call.id, call);
    } else if (entry.role === 'tool' && entry.toolCallId) {
      const call = calls.get(entry.toolCallId);
      calls.delete(entry.toolCallId);
      if (entry.isError || !call || !['read', 'write', 'edit'].includes(call.name) || !call.input || typeof call.input !== 'object') continue;
      const file = (call.input as { path?: unknown }).path;
      if (typeof file === 'string') add(call.name === 'write' ? 'written' : call.name === 'edit' ? 'edited' : 'read', file);
    }
  }
  return { read: [...sets.read], written: [...sets.written], edited: [...sets.edited], truncated };
}

export function validContextStateEntry(entry: Record<string, unknown>): boolean {
  try {
    if (entry.type === 'context_edit') {
      copyContextEdit({ targetEntryId: entry.targetEntryId as string,
        ...(entry.replacement !== undefined ? { replacement: entry.replacement as string } : {}) });
    } else if (entry.type === 'loadout') {
      const changes = copySessionCustomValue(entry.changes) as Partial<SessionLoadout>;
      if (!changes || !Object.keys(changes).length) return false;
      copyLoadout({ provider: 'unknown', model: null, systemPrompt: '', tools: [], thinking: null, ...changes });
    }
    if (entry.checkpoint !== undefined) {
      const checkpoint = copySessionCustomValue(entry.checkpoint, 2 * 1024 * 1024) as SessionCompactionCheckpoint;
      if (checkpoint.loadout) copyLoadout(checkpoint.loadout);
      if (checkpoint.splitUserEntryId !== undefined && (!bounded(checkpoint.splitUserEntryId, 256) || !checkpoint.splitUserEntryId)) return false;
      const files = checkpoint.fileOperations;
      if (!files || typeof files.truncated !== 'boolean') return false;
      for (const key of ['read', 'written', 'edited'] as const) {
        if (!Array.isArray(files[key]) || files[key].length > 256 || files[key].some(file => !bounded(file, 4096))) return false;
      }
    }
    return true;
  } catch { return false; }
}
