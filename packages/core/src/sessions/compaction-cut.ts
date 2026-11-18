import type { MessageEntry } from './session-manager.js';
import { completeContextToolGroups } from './session-context.js';

export interface CompactionCut {
  toCompact: MessageEntry[];
  keptEntries: MessageEntry[];
  firstKeptEntryId: string;
  compactedTokens: number;
  keptTokens: number;
}

/**
 * Pure cut selection over an owned Core model projection and trusted, aligned
 * request-weight estimates. This does not estimate a provider wire, generate or
 * publish summaries, or grant source authority. Keep is a soft target; complete
 * assistant/tool units are indivisible, including the final retained unit.
 */
export function selectCompactionCut(
  entries: readonly MessageEntry[],
  tokensPerEntry: readonly number[],
  keepRecentTokens: number,
  reason: 'manual' | 'threshold' | 'overflow',
): CompactionCut | null {
  const invalid = () => { throw new Error('Compaction cut policy is invalid.'); };
  if (!Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 1
    || !['manual', 'threshold', 'overflow'].includes(reason)
    || entries.length !== tokensPerEntry.length) return invalid();
  let total = 0;
  for (let index = 0; index < tokensPerEntry.length; index++) {
    const property = Object.getOwnPropertyDescriptor(tokensPerEntry, String(index));
    if (!property || !('value' in property)) return invalid();
    const value: unknown = property.value;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
    total += value;
    if (!Number.isSafeInteger(total)) return invalid();
  }
  if (!entries.length) return null;
  // Reuse Core's sole assistant/tool completion rule; never borrow across paths.
  const model = completeContextToolGroups(entries);
  if (model.length !== entries.length || model.some((entry, index) => entry.id !== entries[index].id)
    || new Set(model.map(entry => entry.id)).size !== model.length) {
    throw new Error('Compaction context is not a complete unambiguous model projection.');
  }
  const groups: { start: number; tokens: number }[] = [];
  for (let index = 0; index < model.length; index++) {
    const start = index;
    if (model[index].role === 'assistant') {
      while (index + 1 < model.length && model[index + 1].role === 'tool') index++;
    }
    let tokens = 0;
    for (let item = start; item <= index; item++) tokens += tokensPerEntry[item];
    groups.push({ start, tokens });
  }
  let firstGroup = groups.length - 1, keptTokens = groups[firstGroup].tokens;
  while (firstGroup > 0 && keptTokens + groups[firstGroup - 1].tokens <= keepRecentTokens) {
    keptTokens += groups[--firstGroup].tokens;
  }
  // A force request on small ordinary conversations must retain its historical
  // explicit manual meaning, not silently disappear because default keep20k fits
  // everything. Whole units are indivisible; no raw last-two-message slicing.
  if (firstGroup === 0 && reason !== 'threshold' && groups.length > 2) {
    firstGroup = groups.length - 2;
    keptTokens = groups.slice(firstGroup).reduce((sum, group) => sum + group.tokens, 0);
  }
  if (firstGroup === 0) return null;
  const cut = groups[firstGroup].start;
  return { toCompact: model.slice(0, cut), keptEntries: model.slice(cut),
    firstKeptEntryId: model[cut].id, compactedTokens: total - keptTokens, keptTokens };
}
