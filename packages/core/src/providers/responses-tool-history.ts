import { isDeepStrictEqual } from 'node:util';
import type { ChatOptions } from './index.js';
import type { Message } from '../types/index.js';
import type { SessionEntry } from '../sessions/session-manager.js';
import { buildProviderToolHistory, type ProviderToolHistory } from './provider-tool-history.js';
import { OPENAI_RESPONSE_MODELS } from './openai-responses-metadata.js';
import { responsesInputAnchor } from './responses-replay.js';

interface History extends ProviderToolHistory { owner: object; model: string; additive: boolean }
const models = new Set(OPENAI_RESPONSE_MODELS.filter(row => row.compat.supportsAdditionalTools).map(row => row.id));
const owners = new WeakSet<object>(), requests = new WeakMap<ChatOptions, History>();
export function registerResponsesToolHistory(owner: object): void { owners.add(owner); }
export function supportsResponsesToolHistory(owner: object, model: string): boolean { return owners.has(owner) && models.has(model); }
export function copyResponsesToolHistory(owner: object, options: ChatOptions | undefined, delegate: object): void {
  const value = options && requests.get(options);
  if (value?.owner === owner && owners.has(owner) && owners.has(delegate)) requests.set(options!, { ...value, owner: delegate });
}
export function attachResponsesToolHistory(owner: object, options: ChatOptions, provider: string, model: string, messages: readonly Message[], path: readonly SessionEntry[]): string | undefined {
  if (!supportsResponsesToolHistory(owner, model)) return undefined;
  const history = buildProviderToolHistory(provider, model, messages, path, options.tools ?? []), declared = new Set(history.initial.map(tool => tool.name));
  let additive = true;
  for (const update of history.updates) {
    if (update.removed.length) additive = false;
    for (const tool of update.added) { if (declared.has(tool.name)) additive = false; declared.add(tool.name); }
  }
  requests.set(options, { ...history, owner, model, additive });
  // All additive definitions are already counted once in current options.tools.
  // Only the extra inline framing is additional canonical model input.
  return additive && history.updates.length ? JSON.stringify(history.updates.map(update => ({ before: update.before, type: 'additional_tools', role: 'developer', tools: [] }))) : undefined;
}
/** Current-tool conversion keeps grammar/strict mappings for all declared names. */
export function projectResponsesToolHistory(owner: object, body: Record<string, unknown>, options?: ChatOptions): void {
  const history = options && requests.get(options);
  if (!history || history.owner !== owner || history.model !== body.model || !history.additive || !Array.isArray(body.input)) return;
  if (!isDeepStrictEqual(history.current, structuredClone(options?.tools ?? []))) throw new Error('Invalid Responses tool history.');
  const definitions = new Map<string, unknown>((Array.isArray(body.tools) ? body.tools : []).map(tool => [tool.name, tool]));
  if (history.initial.length) body.tools = history.initial.map(tool => definitions.get(tool.name)); else delete body.tools;
  const insertions = new Map<number, unknown[]>();
  for (const update of history.updates) {
    const anchor = update.before === undefined ? undefined : responsesInputAnchor(body, update.before);
    const index = update.before === undefined ? body.input.length : anchor === undefined ? -1 : body.input.indexOf(anchor);
    if (index < 0) throw new Error('Invalid Responses tool history.');
    const rows = insertions.get(index) ?? []; rows.push({ type: 'additional_tools', role: 'developer', tools: update.added.map(tool => definitions.get(tool.name)) }); insertions.set(index, rows);
  }
  body.input = body.input.flatMap((item: unknown, index: number) => [...(insertions.get(index) ?? []), item]).concat(insertions.get(body.input.length) ?? []);
}
