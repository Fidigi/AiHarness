// ============================================================
// Session Manager with JSONL Persistence & Compaction
// Features: Event system for lifecycle hooks and extensions
// ============================================================

import {
  SESSION_SCHEMA_VERSION,
  type Message,
  type ProviderConfig,
  type Session,
  type ShellCommandRecord,
} from '../types/index.js';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { EventHandler, EventMap } from '../utils/event-emitter.js';
import { EventEmitter } from '../utils/event-emitter.js';
import { readStableDirectoryEntries } from '../security/stable-directory.js';
import { releaseStableLockPath } from '../security/stable-lock.js';

// ===================================================================
// JSONL Entry types for session persistence
// ===================================================================

/** Base entry stored in the JSONL file */
export interface SessionEntryBase {
  id: string;
  type: 'message' | 'command' | 'compaction' | 'branch_summary' | 'metadata';
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

/** Compaction summary entry */
export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction';
  parentEntryId?: string;
  summary: string;
  firstKeptEntryId: string; // ID of the first message kept after compaction
  tokenEstimate?: number;
  instruction?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  provider?: string;
  model?: string;
  usage?: Message['usage'];
}

/** Branch summary entry (when navigating tree) */
export interface BranchSummaryEntry extends SessionEntryBase {
  type: 'branch_summary';
  parentEntryId?: string;
  branchName: string;
  summary: string;
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

export type SessionEntry = MessageEntry | CommandEntry | CompactionEntry | BranchSummaryEntry | SessionMetadataEntry;

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
        && typeof entry.summary === 'string' && typeof entry.firstKeptEntryId === 'string';
    case 'branch_summary':
      return (entry.parentEntryId === undefined || typeof entry.parentEntryId === 'string')
        && typeof entry.branchName === 'string' && typeof entry.summary === 'string';
    case 'metadata':
      return typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
        && typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
        && (entry.usage === undefined || isPersistedUsage(entry.usage));
    default:
      return false;
  }
}

const SECRET_CONFIG_KEYS = /(?:api[-_]?key|secret|private[-_]?key|(?:access|refresh|session|auth|bearer)[-_]?token|authorization|password|cookie|credential|^token$)/i;

/** Provider identity may be stored with a session, credentials never are. */
function sanitizeProviderConfig(config: ProviderConfig | undefined): ProviderConfig | undefined {
  if (!config || typeof config !== 'object') return undefined;
  try { if (Array.isArray(config)) return undefined; }
  catch { return undefined; }
  const seen = new WeakSet<object>();
  let nodes = 0;
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (++nodes > 10_000 || depth > 32) return undefined;
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 1_024) return undefined;
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          let descriptor: PropertyDescriptor | undefined;
          try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
          catch { return undefined; }
          if (!descriptor || !('value' in descriptor)) return undefined;
          const item = sanitize(descriptor.value, depth + 1);
          if (item !== undefined) result.push(item);
        }
        return result;
      }
      let keys: string[];
      try { keys = Object.keys(value); }
      catch { return undefined; }
      if (keys.length > 256) return undefined;
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (SECRET_CONFIG_KEYS.test(key) || Buffer.byteLength(key) > 256) continue;
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
        catch { continue; }
        if (!descriptor || !('value' in descriptor)) continue;
        const item = sanitize(descriptor.value, depth + 1);
        if (item === undefined) continue;
        Object.defineProperty(result, key, {
          value: item, enumerable: true, configurable: true, writable: true,
        });
      }
      return result;
    } finally {
      seen.delete(value);
    }
  };
  return sanitize(config) as ProviderConfig;
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
  ): Promise<void> {
    await this.verifySessionPath(filePath, true);
    const expected = await fs.lstat(filePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const safeContent = this.redactJsonLines(content);
    if (Buffer.byteLength(safeContent) > MAX_SESSION_FILE_BYTES) {
      throw new Error('Session file exceeds its size limit.');
    }
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

  /** Load a session from JSONL file */
  async loadSession(sessionId: string): Promise<Session | null> {
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
      return {
        id: sessionId,
        schemaVersion: SESSION_SCHEMA_VERSION,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
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

    const treeEntries = entries.filter(entry => entry.type !== 'metadata');
    const entriesById = new Map(treeEntries.map(entry => [entry.id, entry]));
    const activePathIds = new Set<string>();
    let cursor = activeLeafId;
    while (cursor && !activePathIds.has(cursor)) {
      const entry = entriesById.get(cursor);
      if (!entry) break;
      activePathIds.add(cursor);
      cursor = entry.type === 'message' ? entry.parentMessageId
        : entry.type === 'command' || entry.type === 'compaction' || entry.type === 'branch_summary'
          ? entry.parentEntryId
          : undefined;
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
      const compactedAt = new Date(latestCompaction.timestamp);
      metadata = {
        ...metadata,
        ...(Number.isNaN(compactedAt.getTime()) ? {} : { lastCompacted: compactedAt.toISOString() }),
        compactionSummary: latestCompaction.summary,
        compactionEntryId: latestCompaction.id,
      };
    }

    const now = new Date();
    return {
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

        await this.rewriteSessionFile(anchoredPath, `${lines.join('\n')}\n`, directoryHandle);
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
  ): Promise<BranchSummaryEntry> {
    const entry: BranchSummaryEntry = {
      id: `branch-summary-${crypto.randomUUID()}`,
      type: 'branch_summary',
      version: SESSION_SCHEMA_VERSION,
      ...(parentEntryId ? { parentEntryId } : {}),
      branchName,
      summary,
      timestamp: Date.now(),
    };
    if (this.enabled) {
      await this.ensureDir();
      await this.appendSessionFile(this.getFilePath(sessionId), `${JSON.stringify(entry)}\n`);
    }
    return entry;
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
  private onSessionUpdate?: (sessionId: string) => void;
  private store: JsonlSessionStore | null = null;
  private compactionSettings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS;
  private autoCompactionCallback?: AutoCompactionCallback;
  private autoCompactionPolicy?: AutoCompactionPolicy;
  private readonly redactText: (value: string) => string;
  private readonly redactJson: <T>(value: T) => T;
  
  // Event system for lifecycle hooks and extensions
  private emitter = new EventEmitter<EventMap>();
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

  /** Set the callback function for auto-compaction summarization */
  setAutoCompactionCallback(callback: AutoCompactionCallback): void {
    this.autoCompactionCallback = callback;
  }

  /** Let the host resolve inherited auto-compaction policy without coupling Core to its config store. */
  setAutoCompactionPolicy(policy: AutoCompactionPolicy): void {
    this.autoCompactionPolicy = policy;
  }

  /** Check if a session needs compaction and trigger it automatically. */
  async checkAndTriggerCompaction(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const active = this.autoCompactionRuns.get(sessionId);
    if (active) return active;
    const run = this.checkAndTriggerCompactionUnlocked(sessionId, signal);
    this.autoCompactionRuns.set(sessionId, run);
    try { return await run; }
    finally {
      if (this.autoCompactionRuns.get(sessionId) === run) this.autoCompactionRuns.delete(sessionId);
    }
  }

  private async checkAndTriggerCompactionUnlocked(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.compactionSettings.enabled || !this.autoCompactionCallback || signal?.aborted) return false;
    if (session.autoCompaction === false) return false;
    if (this.autoCompactionPolicy && !await this.autoCompactionPolicy(session)) return false;

    const result = this.requestCompaction(sessionId);
    if (!result) return false;
    const firstKeptMessage = result.keptEntries.find(entry => entry.type === 'message');
    if (!firstKeptMessage) return false;
    const tokensBefore = TokenEstimator.totalMessages([
      ...result.toCompact,
      ...result.keptEntries,
    ]);

    try {
      await this.emitter.emit('compaction:start', { sessionId, automatic: true, tokensBefore });
      const generated = await this.autoCompactionCallback(
        sessionId,
        result.toCompact,
        result.keptEntries,
        signal,
      );
      const summary = typeof generated === 'string' ? generated : generated.summary;
      const tokensAfter = TokenEstimator.estimateTokens(summary)
        + TokenEstimator.totalMessages(result.keptEntries);
      const applied = await this.applyCompactionResult(sessionId, summary, firstKeptMessage.id, {
        tokensBefore,
        tokensAfter,
        ...(typeof generated === 'string' ? {} : {
          provider: generated.provider,
          model: generated.model,
          usage: generated.usage,
        }),
      });
      if (!applied) return false;
      await this.emitter.emit('compaction:end', {
        sessionId,
        summaryLength: summary.length,
        automatic: true,
        tokensBefore,
        tokensAfter,
        tokensSaved: Math.max(0, tokensBefore - tokensAfter),
      });
      return true;
    } catch (error) {
      const cancelled = signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      const errorMessage = cancelled
        ? 'Compaction cancelled'
        : error instanceof Error ? error.message : 'Unknown error';
      if (!cancelled) console.error(this.redactText('[SessionManager] Auto-compaction failed.'));
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
    options = this.redactJson(options);
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || (options.messages !== undefined && !Array.isArray(options.messages))
      || (options.commands !== undefined && !Array.isArray(options.commands))) {
      throw new Error('Session data is invalid.');
    }
    const sessionId = options.id ?? crypto.randomUUID();
    if (!isValidSessionId(sessionId)) {
      throw new Error('Invalid session ID.');
    }
    return this.withSessionMutation(sessionId, () => this.createUnlocked(options, sessionId));
  }

  private async createUnlocked(options: CreateSessionOptions, sessionId: string): Promise<Session> {
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

    let encodedSession: string;
    try { encodedSession = JSON.stringify(session); }
    catch { throw new Error('Session data is invalid.'); }
    if (Buffer.byteLength(encodedSession) > MAX_SESSION_FILE_BYTES) {
      throw new Error('Session file exceeds its size limit.');
    }

    const initialEntries: Array<MessageEntry | CommandEntry> = [
      ...session.messages.map(messageToEntry),
      ...(session.commands ?? []).map(command => ({
        ...command,
        type: 'command' as const,
        version: SESSION_SCHEMA_VERSION,
        timestamp: command.timestamp.getTime(),
      })),
    ].sort((left, right) => left.timestamp - right.timestamp);
    if (!session.activeLeafId) session.activeLeafId = initialEntries.at(-1)?.id;
    await this.persistSession(session, [], { requireAbsent: true });
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
    options: { signal?: AbortSignal } = {},
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
      if (!this.store) this.volatileEntries.get(sessionId)?.push(messageToEntry(fullMessage));
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
    if (this.compactionSettings.enabled && session.messages.length >= 4) {
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
      if (!this.store) {
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
    const deleted = await this.withSessionMutation(id, async () => {
      if (!this.sessions.has(id)) return false;
      await this.persistDelete(id);
      this.sessions.delete(id);
      this.volatileEntries.delete(id);
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
    if (this.clearInProgress) return this.clearInProgress;
    const operation = (async () => {
      while (this.activeSessionMutations > 0) {
        await new Promise<void>(resolve => { this.sessionMutationIdleWaiters.add(resolve); });
      }
      this.sessions.clear();
      this.volatileEntries.clear();
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

    const entries = orderContextEntries([
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
    ]);
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
  requestCompaction(sessionId: string): { toCompact: SessionEntry[]; keptEntries: SessionEntry[] } | null {
    const session = this.sessions.get(sessionId);
    if (!session || !this.compactionSettings.enabled) return null;

    const entries = this.getEffectiveContext(sessionId);

    if (entries.length < 4) return null; // Need at least a few messages to compact

    const keepThreshold = this.compactionSettings.keepRecentTokens;

    // Find the cut point: walk backwards until we've kept enough tokens
    let accumulatedTokens = 0;
    let cutIndex = entries.length - 1;

    for (let i = entries.length - 1; i >= 0; i--) {
      const entryTokens = TokenEstimator.estimateMessageEntry(entries[i]);
      if (accumulatedTokens + entryTokens > keepThreshold) break;
      accumulatedTokens += entryTokens;
      cutIndex = i;
    }

    // If we kept everything, no compaction needed
    if (cutIndex === 0) return null;

    const toCompact = entries.slice(0, cutIndex);
    const keptEntries = entries.slice(cutIndex);

    return { toCompact, keptEntries };
  }

  /** Apply a compaction by adding a summary entry. */
  async applyCompaction(
    sessionId: string,
    summary: string,
    firstKeptEntryId: string,
    details: CompactionDetails = {},
  ): Promise<void> {
    await this.applyCompactionResult(sessionId, summary, firstKeptEntryId, details);
  }

  private async applyCompactionResult(
    sessionId: string,
    summary: string,
    firstKeptEntryId: string,
    details: CompactionDetails = {},
  ): Promise<boolean> {
    summary = this.redactText(summary);
    details = this.redactJson(details);
    if (!summary.trim() || Buffer.byteLength(summary) > 1024 * 1024 || !isValidEntryId(firstKeptEntryId)
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
      const session = this.sessions.get(sessionId);
      if (!session) return false;

      // Refuse an invalid boundary rather than silently dropping almost all history.
      const firstKeptIndex = session.messages.findIndex(message => message.id === firstKeptEntryId);
      if (firstKeptIndex < 0) return false;

      const updatedAt = new Date();
      const messages = session.messages.slice(firstKeptIndex);
      const compactionEntry: CompactionEntry = {
        id: `compaction-${crypto.randomUUID()}`,
        type: 'compaction',
        version: SESSION_SCHEMA_VERSION,
        ...(session.activeLeafId ? { parentEntryId: session.activeLeafId } : {}),
        summary: summary.trim(),
        firstKeptEntryId,
        tokenEstimate: TokenEstimator.totalMessages(messages.map(messageToEntry)),
        timestamp: updatedAt.getTime(),
        ...details,
      };
      const next: Session = {
        ...session,
        messages,
        activeLeafId: compactionEntry.id,
        updatedAt,
        metadata: {
          ...session.metadata,
          lastCompacted: updatedAt.toISOString(),
          compactionSummary: summary.trim(),
          compactionStats: details,
          compactionEntryId: compactionEntry.id,
        },
      };
      await this.persistSession(next, [compactionEntry]);
      Object.assign(session, next);
      if (!this.store) this.volatileEntries.get(sessionId)?.push(compactionEntry);
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
  async addBranchSummary(sessionId: string, summary: string, branchName?: string): Promise<BranchSummaryEntry | null> {
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
      if (!this.store) this.volatileEntries.get(sessionId)?.push(nextEntry);
      return nextEntry;
    });
    if (entry) this.onSessionUpdate?.(sessionId);
    return entry;
  }

  /** Return append-order entries, including pre-compaction history when a persistent store is attached. */
  async getRawEntries(sessionId: string): Promise<SessionEntry[]> {
    if (this.store) return this.store.getRawEntries(sessionId);
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
      branchName: entry.branchName,
      summary: entry.summary,
      timestamp: entry.timestamp ?? session.updatedAt.getTime(),
    }));
    return [...messages, ...commands, ...branchSummaries]
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  async getBranchSummaries(sessionId: string): Promise<BranchSummaryEntry[]> {
    if (this.store) {
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
        branchName: entry.branchName,
        summary: entry.summary,
        timestamp: entry.timestamp ?? session?.updatedAt.getTime() ?? Date.now(),
      }));
  }

  // ===================================================================
  // Session Tree Operations (fork/clone/tree)
  // ===================================================================

  /** Fork through a durable user entry on its parent-linked path. */
  async forkSessionAtEntry(
    sessionId: string,
    entryId: string,
    newTitle?: string,
  ): Promise<Session | null> {
    newTitle = newTitle === undefined ? undefined : this.redactText(newTitle);
    const snapshot = await this.withSessionMutation(sessionId, async () => {
      const current = this.sessions.get(sessionId);
      if (!current) return null;
      return {
        original: structuredClone(current),
        rawEntries: await this.getRawEntries(sessionId),
      };
    });
    if (!snapshot) return null;
    const { original, rawEntries } = snapshot;
    const selectedIndex = rawEntries.findIndex(entry => entry.id === entryId);
    const selected = rawEntries[selectedIndex];
    if (selectedIndex < 0 || selected?.type !== 'message' || selected.role !== 'user') return null;

    const entriesById = new Map(rawEntries.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, entry]));
    const ancestorIds = new Set<string>();
    let cursor: string | undefined = selected.id;
    while (cursor && !ancestorIds.has(cursor)) {
      const entry = entriesById.get(cursor);
      if (!entry) break;
      ancestorIds.add(cursor);
      cursor = entry.type === 'message' ? entry.parentMessageId
        : entry.type === 'command' || entry.type === 'compaction' || entry.type === 'branch_summary'
          ? entry.parentEntryId
          : undefined;
    }
    const prefix = ancestorIds.size > 1 || selectedIndex === 0
      ? rawEntries.filter(entry => entry.type !== 'metadata' && ancestorIds.has(entry.id))
      : rawEntries.slice(0, selectedIndex + 1);
    const copiedEntries = prefix.filter(
      (entry): entry is MessageEntry | CommandEntry => entry.type === 'message' || entry.type === 'command',
    );
    const normalizedParents = new Map<string, string | undefined>();
    copiedEntries.forEach((entry, index) => normalizedParents.set(entry.id, copiedEntries[index - 1]?.id));
    const messages: Message[] = prefix.flatMap(entry => entry.type === 'message' ? [{
      id: entry.id,
      role: entry.role,
      content: entry.content,
      timestamp: new Date(entry.timestamp),
      blocks: entry.blocks,
      toolCalls: entry.toolCalls,
      toolCallId: entry.toolCallId,
      name: entry.name,
      isError: entry.isError,
      provider: entry.provider,
      model: entry.model,
      usage: entry.usage,
      durationMs: entry.durationMs,
      parentMessageId: normalizedParents.get(entry.id),
      agentId: entry.agentId,
      metadata: entry.metadata,
    }] : []);
    const commands: ShellCommandRecord[] = prefix.flatMap(entry => entry.type === 'command' ? [{
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      timestamp: new Date(entry.timestamp),
      status: entry.status,
      parentEntryId: normalizedParents.get(entry.id),
      output: entry.output,
      exitCode: entry.exitCode,
      durationMs: entry.durationMs,
      excludedFromContext: entry.excludedFromContext,
      truncated: entry.truncated,
      downloadPath: entry.downloadPath,
    }] : []);
    const metadata = original.metadata ? structuredClone(original.metadata) : undefined;
    if (metadata) {
      for (const key of [
        'lastCompacted', 'compactionSummary', 'compactionEntryId', 'compactionStats',
        'activeLeafReset', 'hasBranchedHistory', 'branchSummaries',
      ]) {
        delete metadata[key];
      }
    }
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

    return this.create({
      title: newTitle || `${original.title || 'Fork'} (fork)`,
      messages,
      commands: commands.length ? commands : undefined,
      parentId: sessionId,
      branchId: original.branchId || sessionId,
      activeLeafId: entryId,
      cwd: original.cwd,
      workspaceId: original.workspaceId,
      gitBranch: original.gitBranch,
      model: original.model,
      thinking: original.thinking,
      toolPreset: original.toolPreset,
      autoCompaction: original.autoCompaction,
      providerConfig: sanitizeProviderConfig(original.providerConfig),
      metadata,
      usage,
    });
  }

  /** Fork a session from a specific message index */
  async forkSession(
    sessionId: string,
    fromMessageIndex?: number,
    newTitle?: string,
  ): Promise<Session | null> {
    newTitle = newTitle === undefined ? undefined : this.redactText(newTitle);
    const original = await this.withSessionMutation(sessionId, async () => {
      const current = this.sessions.get(sessionId);
      return current ? structuredClone(current) : null;
    });
    if (!original) return null;
    if (fromMessageIndex !== undefined && (!Number.isSafeInteger(fromMessageIndex)
      || fromMessageIndex < 0 || fromMessageIndex >= original.messages.length)) return null;

    const sourceMessages = fromMessageIndex !== undefined
      ? original.messages.slice(0, fromMessageIndex + 1)
      : original.messages;
    const messagesToCopy = structuredClone(sourceMessages).map(message => ({
      ...message,
      timestamp: new Date(message.timestamp),
    }));
    const cutoff = sourceMessages.at(-1)?.timestamp.getTime();
    const sourceCommands = fromMessageIndex === undefined
      ? original.commands ?? []
      : (original.commands ?? []).filter(command => cutoff === undefined || command.timestamp.getTime() <= cutoff);
    const commandsToCopy = structuredClone(sourceCommands)
      .map(command => ({ ...command, timestamp: new Date(command.timestamp) }));

    return this.create({
      title: newTitle || `${original.title || 'Fork'} (fork)`,
      messages: messagesToCopy,
      commands: commandsToCopy.length ? commandsToCopy : undefined,
      parentId: sessionId,
      branchId: original.branchId || sessionId, // Group forks under the same branch
      activeLeafId: fromMessageIndex === undefined
        ? original.activeLeafId ?? messagesToCopy.at(-1)?.id ?? commandsToCopy.at(-1)?.id
        : messagesToCopy.at(-1)?.id ?? commandsToCopy.at(-1)?.id,
      cwd: original.cwd,
      workspaceId: original.workspaceId,
      gitBranch: original.gitBranch,
      model: original.model,
      thinking: original.thinking,
      toolPreset: original.toolPreset,
      autoCompaction: original.autoCompaction,
      providerConfig: sanitizeProviderConfig(original.providerConfig),
      metadata: original.metadata ? structuredClone(original.metadata) : undefined,
      usage: fromMessageIndex === undefined && original.usage ? { ...original.usage } : undefined,
    });
  }

  /**
   * Move the active leaf to immediately before a durable user entry.
   * Descendants remain in the journal so a later prompt creates a sibling branch.
   */
  async branchBeforeEntry(sessionId: string, entryId: string): Promise<Message | null> {
    if (!isValidEntryId(entryId)) return null;
    return this.withSessionMutation(sessionId, () => this.branchBeforeEntryUnlocked(sessionId, entryId));
  }

  private async branchBeforeEntryUnlocked(sessionId: string, entryId: string): Promise<Message | null> {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const session: Session = {
      ...current,
      messages: [...current.messages],
      commands: current.commands ? [...current.commands] : undefined,
      metadata: current.metadata ? structuredClone(current.metadata) : undefined,
    };
    const rawEntries = await this.getRawEntries(sessionId);
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
      ...(session.activeLeafId ? { activeLeafReset: false } : { activeLeafReset: true }),
    };
    const ancestors = new Set<string>();
    const entriesById = new Map(rawEntries.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, entry]));
    let cursor = session.activeLeafId;
    while (cursor && !ancestors.has(cursor)) {
      const entry = entriesById.get(cursor);
      if (!entry) break;
      ancestors.add(cursor);
      cursor = entry.type === 'message' ? entry.parentMessageId
        : entry.type === 'command' || entry.type === 'compaction' || entry.type === 'branch_summary'
          ? entry.parentEntryId
          : undefined;
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
    await this.persistSession(session);
    Object.assign(current, session);

    if (this.store) {
      const reloaded = await this.store.loadSession(sessionId);
      if (reloaded) Object.assign(current, reloaded);
    }
    this.onSessionUpdate?.(sessionId);
    return selected;
  }

  /** Clone a session as an independent root, optionally through one message. */
  async cloneSession(sessionId: string, newTitle?: string, throughMessageIndex?: number): Promise<Session | null> {
    newTitle = newTitle === undefined ? undefined : this.redactText(newTitle);
    const original = await this.withSessionMutation(sessionId, async () => {
      const current = this.sessions.get(sessionId);
      return current ? structuredClone(current) : null;
    });
    if (!original) return null;
    if (throughMessageIndex !== undefined && (!Number.isSafeInteger(throughMessageIndex)
      || throughMessageIndex < 0 || throughMessageIndex >= original.messages.length)) return null;
    const sourceMessages = throughMessageIndex === undefined
      ? original.messages
      : original.messages.slice(0, throughMessageIndex + 1);

    // Deep clone entries and identifiers so edits cannot mutate or branch the source.
    const messageIds = new Map(sourceMessages.map(message => [message.id, crypto.randomUUID()]));
    const sourceCommands = throughMessageIndex === undefined ? original.commands ?? [] : [];
    const commandIds = new Map(sourceCommands.map(command => [command.id, `command-${crypto.randomUUID()}`]));
    const clonedMessages = structuredClone(sourceMessages).map(message => ({
      ...message,
      id: messageIds.get(message.id)!,
      timestamp: new Date(message.timestamp),
      ...(message.parentMessageId ? {
        parentMessageId: messageIds.get(message.parentMessageId)
          ?? commandIds.get(message.parentMessageId),
      } : {}),
    }));
    const clonedCommands = structuredClone(sourceCommands).map(command => ({
      ...command,
      id: commandIds.get(command.id)!,
      timestamp: new Date(command.timestamp),
      ...(command.parentEntryId ? {
        parentEntryId: messageIds.get(command.parentEntryId)
          ?? commandIds.get(command.parentEntryId),
      } : {}),
    }));
    const clonedActiveLeafId = original.activeLeafId
      ? messageIds.get(original.activeLeafId) ?? commandIds.get(original.activeLeafId)
      : undefined;

    return this.create({
      title: newTitle || `${original.title || 'Clone'} (clone)`,
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
      metadata: {
        ...(original.metadata ? structuredClone(original.metadata) : {}),
        clonedFromSessionId: sessionId,
      },
      usage: throughMessageIndex === undefined && original.usage ? { ...original.usage } : undefined,
    });
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
  private async persistSession(
    session: Session,
    additionalEntries: SessionEntry[] = [],
    options: { requireAbsent?: boolean } = {},
  ): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.saveSession(session, additionalEntries, options);
    } catch {
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
