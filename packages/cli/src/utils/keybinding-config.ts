import type { KeyBinding } from '@ai-harness/core';
import { RESERVED_TERMINAL_KEYS } from './terminal-actions.js';

export const MAX_KEYBINDING_CONFIG_BYTES = 65_536;
export const MAX_KEYBINDING_CONFIG_ENTRIES = 512;
export type KeyBindingConfigProblem =
  | 'size' | 'json' | 'shape' | 'count' | 'entry' | 'properties'
  | 'id' | 'keys' | 'description' | 'action' | 'prevent-default'
  | 'duplicate-id' | 'duplicate-keys' | 'reserved';

/** Value-free diagnostics: neither parser excerpts nor private file contents escape. */
export class KeyBindingConfigError extends Error {
  constructor(readonly reason: KeyBindingConfigProblem) {
    super('Invalid keybinding configuration.');
    this.name = 'KeyBindingConfigError';
  }
}
const hidden = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const fields = new Set(['id', 'keys', 'description', 'action', 'preventDefault']);
const modifiers = new Set(['ctrl', 'alt', 'shift', 'cmd', 'meta']);
const aliases: Readonly<Record<string, string>> = { control: 'ctrl', option: 'alt', return: 'enter', esc: 'escape' };

/** Legacy programmatic handlers retain arbitrary symbolic names; file grammar is stricter. */
export function normalizedKeyParts(keys: readonly string[]): string[] {
  return keys.flatMap(key => key.split('+').map(part => {
    const lower = part.trim().toLowerCase();
    return Object.hasOwn(aliases, lower) ? aliases[lower]! : lower;
  })).sort();
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= max && !hidden.test(value);
}
function refuse(reason: KeyBindingConfigProblem): never { throw new KeyBindingConfigError(reason); }

/** Pure data-only legacy array grammar. Unknown action IDs are retained, never executed. */
export function parseKeyBindingConfig(content: string): KeyBinding[] {
  if (typeof content !== 'string') refuse('json');
  if (Buffer.byteLength(content, 'utf8') > MAX_KEYBINDING_CONFIG_BYTES) refuse('size');
  let value: unknown;
  try { value = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content); }
  catch { refuse('json'); }
  if (!Array.isArray(value)) refuse('shape');
  if (value.length > MAX_KEYBINDING_CONFIG_ENTRIES) refuse('count');
  const ids = new Set<string>(), chords = new Set<string>();
  return value.map((item: unknown): KeyBinding => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) refuse('entry');
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some(key => !fields.has(key))) refuse('properties');
    if (!Object.hasOwn(entry, 'id') || !text(entry.id, 256)) refuse('id');
    if (ids.has(entry.id)) refuse('duplicate-id');
    if (!Object.hasOwn(entry, 'keys') || !Array.isArray(entry.keys) || !entry.keys.length || entry.keys.length > 5
      || !entry.keys.every(key => typeof key === 'string' && key.length <= 64 && !hidden.test(key))) refuse('keys');
    const keys = normalizedKeyParts(entry.keys as string[]);
    if (!keys.length || keys.length > 5 || new Set(keys).size !== keys.length
      || keys.some(key => !/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(key))
      || keys.filter(key => !modifiers.has(key)).length !== 1) refuse('keys');
    const chord = keys.join('+');
    if (chords.has(chord)) refuse('duplicate-keys');
    if (Object.hasOwn(entry, 'description') && (typeof entry.description !== 'string'
      || Buffer.byteLength(entry.description, 'utf8') > 512 || hidden.test(entry.description))) refuse('description');
    if (Object.hasOwn(entry, 'action') && !text(entry.action, 256)) refuse('action');
    if (Object.hasOwn(entry, 'preventDefault') && typeof entry.preventDefault !== 'boolean') refuse('prevent-default');
    const reserved = RESERVED_TERMINAL_KEYS.get(chord);
    const legacyDefault = !Object.hasOwn(entry, 'action') && entry.id === `binding-${chord}`;
    if (reserved && !legacyDefault && (Object.hasOwn(entry, 'action') ? entry.action : entry.id) !== reserved) refuse('reserved');
    ids.add(entry.id); chords.add(chord);
    return {
      id: entry.id, keys,
      ...(Object.hasOwn(entry, 'description') ? { description: entry.description as string } : {}),
      ...(Object.hasOwn(entry, 'action') ? { action: entry.action as string } : {}),
      ...(Object.hasOwn(entry, 'preventDefault') ? { preventDefault: entry.preventDefault as boolean } : {}),
    };
  });
}
