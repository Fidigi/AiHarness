import type { McpConfigScope, McpServerInventoryEntry } from '@ai-harness/core';

export interface McpSelection {
  scope: McpConfigScope;
  name: string;
}

interface SavedSelection extends McpSelection {
  cwd: string | null;
}

const KEY = 'ai-harness-mcp-selection-v1';
const MAX_LENGTH = 65_536;
const MAX_ENTRIES = 24;

function validSelection(value: unknown): value is McpSelection {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<McpSelection>;
  return (entry.scope === 'global' || entry.scope === 'project')
    && typeof entry.name === 'string' && entry.name.length > 0 && entry.name.length <= 4_096;
}

function validCwd(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 8_192);
}

function readSelections(): SavedSelection[] {
  try {
    const text = window.localStorage.getItem(KEY);
    if (!text || text.length > MAX_LENGTH) return [];
    const data = JSON.parse(text) as { version?: unknown; entries?: unknown } | null;
    if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES) return [];
    return data.entries.filter((entry: unknown): entry is SavedSelection =>
      validSelection(entry) && validCwd((entry as SavedSelection).cwd),
    ).map(({ cwd, scope, name }) => ({ cwd, scope, name }));
  } catch { return []; }
}

/** Presentation intent only. Never persists inventory, revisions, reports or OAuth state. */
export function readMcpSelection(cwd?: string): McpSelection | undefined {
  const entry = readSelections().filter(item => item.cwd === (cwd ?? null)).at(-1);
  return entry ? { scope: entry.scope, name: entry.name } : undefined;
}

export function writeMcpSelection(cwd: string | undefined, selection: McpSelection): void {
  if (!validCwd(cwd ?? null) || !validSelection(selection)) return;
  const entries = readSelections().filter(entry => entry.cwd !== (cwd ?? null));
  entries.push({ cwd: cwd ?? null, scope: selection.scope, name: selection.name });
  while (entries.length > MAX_ENTRIES) entries.shift();
  let text = JSON.stringify({ version: 1, entries });
  while (text.length > MAX_LENGTH) {
    entries.shift();
    text = JSON.stringify({ version: 1, entries });
  }
  try { window.localStorage.setItem(KEY, text); } catch { /* Optional browser storage. */ }
}

/** An absent/locked/removed saved row never supplies a descriptor or mutation authority. */
export function selectedMcpServer(
  servers: readonly McpServerInventoryEntry[],
  selection: McpSelection | undefined,
  currentConfigKey?: string,
): McpServerInventoryEntry | undefined {
  if (!selection) return servers[0];
  const matches = servers.filter(server => server.scope === selection.scope && server.name === selection.name);
  if (matches.length === 1) return matches[0];
  // An explicit current-row hint can disambiguate escaped diagnostic labels.
  // It is never persisted and only selects a descriptor from this fresh inventory.
  const pinned = currentConfigKey ? matches.filter(server => server.configKey === currentConfigKey) : [];
  return pinned.length === 1 ? pinned[0] : undefined;
}
