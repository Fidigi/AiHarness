import type { MessageEntry, SessionEntry } from './session-manager.js';
import type { MessageContentBlock, Session, ToolCall } from '../types/index.js';

export function sessionEntryParent(entry: SessionEntry): string | undefined {
  return entry.type === 'message' ? entry.parentMessageId
    : 'parentEntryId' in entry ? entry.parentEntryId : undefined;
}

/** Remember the original unlinked prefix before the first branch changes its head. */
export function legacyRootBoundary(entries: readonly SessionEntry[]): string | undefined {
  let boundary: string | undefined;
  for (const entry of entries) {
    if (entry.type === 'metadata') continue;
    if (sessionEntryParent(entry)) break;
    boundary = entry.id;
  }
  return boundary;
}

/**
 * Legacy chronological roots become an append-order ancestry prefix only for
 * navigation. A single bounded boundary ID prevents later, intentional new roots
 * from being attached to an abandoned legacy branch. Existing links always win.
 */
export function legacyContextEntries(entries: readonly SessionEntry[], boundary?: string): SessionEntry[] {
  if (!boundary) return [...entries];
  const end = entries.findIndex(entry => entry.type !== 'metadata' && entry.id === boundary);
  if (end < 0) return [...entries];
  let previous: string | undefined;
  return entries.map((entry, index) => {
    if (entry.type === 'metadata' || index > end) return entry;
    const actualParent = sessionEntryParent(entry);
    if (actualParent) {
      // Keep a partially persisted legacy chain, but never let a clock-reordered
      // descendant become the parent of its own not-yet-seen root.
      if (actualParent === previous) previous = entry.id;
      return entry;
    }
    const parent = previous;
    previous = entry.id;
    if (!parent) return entry;
    return entry.type === 'message' ? { ...entry, parentMessageId: parent } : { ...entry, parentEntryId: parent };
  });
}

/** Last append-order projection wins, as in session accounting. Never follow summary source links. */
export function sessionEntryPath(entries: readonly SessionEntry[], leafId: string | undefined): {
  entries: SessionEntry[]; complete: boolean;
} {
  const byId = new Map(entries.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const visited = new Set<string>();
  let cursor = leafId;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry || visited.has(cursor)) return { entries: path.reverse(), complete: false };
    visited.add(cursor);
    path.push(entry);
    cursor = sessionEntryParent(entry);
  }
  return { entries: path.reverse(), complete: true };
}

/** A model request may contain only complete, adjacent assistant/tool groups on this path. */
export function completeContextToolGroups(entries: readonly MessageEntry[]): MessageEntry[] {
  const result: MessageEntry[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.role === 'tool') continue; // Orphans cannot borrow a call from another branch.
    if (entry.role !== 'assistant') { result.push(entry); continue; }
    const declared = entry.toolCalls ?? entry.blocks?.flatMap(block =>
      block?.type === 'tool_call' ? [{ id: block.id, name: block.name, input: block.input }] : []) ?? [];
    const calls = new Map<string, ToolCall>();
    for (const call of declared) {
      if (call && typeof call.id === 'string' && typeof call.name === 'string' && !calls.has(call.id)) {
        calls.set(call.id, call);
      }
    }
    const tools: MessageEntry[] = [];
    const answered = new Set<string>();
    let next = index + 1;
    for (; next < entries.length && entries[next].role === 'tool'; next++) {
      const tool = entries[next];
      if (!tool.toolCallId || !calls.has(tool.toolCallId) || answered.has(tool.toolCallId)) continue;
      answered.add(tool.toolCallId);
      tools.push(tool);
    }
    const retained = [...calls.values()].filter(call => answered.has(call.id));
    const blocks = entry.blocks?.filter(block => block?.type !== 'tool_call' || answered.has(block.id));
    result.push({ ...entry,
      ...(entry.toolCalls !== undefined || calls.size ? { toolCalls: retained } : {}),
      ...(blocks ? { blocks } : {}),
    }, ...tools);
    index = next - 1;
  }
  return result;
}

export interface LegacyCompactionPrefix { anchorEntryId: string; summary: string; timestamp: number }

const legacyPrefixKey = 'aiHarnessLegacyCompactionPrefix';
const legacyPrefixError = (): never => { throw new Error('Legacy compaction context is invalid.'); };

/** Own, bounded primitives only; never execute a newly supplied metadata getter. */
export function readLegacyCompactionPrefix(metadata: Session['metadata']): LegacyCompactionPrefix | undefined {
  const property = Object.getOwnPropertyDescriptor(metadata ?? {}, legacyPrefixKey);
  if (!property) return undefined;
  if (!('value' in property) || !property.value || typeof property.value !== 'object' || Array.isArray(property.value)) {
    return legacyPrefixError();
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(property.value)) {
    if (key !== 'anchorEntryId' && key !== 'summary' && key !== 'timestamp') return legacyPrefixError();
    const item = Object.getOwnPropertyDescriptor(property.value, key);
    if (!item || !('value' in item)) return legacyPrefixError();
    values[key] = item.value;
  }
  if (typeof values.anchorEntryId !== 'string' || !values.anchorEntryId || values.anchorEntryId.includes('\0')
    || Buffer.byteLength(values.anchorEntryId) > 256 || typeof values.summary !== 'string' || !values.summary.trim()
    || Buffer.byteLength(values.summary) > 1024 * 1024 || typeof values.timestamp !== 'number'
    || !Number.isFinite(values.timestamp) || values.timestamp < 0 || values.timestamp > 8.64e15) return legacyPrefixError();
  return { anchorEntryId: values.anchorEntryId, summary: values.summary, timestamp: values.timestamp };
}

function legacyActivePath(session: Pick<Session, 'metadata' | 'activeLeafId'>, entries: readonly SessionEntry[]) {
  const boundary = typeof session.metadata?.legacyRootBoundaryId === 'string' ? session.metadata.legacyRootBoundaryId
    : session.metadata?.hasBranchedHistory !== true ? legacyRootBoundary(entries) : undefined;
  return sessionEntryPath(legacyContextEntries(entries, boundary), session.activeLeafId);
}

/** Capture legacy metadata before a navigation/compaction can replace it. */
export function captureLegacyCompactionPrefix(session: Pick<Session, 'metadata' | 'activeLeafId' | 'updatedAt'>,
  entries: readonly SessionEntry[]): LegacyCompactionPrefix | undefined {
  const retained = readLegacyCompactionPrefix(session.metadata);
  if (retained) return retained;
  const summary = Object.getOwnPropertyDescriptor(session.metadata ?? {}, 'compactionSummary');
  if (!summary || !('value' in summary) || typeof summary.value !== 'string' || !summary.value.trim()
    || entries.some(entry => entry.type === 'compaction')) return undefined;
  const path = legacyActivePath(session, entries);
  const anchorEntryId = path.complete ? path.entries[0]?.id : undefined;
  if (!anchorEntryId) return undefined;
  const compacted = Object.getOwnPropertyDescriptor(session.metadata ?? {}, 'lastCompacted');
  const time = compacted && 'value' in compacted && typeof compacted.value === 'string' ? Date.parse(compacted.value) : NaN;
  return readLegacyCompactionPrefix({ [legacyPrefixKey]: { anchorEntryId, summary: summary.value,
    timestamp: Number.isFinite(time) && time >= 0 ? time : session.updatedAt.getTime() } });
}

export function legacyCompactionPrefixApplies(prefix: LegacyCompactionPrefix,
  session: Pick<Session, 'metadata' | 'activeLeafId'>, entries: readonly SessionEntry[]): boolean {
  const path = legacyActivePath(session, entries);
  return path.complete && path.entries.some(entry => entry.id === prefix.anchorEntryId);
}

/** Convert only model-visible data; custom state/details and summary accounting stay private. */
export function contextEntryMessages(entry: SessionEntry): MessageEntry[] {
  if (entry.type === 'message') return [entry];
  const base = { id: entry.id, timestamp: entry.timestamp, version: entry.version };
  if (entry.type === 'branch_summary') return [{ ...base, type: 'message', role: 'user',
    content: `[Branch Summary: ${entry.branchName}]\n${entry.summary}` }];
  if (entry.type === 'custom_message') return [{ ...base, type: 'message', role: 'user',
    content: `[Custom Message: ${entry.customType}]\n${entry.content}` }];
  if (entry.type !== 'command' || entry.excludedFromContext
    || entry.status === 'queued' || entry.status === 'running') return [];
  const block: MessageContentBlock = {
    type: 'command', command: entry.command, cwd: entry.cwd, output: entry.output,
    status: entry.status, exitCode: entry.exitCode, durationMs: entry.durationMs,
    excludedFromContext: false, truncated: entry.truncated,
  };
  return [{ ...base, id: `context-${entry.id}`, type: 'message', role: 'user',
    parentMessageId: entry.parentEntryId,
    content: `[Shell command]\n$ ${entry.command}\n${entry.output ?? ''}\n[exit ${entry.exitCode ?? 'unknown'}]`,
    blocks: [block], metadata: { sourceCommandId: entry.id } }];
}

/** The newest compaction replaces only its prefix, not retained entries or later summaries. */
export function projectContextPath(path: readonly SessionEntry[]): MessageEntry[] {
  const compactionIndex = path.map(entry => entry.type).lastIndexOf('compaction');
  if (compactionIndex < 0) return completeContextToolGroups(path.flatMap(contextEntryMessages));
  const compaction = path[compactionIndex];
  if (compaction.type !== 'compaction') return [];
  const firstKept = path.findIndex(entry => entry.id === compaction.firstKeptEntryId
    || `context-${entry.id}` === compaction.firstKeptEntryId);
  // A missing retained boundary is not permission to revive the compacted prefix.
  const kept = firstKept >= 0 && firstKept < compactionIndex ? path.slice(firstKept, compactionIndex) : [];
  return completeContextToolGroups([
    { id: compaction.id, type: 'message', role: 'system', timestamp: compaction.timestamp,
      content: `[Context Summary] ${compaction.summary}` },
    ...kept.flatMap(contextEntryMessages),
    ...path.slice(compactionIndex + 1).flatMap(contextEntryMessages),
  ]);
}

export function projectSessionContext(entries: readonly SessionEntry[], leafId: string | undefined,
  strict: boolean, reset: boolean, legacyBoundary?: string): MessageEntry[] {
  if (reset && !leafId) return [];
  const graph = legacyContextEntries(entries, legacyBoundary ?? (!strict ? legacyRootBoundary(entries) : undefined));
  const unique = [...new Map(graph.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, entry])).values()];
  const path = sessionEntryPath(unique, leafId);
  if (strict) return path.complete ? projectContextPath(path.entries) : [];
  // Legacy unlinked roots are chronological history, not abandoned branches. Real
  // navigation always sets hasBranchedHistory and therefore uses the strict path.
  const linkedEntries = unique.some(entry => sessionEntryParent(entry) !== undefined);
  if (!linkedEntries || !leafId) {
    return projectContextPath(unique.sort((left, right) => left.timestamp - right.timestamp));
  }
  return path.complete ? projectContextPath(path.entries) : [];
}
