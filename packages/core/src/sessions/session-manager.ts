// ============================================================
// Session Manager with JSONL Persistence & Compaction
// Features: Event system for lifecycle hooks and extensions
// ============================================================

import {
  SESSION_SCHEMA_VERSION,
  type Message,
  type Session,
  type ShellCommandRecord,
} from '../types/index.js';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { EventHandler, EventMap } from '../utils/event-emitter.js';
import { EventEmitter } from '../utils/event-emitter.js';
import { readStableDirectoryEntries } from '../security/stable-directory.js';
import { releaseStableLockPath } from '../security/stable-lock.js';
import { redactProviderConfig as sanitizeProviderConfig } from './serialization.js';
import {
  captureLegacyCompactionPrefix, completeContextToolGroups, contextBoundaryMessageIds, legacyCompactionPrefixApplies,
  legacyContextEntries, legacyRootBoundary, projectContextPath, projectSessionContext, readLegacyCompactionPrefix,
  sessionContextPath, sessionEntryParent, sessionEntryPath,
} from './session-context.js';
import {
  collectAbandonedEntries, copyBranchNavigationOptions, prepareBranchSummary,
} from './branch-summarization.js';
import type { BranchNavigationOptions, BranchNavigationResult, BranchSummaryEvent, BranchSummaryHook, BranchSummaryOutput } from './branch-summarization.js';
import { copyBranchSummaryAccounting, copyBranchSummaryEvent, copyBranchSummaryOutput } from './session-branch-summary.js';
import { copySessionCustomValue } from './session-custom-data.js';
import { collectFileOperations, copyContextEdit, copyLoadout, loadoutChanges, reconstructLoadout, validContextStateEntry } from './session-context-state.js';
import type { SessionContextEdit, SessionLoadout, SessionCompactionCheckpoint } from './session-context-state.js';
import { selectCompactionCut } from './compaction-cut.js';
import { assertCompactionTranscript, copyAutomaticCompactionResult, readCompactionSummary } from './compaction-generation.js';
import {
  captureSessionBranchSignal, copySessionBranchOptions, SessionBranchAdmissions, SessionBranchCancelledError,
} from './session-branch-admission.js';
import type { SessionBranchHook, SessionBranchOptions, SessionBranchTicket } from './session-branch-admission.js';

// ===================================================================
// JSONL Entry types for session persistence
// ===================================================================

/** Base entry stored in the JSONL file */
export interface SessionEntryBase {
  id: string;
  type: 'message' | 'command' | 'compaction' | 'branch_summary' | 'custom' | 'custom_message' | 'context_edit' | 'loadout' | 'metadata';
  timestamp: number; // Unix timestamp (ms)
  /** Missing on legacy entries. */
  version?: typeof SESSION_SCHEMA_VERSION;
}

/** Regular message entry */
export interface MessageEntry extends SessionEntryBase {
  type: 'message';
  role: Message['role'];
  content: string;
  blocks?: Message['blocks'];
  toolCalls?: Message['toolCalls'];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
  provider?: string;
  model?: string;
  usage?: Message['usage'];
  durationMs?: number;
  parentMessageId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/** Shell command entry, kept separate so exclusion from model context is explicit. */
export interface CommandEntry extends SessionEntryBase {
  type: 'command';
  parentEntryId?: string;
  command: string;
  cwd: string;
  status: ShellCommandRecord['status'];
  output?: string;
  exitCode?: number;
  durationMs?: number;
  excludedFromContext?: boolean;
  truncated?: boolean;
  downloadPath?: string;
}

/** Append-only, branch-relative model projection; never a transcript or billing mutation. */
export interface ContextEditEntry extends SessionEntryBase, SessionContextEdit {
  type: 'context_edit';
  parentEntryId?: string;
}

/** Private field-replacement deltas of the final effective request loadout. */
export interface LoadoutEntry extends SessionEntryBase {
  type: 'loadout';
  parentEntryId?: string;
  changes: Partial<SessionLoadout>;
}

/** Compaction summary entry */
export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction';
  parentEntryId?: string;
  summary: string;
  firstKeptEntryId: string; // ID of the first model-visible entry kept after compaction
  /** Private historical state, never copied into session metadata or browser DTOs. */
  checkpoint?: SessionCompactionCheckpoint;
  tokenEstimate?: number;
  instruction?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  provider?: string;
  model?: string;
  usage?: Message['usage'];
}

/** Host-supplied summary-call provenance; absence remains unpriced. */
export interface BranchSummaryAccounting {
  provider?: string;
  model?: string;
  usage?: Message['usage'];
}

/** Branch summary entry (when navigating tree) */
export interface BranchSummaryEntry extends SessionEntryBase, BranchSummaryAccounting {
  type: 'branch_summary';
  parentEntryId?: string;
  /** Abandoned source leaf; provenance only, never a context parent. */
  fromEntryId?: string;
  branchName: string;
  summary: string;
}

/** Privileged extension state. Neither this data nor custom-message details enter model context. */
export interface CustomSessionEntry extends SessionEntryBase {
  type: 'custom';
  parentEntryId?: string;
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: 'custom_message';
  parentEntryId?: string;
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

export interface SessionMetadataEntry extends SessionEntryBase {
  type: 'metadata';
  schemaVersion?: typeof SESSION_SCHEMA_VERSION;
  title?: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  branchId?: string;
  activeLeafId?: string;
  parentAgentId?: string;
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
  gitBranch?: string;
  model?: string;
  thinking?: Session['thinking'];
  toolPreset?: Session['toolPreset'];
  autoCompaction?: boolean;
  usage?: Session['usage'];
  providerConfig?: Session['providerConfig'];
  metadata?: Record<string, unknown>;
}

export type SessionEntry = MessageEntry | CommandEntry | CompactionEntry | BranchSummaryEntry
  | CustomSessionEntry | CustomMessageEntry | ContextEditEntry | LoadoutEntry | SessionMetadataEntry;
type RestorableSessionEntry = BranchSummaryEntry | CompactionEntry | CustomSessionEntry | CustomMessageEntry | ContextEditEntry | LoadoutEntry;

// Associate an exact, admitted load/write with its owned journal without reopening
// a path after commit, changing public store return types or persisting a cache.
const committedSessionEntries = new WeakMap<Session, SessionEntry[]>();
// A borrowed structural store can have no filesystem path and still own a full
// persistent journal. Only the concrete built-in disabled store is memory-only.
const sessionStoreKinds = new WeakMap<JsonlSessionStore, 'native' | 'memory'>();

function parseSessionEntries(content: string): SessionEntry[] {
  return content.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try {
      const entry: unknown = JSON.parse(line);
      return isSessionEntry(entry) ? [entry] : [];
    } catch { return []; }
  });
}

function isPersistedUsage(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd',
  ].every(field => {
    const candidate = (value as Record<string, unknown>)[field];
    return candidate === undefined || (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0);
  });
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id || typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) {
    return false;
  }
  if (entry.version !== undefined && entry.version !== SESSION_SCHEMA_VERSION) return false;

  switch (entry.type) {
    case 'message':
      return ['user', 'assistant', 'system', 'tool'].includes(String(entry.role))
        && typeof entry.content === 'string'
        && (entry.parentMessageId === undefined || typeof entry.parentMessageId === 'string')
        && (entry.provider === undefined || typeof entry.provider === 'string')
        && (entry.model === undefined || typeof entry.model === 'string')
        && (entry.usage === undefined || isPersistedUsage(entry.usage))
        && (entry.blocks === undefined || Array.isArray(entry.blocks));
    case 'command':
      return (entry.parentEntryId === undefined || typeof entry.parentEntryId === 'string')
        && typeof entry.command === 'string'
        && typeof entry.cwd === 'string'
        && ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(entry.status));
    case 'compaction':
      return (entry.parentEntryId === undefined || typeof entry.parentEntryId === 'string')
        && (entry.provider === undefined || typeof entry.provider === 'string')
        && (entry.model === undefined || typeof entry.model === 'string')
        && (entry.usage === undefined || isPersistedUsage(entry.usage))
        && typeof entry.summary === 'string' && typeof entry.firstKeptEntryId === 'string'
        && validContextStateEntry(entry);
    case 'context_edit':
    case 'loadout':
      return (entry.parentEntryId === undefined || typeof entry.parentEntryId === 'string') && validContextStateEntry(entry);
    case 'custom':
    case 'custom_message':
      return (entry.parentEntryId === undefined || typeof entry.parentEntryId === 'string')
        && typeof entry.customType === 'string' && isBoundedSessionString(entry.customType, 256)
        && Boolean(entry.customType)
        && (entry.type === 'custom' || (typeof entry.content === 'string' && typeof entry.display === 'boolean'));
    case 'branch_summary':
      return (entry.parentEntryId === undefined || typeof entry.parentEntryId === 'string')
        && (entry.fromEntryId === undefined || typeof entry.fromEntryId === 'string')
        && (entry.provider === undefined || typeof entry.provider === 'string')
        && (entry.model === undefined || typeof entry.model === 'string')
        && (entry.usage === undefined || isPersistedUsage(entry.usage))
        && typeof entry.branchName === 'string' && typeof entry.summary === 'string';
    case 'metadata':
      return typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
        && typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
        && (entry.usage === undefined || isPersistedUsage(entry.usage));
    default:
      return false;
  }
}

function messageFromEntry(entry: MessageEntry): Message | undefined {
  const timestamp = new Date(entry.timestamp);
  if (Number.isNaN(timestamp.getTime())) return undefined;
  return {
    id: entry.id,
    role: entry.role,
    content: entry.content,
    timestamp,
    blocks: entry.blocks,
    toolCalls: entry.toolCalls,
    toolCallId: entry.toolCallId,
    name: entry.name,
    isError: entry.isError,
    provider: entry.provider,
    model: entry.model,
    usage: entry.usage,
    durationMs: entry.durationMs,
    parentMessageId: entry.parentMessageId,
    agentId: entry.agentId,
    metadata: entry.metadata,
  };
}

/** Parent links outrank wall-clock timestamps (which can regress); legacy roots retain time order. */
function orderContextEntries(entries: SessionEntry[]): SessionEntry[] {
  const ordered: SessionEntry[] = [];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  for (const entry of entries) {
    const commandId = entry.type === 'message' ? entry.metadata?.sourceCommandId : undefined;
    if (typeof commandId === 'string') byId.set(commandId, entry);
  }
  const emitted = new Set<string>();
  for (const entry of entries.sort((left, right) => left.timestamp - right.timestamp)) {
    const chain: SessionEntry[] = [];
    const visiting = new Set<string>();
    let cursor: SessionEntry | undefined = entry;
    while (cursor && !emitted.has(cursor.id) && !visiting.has(cursor.id)) {
      visiting.add(cursor.id); chain.push(cursor);
      const parent: string | undefined = cursor.type === 'message' ? cursor.parentMessageId
        : 'parentEntryId' in cursor ? cursor.parentEntryId : undefined;
      cursor = parent ? byId.get(parent) : undefined;
    }
    for (const ancestor of chain.reverse()) {
      if (emitted.has(ancestor.id)) continue;
      emitted.add(ancestor.id); ordered.push(ancestor);
    }
  }
  return ordered;
}

function messageToEntry(message: Message): MessageEntry {
  return {
    id: message.id,
    type: 'message',
    version: SESSION_SCHEMA_VERSION,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp.getTime(),
    ...(message.blocks ? { blocks: message.blocks } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.isError !== undefined ? { isError: message.isError } : {}),
    ...(message.provider ? { provider: message.provider } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
    ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
  };
}

// ===================================================================
// JSONL File-based session store
// ===================================================================

const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_COMMAND_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_MESSAGES = 100_000;
const MAX_SESSION_COMMANDS = 100_000;
const MAX_SESSION_FILES = 10_000;
const MAX_SESSION_DIRECTORY_ENTRIES = 100_000;
const MAX_SESSION_ID_BYTES = 256;
const SESSION_LOCK_ATTEMPTS = 500;
const SESSION_LOCK_RETRY_MS = 10;
const SESSION_LOCK_STALE_MS = 30_000;
const SESSION_LOCK_HEARTBEAT_MS = 5_000;
const UNSAFE_SESSION_STRING = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;

/** Validate a public session identifier before it reaches memory or filesystem lookups. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value) <= MAX_SESSION_ID_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isBoundedSessionString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= maxBytes
    && !UNSAFE_SESSION_STRING.test(value);
}

function isValidEntryId(value: unknown): value is string {
  return isBoundedSessionString(value, 256) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function generatedSessionTitle(content: string): string | undefined {
  const normalized = content
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length > 50 ? `${characters.slice(0, 50).join('')}...` : normalized;
}

function boundedSessionJson(value: unknown, maxBytes: number, errorMessage: string): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error(errorMessage); }
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error(errorMessage);
}

function normalizedSessionUsage(value: Message['usage']): Message['usage'] {
  if (!value) return undefined;
  const normalized: NonNullable<Message['usage']> = {};
  const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const;
  for (const field of counters) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
      throw new Error('Session usage is invalid.');
    }
    normalized[field] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(candidate));
  }
  if (value.costUsd !== undefined) {
    if (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0) {
      throw new Error('Session usage is invalid.');
    }
    normalized.costUsd = Math.min(Number.MAX_SAFE_INTEGER, value.costUsd);
  }
  return normalized;
}

function saturatedUsageAdd(left: number | undefined, right: number | undefined): number {
  return Math.min(Number.MAX_SAFE_INTEGER, (left ?? 0) + (right ?? 0));
}

async function removeStaleSessionLock(
  lockPath: string,
  observed: Awaited<ReturnType<typeof fs.lstat>>,
): Promise<void> {
  const stalePath = `${lockPath}.${process.pid}.${randomBytes(8).toString('hex')}.stale`;
  try {
    await fs.rename(lockPath, stalePath);
    const moved = await fs.lstat(stalePath);
    if (moved.dev !== observed.dev || moved.ino !== observed.ino || moved.nlink !== 1
      || moved.mtimeMs !== observed.mtimeMs || Date.now() - moved.mtimeMs <= SESSION_LOCK_STALE_MS) {
      const replacement = await fs.lstat(lockPath).catch(() => undefined);
      if (!replacement) await fs.rename(stalePath, lockPath).catch(() => undefined);
      return;
    }
    await fs.rm(stalePath, { force: true });
  } catch {
    const replacement = await fs.lstat(lockPath).catch(() => undefined);
    if (!replacement) await fs.rename(stalePath, lockPath).catch(() => undefined);
  }
}

async function acquireSessionLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < SESSION_LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await fs.open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const identity = await handle.stat();
      if (!identity.isFile() || identity.nlink !== 1
        || (process.platform !== 'win32' && (identity.mode & 0o077) !== 0)
        || (typeof process.getuid === 'function' && identity.uid !== process.getuid())) {
        await handle.close().catch(() => undefined);
        throw new Error('Session file lock is unsafe.');
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => undefined);
      }, SESSION_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        await handle.close().catch(() => undefined);
        await releaseStableLockPath(lockPath, identity);
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Session file lock is unsafe.') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error('Session file lock is unavailable.');
      }
      const current = await fs.lstat(lockPath).catch(() => undefined);
      if (!current) continue;
      if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
        || (process.platform !== 'win32' && (current.mode & 0o077) !== 0)
        || (typeof process.getuid === 'function' && current.uid !== process.getuid())) {
        throw new Error('Session file lock is unsafe.');
      }
      if (Date.now() - current.mtimeMs > SESSION_LOCK_STALE_MS) {
        await removeStaleSessionLock(lockPath, current);
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, SESSION_LOCK_RETRY_MS));
    }
  }
  throw new Error('Session file is busy.');
}

/** Manages sessions with JSONL file persistence */
export class JsonlSessionStore {
  private readonly sessionsDir: string;
  private redactText: (value: string) => string = value => value;
  private redactJson: <T>(value: T) => T = value => value;

  constructor(sessionsDir?: string, private readonly enabled = true) {
    this.sessionsDir = path.resolve(sessionsDir || path.join(process.env.HOME || '.', '.ai-harness', 'sessions'));
    if (new.target === JsonlSessionStore) sessionStoreKinds.set(this, enabled ? 'native' : 'memory');
  }

  /** Install a process-local scrubber without granting the store access to secret values. */
  setRedaction(
    redactText: (value: string) => string,
    redactJson: <T>(value: T) => T,
  ): void {
    this.redactText = redactText;
    this.redactJson = redactJson;
  }

  private redactJsonLines(content: string): string {
    const trailingNewline = content.endsWith('\n');
    const lines = content.split('\n');
    if (trailingNewline) lines.pop();
    const safe = lines.map(line => {
      if (!line.trim()) return '';
      try { return JSON.stringify(this.redactJson(JSON.parse(line))); }
      catch { return this.redactText(line); }
    }).join('\n');
    return trailingNewline ? `${safe}\n` : safe;
  }

  /** Ensure the sessions directory exists without traversing linked path components. */
  async ensureDir(): Promise<void> {
    if (!this.enabled) return;
    const parsed = path.parse(this.sessionsDir);
    let current = parsed.root;
    for (const component of this.sessionsDir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      let info: Awaited<ReturnType<typeof fs.lstat>>;
      try { info = await fs.lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('Session directory is unavailable.');
        }
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw new Error('Session directory is unavailable.');
          }
        }
        info = await fs.lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Session directory must not contain symbolic links.');
      }
    }

    const before = await fs.lstat(this.sessionsDir);
    const handle = await fs.open(
      this.sessionsDir,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino
        || (typeof process.getuid === 'function' && opened.uid !== process.getuid())) {
        throw new Error('Session directory must be a private regular directory.');
      }
      if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) await handle.chmod(0o700);
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino
        || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)) {
        throw new Error('Session directory changed unexpectedly.');
      }
    } finally {
      await handle.close();
    }
  }

  private async withStableSessionDirectory<T>(
    operation: (directoryPath: string, handle: Awaited<ReturnType<typeof fs.open>>) => Promise<T>,
  ): Promise<T> {
    await this.ensureDir();
    const before = await fs.lstat(this.sessionsDir);
    const handle = await fs.open(
      this.sessionsDir,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino
        || (typeof process.getuid === 'function' && opened.uid !== process.getuid())) {
        throw new Error('Session directory changed unexpectedly.');
      }
      const directoryPath = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : this.sessionsDir;
      const result = await operation(directoryPath, handle);
      const [openedAfter, pathAfter] = await Promise.all([handle.stat(), fs.lstat(this.sessionsDir)]);
      if (!openedAfter.isDirectory() || openedAfter.dev !== opened.dev || openedAfter.ino !== opened.ino
        || !pathAfter.isDirectory() || pathAfter.isSymbolicLink()
        || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
        throw new Error('Session directory changed unexpectedly.');
      }
      return result;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private anchoredFilePath(directoryPath: string, filePath: string): string {
    return path.join(directoryPath, path.basename(filePath));
  }

  /** Get the session file path for a given session ID. Session files are always flat. */
  private getFilePath(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
      throw new Error('Invalid session ID.');
    }

    const sessionsRoot = path.resolve(this.sessionsDir);
    const filePath = path.resolve(sessionsRoot, `${sessionId}.jsonl`);
    if (!filePath.startsWith(`${sessionsRoot}${path.sep}`)) {
      throw new Error('Invalid session ID.');
    }
    return filePath;
  }

  private async verifySessionPath(filePath: string, allowMissing: boolean): Promise<void> {
    try {
      const stats = await fs.lstat(filePath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
        || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
        throw new Error('Session path must be a regular, unlinked file.');
      }
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async readSessionFile(filePath: string): Promise<string> {
    await this.verifySessionPath(filePath, false);
    const before = await fs.lstat(filePath);
    if (before.size > MAX_SESSION_FILE_BYTES) throw new Error('Session file exceeds its size limit.');
    const handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    try {
      let opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_SESSION_FILE_BYTES
        || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || (typeof process.getuid === 'function' && opened.uid !== process.getuid())) {
        throw new Error('Session path must be a stable, regular, unlinked file.');
      }
      if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
        await handle.chmod(0o600);
        opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || (opened.mode & 0o077) !== 0) {
          throw new Error('Session file permissions could not be secured.');
        }
      }
      const bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const item = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (item.bytesRead === 0) break;
        offset += item.bytesRead;
      }
      const [after, target] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
      if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
        || after.nlink !== 1 || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || !target.isFile() || target.isSymbolicLink() || target.nlink !== 1
        || target.dev !== after.dev || target.ino !== after.ino || target.size !== after.size
        || target.mtimeMs !== after.mtimeMs || target.ctimeMs !== after.ctimeMs) {
        throw new Error('Session file changed while it was read.');
      }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return this.redactJsonLines(content);
    } finally {
      await handle.close();
    }
  }

  private async appendSessionFile(filePath: string, content: string): Promise<void> {
    await this.withStableSessionDirectory(async (directoryPath, directoryHandle) => {
      const anchoredPath = this.anchoredFilePath(directoryPath, filePath);
      const release = await acquireSessionLock(anchoredPath);
      let releaseInventory: (() => Promise<void>) | undefined;
      try {
        releaseInventory = await this.acquireSessionInventorySlot(directoryPath, anchoredPath, directoryHandle);
        await this.verifySessionPath(anchoredPath, true);
        const safeContent = this.redactJsonLines(content);
        const contentBytes = Buffer.byteLength(safeContent);
        if (contentBytes > MAX_SESSION_FILE_BYTES) throw new Error('Session file exceeds its size limit.');
        const handle = await fs.open(
          anchoredPath,
          fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT
            | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
          0o600,
        );
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.nlink > 1 || stats.size + contentBytes > MAX_SESSION_FILE_BYTES
            || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
            throw new Error('Session path must be a bounded, regular, unlinked file.');
          }
          await handle.chmod(0o600);
          await handle.writeFile(safeContent, { encoding: 'utf8' });
          await handle.sync();
          const [after, target] = await Promise.all([handle.stat(), fs.lstat(anchoredPath)]);
          if (after.dev !== stats.dev || after.ino !== stats.ino || after.nlink !== 1
            || after.size !== stats.size + contentBytes || after.size > MAX_SESSION_FILE_BYTES
            || !target.isFile() || target.isSymbolicLink() || target.nlink !== 1
            || target.dev !== after.dev || target.ino !== after.ino || target.size !== after.size) {
            throw new Error('Session path changed while it was written.');
          }
        } finally {
          await handle.close();
        }
      } finally {
        try { await releaseInventory?.(); }
        finally { await release(); }
      }
    });
  }

  private async rewriteSessionFile(
    filePath: string,
    content: string,
    directoryHandle?: Awaited<ReturnType<typeof fs.open>>,
  ): Promise<SessionEntry[]> {
    await this.verifySessionPath(filePath, true);
    const expected = await fs.lstat(filePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const safeContent = this.redactJsonLines(content);
    if (Buffer.byteLength(safeContent) > MAX_SESSION_FILE_BYTES) {
      throw new Error('Session file exceeds its size limit.');
    }
    const snapshot = parseSessionEntries(safeContent);
    const temporary = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(safeContent, { encoding: 'utf8' });
      await handle.sync();
      const staged = await handle.stat();
      if (!staged.isFile() || staged.nlink !== 1 || staged.size !== Buffer.byteLength(safeContent)
        || (typeof process.getuid === 'function' && staged.uid !== process.getuid())) {
        throw new Error('Session staging file changed unexpectedly.');
      }
      const current = await fs.lstat(filePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if ((expected && (!current || current.dev !== expected.dev || current.ino !== expected.ino
        || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs
        || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1))
        || (!expected && current)) {
        throw new Error('Session path changed while it was rewritten.');
      }
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, filePath);
      const target = await fs.lstat(filePath);
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1
        || target.dev !== staged.dev || target.ino !== staged.ino || target.size !== staged.size) {
        throw new Error('Session path changed while it was committed.');
      }
      if (directoryHandle) await directoryHandle.sync();
      else {
        const directory = await fs.open(path.dirname(filePath), fsConstants.O_RDONLY).catch(() => undefined);
        await directory?.sync().catch(() => undefined);
        await directory?.close().catch(() => undefined);
      }
      return snapshot;
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** List all session IDs (from .jsonl files) */
  async listSessionIds(): Promise<string[]> {
    if (!this.enabled) return [];
    try {
      return await this.withStableSessionDirectory(async (directoryPath, directoryHandle) => {
        const listing = await readStableDirectoryEntries(this.sessionsDir, MAX_SESSION_DIRECTORY_ENTRIES);
        const held = await directoryHandle.stat();
        if (listing.truncated || listing.stats.dev !== held.dev || listing.stats.ino !== held.ino) {
          throw new Error('Session inventory changed while it was read.');
        }
        // Never discover symbolic links or an unbounded number of entries as sessions.
        const candidates = listing.entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')
          && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.jsonl$/u.test(entry.name));
        if (candidates.length > MAX_SESSION_FILES) throw new Error('Session inventory limit reached.');
        const sessions: Array<{ id: string; mtimeMs: number }> = [];
        for (const entry of candidates) {
          const stats = await fs.lstat(path.join(directoryPath, entry.name)).catch(() => undefined);
          if (stats?.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
            && stats.size <= MAX_SESSION_FILE_BYTES
            && (typeof process.getuid !== 'function' || stats.uid === process.getuid())) {
            sessions.push({ id: entry.name.replace(/\.jsonl$/, ''), mtimeMs: stats.mtimeMs });
          }
        }
        return sessions
          .sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id))
          .map(entry => entry.id);
      });
    } catch {
      // Directory doesn't exist or can't be read
      return [];
    }
  }

  /** Load a session from JSONL file. */
  async loadSession(sessionId: string): Promise<Session | null> {
    return (await this.getSessionSnapshot(sessionId))?.session ?? null;
  }

  /** Read one bounded stable file into an owned session and journal, without writing it. */
  async getSessionSnapshot(sessionId: string): Promise<SessionStoreSnapshot | null> {
    if (!this.enabled) return null;
    const filePath = this.getFilePath(sessionId);

    let content: string;
    try {
      content = await this.withStableSessionDirectory(directoryPath => (
        this.readSessionFile(this.anchoredFilePath(directoryPath, filePath))
      ));
    } catch {
      return null;
    }
    if (!content.trim()) {
      return { session: {
        id: sessionId,
        schemaVersion: SESSION_SCHEMA_VERSION,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }, entries: [] };
    }

    const entries: SessionEntry[] = [];
    for (const line of content.split('\n').filter(l => l.trim())) {
      try {
        const entry: unknown = JSON.parse(line);
        if (isSessionEntry(entry)) entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    let messages: Message[] = [];
    let commands: ShellCommandRecord[] = [];
    let title: string | undefined;
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;
    let parentId: string | undefined;
    let branchId: string | undefined;
    let activeLeafId: string | undefined;
    let parentAgentId: string | undefined;
    let agentId: string | undefined;
    let cwd: string | undefined;
    let workspaceId: string | undefined;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let thinking: Session['thinking'];
    let toolPreset: Session['toolPreset'];
    let autoCompaction: boolean | undefined;
    let usage: Session['usage'];
    let providerConfig: Session['providerConfig'];
    let metadata: Record<string, unknown> | undefined;
    let latestCompaction: CompactionEntry | undefined;

    const includeTimestamp = (value: number): void => {
      const timestamp = new Date(value);
      if (Number.isNaN(timestamp.getTime())) return;
      if (!createdAt || timestamp < createdAt) createdAt = timestamp;
      if (!updatedAt || timestamp > updatedAt) updatedAt = timestamp;
    };

    for (const entry of entries) {
      if (entry.type === 'message') {
        const msg = messageFromEntry(entry);
        if (!msg) continue;
        messages.push(msg);

        if (!title && entry.role === 'user') {
          title = entry.content.slice(0, 50) + (entry.content.length > 50 ? '...' : '');
        }
      } else if (entry.type === 'command') {
        const timestamp = new Date(entry.timestamp);
        if (!Number.isNaN(timestamp.getTime())) {
          commands.push({
            id: entry.id,
            command: entry.command,
            cwd: entry.cwd,
            timestamp,
            status: entry.status,
            parentEntryId: entry.parentEntryId,
            output: entry.output,
            exitCode: entry.exitCode,
            durationMs: entry.durationMs,
            excludedFromContext: entry.excludedFromContext,
            truncated: entry.truncated,
            downloadPath: entry.downloadPath,
          });
        }
      } else if (entry.type === 'metadata') {
        title = entry.title ?? title;
        const metadataCreatedAt = new Date(entry.createdAt);
        const metadataUpdatedAt = new Date(entry.updatedAt);
        if (!Number.isNaN(metadataCreatedAt.getTime())) createdAt = metadataCreatedAt;
        if (!Number.isNaN(metadataUpdatedAt.getTime())) updatedAt = metadataUpdatedAt;
        parentId = entry.parentId;
        branchId = entry.branchId;
        activeLeafId = entry.activeLeafId;
        parentAgentId = entry.parentAgentId;
        agentId = entry.agentId;
        cwd = entry.cwd;
        workspaceId = entry.workspaceId;
        gitBranch = entry.gitBranch;
        model = entry.model;
        thinking = entry.thinking;
        toolPreset = entry.toolPreset;
        autoCompaction = entry.autoCompaction;
        usage = entry.usage;
        providerConfig = sanitizeProviderConfig(entry.providerConfig);
        metadata = entry.metadata;
      } else if (entry.type === 'compaction') {
        latestCompaction = entry;
      }

      includeTimestamp(entry.timestamp);
    }

    const legacyBoundary = typeof metadata?.legacyRootBoundaryId === 'string' ? metadata.legacyRootBoundaryId
      : metadata?.hasBranchedHistory !== true ? legacyRootBoundary(entries) : undefined;
    const treeEntries = legacyContextEntries(entries, legacyBoundary).filter(entry => entry.type !== 'metadata');
    const entriesById = new Map(treeEntries.map(entry => [entry.id, entry]));
    const activePathIds = new Set<string>();
    let cursor = activeLeafId;
    while (cursor && !activePathIds.has(cursor)) {
      const entry = entriesById.get(cursor);
      if (!entry) break;
      activePathIds.add(cursor);
      cursor = sessionEntryParent(entry);
    }
    const activeLeafReset = metadata?.activeLeafReset === true && !activeLeafId;
    const hasUsableTree = Boolean(activeLeafId) && (
      activePathIds.size > 1 || treeEntries.length <= 1 || metadata?.hasBranchedHistory === true
    );
    if (activeLeafReset) {
      messages = [];
      commands = [];
      latestCompaction = undefined;
    } else if (hasUsableTree) {
      messages = messages.filter(message => activePathIds.has(message.id));
      commands = commands.filter(command => activePathIds.has(command.id));
      latestCompaction = [...treeEntries].reverse().find(
        (entry): entry is CompactionEntry => entry.type === 'compaction' && activePathIds.has(entry.id),
      );
    }

    if ((activeLeafReset || hasUsableTree) && !latestCompaction && metadata) {
      const activeMetadata = { ...metadata };
      delete activeMetadata.lastCompacted;
      delete activeMetadata.compactionSummary;
      delete activeMetadata.compactionEntryId;
      delete activeMetadata.compactionStats;
      metadata = activeMetadata;
    }

    if (latestCompaction) {
      const firstKeptIndex = messages.findIndex(message => message.id === latestCompaction!.firstKeptEntryId);
      if (firstKeptIndex >= 0) messages = messages.slice(firstKeptIndex);
      else {
        const activePath = sessionContextPath(entries, activeLeafId, metadata?.hasBranchedHistory === true,
          activeLeafReset, legacyBoundary);
        const retainedIds = contextBoundaryMessageIds(activePath, latestCompaction.firstKeptEntryId, latestCompaction.id);
        if (retainedIds) messages = messages.filter(message => retainedIds.has(message.id));
      }
      const compactedAt = new Date(latestCompaction.timestamp);
      metadata = {
        ...metadata,
        ...(Number.isNaN(compactedAt.getTime()) ? {} : { lastCompacted: compactedAt.toISOString() }),
        compactionSummary: latestCompaction.summary,
        compactionEntryId: latestCompaction.id,
      };
    }

    const now = new Date();
    const session: Session = {
      id: sessionId,
      schemaVersion: SESSION_SCHEMA_VERSION,
      title,
      messages,
      ...(commands.length ? { commands } : {}),
      createdAt: createdAt ?? now,
      updatedAt: updatedAt ?? now,
      parentId,
      branchId,
      activeLeafId,
      parentAgentId,
      agentId,
      cwd,
      workspaceId,
      gitBranch,
      model,
      thinking,
      toolPreset,
      autoCompaction,
      usage,
      providerConfig,
      metadata,
    };
    return { session, entries };
  }

  private async acquireSessionInventorySlot(
    directoryPath: string,
    targetPath: string,
    directoryHandle: Awaited<ReturnType<typeof fs.open>>,
  ): Promise<(() => Promise<void>) | undefined> {
    const existing = await fs.lstat(targetPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) return undefined;
    const release = await acquireSessionLock(path.join(directoryPath, '.session-inventory'));
    try {
      const createdWhileWaiting = await fs.lstat(targetPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (createdWhileWaiting) return release;
      const listing = await readStableDirectoryEntries(this.sessionsDir, MAX_SESSION_DIRECTORY_ENTRIES);
      const held = await directoryHandle.stat();
      if (listing.truncated || listing.stats.dev !== held.dev || listing.stats.ino !== held.ino) {
        throw new Error('Session inventory changed while it was read.');
      }
      let count = 0;
      for (const entry of listing.entries) {
        // Matching names reserve inventory capacity even if a hostile entry has an unsafe type.
        if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.jsonl$/u.test(entry.name)) {
          count++;
          if (count >= MAX_SESSION_FILES) throw new Error('Session inventory limit reached.');
        }
      }
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** Save a session to JSONL file. Creation callers can require the ID to remain absent under the file lock. */
  async saveSession(
    session: Session,
    additionalEntries: SessionEntry[] = [],
    options: { requireAbsent?: boolean } = {},
  ): Promise<void> {
    if (!this.enabled) return;
    if (!Array.isArray(additionalEntries) || additionalEntries.length > 1_024
      || additionalEntries.some(entry => !entry || entry.type === 'metadata'
        || !isValidEntryId(entry.id) || !Number.isFinite(entry.timestamp))) {
      throw new Error('Session entries are invalid.');
    }
    const filePath = this.getFilePath(session.id);
    await this.withStableSessionDirectory(async (directoryPath, directoryHandle) => {
      const anchoredPath = this.anchoredFilePath(directoryPath, filePath);
      const release = await acquireSessionLock(anchoredPath);
      let releaseInventory: (() => Promise<void>) | undefined;
      try {
        releaseInventory = await this.acquireSessionInventorySlot(directoryPath, anchoredPath, directoryHandle);
        let existingLines: string[] = [];
        try {
          existingLines = (await this.readSessionFile(anchoredPath)).split('\n').filter(line => line.trim());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // File does not exist yet.
        }
        if (options.requireAbsent && existingLines.length > 0) {
          throw new Error('Session already exists.');
        }

        const metadataEntry: SessionMetadataEntry = {
        id: 'session-metadata',
        type: 'metadata',
        version: SESSION_SCHEMA_VERSION,
        schemaVersion: SESSION_SCHEMA_VERSION,
        timestamp: session.updatedAt.getTime(),
        title: session.title,
        createdAt: session.createdAt.getTime(),
        updatedAt: session.updatedAt.getTime(),
        parentId: session.parentId,
        branchId: session.branchId,
        activeLeafId: session.activeLeafId,
        parentAgentId: session.parentAgentId,
        agentId: session.agentId,
        cwd: session.cwd,
        workspaceId: session.workspaceId,
        gitBranch: session.gitBranch,
        model: session.model,
        thinking: session.thinking,
        toolPreset: session.toolPreset,
        autoCompaction: session.autoCompaction,
        usage: session.usage,
        providerConfig: sanitizeProviderConfig(session.providerConfig),
        metadata: session.metadata,
      };
      const currentEntries: SessionEntry[] = [
        ...session.messages.map(messageToEntry),
        ...(session.commands ?? []).map(command => ({
          ...command,
          type: 'command' as const,
          version: SESSION_SCHEMA_VERSION,
          timestamp: command.timestamp.getTime(),
        })),
        ...additionalEntries,
      ];
      const currentById = new Map(currentEntries.map(entry => [entry.id, entry]));
      const existingIds = new Set<string>();
      const durableLines = existingLines.flatMap(line => {
        try {
          const entry = JSON.parse(line) as { id?: unknown; type?: unknown };
          if (entry.type === 'metadata') return [];
          if (typeof entry.id !== 'string') return [line];
          existingIds.add(entry.id);
          const current = currentById.get(entry.id);
          return [current ? JSON.stringify(current) : line];
        } catch {
          return [line];
        }
      });
      const newEntries = currentEntries
        .filter(entry => !existingIds.has(entry.id))
        .sort((left, right) => left.timestamp - right.timestamp)
        .map(entry => JSON.stringify(entry));
        const lines = [JSON.stringify(metadataEntry), ...durableLines, ...newEntries];

        const snapshot = await this.rewriteSessionFile(anchoredPath, `${lines.join('\n')}\n`, directoryHandle);
        committedSessionEntries.set(session, snapshot);
      } finally {
        try { await releaseInventory?.(); }
        finally { await release(); }
      }
    });
  }

  /** Append a message entry to the session file */
  async appendMessage(
    sessionId: string,
    role: Message['role'],
    content: string,
    metadata: Omit<Message, 'id' | 'timestamp' | 'role' | 'content'> = {},
  ): Promise<string> {
    const message: Message = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: new Date(),
      ...metadata,
    };
    if (!this.enabled) return message.id;

    await this.ensureDir();
    await this.appendSessionFile(
      this.getFilePath(sessionId),
      `${JSON.stringify(messageToEntry(message))}\n`,
    );

    return message.id;
  }

  /** Append a shell command without implicitly adding it to model context. */
  async appendCommand(
    sessionId: string,
    command: Omit<ShellCommandRecord, 'id' | 'timestamp'> & Partial<Pick<ShellCommandRecord, 'id' | 'timestamp'>>,
  ): Promise<ShellCommandRecord> {
    const record: ShellCommandRecord = {
      ...command,
      id: command.id ?? `command-${crypto.randomUUID()}`,
      timestamp: command.timestamp ? new Date(command.timestamp) : new Date(),
    };
    if (!this.enabled) return record;
    const entry: CommandEntry = {
      ...record,
      type: 'command',
      version: SESSION_SCHEMA_VERSION,
      timestamp: record.timestamp.getTime(),
    };
    await this.ensureDir();
    await this.appendSessionFile(this.getFilePath(sessionId), `${JSON.stringify(entry)}\n`);
    return record;
  }

  /** Append a compaction entry to the session file */
  async appendCompaction(
    sessionId: string,
    summary: string,
    firstKeptEntryId: string,
    tokenEstimate?: number,
    details: Pick<CompactionEntry,
      'instruction' | 'tokensBefore' | 'tokensAfter' | 'parentEntryId' | 'provider' | 'model' | 'usage'> = {},
  ): Promise<void> {
    if (!this.enabled) return;
    await this.ensureDir();
    const line = JSON.stringify({
      id: `compaction-${crypto.randomUUID()}`,
      type: 'compaction',
      version: SESSION_SCHEMA_VERSION,
      summary,
      firstKeptEntryId,
      timestamp: Date.now(),
      ...(details.parentEntryId ? { parentEntryId: details.parentEntryId } : {}),
      ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
      ...(details.instruction ? { instruction: details.instruction } : {}),
      ...(details.tokensBefore !== undefined ? { tokensBefore: details.tokensBefore } : {}),
      ...(details.tokensAfter !== undefined ? { tokensAfter: details.tokensAfter } : {}),
      ...(details.provider ? { provider: details.provider } : {}),
      ...(details.model ? { model: details.model } : {}),
      ...(details.usage ? { usage: details.usage } : {}),
    });

    await this.appendSessionFile(this.getFilePath(sessionId), `${line}\n`);
  }

  /** Append a summary describing an abandoned or completed branch. */
  async appendBranchSummary(
    sessionId: string,
    branchName: string,
    summary: string,
    parentEntryId?: string,
    accounting: BranchSummaryAccounting = {},
  ): Promise<BranchSummaryEntry> {
    const provenance = copyBranchSummaryAccounting(accounting);
    const entry: BranchSummaryEntry = {
      id: `branch-summary-${crypto.randomUUID()}`,
      type: 'branch_summary',
      version: SESSION_SCHEMA_VERSION,
      ...(parentEntryId ? { parentEntryId } : {}),
      branchName,
      summary,
      ...provenance,
      timestamp: Date.now(),
    };
    if (this.enabled) {
      await this.ensureDir();
      await this.appendSessionFile(this.getFilePath(sessionId), `${JSON.stringify(entry)}\n`);
    }
    return entry;
  }

  /** Informational path only; disabled persistence has no session file. */
  getSessionFilePath(sessionId: string): string | undefined {
    return this.enabled ? this.getFilePath(sessionId) : undefined;
  }

  /** Delete a session file */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.enabled) return true;
    const filePath = this.getFilePath(sessionId);
    return this.withStableSessionDirectory(async directoryPath => {
      const anchoredPath = this.anchoredFilePath(directoryPath, filePath);
      const release = await acquireSessionLock(anchoredPath);
      try {
        await this.verifySessionPath(anchoredPath, false);
        await fs.unlink(anchoredPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw new Error('Session deletion failed.');
      } finally {
        await release();
      }
    });
  }

  /** Get the raw entries from a session file (for compaction/tree operations) */
  async getRawEntries(sessionId: string): Promise<SessionEntry[]> {
    if (!this.enabled) return [];
    const filePath = this.getFilePath(sessionId);
    try {
      const content = await this.withStableSessionDirectory(directoryPath => (
        this.readSessionFile(this.anchoredFilePath(directoryPath, filePath))
      ));
      const entries: SessionEntry[] = [];

      for (const line of content.split('\n').filter(l => l.trim())) {
        try {
          const entry: unknown = JSON.parse(line);
          if (isSessionEntry(entry)) entries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }

      return entries.filter(entry => entry.type !== 'metadata');
    } catch {
      return [];
    }
  }
}

// ===================================================================
// In-memory session manager (can be extended with persistence)
// ===================================================================

/** Compaction settings */
export interface CompactionSettings {
  enabled: boolean;
  /** Tokens reserved for the model response */
  reserveTokens: number;
  /** Recent tokens retained without summarization */
  keepRecentTokens: number;
}

const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** Read only recognized own-data policy; legacy fields gain no read/serialization authority. */
function ownedCompactionSettings(value: unknown): CompactionSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const enabled = Object.getOwnPropertyDescriptor(value, 'enabled');
  const reserve = Object.getOwnPropertyDescriptor(value, 'reserveTokens');
  const keep = Object.getOwnPropertyDescriptor(value, 'keepRecentTokens');
  if (!enabled || !('value' in enabled) || typeof enabled.value !== 'boolean'
    || !reserve || !('value' in reserve) || typeof reserve.value !== 'number'
    || !Number.isSafeInteger(reserve.value) || reserve.value < 0
    || !keep || !('value' in keep) || typeof keep.value !== 'number'
    || !Number.isSafeInteger(keep.value) || keep.value < 0) return null;
  return { enabled: enabled.value, reserveTokens: reserve.value, keepRecentTokens: keep.value };
}

export interface SessionStoreSnapshot {
  session: Session;
  entries: SessionEntry[];
}

/** Own destination overrides and an optional read-only external journal source. */
export interface SessionForkOptions extends SessionBranchOptions {
  sourceStore?: JsonlSessionStore;
  id?: string;
  cwd?: string;
  workspaceId?: string;
}

interface SessionCopySource {
  original: Session;
  rawEntries: SessionEntry[];
  validateSource?: () => void;
}

interface SessionPublicationAdmission {
  check(): void;
  admit(): void;
}

export type CreateSessionOptions = Partial<Pick<Session,
  | 'id'
  | 'title'
  | 'messages'
  | 'commands'
  | 'createdAt'
  | 'updatedAt'
  | 'providerConfig'
  | 'metadata'
  | 'parentId'
  | 'branchId'
  | 'activeLeafId'
  | 'parentAgentId'
  | 'agentId'
  | 'cwd'
  | 'workspaceId'
  | 'gitBranch'
  | 'model'
  | 'thinking'
  | 'toolPreset'
  | 'autoCompaction'
  | 'usage'
>>;

export type MutableSessionFields = Pick<Session,
  | 'title'
  | 'metadata'
  | 'providerConfig'
  | 'activeLeafId'
  | 'agentId'
  | 'cwd'
  | 'workspaceId'
  | 'gitBranch'
  | 'model'
  | 'thinking'
  | 'toolPreset'
  | 'autoCompaction'
  | 'usage'
>;

export type MutableSessionChanges = {
  [K in keyof MutableSessionFields]?: MutableSessionFields[K] | null;
};

/** Token estimation helpers (simplified) */
class TokenEstimator {
  /** Rough token count estimation (chars / 4 for English text is a common heuristic) */
  static estimateTokens(text: string): number {
    // More accurate: ~1 token per 4 characters for typical English text
    return Math.ceil(text.length / 4);
  }

  /** Estimate tokens for a message entry (including role prefix overhead) */
  static estimateMessageEntry(entry: SessionEntry): number {
    const text = 'content' in entry ? entry.content : 'summary' in entry ? entry.summary : '';
    const base = this.estimateTokens(text || '');
    // Add overhead for metadata, role markers, etc.
    return base + 4;
  }

  /** Total tokens for a list of message entries */
  static totalMessages(entries: SessionEntry[]): number {
    return entries.reduce((sum, e) => sum + this.estimateMessageEntry(e), 0);
  }
}

/** Process-local captured source; copied or fabricated values cannot carry its publication lease. */
export interface SessionCompactionSource { readonly sourceSessionId: string; readonly entryId?: string }
/** Optional caller lifetime/source for explicit summary publication; admitted saves still finish. */
export interface SessionCompactionOptions { signal?: AbortSignal; source?: SessionCompactionSource }

/** Output-only admission: cannot redirect the source/cut, supply accounting or authorize model work. */
export interface SessionCompactionEvent {
  readonly sessionId: string;
  readonly firstKeptEntryId: string;
  readonly summary: string;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}
export type SessionCompactionHook = (event: Readonly<SessionCompactionEvent>) => void | false | { summary: string }
  | Promise<void | false | { summary: string }>;

const compactionAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function isCompactionAborted(signal?: AbortSignal): boolean {
  if (!signal) return false;
  try { return compactionAborted.call(signal) as boolean; }
  catch { throw new Error('Compaction options are invalid.'); }
}

function copyCompactionOptions(value: SessionCompactionOptions): SessionCompactionOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Compaction options are invalid.');
  let signal: AbortSignal | undefined, source: SessionCompactionSource | undefined;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if ((key !== 'signal' && key !== 'source') || !descriptor || !('value' in descriptor)) throw new Error('Compaction options are invalid.');
    if (key === 'signal') {
      if (descriptor.value !== undefined && !(descriptor.value instanceof AbortSignal)) throw new Error('Compaction options are invalid.');
      signal = descriptor.value as AbortSignal | undefined;
    } else {
      if (descriptor.value !== undefined && (!descriptor.value || typeof descriptor.value !== 'object' || Array.isArray(descriptor.value))) throw new Error('Compaction options are invalid.');
      source = descriptor.value as SessionCompactionSource | undefined;
    }
  }
  return { signal, source };
}

interface CompactionDetails {
  instruction?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  provider?: string;
  model?: string;
  usage?: Message['usage'];
}

export interface AutoCompactionResult {
  summary: string;
  provider?: string;
  model?: string;
  usage?: Message['usage'];
}

/** Callback type for auto-compaction trigger */
export type AutoCompactionCallback = (
  sessionId: string,
  toCompact: SessionEntry[],
  keptEntries: SessionEntry[],
  signal?: AbortSignal,
) => Promise<string | AutoCompactionResult>;

/** Optional host policy used to resolve global/project/session inheritance. */
export type AutoCompactionPolicy = (session: Readonly<Session>) => boolean | Promise<boolean>;

/** Main session manager with in-memory storage and optional JSONL persistence */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  /** Append-only journal used when persistence is disabled. */
  private volatileEntries: Map<string, SessionEntry[]> = new Map();
  private committedEntries: Map<string, SessionEntry[]> = new Map();
  private onSessionUpdate?: (sessionId: string) => void;
  private store: JsonlSessionStore | null = null;
  private storeGeneration = 0;
  private readonly compactionSources = new WeakMap<SessionCompactionSource, SessionPublicationAdmission & { sourceSessionId: string }>();
  private compactionSettings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS;
  private compactionContextWindow?: number;
  private autoCompactionCallback?: AutoCompactionCallback;
  private autoCompactionPolicy?: AutoCompactionPolicy;
  private readonly redactText: (value: string) => string;
  private readonly redactJson: <T>(value: T) => T;
  
  // Event system for lifecycle hooks and extensions
  private emitter = new EventEmitter<EventMap>();
  private readonly branchAdmissions = new SessionBranchAdmissions();
  private readonly branchSummaryHooks = new Map<symbol, BranchSummaryHook>();
  private readonly compactionHooks = new Map<symbol, SessionCompactionHook>();
  private compactionHookGeneration = 0;
  private readonly sessionMutationTails = new Map<string, Promise<void>>();
  private readonly autoCompactionRuns = new Map<string, Promise<boolean>>();
  private activeSessionMutations = 0;
  private readonly sessionMutationIdleWaiters = new Set<() => void>();
  private clearInProgress?: Promise<void>;

  private async withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    while (this.clearInProgress) await this.clearInProgress;
    this.activeSessionMutations++;
    const previous = this.sessionMutationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sessionMutationTails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionMutationTails.get(sessionId) === tail) this.sessionMutationTails.delete(sessionId);
      this.activeSessionMutations--;
      if (this.activeSessionMutations === 0) {
        for (const resolve of this.sessionMutationIdleWaiters) resolve();
        this.sessionMutationIdleWaiters.clear();
      }
    }
  }

  constructor(options: {
    store?: JsonlSessionStore;
    redactText?: (value: string) => string;
    redactJson?: <T>(value: T) => T;
  } = {}) {
    this.store = options.store ?? null;
    this.redactText = options.redactText ?? (value => value);
    this.redactJson = options.redactJson ?? (value => value);
    this.store?.setRedaction(this.redactText, this.redactJson);
  }

  /** Set the JSONL persistence store */
  setStore(store: JsonlSessionStore): void {
    if (this.store !== store) {
      this.storeGeneration++;
      this.branchAdmissions.retire(undefined, new Error('Session changed while copying its branch.'), true);
    }
    this.store = store;
    store.setRedaction(this.redactText, this.redactJson);
  }

  /** Configure compaction settings */
  setCompactionSettings(settings: Partial<CompactionSettings>): void {
    this.compactionSettings = { ...this.compactionSettings, ...settings };
  }

  getCompactionSettings(): CompactionSettings {
    return this.compactionSettings;
  }

  /** Supply the active model's token limit; undefined preserves legacy host policy. */
  setCompactionContextWindow(contextWindow?: number): void {
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
      throw new Error('Compaction context window is invalid.');
    }
    this.compactionContextWindow = contextWindow;
  }

  getCompactionContextWindow(): number | undefined { return this.compactionContextWindow; }

  /** Set the callback function for auto-compaction summarization */
  setAutoCompactionCallback(callback: AutoCompactionCallback): void {
    this.autoCompactionCallback = callback;
  }

  /** Let the host resolve inherited auto-compaction policy without coupling Core to its config store. */
  setAutoCompactionPolicy(policy: AutoCompactionPolicy): void {
    this.autoCompactionPolicy = policy;
  }

  /** Check if a session needs compaction and trigger it automatically. */
  async checkAndTriggerCompaction(sessionId: string, signal?: AbortSignal, reason: 'threshold' | 'overflow' = 'threshold'): Promise<boolean> {
    const active = this.autoCompactionRuns.get(sessionId);
    if (active) return active;
    // Admit before invoking policy or lifecycle observers, which may reenter this method.
    const run = Promise.resolve().then(() => this.checkAndTriggerCompactionUnlocked(sessionId, signal, reason));
    this.autoCompactionRuns.set(sessionId, run);
    try { return await run; }
    finally {
      if (this.autoCompactionRuns.get(sessionId) === run) this.autoCompactionRuns.delete(sessionId);
    }
  }

  private async checkAndTriggerCompactionUnlocked(sessionId: string, signal?: AbortSignal, reason: 'threshold' | 'overflow' = 'threshold'): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const settings = ownedCompactionSettings(this.compactionSettings);
    const contextWindow = this.compactionContextWindow;
    const store = this.store;
    const storeGeneration = this.storeGeneration;
    const summarize = this.autoCompactionCallback;
    const policy = this.autoCompactionPolicy;
    const redactText = this.redactText.bind(this);
    if (!session || !settings || !settings.enabled || !summarize || isCompactionAborted(signal)) return false;
    if (session.autoCompaction === false) return false;
    let started = false;
    try {
      const admission = this.compactionAdmission(sessionId);
      const activeLeafId = session.activeLeafId;
      const isCurrent = (): boolean => {
        const current = ownedCompactionSettings(this.compactionSettings);
        return current !== null && this.sessions.get(sessionId) === session
          && this.store === store && this.storeGeneration === storeGeneration
          && session.activeLeafId === activeLeafId
          && session.autoCompaction !== false
          && current.enabled
          && current.reserveTokens === settings.reserveTokens
          && current.keepRecentTokens === settings.keepRecentTokens
          && this.compactionContextWindow === contextWindow
          && this.autoCompactionCallback === summarize
          && this.autoCompactionPolicy === policy;
      };
      if (policy && !await policy(session)) return false;
      admission.check();
      if (isCompactionAborted(signal) || !isCurrent()) return false;
      if (reason === 'threshold' && contextWindow !== undefined
        && this.estimateContextTokens(sessionId) <= contextWindow - settings.reserveTokens) return false;

      const result = this.requestCompaction(sessionId, reason);
      if (!result) return false;
      const firstKeptMessage = result.keptEntries.find(entry => entry.type === 'message');
      if (!firstKeptMessage) return false;
      const firstKeptEntryId = firstKeptMessage.id;
      const keptTokens = TokenEstimator.totalMessages(result.keptEntries);
      const tokensBefore = TokenEstimator.totalMessages([
        ...result.toCompact,
        ...result.keptEntries,
      ]);

      const validateAdmission = (): void => {
        if (isCompactionAborted(signal)) throw new DOMException('Compaction cancelled', 'AbortError');
        admission.check();
        if (!isCurrent()) throw new Error('Compaction context or policy changed.');
      };
      validateAdmission();
      started = true;
      await this.emitter.emit('compaction:start', { sessionId, automatic: true, tokensBefore });
      validateAdmission();
      assertCompactionTranscript(result.toCompact);
      const generated = await summarize(
        sessionId,
        result.toCompact,
        result.keptEntries,
        signal,
      );
      validateAdmission();
      const output = copyAutomaticCompactionResult(generated);
      const summary = readCompactionSummary({ content: redactText(output.summary) }).trim();
      const tokensAfter = TokenEstimator.estimateTokens(summary) + keptTokens;
      const applied = await this.applyCompactionResult(sessionId, summary, firstKeptEntryId, {
        tokensBefore,
        tokensAfter,
        provider: output.provider,
        model: output.model,
        usage: output.usage,
      }, validateAdmission, admission.admit, 16_384, true, signal);
      if (!applied) throw new Error('Compaction context or policy changed.');
      await this.emitter.emit('compaction:end', {
        sessionId,
        summaryLength: String(session.metadata?.compactionSummary ?? summary).length,
        automatic: true,
        tokensBefore,
        tokensAfter: (session.metadata?.compactionStats as CompactionDetails | undefined)?.tokensAfter ?? tokensAfter,
        tokensSaved: Math.max(0, tokensBefore - tokensAfter),
      });
      return true;
    } catch (error) {
      const cancelled = isCompactionAborted(signal) || (error instanceof Error && error.name === 'AbortError');
      const errorMessage = cancelled
        ? 'Compaction cancelled'
        : error instanceof Error ? error.message : 'Unknown error';
      if (!cancelled) console.error(redactText('[SessionManager] Auto-compaction failed.'));
      if (!started) return false;
      await this.emitter.emit('compaction:error', {
        sessionId, error: errorMessage, automatic: true, cancelled,
      });
      // A failed summary must not prevent the conversation from continuing.
      return false;
    }
  }


  // ===================================================================
  // Event System - Lifecycle hooks and extension integration
  // ===================================================================

  /** Ordered cancellation admission, separate from concurrent lifecycle observers. */
  onBeforeBranch(hook: SessionBranchHook): () => void {
    return this.branchAdmissions.onBefore(hook);
  }

  /** Explicit summary overrides run in order; the last defined owned output wins. */
  onBeforeBranchSummary(hook: BranchSummaryHook): () => void {
    if (typeof hook !== 'function') throw new Error('Branch summary hook is invalid.');
    if (this.branchSummaryHooks.size >= 128) throw new Error('Branch summary hook limit reached.');
    const key = Symbol(); this.branchAdmissions.retire();
    if (this.branchSummaryHooks.size >= 128) throw new Error('Branch summary hook limit reached.');
    this.branchSummaryHooks.set(key, hook);
    return () => { if (this.branchSummaryHooks.delete(key)) this.branchAdmissions.retire(); };
  }

  private async runBranchSummaryHooks(event: BranchSummaryEvent, ticket: SessionBranchTicket): Promise<BranchSummaryOutput | undefined> {
    const captured = copyBranchSummaryEvent(event);
    let output: BranchSummaryOutput | undefined;
    for (const hook of [...this.branchSummaryHooks.values()]) {
      ticket.check(); let result: unknown;
      try { result = await ticket.waitFor(Promise.resolve().then(() => hook(captured))); }
      catch { ticket.check(); throw new Error('Branch summary hook failed.'); }
      ticket.check();
      if (result === false) { ticket.cancel(); ticket.check(); }
      if (result !== undefined) output = copyBranchSummaryOutput(result, captured.maxOutputBytes);
    }
    return output;
  }

  /** Host generation withdrawal; future operations use the current registrations. */
  retirePendingBranchOperations(): void {
    this.branchAdmissions.retire();
    this.compactionHookGeneration++;
  }

  onBeforeCompaction(hook: SessionCompactionHook): () => void {
    if (typeof hook !== 'function' || this.compactionHooks.size >= 128) throw new Error('Compaction hook is invalid.');
    const key = Symbol(); this.compactionHooks.set(key, hook); this.compactionHookGeneration++;
    return () => { if (this.compactionHooks.delete(key)) this.compactionHookGeneration++; };
  }

  private async withBranchTicket<T>(sourceSessionId: string, signal: AbortSignal | undefined,
    operation: (ticket: SessionBranchTicket) => Promise<T>): Promise<T> {
    const ticket = this.branchAdmissions.begin(sourceSessionId, signal);
    try { return await operation(ticket); }
    finally { ticket.finish(); }
  }

  /** Register a listener for an event */
  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    this.emitter.on(event, handler);
  }

  /** Register a one-time listener for an event */
  once<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    this.emitter.once(event, handler);
  }

  /** Remove a listener for an event */
  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    this.emitter.off(event, handler);
  }

  /** Check if there are any listeners for an event */
  hasListeners<K extends keyof EventMap>(event: K): boolean {
    return this.emitter.hasListeners(event);
  }

  /** Get the number of listeners for an event */
  listenerCount<K extends keyof EventMap>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  /** Remove all listeners for an event or all events */
  removeAllListeners<K extends keyof EventMap>(event?: K): void {
    this.emitter.removeAllListeners(event);
  }

  // ===================================================================
  // Legacy listener (kept for backward compatibility)
  // ===================================================================

  /** Set a listener for session updates */
  setListener(listener: (sessionId: string) => void): void {
    this.onSessionUpdate = listener;
  }

  /** Create a new session and optionally persist imported rich data. */
  async create(options: CreateSessionOptions = {}): Promise<Session> {
    return this.createWithEntries(options);
  }

  /** Internal clone entries join the create-only write, never a later append. */
  private async createWithEntries(
    options: CreateSessionOptions,
    entries: RestorableSessionEntry[] = [],
    expectedStore?: { store: JsonlSessionStore | null },
    admission?: SessionPublicationAdmission,
  ): Promise<Session> {
    options = this.redactJson(options);
    entries = this.redactJson(structuredClone(entries));
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || (options.messages !== undefined && !Array.isArray(options.messages))
      || (options.commands !== undefined && !Array.isArray(options.commands))) {
      throw new Error('Session data is invalid.');
    }
    const sessionId = options.id ?? crypto.randomUUID();
    if (!isValidSessionId(sessionId)) {
      throw new Error('Invalid session ID.');
    }
    return this.withSessionMutation(sessionId, () => {
      admission?.check();
      if (expectedStore && this.store !== expectedStore.store) throw new Error('Session changed while copying its branch.');
      return this.createUnlocked(options, sessionId, entries, admission);
    });
  }

  private async createUnlocked(
    options: CreateSessionOptions,
    sessionId: string,
    entries: RestorableSessionEntry[],
    admission?: SessionPublicationAdmission,
  ): Promise<Session> {
    if (this.sessions.has(sessionId)) throw new Error('Session already exists.');
    if (this.sessions.size >= MAX_SESSION_FILES) throw new Error('Session inventory limit reached.');
    if (this.store) {
      const storedIds = await this.store.listSessionIds();
      if (storedIds.includes(sessionId)) throw new Error('Session already exists.');
      if (storedIds.length >= MAX_SESSION_FILES) throw new Error('Session inventory limit reached.');
    }
    const now = new Date();
    const session: Session = {
      id: sessionId,
      schemaVersion: SESSION_SCHEMA_VERSION,
      title: options.title,
      messages: options.messages?.map(message => ({
        ...message,
        timestamp: new Date(message.timestamp),
      })) ?? [],
      commands: options.commands?.map(command => ({
        ...command,
        timestamp: new Date(command.timestamp),
      })),
      createdAt: options.createdAt ? new Date(options.createdAt) : now,
      updatedAt: options.updatedAt ? new Date(options.updatedAt) : now,
      providerConfig: sanitizeProviderConfig(options.providerConfig),
      metadata: options.metadata,
      parentId: options.parentId,
      branchId: options.branchId,
      activeLeafId: options.activeLeafId,
      parentAgentId: options.parentAgentId,
      agentId: options.agentId,
      cwd: options.cwd,
      workspaceId: options.workspaceId,
      gitBranch: options.gitBranch,
      model: options.model,
      thinking: options.thinking,
      toolPreset: options.toolPreset,
      autoCompaction: options.autoCompaction,
      usage: normalizedSessionUsage(options.usage),
    };

    if (!isValidDate(session.createdAt) || !isValidDate(session.updatedAt)
      || (session.title !== undefined && !isBoundedSessionString(session.title, 4_096))
      || (session.parentId !== undefined
        && (!isValidSessionId(session.parentId) || session.parentId === session.id))
      || (session.branchId !== undefined && !isValidSessionId(session.branchId))
      || (session.activeLeafId !== undefined && !isValidEntryId(session.activeLeafId))
      || (session.parentAgentId !== undefined && !isBoundedSessionString(session.parentAgentId, 256))
      || (session.agentId !== undefined && !isBoundedSessionString(session.agentId, 256))
      || (session.cwd !== undefined && !isBoundedSessionString(session.cwd, 4_096))
      || (session.workspaceId !== undefined && !isBoundedSessionString(session.workspaceId, 256))
      || (session.gitBranch !== undefined && !isBoundedSessionString(session.gitBranch, 1_024))
      || (session.model !== undefined && !isBoundedSessionString(session.model, 500))
      || (session.thinking !== undefined
        && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(session.thinking))
      || (session.toolPreset !== undefined
        && !['configured', 'chat-only', 'read-only', 'default', 'full'].includes(session.toolPreset))
      || (session.autoCompaction !== undefined && typeof session.autoCompaction !== 'boolean')
      || (session.metadata !== undefined
        && (!session.metadata || typeof session.metadata !== 'object' || Array.isArray(session.metadata)))) {
      throw new Error('Session data is invalid.');
    }
    if (session.metadata !== undefined) {
      boundedSessionJson(session.metadata, 8 * 1024 * 1024, 'Session metadata exceeds its size limit.');
    }
    const ancestry = new Set<string>([session.id]);
    let ancestorId = session.parentId;
    while (ancestorId) {
      if (ancestry.has(ancestorId)) throw new Error('Session ancestry is invalid.');
      ancestry.add(ancestorId);
      if (ancestry.size > MAX_SESSION_FILES) throw new Error('Session ancestry is invalid.');
      ancestorId = this.sessions.get(ancestorId)?.parentId;
    }
    if (session.messages.length > MAX_SESSION_MESSAGES || (session.commands?.length ?? 0) > MAX_SESSION_COMMANDS) {
      throw new Error('Session entry limit reached.');
    }
    const entryIds = new Set<string>();
    for (const message of session.messages) {
      if (!message || !isValidEntryId(message.id) || entryIds.has(message.id) || !isValidDate(message.timestamp)
        || !['user', 'assistant', 'system', 'tool'].includes(message.role)
        || typeof message.content !== 'string'
        || (message.parentMessageId !== undefined && !isValidEntryId(message.parentMessageId))
        || (message.provider !== undefined && !isBoundedSessionString(message.provider, 128))
        || (message.model !== undefined && !isBoundedSessionString(message.model, 500))
        || (message.toolCallId !== undefined && !isBoundedSessionString(message.toolCallId, 256))
        || (message.name !== undefined && !isBoundedSessionString(message.name, 256))
        || (message.blocks !== undefined && (!Array.isArray(message.blocks) || message.blocks.length > 1_024))
        || (message.toolCalls !== undefined && (!Array.isArray(message.toolCalls) || message.toolCalls.length > 1_024))) {
        throw new Error('Session message is invalid.');
      }
      entryIds.add(message.id);
      message.usage = normalizedSessionUsage(message.usage);
      boundedSessionJson(message, MAX_SESSION_MESSAGE_BYTES, 'Session message exceeds its size limit.');
    }
    for (const command of session.commands ?? []) {
      if (!command || !isValidEntryId(command.id) || entryIds.has(command.id) || !isValidDate(command.timestamp)
        || typeof command.command !== 'string' || Buffer.byteLength(command.command) > 1_000_000
        || !isBoundedSessionString(command.cwd, 4_096)
        || (command.parentEntryId !== undefined && !isValidEntryId(command.parentEntryId))
        || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(command.status)
        || (command.output !== undefined && typeof command.output !== 'string')) {
        throw new Error('Session command is invalid.');
      }
      entryIds.add(command.id);
      boundedSessionJson(command, MAX_SESSION_COMMAND_BYTES, 'Session command exceeds its size limit.');
    }

    // Preserve the store's existing additional-entry bound and validate before any publication.
    if (!Array.isArray(entries) || entries.length > 1_024) throw new Error('Session entries are invalid.');
    for (const entry of entries) {
      if (!isSessionEntry(entry) || !isValidEntryId(entry.id)
        || entryIds.has(entry.id) || !isValidDate(new Date(entry.timestamp))
        || (entry.parentEntryId !== undefined && !isValidEntryId(entry.parentEntryId))) {
        throw new Error('Session entries are invalid.');
      }
      if (entry.type === 'branch_summary' || entry.type === 'compaction') {
        if (!entry.summary.trim() || Buffer.byteLength(entry.summary) > 1024 * 1024
          || (entry.type === 'branch_summary' && !isBoundedSessionString(entry.branchName, 4_096))
          || (entry.type === 'compaction' && !isValidEntryId(entry.firstKeptEntryId))) {
          throw new Error('Session entries are invalid.');
        }
      } else {
        if (entry.type === 'custom') copySessionCustomValue(entry.data);
        else if (entry.type === 'custom_message') copySessionCustomValue(entry.details);
        boundedSessionJson(entry, 2 * 1024 * 1024, 'Custom session entry exceeds its size limit.');
      }
      entryIds.add(entry.id);
    }

    let encodedSession: string;
    try { encodedSession = JSON.stringify(entries.length ? [session, ...entries] : session); }
    catch { throw new Error('Session data is invalid.'); }
    if (Buffer.byteLength(encodedSession) > MAX_SESSION_FILE_BYTES) {
      throw new Error('Session file exceeds its size limit.');
    }

    const initialEntries: SessionEntry[] = [
      ...session.messages.map(messageToEntry),
      ...(session.commands ?? []).map(command => ({
        ...command,
        type: 'command' as const,
        version: SESSION_SCHEMA_VERSION,
        timestamp: command.timestamp.getTime(),
      })),
      ...entries,
    ].sort((left, right) => left.timestamp - right.timestamp);
    if (!session.activeLeafId) session.activeLeafId = initialEntries.at(-1)?.id;
    await this.persistSession(session, entries, { requireAbsent: true }, () => {
      admission?.check();
      admission?.admit();
    });
    this.sessions.set(session.id, session);
    this.volatileEntries.set(session.id, initialEntries);
    this.onSessionUpdate?.(session.id);
    
    // Emit session:create event
    await this.emitter.emit('session:create', { sessionId: session.id, title: session.title });
    return session;
  }

  /** Get a session by ID */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** List all sessions (sorted by updatedAt, newest first) */
  list(): Session[] {
    const sorted = Array.from(this.sessions.values()).sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    return sorted;
  }

  /** Add a message to a session and persist it */
  async addMessage(
    sessionId: string,
    message: Omit<Message, 'id' | 'timestamp'>,
    options: { signal?: AbortSignal; skipAutoCompaction?: boolean } = {},
  ): Promise<Session | null> {
    message = this.redactJson(message);
    if (!message || typeof message !== 'object'
      || !['user', 'assistant', 'system', 'tool'].includes(message.role)
      || typeof message.content !== 'string'
      || (message.parentMessageId !== undefined && !isValidEntryId(message.parentMessageId))
      || (message.provider !== undefined && !isBoundedSessionString(message.provider, 128))
      || (message.model !== undefined && !isBoundedSessionString(message.model, 500))
      || (message.toolCallId !== undefined && !isBoundedSessionString(message.toolCallId, 256))
      || (message.name !== undefined && !isBoundedSessionString(message.name, 256))
      || (message.isError !== undefined && typeof message.isError !== 'boolean')
      || (message.durationMs !== undefined && (typeof message.durationMs !== 'number'
        || !Number.isFinite(message.durationMs) || message.durationMs < 0))
      || (message.metadata !== undefined
        && (!message.metadata || typeof message.metadata !== 'object' || Array.isArray(message.metadata)))
      || (message.blocks !== undefined && (!Array.isArray(message.blocks) || message.blocks.length > 1_024))
      || (message.toolCalls !== undefined && (!Array.isArray(message.toolCalls) || message.toolCalls.length > 1_024))) {
      throw new Error('Session message is invalid.');
    }
    const normalizedUsage = normalizedSessionUsage(message.usage);
    message = { ...message, ...(normalizedUsage ? { usage: normalizedUsage } : { usage: undefined }) };
    boundedSessionJson(message, MAX_SESSION_MESSAGE_BYTES, 'Session message exceeds its size limit.');
    const session = await this.withSessionMutation(sessionId, async () => {
      const current = this.sessions.get(sessionId);
      if (!current) return null;
      if (current.messages.length >= MAX_SESSION_MESSAGES) throw new Error('Session message limit reached.');

      const parentMessageId = message.parentMessageId ?? current.activeLeafId;
      const messageWithParent = parentMessageId ? { ...message, parentMessageId } : message;
      const msgId = crypto.randomUUID();
      const fullMessage: Message = {
        id: msgId,
        ...messageWithParent,
        // Preserve append order even when the wall clock is coarse or moves backwards.
        timestamp: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
      };
      const next: Session = {
        ...current,
        messages: [...current.messages, fullMessage],
        activeLeafId: msgId,
        updatedAt: new Date(),
      };
      if (current.metadata?.activeLeafReset === true) {
        const metadata = { ...current.metadata };
        delete metadata.activeLeafReset;
        next.metadata = metadata;
      }
      if (message.usage) {
        const hadPreviousUsage = current.usage !== undefined;
        const previous = current.usage ?? {};
        const cumulativeCost = message.usage.costUsd === undefined
          || (hadPreviousUsage && previous.costUsd === undefined)
          ? undefined
          : (previous.costUsd ?? 0) + message.usage.costUsd;
        next.usage = {
          inputTokens: saturatedUsageAdd(previous.inputTokens, message.usage.inputTokens),
          outputTokens: saturatedUsageAdd(previous.outputTokens, message.usage.outputTokens),
          cacheReadTokens: saturatedUsageAdd(previous.cacheReadTokens, message.usage.cacheReadTokens),
          cacheWriteTokens: saturatedUsageAdd(previous.cacheWriteTokens, message.usage.cacheWriteTokens),
          totalTokens: saturatedUsageAdd(previous.totalTokens, message.usage.totalTokens
            ?? saturatedUsageAdd(message.usage.inputTokens,
              saturatedUsageAdd(message.usage.outputTokens,
                saturatedUsageAdd(message.usage.cacheReadTokens, message.usage.cacheWriteTokens)))),
          ...(cumulativeCost === undefined ? {} : { costUsd: Math.min(Number.MAX_SAFE_INTEGER, cumulativeCost) }),
        };
      }
      if (!current.title && message.role === 'user') {
        next.title = generatedSessionTitle(message.content);
      }

      await this.persistSession(next);
      Object.assign(current, next);
      if (!this.usesSessionStore()) this.volatileEntries.get(sessionId)?.push(messageToEntry(fullMessage));
      return current;
    });
    if (!session) return null;
    this.onSessionUpdate?.(sessionId);

    // Emit message:add event
    await this.emitter.emit('message:add', {
      sessionId,
      role: message.role,
      contentLength: message.content.length,
    });
    await this.emitter.emit('session:update', {
      sessionId,
      messageCount: session.messages.length,
    });
    
    // Auto-compact if enabled and we have enough messages with significant context
    if (!options.skipAutoCompaction && this.compactionSettings.enabled && session.messages.length >= 4) {
      await this.checkAndTriggerCompaction(session.id, options.signal);
    }

    return session;
  }

  /** Persist a shell command and keep its context policy explicit. */
  async addCommand(
    sessionId: string,
    command: Omit<ShellCommandRecord, 'id' | 'timestamp'> & Partial<Pick<ShellCommandRecord, 'id' | 'timestamp'>>,
  ): Promise<ShellCommandRecord | null> {
    command = this.redactJson(command);
    if (!command || typeof command !== 'object' || typeof command.command !== 'string'
      || Buffer.byteLength(command.command) > 1_000_000
      || !isBoundedSessionString(command.cwd, 4_096)
      || (command.id !== undefined && !isValidEntryId(command.id))
      || (command.parentEntryId !== undefined && !isValidEntryId(command.parentEntryId))
      || (command.timestamp !== undefined && !isValidDate(new Date(command.timestamp)))
      || (command.output !== undefined && typeof command.output !== 'string')
      || (command.exitCode !== undefined && !Number.isSafeInteger(command.exitCode))
      || (command.durationMs !== undefined && (typeof command.durationMs !== 'number'
        || !Number.isFinite(command.durationMs) || command.durationMs < 0))
      || (command.excludedFromContext !== undefined && typeof command.excludedFromContext !== 'boolean')
      || (command.truncated !== undefined && typeof command.truncated !== 'boolean')
      || (command.downloadPath !== undefined && !isBoundedSessionString(command.downloadPath, 4_096))
      || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(command.status)) {
      throw new Error('Session command is invalid.');
    }
    boundedSessionJson(command, MAX_SESSION_COMMAND_BYTES, 'Session command exceeds its size limit.');
    const record = await this.withSessionMutation(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) return null;
      if ((session.commands?.length ?? 0) >= MAX_SESSION_COMMANDS) {
        throw new Error('Session command limit reached.');
      }
      const commandWithParent = command.parentEntryId || !session.activeLeafId
        ? command
        : { ...command, parentEntryId: session.activeLeafId };
      const nextRecord: ShellCommandRecord = {
        ...commandWithParent,
        id: command.id ?? `command-${crypto.randomUUID()}`,
        timestamp: command.timestamp ? new Date(command.timestamp) : new Date(),
      };
      const next: Session = {
        ...session,
        commands: [...(session.commands ?? []), nextRecord],
        activeLeafId: nextRecord.id,
        updatedAt: new Date(),
      };
      if (session.metadata?.activeLeafReset === true) {
        const metadata = { ...session.metadata };
        delete metadata.activeLeafReset;
        next.metadata = metadata;
      }
      await this.persistSession(next);
      Object.assign(session, next);
      if (!this.usesSessionStore()) {
        this.volatileEntries.get(sessionId)?.push({
          ...nextRecord,
          type: 'command',
          version: SESSION_SCHEMA_VERSION,
          timestamp: nextRecord.timestamp.getTime(),
        });
      }
      return nextRecord;
    });
    if (!record) return null;
    this.onSessionUpdate?.(sessionId);
    return record;
  }

  /** Update mutable session metadata and persist it. */
  async update(
    id: string,
    changes: MutableSessionChanges,
  ): Promise<Session | null> {
    changes = this.redactJson(changes);
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new Error('Session update is invalid.');
    }
    const session = await this.withSessionMutation(id, async () => {
      const current = this.sessions.get(id);
      if (!current) return null;
      const next: Session = { ...current };
      const fields: Array<keyof MutableSessionFields> = [
        'title', 'metadata', 'providerConfig', 'activeLeafId', 'agentId', 'cwd',
        'workspaceId', 'gitBranch', 'model', 'thinking', 'toolPreset', 'autoCompaction', 'usage',
      ];
      for (const field of fields) {
        const value = changes[field];
        if (value === null) Object.assign(next, { [field]: undefined });
        else if (value !== undefined) Object.assign(next, {
          [field]: field === 'providerConfig'
            ? sanitizeProviderConfig(changes.providerConfig ?? undefined)
            : field === 'usage' ? normalizedSessionUsage(changes.usage ?? undefined)
              : value,
        });
      }
      const boundedStrings: Array<[unknown, number]> = [
        [next.title, 4_096], [next.activeLeafId, 256], [next.agentId, 256], [next.cwd, 4_096],
        [next.workspaceId, 256], [next.gitBranch, 1_024], [next.model, 500],
      ];
      if (boundedStrings.some(([value, limit]) => value !== undefined
        && (typeof value !== 'string' || Buffer.byteLength(value) > limit
          || UNSAFE_SESSION_STRING.test(value)))) {
        throw new Error('Session update is invalid.');
      }
      if (next.thinking !== undefined
        && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(next.thinking)) {
        throw new Error('Session update is invalid.');
      }
      if (next.toolPreset !== undefined
        && !['configured', 'chat-only', 'read-only', 'default', 'full'].includes(next.toolPreset)) {
        throw new Error('Session update is invalid.');
      }
      if (next.autoCompaction !== undefined && typeof next.autoCompaction !== 'boolean') {
        throw new Error('Session update is invalid.');
      }
      if (next.metadata !== undefined) {
        if (!next.metadata || typeof next.metadata !== 'object' || Array.isArray(next.metadata)) {
          throw new Error('Session update is invalid.');
        }
        boundedSessionJson(next.metadata, 8 * 1024 * 1024, 'Session metadata exceeds its size limit.');
      }
      next.updatedAt = new Date();
      boundedSessionJson(next, MAX_SESSION_FILE_BYTES, 'Session file exceeds its size limit.');
      await this.persistSession(next);
      Object.assign(current, next);
      return current;
    });
    if (!session) return null;
    this.onSessionUpdate?.(id);
    await this.emitter.emit('session:update', { sessionId: id, messageCount: session.messages.length });
    return session;
  }

  /** Delete a session */
  async delete(id: string): Promise<boolean> {
    this.branchAdmissions.retire(id, undefined, true);
    const deleted = await this.withSessionMutation(id, async () => {
      if (!this.sessions.has(id)) return false;
      await this.persistDelete(id);
      this.sessions.delete(id);
      this.volatileEntries.delete(id);
      this.committedEntries.delete(id);
      return true;
    });
    if (!deleted) return false;
    this.onSessionUpdate?.(id);

    // Emit session:delete event
    await this.emitter.emit('session:delete', { sessionId: id });
    return true;
  }

  /** Clear all process-local sessions after already accepted mutations settle. */
  async clear(): Promise<void> {
    this.branchAdmissions.retire(undefined, undefined, true);
    if (this.clearInProgress) return this.clearInProgress;
    const operation = (async () => {
      while (this.activeSessionMutations > 0) {
        await new Promise<void>(resolve => { this.sessionMutationIdleWaiters.add(resolve); });
      }
      this.sessions.clear();
      this.volatileEntries.clear();
      this.committedEntries.clear();
    })();
    this.clearInProgress = operation;
    try { await operation; }
    finally {
      if (this.clearInProgress === operation) this.clearInProgress = undefined;
    }
  }

  /** Load a session from the JSONL store into memory */
  async loadFromStore(sessionId: string): Promise<Session | null> {
    const store = this.store;
    if (!store) return null;
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session ID.');

    return this.withSessionMutation(sessionId, async () => {
      const session = await store.loadSession(sessionId);
      if (!session) return null;
      await this.persistSession(session);
      this.sessions.set(session.id, session);
      return session;
    });
  }

  /** Get the current token count for a session */
  getTokenCount(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;

    return TokenEstimator.totalMessages(this.getEffectiveContext(sessionId));
  }

  /** Get the effective context for a session (after applying any compactions) */
  getEffectiveContext(sessionId: string): SessionEntry[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const journal = this.usesSessionStore()
      ? this.committedEntries.get(sessionId) : this.volatileEntries.get(sessionId);
    let entries: MessageEntry[];
    if (journal && (session.metadata?.hasBranchedHistory === true || readLegacyCompactionPrefix(session.metadata) !== undefined
      || journal.some(entry => entry.type === 'compaction' || entry.type === 'branch_summary'
        || entry.type === 'custom' || entry.type === 'custom_message' || entry.type === 'context_edit' || entry.type === 'loadout'))) {
      entries = structuredClone(projectSessionContext(journal, session.activeLeafId,
        session.metadata?.hasBranchedHistory === true, session.metadata?.activeLeafReset === true,
        typeof session.metadata?.legacyRootBoundaryId === 'string' ? session.metadata.legacyRootBoundaryId : undefined));
    } else entries = completeContextToolGroups(orderContextEntries([
      ...session.messages.map(messageToEntry),
      ...(session.commands ?? [])
        .filter(command => !command.excludedFromContext && command.status !== 'queued' && command.status !== 'running')
        .map(command => ({
          id: `context-${command.id}`,
          parentMessageId: command.parentEntryId,
          type: 'message' as const,
          version: SESSION_SCHEMA_VERSION,
          role: 'user' as const,
          content: `[Shell command]\n$ ${command.command}\n${command.output ?? ''}\n[exit ${command.exitCode ?? 'unknown'}]`,
          timestamp: command.timestamp.getTime(),
          blocks: [{
            type: 'command' as const,
            command: command.command,
            cwd: command.cwd,
            output: command.output,
            status: command.status,
            exitCode: command.exitCode,
            durationMs: command.durationMs,
            excludedFromContext: false,
            truncated: command.truncated,
          }],
          metadata: { sourceCommandId: command.id },
        })),
    ]) as MessageEntry[]);
    const compactionIds = new Set(journal?.filter(entry => entry.type === 'compaction').map(entry => entry.id));
    if (entries.some(entry => entry.role === 'system' && compactionIds.has(entry.id))) return entries;
    const legacyPrefix = readLegacyCompactionPrefix(session.metadata);
    if (legacyPrefix) {
      if (!legacyCompactionPrefixApplies(legacyPrefix, session, journal ?? [])) return entries;
      return [{ id: `legacy-compaction-${session.id}`, type: 'message', role: 'system',
        content: `[Context Summary] ${legacyPrefix.summary}`, timestamp: legacyPrefix.timestamp }, ...entries];
    }
    const summary = session.metadata?.compactionSummary;
    if (typeof summary !== 'string' || !summary) return entries;

    const compactedAt = typeof session.metadata?.lastCompacted === 'string'
      ? new Date(session.metadata.lastCompacted).getTime()
      : session.updatedAt.getTime();
    return [{
      id: typeof session.metadata?.compactionEntryId === 'string'
        ? session.metadata.compactionEntryId
        : `compaction-summary-${session.id}`,
      type: 'message',
      role: 'system',
      content: `[Context Summary] ${summary}`,
      timestamp: Number.isNaN(compactedAt) ? session.updatedAt.getTime() : compactedAt,
    }, ...entries];
  }

  /** Estimate the current model-visible context with the same estimator used by compaction. */
  estimateContextTokens(sessionId: string): number {
    return TokenEstimator.totalMessages(this.getEffectiveContext(sessionId));
  }

  /** Request compaction for a session (returns the entries to be compacted) */
  requestCompaction(sessionId: string, reason: 'threshold' | 'overflow' = 'threshold'): { toCompact: SessionEntry[]; keptEntries: SessionEntry[] } | null {
    const session = this.sessions.get(sessionId);
    if (!session || !this.compactionSettings.enabled) return null;

    const entries = structuredClone(this.getEffectiveContext(sessionId))
      .filter((entry): entry is MessageEntry => entry.type === 'message');
    if (entries.length < 4) return null;
    const keep = Object.getOwnPropertyDescriptor(this.compactionSettings, 'keepRecentTokens');
    if (!keep || !('value' in keep) || typeof keep.value !== 'number' || !Number.isSafeInteger(keep.value) || keep.value < 0) {
      throw new Error('Compaction cut policy is invalid.');
    }
    const cut = selectCompactionCut(entries, entries.map(entry => TokenEstimator.estimateMessageEntry(entry)),
      Math.max(1, keep.value), reason);
    // Preserve the existing mutable two-array callback/public return shape.
    return cut ? { toCompact: cut.toCompact, keptEntries: cut.keptEntries } : null;
  }

  /** Capture before a host awaits summary generation; no provider or store work is started. */
  captureCompactionSource(sessionId: string): Readonly<SessionCompactionSource> | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const source = Object.freeze({ sourceSessionId: sessionId, ...(session.activeLeafId ? { entryId: session.activeLeafId } : {}) });
    this.compactionSources.set(source, this.compactionAdmission(sessionId));
    return source;
  }

  private compactionAdmission(sessionId: string): SessionPublicationAdmission & { sourceSessionId: string } {
    const session = this.sessions.get(sessionId), leaf = session?.activeLeafId;
    const store = this.store, generation = this.storeGeneration;
    const canonicalIdentity = (): boolean => {
      if (!session) return true; // Keep legacy missing-session publication a no-op.
      const descriptor = Object.getOwnPropertyDescriptor(session, 'id');
      return !!descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === sessionId;
    };
    if (!canonicalIdentity()) throw new Error('Compaction context or policy changed.');
    // Compare the same owned representation on both sides: structuredClone normalizes
    // valid null-prototype custom JSON in true-memory journals to ordinary objects.
    const currentJournal = (): SessionEntry[] => structuredClone((this.committedEntries.get(sessionId)
      ?? this.volatileEntries.get(sessionId) ?? []).filter(entry => entry.type !== 'metadata'));
    const currentLegacy = (): unknown[] => ['compactionSummary', 'lastCompacted', 'compactionEntryId', 'aiHarnessLegacyCompactionPrefix',
      'legacyRootBoundaryId', 'hasBranchedHistory', 'activeLeafReset'].map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(session?.metadata ?? {}, key);
      if (descriptor && !('value' in descriptor)) throw new Error('Compaction context or policy changed.');
      if (key === 'aiHarnessLegacyCompactionPrefix') return readLegacyCompactionPrefix(session?.metadata);
      const value: unknown = descriptor?.value;
      return key === 'hasBranchedHistory' || key === 'activeLeafReset' ? value === true : typeof value === 'string' ? value : undefined;
    });
    // Preserve the shared legacy validation error and never clone/serialize its unvalidated input.
    const metadata = currentLegacy();
    let journal: SessionEntry[], legacy: unknown[];
    try {
      const entries = currentJournal();
      boundedSessionJson(entries, MAX_SESSION_FILE_BYTES, 'Compaction source is invalid.');
      boundedSessionJson(metadata, MAX_SESSION_FILE_BYTES, 'Compaction source is invalid.');
      journal = entries; legacy = structuredClone(metadata);
    } catch { throw new Error('Compaction source is invalid.'); }
    let admitted = false;
    const check = (): void => {
      if (admitted || this.sessions.get(sessionId) !== session || !canonicalIdentity() || session?.activeLeafId !== leaf
        || this.store !== store || this.storeGeneration !== generation || !isDeepStrictEqual(currentJournal(), journal)
        || !isDeepStrictEqual(currentLegacy(), legacy)) throw new Error('Compaction context or policy changed.');
    };
    return { sourceSessionId: sessionId, check, admit: () => { check(); admitted = true; } };
  }

  /** Apply a compaction by adding a summary entry. */
  async applyCompaction(
    sessionId: string,
    summary: string,
    firstKeptEntryId: string,
    details: CompactionDetails = {},
    options: SessionCompactionOptions = {},
  ): Promise<void> {
    const { signal, source } = copyCompactionOptions(options);
    if (isCompactionAborted(signal)) throw new DOMException('Compaction cancelled', 'AbortError');
    const admission = source ? this.compactionSources.get(source) : this.compactionAdmission(sessionId);
    if (!admission || admission.sourceSessionId !== sessionId) throw new Error('Compaction source is invalid.');
    const validate = (): void => {
      if (isCompactionAborted(signal)) throw new DOMException('Compaction cancelled', 'AbortError');
      admission.check();
    };
    validate();
    const applied = await this.applyCompactionResult(sessionId, summary, firstKeptEntryId, details, validate, admission.admit,
      1024 * 1024, false, signal);
    // Legacy four-slot invalid boundaries remain no-ops. A captured publication must
    // report refusal, never let a generation owner publish a false completion event.
    if (!applied && source) throw new Error('Compaction boundary is not an active model entry.');
  }

  private async applyCompactionResult(
    sessionId: string,
    summary: string,
    firstKeptEntryId: string,
    details: CompactionDetails = {},
    validateAdmission?: () => void,
    admit?: () => void,
    maxSummaryBytes = 1024 * 1024,
    preparedSummary = false,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!preparedSummary) summary = this.redactText(summary);
    const originalSummaryTokens = TokenEstimator.estimateTokens(summary);
    const hookGeneration = this.compactionHookGeneration;
    const checkHooks = (): void => {
      validateAdmission?.();
      if (hookGeneration !== this.compactionHookGeneration) throw new Error('Compaction hook generation changed.');
    };
    for (const hook of [...this.compactionHooks.values()]) {
      checkHooks();
      const result = await hook(Object.freeze({ sessionId, firstKeptEntryId, summary, maxOutputBytes: maxSummaryBytes,
        signal: signal ?? new AbortController().signal }));
      checkHooks();
      if (result === false) throw new DOMException('Compaction cancelled by a hook.', 'AbortError');
      if (result !== undefined) {
        const copied = copySessionCustomValue(result) as { summary: string };
        if (!copied || Object.keys(copied).length !== 1 || typeof copied.summary !== 'string'
          || !copied.summary.trim() || Buffer.byteLength(copied.summary) > maxSummaryBytes) throw new Error('Compaction hook result is invalid.');
        summary = this.redactText(copied.summary);
      }
    }
    details = this.redactJson(details);
    if (details.tokensAfter !== undefined && Number.isSafeInteger(details.tokensAfter) && details.tokensAfter >= 0) {
      details = { ...details, tokensAfter: Math.max(0, details.tokensAfter - originalSummaryTokens + TokenEstimator.estimateTokens(summary)) };
    }
    if (!summary.trim() || Buffer.byteLength(summary) > maxSummaryBytes || !isValidEntryId(firstKeptEntryId)
      || (details.instruction !== undefined && (typeof details.instruction !== 'string'
        || Buffer.byteLength(details.instruction) > 1024 * 1024))
      || (details.provider !== undefined && !isBoundedSessionString(details.provider, 128))
      || (details.model !== undefined && !isBoundedSessionString(details.model, 500))
      || (details.tokensBefore !== undefined && (!Number.isSafeInteger(details.tokensBefore) || details.tokensBefore < 0))
      || (details.tokensAfter !== undefined && (!Number.isSafeInteger(details.tokensAfter) || details.tokensAfter < 0))) {
      throw new Error('Session compaction is invalid.');
    }
    const normalizedUsage = normalizedSessionUsage(details.usage);
    details = { ...details, ...(normalizedUsage ? { usage: normalizedUsage } : { usage: undefined }) };
    const compacted = await this.withSessionMutation(sessionId, async () => {
      // Recheck after queue waits, before beginning persistence. A started write is not rolled back.
      validateAdmission?.();
      const session = this.sessions.get(sessionId);
      if (!session) return false;

      // Resolve nonordinary boundaries through the same owned model projection and raw ancestry.
      // A provider-supplied private ID, orphan or ambiguous projected link grants no authority.
      const firstKeptIndex = session.messages.findIndex(message => message.id === firstKeptEntryId);
      let messages = session.messages.slice(firstKeptIndex);
      if (firstKeptIndex < 0) {
        const model = this.getEffectiveContext(sessionId);
        if (model.filter(entry => entry.id === firstKeptEntryId).length !== 1) return false;
        const raw = await this.getRawEntries(sessionId);
        validateAdmission?.();
        const activePath = sessionContextPath(raw, session.activeLeafId, session.metadata?.hasBranchedHistory === true,
          session.metadata?.activeLeafReset === true, typeof session.metadata?.legacyRootBoundaryId === 'string'
            ? session.metadata.legacyRootBoundaryId : undefined);
        const retainedIds = contextBoundaryMessageIds(activePath, firstKeptEntryId);
        if (!retainedIds) return false;
        messages = session.messages.filter(message => retainedIds.has(message.id));
      }
      let legacyPrefix = readLegacyCompactionPrefix(session.metadata);
      if (!legacyPrefix && typeof Object.getOwnPropertyDescriptor(session.metadata ?? {}, 'compactionSummary')?.value === 'string') {
        legacyPrefix = captureLegacyCompactionPrefix(session, await this.getRawEntries(sessionId));
        // The extra legacy read is still before write admission, never a cancellation gap.
        validateAdmission?.();
      }

      const rawPath = sessionContextPath(this.committedEntries.get(sessionId) ?? this.volatileEntries.get(sessionId) ?? [],
        session.activeLeafId, session.metadata?.hasBranchedHistory === true, session.metadata?.activeLeafReset === true,
        typeof session.metadata?.legacyRootBoundaryId === 'string' ? session.metadata.legacyRootBoundaryId : undefined);
      const loadout = reconstructLoadout(rawPath);
      const modelContext = this.getEffectiveContext(sessionId).filter((entry): entry is MessageEntry => entry.type === 'message');
      const boundaryIndex = modelContext.findIndex(entry => entry.id === firstKeptEntryId);
      const splitUserEntryId = boundaryIndex >= 0 && modelContext[boundaryIndex].role !== 'user'
        ? modelContext.slice(0, boundaryIndex).reverse().find(entry => entry.role === 'user')?.id : undefined;
      const checkpoint: SessionCompactionCheckpoint = this.redactJson({ ...(loadout ? { loadout } : {}),
        fileOperations: collectFileOperations(rawPath), ...(splitUserEntryId ? { splitUserEntryId } : {}) });
      const updatedAt = new Date();
      const compactionEntry: CompactionEntry = {
        id: `compaction-${crypto.randomUUID()}`,
        type: 'compaction',
        version: SESSION_SCHEMA_VERSION,
        ...(session.activeLeafId ? { parentEntryId: session.activeLeafId } : {}),
        summary: summary.trim(),
        firstKeptEntryId,
        checkpoint,
        tokenEstimate: TokenEstimator.totalMessages(messages.map(messageToEntry)),
        timestamp: updatedAt.getTime(),
        ...details,
      };
      if (!validContextStateEntry(compactionEntry as unknown as Record<string, unknown>)) throw new Error('Compaction checkpoint is invalid.');
      const next: Session = {
        ...session,
        messages,
        activeLeafId: compactionEntry.id,
        updatedAt,
        metadata: {
          ...session.metadata,
          ...(legacyPrefix ? { aiHarnessLegacyCompactionPrefix: legacyPrefix } : {}),
          lastCompacted: updatedAt.toISOString(),
          compactionSummary: summary.trim(),
          compactionStats: details,
          compactionEntryId: compactionEntry.id,
        },
      };
      // Structural-store preparation may await after the mutation-queue check.
      // Revalidate immediately before its captured save, not after an admitted write.
      await this.persistSession(next, [compactionEntry], {}, () => { checkHooks(); admit?.(); });
      Object.assign(session, next);
      if (!this.usesSessionStore()) this.volatileEntries.get(sessionId)?.push(compactionEntry);
      return true;
    });
    if (compacted) this.onSessionUpdate?.(sessionId);
    return compacted;
  }


  /** Load sessions from JSONL store on initialization */
  async loadAllSessions(): Promise<void> {
    if (!this.store) return;

    const store = this.store;
    const sessionIds = await store.listSessionIds();
    for (const id of sessionIds) {
      await this.withSessionMutation(id, async () => {
        const session = await store.loadSession(id);
        if (!session) return;
        await this.persistSession(session);
        this.sessions.set(session.id, session);
      });
    }
  }

  /** Persist a summary for a branch without altering its messages. */
  async addBranchSummary(sessionId: string, summary: string, branchName?: string,
    accounting: BranchSummaryAccounting = {}): Promise<BranchSummaryEntry | null> {
    const provenance = this.redactJson(copyBranchSummaryAccounting(accounting));
    summary = this.redactText(summary);
    branchName = branchName === undefined ? undefined : this.redactText(branchName);
    if (!summary.trim() || Buffer.byteLength(summary) > 1024 * 1024
      || (branchName !== undefined && !isBoundedSessionString(branchName, 4_096))) return null;
    const entry = await this.withSessionMutation(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) return null;
      const resolvedBranchName = branchName || session.title || session.id;
      const previousSummaries = (session.metadata?.branchSummaries as BranchSummaryEntry[] | undefined) ?? [];
      if (!Array.isArray(previousSummaries) || previousSummaries.length >= 10_000) {
        throw new Error('Session branch summary limit reached.');
      }
      const nextEntry: BranchSummaryEntry = {
        id: `branch-summary-${crypto.randomUUID()}`,
        type: 'branch_summary',
        version: SESSION_SCHEMA_VERSION,
        ...(session.activeLeafId ? { parentEntryId: session.activeLeafId } : {}),
        branchName: resolvedBranchName,
        summary: summary.trim(),
        ...provenance,
        timestamp: Date.now(),
      };
      const next: Session = {
        ...session,
        metadata: {
          ...session.metadata,
          branchSummaries: [...previousSummaries, nextEntry],
        },
        activeLeafId: nextEntry.id,
        updatedAt: new Date(),
      };
      await this.persistSession(next, [nextEntry]);
      Object.assign(session, next);
      if (!this.usesSessionStore()) this.volatileEntries.get(sessionId)?.push(nextEntry);
      return nextEntry;
    });
    if (entry) this.onSessionUpdate?.(sessionId);
    return entry;
  }

  /** Append private, parented extension state without making it a model message. */
  async appendCustomEntry(sessionId: string, customType: string, data?: unknown): Promise<CustomSessionEntry | null> {
    if (typeof customType !== 'string' || !customType || !isBoundedSessionString(customType, 256)) {
      throw new Error('Custom session type is invalid.');
    }
    const copied = this.redactJson(copySessionCustomValue(data));
    return this.appendCustomSessionEntry(sessionId, {
      id: `custom-${crypto.randomUUID()}`, type: 'custom', version: SESSION_SCHEMA_VERSION,
      timestamp: Date.now(), customType: this.redactText(customType), ...(copied !== undefined ? { data: copied } : {}),
    });
  }

  /** Display is a UI preference only; every custom_message contributes its content to context. */
  async appendCustomMessage(sessionId: string, customType: string, content: string,
    options: { display?: boolean; details?: unknown } = {}, admission: SessionBranchOptions = {}): Promise<CustomMessageEntry | null> {
    if (typeof customType !== 'string' || !customType || !isBoundedSessionString(customType, 256)) {
      throw new Error('Custom session type is invalid.');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Custom session message is invalid.');
    const copiedOptions: { display?: boolean; details?: unknown } = {};
    for (const key of Reflect.ownKeys(options)) {
      if (key !== 'display' && key !== 'details') throw new Error('Custom session message is invalid.');
      const property = Object.getOwnPropertyDescriptor(options, key);
      if (!property || !('value' in property)) throw new Error('Custom session message is invalid.');
      if (property.value === undefined) continue;
      if (key === 'display') {
        if (typeof property.value !== 'boolean') throw new Error('Custom session message is invalid.');
        copiedOptions.display = property.value;
      } else copiedOptions.details = copySessionCustomValue(property.value);
    }
    if (typeof content !== 'string') throw new Error('Custom session message is invalid.');
    const safeContent = this.redactText(content);
    if (Buffer.byteLength(safeContent) > 1024 * 1024) throw new Error('Custom session message exceeds its size limit.');
    return this.appendCustomSessionEntry(sessionId, {
      id: `custom-message-${crypto.randomUUID()}`, type: 'custom_message', version: SESSION_SCHEMA_VERSION,
      timestamp: Date.now(), customType: this.redactText(customType), content: safeContent,
      display: copiedOptions.display !== false,
      ...(copiedOptions.details !== undefined ? { details: this.redactJson(copiedOptions.details) } : {}),
    }, undefined, admission);
  }

  /** Owned historical state only; it never supplies current execution authority. */
  getSessionLoadout(sessionId: string): SessionLoadout | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return reconstructLoadout(sessionContextPath(this.committedEntries.get(sessionId) ?? this.volatileEntries.get(sessionId) ?? [],
      session.activeLeafId, session.metadata?.hasBranchedHistory === true, session.metadata?.activeLeafReset === true,
      typeof session.metadata?.legacyRootBoundaryId === 'string' ? session.metadata.legacyRootBoundaryId : undefined));
  }

  async appendContextEdit(sessionId: string, edit: SessionContextEdit, options: SessionBranchOptions = {}): Promise<ContextEditEntry | null> {
    const copied = copyContextEdit(this.redactJson(copyContextEdit(edit)));
    const value: ContextEditEntry = { ...copied, id: `context-edit-${crypto.randomUUID()}`,
      type: 'context_edit', version: SESSION_SCHEMA_VERSION, timestamp: Date.now() };
    return this.appendCustomSessionEntry(sessionId, value, () => {
      const target = this.getEffectiveContext(sessionId).find(entry => entry.id === copied.targetEntryId
        || (entry.type === 'message' && entry.metadata?.sourceCommandId === copied.targetEntryId));
      // Repeated edits may restore an omitted entry on the same active path, but cannot edit a compacted prefix.
      const session = this.sessions.get(sessionId)!;
      const path = sessionContextPath(this.committedEntries.get(sessionId) ?? this.volatileEntries.get(sessionId) ?? [],
        session.activeLeafId, session.metadata?.hasBranchedHistory === true, session.metadata?.activeLeafReset === true,
        typeof session.metadata?.legacyRootBoundaryId === 'string' ? session.metadata.legacyRootBoundaryId : undefined);
      const withoutEdits = projectContextPath(path.filter(entry => entry.type !== 'context_edit'));
      const original = withoutEdits.find(entry => entry.id === copied.targetEntryId || entry.metadata?.sourceCommandId === copied.targetEntryId);
      if (!target && !original) throw new Error('Context edit target is not an active model entry.');
      // Persist a command's raw identity, not its model-only context- alias.
      const commandId = original?.metadata?.sourceCommandId;
      if (typeof commandId === 'string') value.targetEntryId = commandId;
    }, options);
  }

  async recordSessionLoadout(sessionId: string, loadout: SessionLoadout, options: SessionBranchOptions = {}): Promise<LoadoutEntry | null> {
    const copied = copyLoadout(this.redactJson(copyLoadout(loadout)));
    const value: LoadoutEntry = { id: `loadout-${crypto.randomUUID()}`, type: 'loadout', version: SESSION_SCHEMA_VERSION,
      timestamp: Date.now(), changes: copied };
    return this.appendCustomSessionEntry(sessionId, value, () => {
      value.changes = loadoutChanges(this.getSessionLoadout(sessionId), copied);
      return Object.keys(value.changes).length ? undefined : false;
    }, options);
  }

  private async appendCustomSessionEntry<T extends CustomSessionEntry | CustomMessageEntry | ContextEditEntry | LoadoutEntry>(
    sessionId: string, value: T, prepare?: () => void | false, options: SessionBranchOptions = {},
  ): Promise<T | null> {
    if ((value.type === 'custom' || value.type === 'custom_message')
      && (typeof value.customType !== 'string' || !value.customType || !isBoundedSessionString(value.customType, 256))) {
      throw new Error('Custom session type is invalid.');
    }
    boundedSessionJson(value, 2 * 1024 * 1024, 'Custom session entry exceeds its size limit.');
    const { signal } = copySessionBranchOptions(options);
    const store = this.store, generation = this.storeGeneration;
    const check = (): void => {
      if (isCompactionAborted(signal)) throw new DOMException('Session context operation cancelled.', 'AbortError');
      if (this.store !== store || this.storeGeneration !== generation) throw new Error('Session store changed.');
    };
    const result = await this.withSessionMutation(sessionId, async () => {
      check();
      const current = this.sessions.get(sessionId);
      if (!current) return null;
      if (prepare?.() === false) return null;
      const entry = { ...value, ...(current.activeLeafId ? { parentEntryId: current.activeLeafId } : {}) };
      if (!this.usesSessionStore()) {
        const journal = this.volatileEntries.get(sessionId) ?? [];
        if (journal.filter(item => item.type === 'custom' || item.type === 'custom_message').length >= MAX_SESSION_MESSAGES) {
          throw new Error('Session entry limit reached.');
        }
        boundedSessionJson([...journal, entry], MAX_SESSION_FILE_BYTES, 'Session file exceeds its size limit.');
      }
      const next: Session = { ...current, activeLeafId: entry.id, updatedAt: new Date() };
      await this.persistSession(next, [entry], {}, check);
      Object.assign(current, next);
      if (!this.usesSessionStore()) this.volatileEntries.get(sessionId)?.push(entry);
      return structuredClone(entry);
    });
    if (result) this.onSessionUpdate?.(sessionId);
    return result;
  }

  /**
   * Select an exact durable entry. Summary generation is opt-in and occurs outside
   * the mutation queue. Signal, identity and the complete source snapshot are
   * revalidated before a single durable publication; admitted writes are not rollback.
   */
  async navigateTree(sessionId: string, entryId: string,
    options: BranchNavigationOptions = {}): Promise<BranchNavigationResult> {
    const settings = copyBranchNavigationOptions(options, this.branchSummaryHooks.size > 0);
    if (settings.signal?.aborted) return { status: 'cancelled' };
    if (!isValidSessionId(sessionId) || !isValidEntryId(entryId)) return { status: 'not-found' };
    return this.withBranchTicket<BranchNavigationResult>(sessionId, settings.signal, async ticket => {
      try { return await this.navigateTreeWithAdmission(sessionId, entryId, { ...settings, signal: ticket.signal }, ticket, settings.signal); }
      catch (error) {
        if (ticket.authorityWithdrawn) return { status: 'stale' };
        if (ticket.signal.aborted || error instanceof SessionBranchCancelledError) return { status: 'cancelled' };
        throw error;
      }
    });
  }

  private async navigateTreeWithAdmission(sessionId: string, entryId: string, settings: BranchNavigationOptions,
    ticket: SessionBranchTicket, callerSignal?: AbortSignal): Promise<BranchNavigationResult> {
    const stamp = (session: Session, entries: readonly SessionEntry[]): string => createHash('sha256')
      .update(JSON.stringify(session)).update('\n').update(JSON.stringify(entries)).digest('hex');
    const snapshot = await ticket.waitFor(this.withSessionMutation(sessionId, async () => {
      if (settings.signal?.aborted) return null;
      const current = this.sessions.get(sessionId);
      if (!current) return null;
      if (current.commands?.some(command => command.status === 'running' || command.status === 'queued')) {
        throw new Error('Cannot navigate while a session command is pending.');
      }
      readLegacyCompactionPrefix(current.metadata);
      const original = await this.getRawEntries(sessionId);
      const legacyBoundary = typeof current.metadata?.legacyRootBoundaryId === 'string' ? current.metadata.legacyRootBoundaryId
        : current.metadata?.hasBranchedHistory !== true ? legacyRootBoundary(original) : undefined;
      const raw = legacyContextEntries(original, legacyBoundary);
      const target = new Map(raw.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, entry])).get(entryId);
      if (!target) return null;
      if (!sessionEntryPath(raw, entryId).complete) throw new Error('Session ancestry is incomplete.');
      const legacyPrefix = captureLegacyCompactionPrefix(current, original);
      return { current, raw: structuredClone(raw), from: current.activeLeafId, legacyBoundary, legacyPrefix,
        stamp: stamp(current, original) };
    }));
    if (settings.signal?.aborted) return { status: 'cancelled' };
    if (!snapshot) return { status: 'not-found' };
    const abandoned = collectAbandonedEntries(snapshot.raw, snapshot.from, entryId);
    const request = settings.summarize && snapshot.from && abandoned.length
      ? prepareBranchSummary(abandoned, snapshot.from, entryId, { ...settings, signal: callerSignal }) : undefined;
    let generated: { summary: string } & BranchSummaryAccounting | undefined;
    if (request) {
      const maxOutputBytes = Math.min(1024 * 1024, settings.reserveTokens ?? 16_384, request.maxOutputTokens * 4);
      let output: unknown = await this.runBranchSummaryHooks({ sourceSessionId: sessionId,
        fromEntryId: request.fromEntryId, targetEntryId: request.targetEntryId,
        transcript: request.messages.map(message => message.content).join('\n'), signal: ticket.signal,
        tokenBudget: request.tokenBudget, maxOutputTokens: request.maxOutputTokens, maxOutputBytes }, ticket);
      if (output === undefined) {
        if (!settings.summarizer) throw new Error('No branch summarizer configured.');
        output = await ticket.waitFor(Promise.resolve().then(() => settings.summarizer!(request)));
      }
      ticket.check();
      const { summary: rawSummary, ...accounting } = copyBranchSummaryOutput(output, maxOutputBytes);
      const summary = this.redactText(rawSummary).trim();
      if (!summary || Buffer.byteLength(summary) > maxOutputBytes) throw new Error('Branch summary result is invalid.');
      generated = { summary, ...this.redactJson(copyBranchSummaryAccounting(accounting)) };
    } else if (settings.summarize && !settings.summarizer) throw new Error('No branch summarizer configured.');
    const result = await ticket.waitFor(this.withSessionMutation(sessionId, async (): Promise<BranchNavigationResult> => {
      if (settings.signal?.aborted) return { status: 'cancelled' };
      const current = this.sessions.get(sessionId);
      if (current !== snapshot.current) return { status: 'stale' };
      const raw = await this.getRawEntries(sessionId);
      if (settings.signal?.aborted) return { status: 'cancelled' };
      if (stamp(current, raw) !== snapshot.stamp) return { status: 'stale' };
      const path = sessionEntryPath(legacyContextEntries(raw, snapshot.legacyBoundary), entryId).entries;
      const metadata: Record<string, unknown> = { ...current.metadata, hasBranchedHistory: true, activeLeafReset: false,
        ...(snapshot.legacyBoundary ? { legacyRootBoundaryId: snapshot.legacyBoundary } : {}),
        ...(snapshot.legacyPrefix ? { aiHarnessLegacyCompactionPrefix: snapshot.legacyPrefix } : {}) };
      delete metadata.lastCompacted;
      delete metadata.compactionSummary;
      delete metadata.compactionEntryId;
      delete metadata.compactionStats;
      let messages = path.flatMap(entry => entry.type === 'message' ? [messageFromEntry(entry)!] : []);
      const compaction = path.filter((entry): entry is CompactionEntry => entry.type === 'compaction').at(-1);
      if (compaction) {
        const firstKept = messages.findIndex(message => message.id === compaction.firstKeptEntryId);
        const retainedIds = contextBoundaryMessageIds(path, compaction.firstKeptEntryId, compaction.id);
        if (firstKept >= 0) messages = messages.slice(firstKept);
        else if (retainedIds) messages = messages.filter(message => retainedIds.has(message.id));
        else messages = messages.filter(message => {
          const position = path.findIndex(entry => entry.id === message.id);
          return position > path.indexOf(compaction);
        });
        Object.assign(metadata, { compactionSummary: compaction.summary, compactionEntryId: compaction.id,
          lastCompacted: new Date(compaction.timestamp).toISOString() });
      }
      const commands = path.flatMap(entry => entry.type === 'command' ? [{ ...entry, timestamp: new Date(entry.timestamp) }] : []);
      const summary: BranchSummaryEntry | undefined = generated ? {
        id: `branch-summary-${crypto.randomUUID()}`, type: 'branch_summary', version: SESSION_SCHEMA_VERSION,
        parentEntryId: entryId, fromEntryId: snapshot.from, branchName: current.title || current.id,
        timestamp: Date.now(), ...generated,
      } : undefined;
      if (summary) {
        const previous = raw.filter((entry): entry is BranchSummaryEntry => entry.type === 'branch_summary');
        if (previous.length >= 10_000) throw new Error('Session branch summary limit reached.');
        Object.assign(metadata, { branchSummaries: [...previous, summary] });
      }
      const next: Session = { ...current, activeLeafId: summary?.id ?? entryId, metadata,
        messages, commands: commands.length ? commands : undefined, updatedAt: new Date() };
      boundedSessionJson(next, MAX_SESSION_FILE_BYTES, 'Session file exceeds its size limit.');
      await this.persistSession(next, summary ? [summary] : [], {}, () => { ticket.admit(); });
      Object.assign(current, next);
      if (!this.usesSessionStore() && summary) this.volatileEntries.get(sessionId)?.push(summary);
      return { status: 'navigated', entryId: next.activeLeafId, ...(summary ? { summary: structuredClone(summary) } : {}) };
    }));
    if (result.status === 'navigated') this.onSessionUpdate?.(sessionId);
    return result;
  }

  /** Owned active ancestry, including private state before compaction; never summary-source history. */
  async getActiveBranchEntries(sessionId: string): Promise<SessionEntry[]> {
    if (!isValidSessionId(sessionId)) return [];
    return this.withSessionMutation(sessionId, async () => {
      const current = this.sessions.get(sessionId);
      if (!current) return [];
      const store = this.store;
      const leafId = current.activeLeafId;
      const metadata = current.metadata;
      const boundaryId = metadata?.legacyRootBoundaryId;
      const branched = metadata?.hasBranchedHistory;
      const entries = await this.getRawEntries(sessionId);
      if (this.store !== store || this.sessions.get(sessionId) !== current || current.activeLeafId !== leafId
        || current.metadata !== metadata || metadata?.legacyRootBoundaryId !== boundaryId
        || metadata?.hasBranchedHistory !== branched) {
        throw new Error('Session changed while reading its active branch.');
      }
      const boundary = typeof boundaryId === 'string' ? boundaryId : branched !== true ? legacyRootBoundary(entries) : undefined;
      const selected = sessionEntryPath(legacyContextEntries(entries, boundary), leafId);
      if (!selected.complete) throw new Error('Session ancestry is incomplete.');
      boundedSessionJson(selected.entries, MAX_SESSION_FILE_BYTES, 'Session branch exceeds its size limit.');
      return structuredClone(selected.entries);
    });
  }

  /** Return append-order entries, including pre-compaction history when a persistent store is attached. */
  async getRawEntries(sessionId: string): Promise<SessionEntry[]> {
    if (this.store && this.usesSessionStore()) return this.store.getRawEntries(sessionId);
    const journal = this.volatileEntries.get(sessionId);
    if (journal) return structuredClone(journal);
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const messages = session.messages.map(messageToEntry);
    const commands: CommandEntry[] = (session.commands ?? []).map(command => ({
      ...command,
      type: 'command',
      version: SESSION_SCHEMA_VERSION,
      timestamp: command.timestamp.getTime(),
    }));
    const branchSummaries: BranchSummaryEntry[] = (
      (session.metadata?.branchSummaries as Array<Partial<BranchSummaryEntry>
        & Pick<BranchSummaryEntry, 'branchName' | 'summary'>> | undefined) ?? []
    ).map((entry, index) => ({
      id: entry.id ?? `branch-summary-memory-${index}`,
      type: 'branch_summary',
      version: SESSION_SCHEMA_VERSION,
      ...(entry.parentEntryId ? { parentEntryId: entry.parentEntryId } : {}),
      ...(entry.fromEntryId ? { fromEntryId: entry.fromEntryId } : {}),
      branchName: entry.branchName,
      summary: entry.summary,
      ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.usage !== undefined ? { usage: structuredClone(entry.usage) } : {}),
      timestamp: entry.timestamp ?? session.updatedAt.getTime(),
    }));
    return [...messages, ...commands, ...branchSummaries]
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  async getBranchSummaries(sessionId: string): Promise<BranchSummaryEntry[]> {
    if (this.store && this.usesSessionStore()) {
      return (await this.store.getRawEntries(sessionId)).filter(
        (entry): entry is BranchSummaryEntry => entry.type === 'branch_summary',
      );
    }
    const session = this.sessions.get(sessionId);
    return ((session?.metadata?.branchSummaries as Array<Partial<BranchSummaryEntry>
      & Pick<BranchSummaryEntry, 'branchName' | 'summary'>> | undefined) ?? [])
      .map((entry, index) => ({
        id: entry.id ?? `branch-summary-memory-${index}`,
        type: 'branch_summary' as const,
        ...(entry.parentEntryId ? { parentEntryId: entry.parentEntryId } : {}),
        ...(entry.fromEntryId ? { fromEntryId: entry.fromEntryId } : {}),
        branchName: entry.branchName,
        summary: entry.summary,
        ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.usage !== undefined ? { usage: structuredClone(entry.usage) } : {}),
        timestamp: entry.timestamp ?? session?.updatedAt.getTime() ?? Date.now(),
      }));
  }

  // ===================================================================
  // Session Tree Operations (fork/clone/tree)
  // ===================================================================

  /** Fork through (or immediately before) a durable user entry on its parent-linked path. */
  async forkSessionAtEntry(
    sessionId: string,
    entryId: string,
    newTitle?: string,
    options: SessionBranchOptions & { before?: boolean } = {},
  ): Promise<Session | null> {
    if (!isValidSessionId(sessionId) || !isValidEntryId(entryId)) return null;
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Session fork options are invalid.');
    let before = false, signal: AbortSignal | undefined;
    for (const key of Reflect.ownKeys(options)) {
      const property = Object.getOwnPropertyDescriptor(options, key);
      if (!property || !('value' in property)) throw new Error('Session fork options are invalid.');
      if (key === 'signal') signal = captureSessionBranchSignal(property.value);
      else if (key === 'before' && (property.value === undefined || typeof property.value === 'boolean')) before = property.value === true;
      else throw new Error('Session fork options are invalid.');
    }
    newTitle = newTitle === undefined ? undefined : this.redactText(newTitle);
    const store = this.store;
    return this.withBranchTicket(sessionId, signal, async ticket => {
      const snapshot = await ticket.waitFor(this.captureSessionCopySource(sessionId));
      if (!snapshot) return null;
      return this.copySessionAtLeaf(snapshot, entryId, before, newTitle, store, ticket);
    });
  }

  private async copySessionAtLeaf(snapshot: SessionCopySource, entryId: string, before: boolean,
    newTitle: string | undefined, store: JsonlSessionStore | null, ticket: SessionBranchTicket,
    kind: 'fork' | 'clone' = 'fork', externalSource = false): Promise<Session | null> {
    const { original, rawEntries } = snapshot;
    const graph = legacyContextEntries(rawEntries, typeof original.metadata?.legacyRootBoundaryId === 'string'
      ? original.metadata.legacyRootBoundaryId : original.metadata?.hasBranchedHistory !== true ? legacyRootBoundary(rawEntries) : undefined);
    const selected = graph.filter(entry => entry.id === entryId).at(-1);
    if (!selected || selected.type === 'metadata'
      || kind === 'fork' && (selected.type !== 'message' || selected.role !== 'user')) return null;
    const path = sessionEntryPath(graph, entryId);
    if (!path.complete) return null;
    const prefix = before ? path.entries.slice(0, -1) : path.entries;
    if (prefix.some(entry => entry.type === 'command' && (entry.status === 'running'
      || kind === 'clone' && entry.status === 'queued'))) return null;
    if (kind === 'clone') {
      // New exact-leaf copies refuse an unfinished group instead of borrowing the
      // model projection's partial-group repair. Legacy raw-history clone stays unchanged.
      const messages = prefix.filter((entry): entry is MessageEntry => entry.type === 'message');
      const complete = completeContextToolGroups(messages);
      if (complete.length !== messages.length || messages.some((message, index) => {
        const retained = complete[index];
        const declared = message.toolCalls ?? message.blocks?.filter(block => block?.type === 'tool_call');
        return message.id !== retained.id || message.role !== retained.role
          || message.role === 'assistant' && ((declared?.length ?? 0) !== (retained.toolCalls?.length ?? 0)
            || (message.blocks?.filter(block => block?.type === 'tool_call').length ?? 0)
              !== (retained.blocks?.filter(block => block?.type === 'tool_call').length ?? 0));
      })) return null;
    }
    const compacted = prefix.some(entry => entry.type === 'compaction');
    const effectiveIds = compacted ? new Set(projectContextPath(prefix.filter(entry => entry.type !== 'context_edit')).map(entry => entry.id)) : undefined;
    const messages = prefix.flatMap(entry => {
      if (entry.type !== 'message' || effectiveIds && !effectiveIds.has(entry.id)) return [];
      const message = messageFromEntry(entry);
      return message ? [message] : [];
    });
    const commands: ShellCommandRecord[] = prefix.flatMap(entry => entry.type === 'command' ? [{
      ...entry, timestamp: new Date(entry.timestamp),
    }] : []);
    const metadata = { ...(original.metadata ? structuredClone(original.metadata) : {}) };
    const legacyPrefix = captureLegacyCompactionPrefix(original, rawEntries);
    for (const key of ['lastCompacted', 'compactionSummary', 'compactionEntryId', 'compactionStats',
      'activeLeafReset', 'legacyRootBoundaryId', 'branchSummaries', 'aiHarnessLegacyCompactionPrefix']) delete metadata[key];
    metadata.hasBranchedHistory = true;
    if (legacyPrefix && prefix.some(entry => entry.id === legacyPrefix.anchorEntryId)) metadata.aiHarnessLegacyCompactionPrefix = legacyPrefix;
    const lastCompaction = prefix.filter((entry): entry is CompactionEntry => entry.type === 'compaction').at(-1);
    if (lastCompaction) Object.assign(metadata, { lastCompacted: new Date(lastCompaction.timestamp).toISOString(),
      compactionSummary: lastCompaction.summary, compactionEntryId: lastCompaction.id });
    const usageEntries = messages.flatMap(message => message.usage ? [message.usage] : []);
    const usage = usageEntries.length ? usageEntries.reduce((total, current) => ({
      inputTokens: (total.inputTokens ?? 0) + (current.inputTokens ?? 0),
      outputTokens: (total.outputTokens ?? 0) + (current.outputTokens ?? 0),
      cacheReadTokens: (total.cacheReadTokens ?? 0) + (current.cacheReadTokens ?? 0),
      cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (current.cacheWriteTokens ?? 0),
      totalTokens: (total.totalTokens ?? 0) + (current.totalTokens
        ?? (current.inputTokens ?? 0) + (current.outputTokens ?? 0)),
      costUsd: (total.costUsd ?? 0) + (current.costUsd ?? 0),
    }), {} as NonNullable<Session['usage']>) : undefined;
    return this.copySessionSnapshot({ ...snapshot, original: { ...original, messages, commands,
      activeLeafId: prefix.at(-1)?.id, metadata, usage } }, newTitle, undefined, kind,
    { options: {}, store }, { ticket, entryId, before, externalSource });
  }

  /** Fork a session from the current model projection or one of its stable message IDs. */
  async forkSession(sessionId: string, fromMessageIndex?: number | string, newTitle?: string,
    options: SessionForkOptions = {}): Promise<Session | null> {
    if (!isValidSessionId(sessionId)) return null;
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Session fork options are invalid.');
    const destination: Pick<CreateSessionOptions, 'id' | 'cwd' | 'workspaceId'> = {};
    let sourceStore: JsonlSessionStore | undefined, signal: AbortSignal | undefined;
    for (const key of Reflect.ownKeys(options)) {
      const property = Object.getOwnPropertyDescriptor(options, key);
      if (!property || !('value' in property)) throw new Error('Session fork options are invalid.');
      const value: unknown = property.value;
      if (key === 'signal') signal = captureSessionBranchSignal(value);
      else if (key === 'sourceStore') {
        if (value !== undefined && !(value instanceof JsonlSessionStore)) throw new Error('Session fork options are invalid.');
        sourceStore = value as JsonlSessionStore | undefined;
      } else if (key === 'id' || key === 'cwd' || key === 'workspaceId') {
        if (value !== undefined && (typeof value !== 'string'
          || (key === 'id' ? !isValidSessionId(value) : !isBoundedSessionString(value, key === 'cwd' ? 4_096 : 256)))) {
          throw new Error('Session fork options are invalid.');
        }
        destination[key] = value as string | undefined;
      } else throw new Error('Session fork options are invalid.');
    }
    newTitle = newTitle === undefined ? undefined : this.redactText(newTitle);
    const store = this.store;
    return this.withBranchTicket(sessionId, signal, async ticket => {
      const external = sourceStore ? await ticket.waitFor(sourceStore.getSessionSnapshot(sessionId)) : undefined;
      const snapshot = sourceStore ? external ? { original: external.session, rawEntries: external.entries } : null
        : await ticket.waitFor(this.captureSessionCopySource(sessionId));
      ticket.check();
      if (this.store !== store) throw new Error('Session changed while copying its branch.');
      return snapshot ? this.copySessionSnapshot(snapshot, newTitle, fromMessageIndex, 'fork',
        { options: destination, store }, { ticket, externalSource: Boolean(sourceStore) }) : null;
    });
  }

  private async captureSessionCopySource(sessionId: string): Promise<SessionCopySource | null> {
    if (!isValidSessionId(sessionId)) return null;
    return this.withSessionMutation(sessionId, async () => {
      const current = this.sessions.get(sessionId);
      if (!current) return null;
      const store = this.store;
      const original = structuredClone(current);
      const rawEntries = await this.getRawEntries(sessionId);
      if (this.store !== store) throw new Error('Session changed while copying its branch.');
      return { original, rawEntries, validateSource: () => {
        if (this.store !== store || this.sessions.get(sessionId) !== current) {
          throw new Error('Session changed while copying its branch.');
        }
      } };
    });
  }

  /**
   * Move the active leaf to immediately before a durable user entry.
   * Descendants remain in the journal so a later prompt creates a sibling branch.
   */
  async branchBeforeEntry(sessionId: string, entryId: string, options: SessionBranchOptions = {}): Promise<Message | null> {
    const { signal } = copySessionBranchOptions(options);
    if (!isValidSessionId(sessionId) || !isValidEntryId(entryId)) return null;
    return this.withBranchTicket(sessionId, signal, async ticket => {
      const snapshot = await ticket.waitFor(this.captureSessionCopySource(sessionId));
      if (!snapshot) return null;
      if (!snapshot.rawEntries.some(entry => entry.type === 'message' && entry.id === entryId && entry.role === 'user')
        && !snapshot.original.messages.some(message => message.id === entryId && message.role === 'user')) return null;
      const check = (): void => {
        ticket.check(); snapshot.validateSource?.();
        if (JSON.stringify(this.sessions.get(sessionId)) !== JSON.stringify(snapshot.original)) {
          throw new Error('Session changed while branching its history.');
        }
      };
      await this.branchAdmissions.run(ticket, { operation: 'branch-before', entryId, position: 'before', externalSource: false });
      return ticket.waitFor(this.withSessionMutation(sessionId, () => this.branchBeforeEntryUnlocked(sessionId, entryId,
        snapshot, { check, admit: () => { check(); ticket.admit(); } })));
    });
  }

  private async branchBeforeEntryUnlocked(sessionId: string, entryId: string,
    snapshot: SessionCopySource, admission: SessionPublicationAdmission): Promise<Message | null> {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const session: Session = {
      ...current,
      messages: [...current.messages],
      commands: current.commands ? [...current.commands] : undefined,
      metadata: current.metadata ? structuredClone(current.metadata) : undefined,
    };
    const originalEntries = await this.getRawEntries(sessionId);
    admission.check();
    if (JSON.stringify(originalEntries) !== JSON.stringify(snapshot.rawEntries)) throw new Error('Session changed while branching its history.');
    const legacyBoundary = typeof session.metadata?.legacyRootBoundaryId === 'string' ? session.metadata.legacyRootBoundaryId
      : session.metadata?.hasBranchedHistory !== true ? legacyRootBoundary(originalEntries) : undefined;
    const rawEntries = legacyContextEntries(originalEntries, legacyBoundary);
    const target = rawEntries.find(
      (entry): entry is MessageEntry => entry.type === 'message' && entry.id === entryId && entry.role === 'user',
    );
    const fallbackTarget = session.messages.find(message => message.id === entryId && message.role === 'user');
    if (!target && !fallbackTarget) return null;

    const selected = target ? messageFromEntry(target) : structuredClone(fallbackTarget!);
    if (!selected) return null;

    session.activeLeafId = target?.parentMessageId ?? fallbackTarget?.parentMessageId;
    session.metadata = {
      ...session.metadata,
      hasBranchedHistory: true,
      ...(legacyBoundary ? { legacyRootBoundaryId: legacyBoundary } : {}),
      ...(session.activeLeafId ? { activeLeafReset: false } : { activeLeafReset: true }),
    };
    const ancestors = new Set<string>();
    const entriesById = new Map(rawEntries.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, entry]));
    let cursor = session.activeLeafId;
    while (cursor && !ancestors.has(cursor)) {
      const entry = entriesById.get(cursor);
      if (!entry) break;
      ancestors.add(cursor);
      cursor = sessionEntryParent(entry);
    }
    if (rawEntries.length > 0) {
      session.messages = rawEntries.flatMap(entry => {
        if (entry.type !== 'message' || !ancestors.has(entry.id)) return [];
        const message = messageFromEntry(entry);
        return message ? [message] : [];
      });
      const commands = rawEntries.flatMap(entry => {
        if (entry.type !== 'command' || !ancestors.has(entry.id)) return [];
        const timestamp = new Date(entry.timestamp);
        if (Number.isNaN(timestamp.getTime())) return [];
        return [{
          id: entry.id,
          command: entry.command,
          cwd: entry.cwd,
          timestamp,
          status: entry.status,
          parentEntryId: entry.parentEntryId,
          output: entry.output,
          exitCode: entry.exitCode,
          durationMs: entry.durationMs,
          excludedFromContext: entry.excludedFromContext,
          truncated: entry.truncated,
          downloadPath: entry.downloadPath,
        }];
      });
      session.commands = commands.length ? commands : undefined;
    } else {
      session.messages = session.messages.filter(message => ancestors.has(message.id));
      if (session.commands) session.commands = session.commands.filter(command => ancestors.has(command.id));
    }
    const activeCompaction = [...rawEntries].reverse().find(
      (entry): entry is CompactionEntry => entry.type === 'compaction' && ancestors.has(entry.id),
    );
    if (activeCompaction) {
      session.metadata = {
        ...session.metadata,
        lastCompacted: new Date(activeCompaction.timestamp).toISOString(),
        compactionSummary: activeCompaction.summary,
        compactionEntryId: activeCompaction.id,
        compactionStats: {
          instruction: activeCompaction.instruction,
          tokensBefore: activeCompaction.tokensBefore,
          tokensAfter: activeCompaction.tokensAfter,
          provider: activeCompaction.provider,
          model: activeCompaction.model,
          usage: activeCompaction.usage,
        },
      };
    } else if (session.metadata) {
      const metadata = { ...session.metadata };
      delete metadata.lastCompacted;
      delete metadata.compactionSummary;
      delete metadata.compactionEntryId;
      delete metadata.compactionStats;
      session.metadata = metadata;
    }
    session.updatedAt = new Date();
    await this.persistSession(session, [], {}, () => { admission.check(); admission.admit(); });
    Object.assign(current, session);

    if (this.store) {
      const reloaded = await this.store.loadSession(sessionId);
      if (reloaded) Object.assign(current, reloaded);
    }
    this.onSessionUpdate?.(sessionId);
    return selected;
  }

  /** Independently copy one exact durable ancestry leaf; never choose a later
   * current message, repair an unfinished tool group or prepare a source runtime. */
  async cloneSessionAtEntry(sessionId: string, entryId: string, newTitle?: string,
    options: SessionBranchOptions & { sourceStore?: JsonlSessionStore; expectedCwd?: string } = {}): Promise<Session | null> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Session clone options are invalid.');
    let sourceStore: JsonlSessionStore | undefined, signal: AbortSignal | undefined, expectedCwd: string | undefined;
    for (const key of Reflect.ownKeys(options)) {
      const property = Object.getOwnPropertyDescriptor(options, key);
      if (!property || !('value' in property)) throw new Error('Session clone options are invalid.');
      const value: unknown = property.value;
      if (key === 'signal') signal = captureSessionBranchSignal(value);
      else if (key === 'sourceStore') {
        if (value !== undefined && !(value instanceof JsonlSessionStore)) throw new Error('Session clone options are invalid.');
        sourceStore = value as JsonlSessionStore | undefined;
      } else if (key === 'expectedCwd') {
        if (value !== undefined && (typeof value !== 'string' || !isBoundedSessionString(value, 4_096))) throw new Error('Session clone options are invalid.');
        expectedCwd = value as string | undefined;
      } else throw new Error('Session clone options are invalid.');
    }
    if (!isValidSessionId(sessionId) || !isValidEntryId(entryId)) return null;
    const store = this.store;
    newTitle = newTitle === undefined ? undefined : this.redactText(newTitle);
    return this.withBranchTicket(sessionId, signal, async ticket => {
      const external = sourceStore ? await ticket.waitFor(sourceStore.getSessionSnapshot(sessionId)) : undefined;
      const snapshot = sourceStore ? external ? { original: external.session, rawEntries: external.entries } : null
        : await ticket.waitFor(this.captureSessionCopySource(sessionId));
      ticket.check();
      if (this.store !== store) throw new Error('Session changed while copying its branch.');
      // Expected scope is only a comparison with the owned source, never a
      // destination path, filesystem root or execution/trust grant.
      if (!snapshot || snapshot.original.metadata?.subagent === true
        || expectedCwd !== undefined && snapshot.original.cwd !== expectedCwd) return null;
      let title = newTitle;
      if (!title) {
        const suffix = ' (clone)', maximum = 4_096 - Buffer.byteLength(suffix);
        let prefix = '', bytes = 0;
        for (const character of snapshot.original.title || 'Clone') {
          const size = Buffer.byteLength(character);
          if (bytes + size > maximum) break;
          prefix += character; bytes += size;
        }
        title = prefix + suffix;
      }
      const source = { ...snapshot, original: { ...snapshot.original,
        metadata: { ...snapshot.original.metadata, clonedFromEntryId: entryId } } };
      return this.copySessionAtLeaf(source, entryId, false, title, store, ticket, 'clone', Boolean(sourceStore));
    });
  }

  /** Clone a session as an independent root, optionally through one message. */
  async cloneSession(sessionId: string, newTitle?: string, throughMessageIndex?: number | string,
    options: SessionBranchOptions = {}): Promise<Session | null> {
    const { signal } = copySessionBranchOptions(options), store = this.store;
    newTitle = newTitle === undefined ? undefined : this.redactText(newTitle);
    return this.withBranchTicket(sessionId, signal, async ticket => {
      const snapshot = await ticket.waitFor(this.captureSessionCopySource(sessionId));
      return snapshot ? this.copySessionSnapshot(snapshot, newTitle, throughMessageIndex, 'clone',
        { options: {}, store }, { ticket }) : null;
    });
  }

  private async copySessionSnapshot(snapshot: SessionCopySource,
    newTitle: string | undefined, throughMessageIndex: number | string | undefined, kind: 'clone' | 'fork',
    destination: { options: Pick<CreateSessionOptions, 'id' | 'cwd' | 'workspaceId'>; store: JsonlSessionStore | null },
    admission: { ticket: SessionBranchTicket; externalSource?: boolean; entryId?: string; before?: boolean },
  ): Promise<Session | null> {
    const { original, rawEntries } = snapshot;
    const sessionId = original.id;
    if (typeof throughMessageIndex === 'string') throughMessageIndex = original.messages.findIndex(message => message.id === throughMessageIndex);
    if (throughMessageIndex !== undefined && (!Number.isSafeInteger(throughMessageIndex)
      || throughMessageIndex < 0 || throughMessageIndex >= original.messages.length)) return null;
    const sourceMessages = throughMessageIndex === undefined
      ? original.messages
      : original.messages.slice(0, throughMessageIndex + 1);

    const cutoff = sourceMessages.at(-1)?.timestamp.getTime();
    if (original.commands?.some(command => command.status === 'running'
      && (throughMessageIndex === undefined || cutoff === undefined || command.timestamp.getTime() <= cutoff))) return null;

    // Share rich ancestry copying; only independent clones remap identifiers.
    let sourceCommands = original.commands ?? [];
    const graph = legacyContextEntries(rawEntries, typeof original.metadata?.legacyRootBoundaryId === 'string'
      ? original.metadata.legacyRootBoundaryId : original.metadata?.hasBranchedHistory !== true ? legacyRootBoundary(rawEntries) : undefined);
    const selectedLeaf = throughMessageIndex === undefined ? original.activeLeafId : sourceMessages.at(-1)?.id;
    if (!sessionEntryPath(graph, selectedLeaf).complete) return null;
    const sourceEntries = [...new Map(graph.filter((entry): entry is RestorableSessionEntry => entry.type === 'branch_summary'
      || entry.type === 'compaction' || entry.type === 'custom' || entry.type === 'custom_message'
      || entry.type === 'context_edit' || entry.type === 'loadout').map(entry => [entry.id, entry])).values()];
    const sourceSummaries = sourceEntries.filter((entry): entry is BranchSummaryEntry => entry.type === 'branch_summary');
    const parents = new Map(graph.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, sessionEntryParent(entry)]));
    for (const message of sourceMessages) parents.set(message.id, message.parentMessageId ?? parents.get(message.id));
    for (const command of sourceCommands) parents.set(command.id, command.parentEntryId ?? parents.get(command.id));
    const ancestors = new Set<string>();
    const starts = [...sourceMessages.map(message => message.id), ...(throughMessageIndex === undefined
      ? [...sourceCommands.map(command => command.id), ...(original.activeLeafId ? [original.activeLeafId] : [])] : [])];
    for (const start of starts) {
      let cursor: string | undefined = start;
      while (cursor && !ancestors.has(cursor)) {
        ancestors.add(cursor);
        cursor = parents.get(cursor);
      }
    }
    const retainedEntries = sourceEntries.filter(entry => ancestors.has(entry.id));
    if (retainedEntries.length > 1_024) return null;
    if (throughMessageIndex !== undefined) {
      // Copy required ancestors even across summary nodes, never by wall-clock order.
      sourceCommands = sourceCommands.filter(command => ancestors.has(command.id));
      // Retain the conservative timestamp gate above, and also refuse a required
      // running ancestor whose timestamp is ahead of the selected message.
      if (sourceCommands.some(command => command.status === 'running')) return null;
    }
    const messageIds = new Map(sourceMessages.map(message => [message.id, kind === 'fork' ? message.id : crypto.randomUUID()]));
    const commandIds = new Map(sourceCommands.map(command => [command.id, kind === 'fork' ? command.id : `command-${crypto.randomUUID()}`]));
    const extraIds = new Map(retainedEntries.map(entry => [entry.id, kind === 'fork' ? entry.id
      : `${entry.type === 'branch_summary' ? 'branch-summary' : entry.type === 'custom_message' ? 'custom-message' : entry.type}-${crypto.randomUUID()}`]));
    const copiedId = (id: string): string | undefined => messageIds.get(id) ?? commandIds.get(id) ?? extraIds.get(id);
    const remapParent = (id: string): string | undefined => {
      const seen = new Set<string>();
      let cursor: string | undefined = id;
      while (cursor && !seen.has(cursor)) {
        const copied = copiedId(cursor);
        if (copied) return copied;
        seen.add(cursor);
        cursor = parents.get(cursor);
      }
      return undefined;
    };
    const clonedEntries: RestorableSessionEntry[] = structuredClone(retainedEntries).map(entry => {
      const base = { id: extraIds.get(entry.id)!, parentEntryId: entry.parentEntryId ? remapParent(entry.parentEntryId) : undefined };
      if (entry.type === 'context_edit') return { ...entry, ...base,
        targetEntryId: copiedId(entry.targetEntryId) ?? entry.targetEntryId };
      if (entry.type === 'compaction') {
        if (entry.checkpoint?.splitUserEntryId) entry.checkpoint.splitUserEntryId = copiedId(entry.checkpoint.splitUserEntryId)
          ?? entry.checkpoint.splitUserEntryId;
        const commandBoundary = [...commandIds].find(([source]) => entry.firstKeptEntryId === `context-${source}`)?.[1];
        return { ...entry, ...base, firstKeptEntryId: copiedId(entry.firstKeptEntryId)
          ?? (commandBoundary ? `context-${commandBoundary}` : undefined)
          ?? messageIds.get(sourceMessages[0]?.id) ?? base.id };
      }
      if (entry.type === 'branch_summary') return { ...entry, ...base,
        ...(entry.fromEntryId ? { fromEntryId: copiedId(entry.fromEntryId) ?? entry.fromEntryId } : {}) };
      return { ...entry, ...base };
    });
    const clonedSummaries = clonedEntries.filter((entry): entry is BranchSummaryEntry => entry.type === 'branch_summary');
    const clonedMessages = structuredClone(sourceMessages).map(message => ({
      ...message,
      id: messageIds.get(message.id)!,
      timestamp: new Date(message.timestamp),
      ...(message.parentMessageId ? {
        parentMessageId: remapParent(message.parentMessageId),
      } : {}),
    }));
    const clonedCommands = structuredClone(sourceCommands).map(command => ({
      ...command,
      id: commandIds.get(command.id)!,
      timestamp: new Date(command.timestamp),
      ...(command.parentEntryId ? {
        parentEntryId: remapParent(command.parentEntryId),
      } : {}),
    }));
    const clonedActiveLeafId = original.activeLeafId ? remapParent(original.activeLeafId) : undefined;
    const metadata: Record<string, unknown> = {
      ...(original.metadata ? structuredClone(original.metadata) : {}), ...(kind === 'clone' ? { clonedFromSessionId: sessionId } : {}),
    };
    const legacyPrefix = captureLegacyCompactionPrefix(original, rawEntries);
    const legacyAnchor = legacyPrefix ? copiedId(legacyPrefix.anchorEntryId) : undefined;
    if (legacyPrefix && legacyAnchor) metadata.aiHarnessLegacyCompactionPrefix = { ...legacyPrefix, anchorEntryId: legacyAnchor };
    else delete metadata.aiHarnessLegacyCompactionPrefix;
    if (sourceSummaries.length > 0) {
      if (clonedSummaries.length > 0) Object.assign(metadata, { branchSummaries: clonedSummaries });
      else delete metadata.branchSummaries;
    }
    for (const field of ['legacyRootBoundaryId', 'compactionEntryId']) {
      if (typeof metadata[field] !== 'string') continue;
      const replacement = copiedId(metadata[field]);
      if (replacement) metadata[field] = replacement;
      else if (field === 'legacyRootBoundaryId') delete metadata[field];
    }

    const options: CreateSessionOptions = {
      title: newTitle || `${original.title || (kind === 'clone' ? 'Clone' : 'Fork')} (${kind})`,
      ...(kind === 'fork' ? { parentId: sessionId, branchId: original.branchId || sessionId } : {}),
      messages: clonedMessages,
      commands: clonedCommands.length ? clonedCommands : undefined,
      activeLeafId: clonedActiveLeafId ?? clonedMessages.at(-1)?.id ?? clonedCommands.at(-1)?.id,
      cwd: original.cwd,
      workspaceId: original.workspaceId,
      gitBranch: original.gitBranch,
      model: original.model,
      thinking: original.thinking,
      toolPreset: original.toolPreset,
      autoCompaction: original.autoCompaction,
      providerConfig: sanitizeProviderConfig(original.providerConfig),
      metadata,
      usage: throughMessageIndex === undefined && original.usage ? { ...original.usage } : undefined,
      ...destination?.options,
    };
    const { ticket } = admission;
    const check = (): void => {
      ticket.check(); snapshot.validateSource?.();
      if (this.store !== destination.store) throw new Error('Session changed while copying its branch.');
    };
    check();
    await this.branchAdmissions.run(ticket, { operation: kind, entryId: admission.entryId ?? selectedLeaf,
      position: admission.before ? 'before' : 'at', externalSource: admission.externalSource === true });
    check();
    return ticket.waitFor(this.createWithEntries(options, clonedEntries, destination,
      { check, admit: () => { check(); ticket.admit(); } }));
  }

  /** Get the session tree structure for a given branch */
  getSessionTree(branchId?: string): Array<{ id: string; title?: string; parentId?: string; depth: number }> {
    const sessions = this.list();
    
    // Filter by branch if specified, otherwise show all
    const filteredSessions = branchId
      ? sessions.filter(s => s.branchId === branchId || s.id === branchId)
      : sessions;

    // Build tree structure
    const sessionMap = new Map<string, {
      id: string;
      title: string;
      parentId?: string;
      depth: number;
      messages: number;
    }>();
    for (const session of filteredSessions) {
      sessionMap.set(session.id, {
        id: session.id,
        title: session.title || 'Untitled',
        parentId: session.parentId,
        depth: 0,
        messages: session.messages.length,
      });
    }

    // Calculate depths iteratively to remain bounded for the full 10k-session inventory.
    const children = new Map<string, string[]>();
    for (const session of filteredSessions) {
      if (!session.parentId || !sessionMap.has(session.parentId)) continue;
      const values = children.get(session.parentId) ?? [];
      values.push(session.id);
      children.set(session.parentId, values);
    }
    const roots = filteredSessions.filter(session => !session.parentId
      || !sessionMap.has(session.parentId) || session.branchId === session.id);
    const queue = roots.map(session => ({ id: session.id, depth: 0 }));
    const visited = new Set<string>();
    for (let index = 0; index < queue.length && visited.size <= MAX_SESSION_FILES; index++) {
      const current = queue[index]!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const entry = sessionMap.get(current.id);
      if (entry) entry.depth = current.depth;
      for (const child of children.get(current.id) ?? []) {
        if (!visited.has(child)) queue.push({ id: child, depth: current.depth + 1 });
      }
    }
    // Cyclic or malformed legacy roots remain visible at depth zero without recursion.
    return Array.from(sessionMap.values()).sort((a, b) => a.depth - b.depth);
  }

  /** Get all sessions in a branch (including forks) */
  getBranchSessions(branchId?: string): Session[] {
    if (!branchId) return this.list();
    
    return this.list().filter(s => s.branchId === branchId || s.id === branchId);
  }

  /** Delete a session and all its forks */
  async deleteWithForks(sessionId: string): Promise<number> {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session ID.');
    const children = new Map<string, string[]>();
    for (const session of this.sessions.values()) {
      if (!session.parentId) continue;
      const values = children.get(session.parentId) ?? [];
      values.push(session.id);
      children.set(session.parentId, values);
    }
    const visited = new Set<string>();
    const deletionOrder: string[] = [];
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: sessionId, expanded: false }];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.expanded) {
        deletionOrder.push(current.id);
        continue;
      }
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      if (visited.size > MAX_SESSION_FILES) throw new Error('Session inventory limit reached.');
      stack.push({ id: current.id, expanded: true });
      for (const child of children.get(current.id) ?? []) {
        if (!visited.has(child)) stack.push({ id: child, expanded: false });
      }
    }

    let deletedCount = 0;
    for (const id of deletionOrder) {
      if (await this.delete(id)) deletedCount++;
    }
    return deletedCount;
  }

  // Private persistence helpers
  private usesSessionStore(): boolean { return Boolean(this.store && sessionStoreKinds.get(this.store) !== 'memory'); }

  private async persistSession(
    session: Session,
    additionalEntries: SessionEntry[] = [],
    options: { requireAbsent?: boolean } = {},
    admit?: () => void,
  ): Promise<void> {
    if (!this.store || !this.usesSessionStore()) { admit?.(); return; }
    const store = this.store;
    let admissionRejected = false;
    try {
      let fallback: SessionEntry[] | undefined;
      if (sessionStoreKinds.get(store) !== 'native') {
        // Structural stores promise the same journal-preserving save semantics.
        // Prepare the owned context projection BEFORE the write; a failed later
        // read must never turn an accepted durable write into a reported failure.
        const previous = await store.getRawEntries(session.id);
        const currentEntries: SessionEntry[] = [
          ...session.messages.map(messageToEntry),
          ...(session.commands ?? []).map(command => ({ ...command, type: 'command' as const,
            version: SESSION_SCHEMA_VERSION, timestamp: command.timestamp.getTime() })),
          ...additionalEntries,
        ];
        const currentById = new Map(currentEntries.map(entry => [entry.id, entry]));
        const existing = new Set(previous.map(entry => entry.id));
        fallback = this.redactJson(structuredClone([
          ...previous.filter(entry => entry.type !== 'metadata').map(entry => currentById.get(entry.id) ?? entry),
          ...currentEntries.filter(entry => !existing.has(entry.id)).sort((left, right) => left.timestamp - right.timestamp),
        ]));
        boundedSessionJson(fallback, MAX_SESSION_FILE_BYTES, 'Session file exceeds its size limit.');
      }
      try { admit?.(); }
      catch (error) { admissionRejected = true; throw error; }
      await store.saveSession(session, additionalEntries, options);
      const snapshot = committedSessionEntries.get(session) ?? fallback;
      if (snapshot) this.committedEntries.set(session.id, snapshot);
    } catch (error) {
      if (admissionRejected) throw error;
      console.error('[SessionManager] Failed to save session.');
      throw new Error('Session persistence failed.');
    }
  }

  private async persistDelete(id: string): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.deleteSession(id);
    } catch {
      console.error('[SessionManager] Failed to delete session.');
      throw new Error('Session deletion failed.');
    }
  }
}
