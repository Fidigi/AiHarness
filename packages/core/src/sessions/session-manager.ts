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
import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter, EventHandler, EventMap } from '../utils/event-emitter.js';

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
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const seen = new WeakSet<object>();
  const sanitize = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) return value.map(sanitize).filter(item => item !== undefined);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_CONFIG_KEYS.test(key))
        .flatMap(([key, item]) => {
          const sanitized = sanitize(item);
          return sanitized === undefined ? [] : [[key, sanitized]];
        }),
    );
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

/** Manages sessions with JSONL file persistence */
export class JsonlSessionStore {
  private readonly sessionsDir: string;

  constructor(sessionsDir?: string, private readonly enabled = true) {
    this.sessionsDir = sessionsDir || path.join(process.env.HOME || '.', '.ai-harness', 'sessions');
  }

  /** Ensure the sessions directory exists */
  async ensureDir(): Promise<void> {
    if (!this.enabled) return;
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  /** Get the session file path for a given session ID. Session files are always flat. */
  private getFilePath(sessionId: string): string {
    if (!sessionId || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('\0')) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    const sessionsRoot = path.resolve(this.sessionsDir);
    const filePath = path.resolve(sessionsRoot, `${sessionId}.jsonl`);
    if (!filePath.startsWith(`${sessionsRoot}${path.sep}`)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    return filePath;
  }

  private async verifySessionPath(filePath: string, allowMissing: boolean): Promise<void> {
    try {
      const stats = await fs.lstat(filePath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
        throw new Error('Session path must be a regular, unlinked file.');
      }
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async readSessionFile(filePath: string): Promise<string> {
    await this.verifySessionPath(filePath, false);
    const handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink > 1) throw new Error('Session path must be a regular, unlinked file.');
      return await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  }

  private async appendSessionFile(filePath: string, content: string): Promise<void> {
    await this.verifySessionPath(filePath, true);
    const handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT
        | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      0o600,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink > 1) throw new Error('Session path must be a regular, unlinked file.');
      await handle.chmod(0o600);
      await handle.writeFile(content, { encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  }

  private async rewriteSessionFile(filePath: string, content: string): Promise<void> {
    await this.verifySessionPath(filePath, true);
    const handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT
        | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      0o600,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink > 1) throw new Error('Session path must be a regular, unlinked file.');
      await handle.chmod(0o600);
      await handle.truncate(0);
      await handle.writeFile(content, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** List all session IDs (from .jsonl files) */
  async listSessionIds(): Promise<string[]> {
    if (!this.enabled) return [];
    try {
      await this.ensureDir();
      const files = await fs.readdir(this.sessionsDir, { withFileTypes: true });
      // Never discover symbolic links as sessions.
      const sessionFiles = files
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => entry.name.replace(/\.jsonl$/, ''));

      for (let i = 0; i < sessionFiles.length; i++) {
        for (let j = i + 1; j < sessionFiles.length; j++) {
          const aStat = await fs.lstat(path.join(this.sessionsDir, `${sessionFiles[i]}.jsonl`)).catch(() => ({ mtimeMs: 0 }));
          const bStat = await fs.lstat(path.join(this.sessionsDir, `${sessionFiles[j]}.jsonl`)).catch(() => ({ mtimeMs: 0 }));
          if ((bStat as any).mtimeMs > (aStat as any).mtimeMs) {
            [sessionFiles[i], sessionFiles[j]] = [sessionFiles[j], sessionFiles[i]];
          }
        }
      }

      return sessionFiles;
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
      content = await this.readSessionFile(filePath);
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

  /** Save a session to JSONL file */
  async saveSession(session: Session): Promise<void> {
    if (!this.enabled) return;
    await this.ensureDir();

    const filePath = this.getFilePath(session.id);
    let existingLines: string[] = [];
    try {
      existingLines = (await this.readSessionFile(filePath)).split('\n').filter(line => line.trim());
    } catch {
      // File does not exist yet.
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
    const currentEntries: Array<MessageEntry | CommandEntry> = [
      ...session.messages.map(messageToEntry),
      ...(session.commands ?? []).map(command => ({
        ...command,
        type: 'command' as const,
        version: SESSION_SCHEMA_VERSION,
        timestamp: command.timestamp.getTime(),
      })),
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

    await this.rewriteSessionFile(filePath, `${lines.join('\n')}\n`);
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
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the raw entries from a session file (for compaction/tree operations) */
  async getRawEntries(sessionId: string): Promise<SessionEntry[]> {
    if (!this.enabled) return [];
    const filePath = this.getFilePath(sessionId);
    try {
      const content = await this.readSessionFile(filePath);
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
  
  // Event system for lifecycle hooks and extensions
  private emitter = new EventEmitter<EventMap>();

  constructor(options: { store?: JsonlSessionStore } = {}) {
    this.store = options.store ?? null;
  }

  /** Set the JSONL persistence store */
  setStore(store: JsonlSessionStore): void {
    this.store = store;
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
      await this.applyCompaction(sessionId, summary, firstKeptMessage.id, {
        tokensBefore,
        tokensAfter,
        ...(typeof generated === 'string' ? {} : {
          provider: generated.provider,
          model: generated.model,
          usage: generated.usage,
        }),
      });
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
      if (!cancelled) console.error('[SessionManager] Auto-compaction failed:', error);
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
    const now = new Date();
    const session: Session = {
      id: options.id ?? crypto.randomUUID(),
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
      usage: options.usage,
    };

    this.sessions.set(session.id, session);
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
    this.volatileEntries.set(session.id, initialEntries);
    await this.persistSession(session);
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
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const parentMessageId = message.parentMessageId ?? session.activeLeafId;
    const messageWithParent = parentMessageId ? { ...message, parentMessageId } : message;

    // Persist to JSONL first (for streaming scenarios where we don't have the full message object yet)
    let msgId: string;
    if (this.store) {
      const { role: _role, content: _content, ...metadata } = messageWithParent;
      msgId = await this.store.appendMessage(sessionId, message.role, message.content, metadata);
    } else {
      msgId = crypto.randomUUID();
    }

    const fullMessage: Message = {
      id: msgId,
      ...messageWithParent,
      timestamp: new Date(),
    };

    session.messages.push(fullMessage);
    if (!this.store) this.volatileEntries.get(sessionId)?.push(messageToEntry(fullMessage));
    session.activeLeafId = msgId;
    if (session.metadata?.activeLeafReset === true) {
      const metadata = { ...session.metadata };
      delete metadata.activeLeafReset;
      session.metadata = metadata;
    }
    session.updatedAt = new Date();
    if (message.usage) {
      const hadPreviousUsage = session.usage !== undefined;
      const previous = session.usage ?? {};
      const cumulativeCost = message.usage.costUsd === undefined
        || (hadPreviousUsage && previous.costUsd === undefined)
        ? undefined
        : (previous.costUsd ?? 0) + message.usage.costUsd;
      session.usage = {
        inputTokens: (previous.inputTokens ?? 0) + (message.usage.inputTokens ?? 0),
        outputTokens: (previous.outputTokens ?? 0) + (message.usage.outputTokens ?? 0),
        cacheReadTokens: (previous.cacheReadTokens ?? 0) + (message.usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (previous.cacheWriteTokens ?? 0) + (message.usage.cacheWriteTokens ?? 0),
        totalTokens: (previous.totalTokens ?? 0) + (message.usage.totalTokens
          ?? (message.usage.inputTokens ?? 0) + (message.usage.outputTokens ?? 0)
            + (message.usage.cacheReadTokens ?? 0) + (message.usage.cacheWriteTokens ?? 0)),
        ...(cumulativeCost === undefined ? {} : { costUsd: cumulativeCost }),
      };
    }

    // Auto-generate title from first user message
    if (!session.title && message.role === 'user') {
      session.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
    }

    await this.persistSession(session);
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
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const commandWithParent = command.parentEntryId || !session.activeLeafId
      ? command
      : { ...command, parentEntryId: session.activeLeafId };
    const record = this.store
      ? await this.store.appendCommand(sessionId, commandWithParent)
      : {
          ...commandWithParent,
          id: command.id ?? `command-${crypto.randomUUID()}`,
          timestamp: command.timestamp ? new Date(command.timestamp) : new Date(),
        };
    session.commands = [...(session.commands ?? []), record];
    if (!this.store) {
      this.volatileEntries.get(sessionId)?.push({
        ...record,
        type: 'command',
        version: SESSION_SCHEMA_VERSION,
        timestamp: record.timestamp.getTime(),
      });
    }
    session.activeLeafId = record.id;
    if (session.metadata?.activeLeafReset === true) {
      const metadata = { ...session.metadata };
      delete metadata.activeLeafReset;
      session.metadata = metadata;
    }
    session.updatedAt = new Date();
    await this.persistSession(session);
    this.onSessionUpdate?.(sessionId);
    return record;
  }

  /** Update mutable session metadata and persist it. */
  async update(
    id: string,
    changes: MutableSessionChanges,
  ): Promise<Session | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const fields: Array<keyof MutableSessionFields> = [
      'title', 'metadata', 'providerConfig', 'activeLeafId', 'agentId', 'cwd',
      'workspaceId', 'gitBranch', 'model', 'thinking', 'toolPreset', 'autoCompaction', 'usage',
    ];
    for (const field of fields) {
      const value = changes[field];
      if (value === null) Object.assign(session, { [field]: undefined });
      else if (value !== undefined) Object.assign(session, {
        [field]: field === 'providerConfig'
          ? sanitizeProviderConfig(changes.providerConfig ?? undefined)
          : value,
      });
    }
    session.updatedAt = new Date();
    await this.persistSession(session);
    this.onSessionUpdate?.(id);
    await this.emitter.emit('session:update', { sessionId: id, messageCount: session.messages.length });
    return session;
  }

  /** Delete a session */
  async delete(id: string): Promise<boolean> {
    const deleted = this.sessions.delete(id);
    if (deleted) {
      this.volatileEntries.delete(id);
      await this.persistDelete(id);
      this.onSessionUpdate?.(id);
      
      // Emit session:delete event
      await this.emitter.emit('session:delete', { sessionId: id });
    }
    return deleted;
  }

  /** Clear all sessions */
  async clear(): Promise<void> {
    this.sessions.clear();
  }

  /** Load a session from the JSONL store into memory */
  async loadFromStore(sessionId: string): Promise<Session | null> {
    if (!this.store) return null;

    const session = await this.store.loadSession(sessionId);
    if (session) {
      this.sessions.set(session.id, session);
      return session;
    }
    return null;
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

    const entries: SessionEntry[] = [
      ...session.messages.map(messageToEntry),
      ...(session.commands ?? [])
        .filter(command => !command.excludedFromContext && command.status !== 'queued' && command.status !== 'running')
        .map(command => ({
          id: `context-${command.id}`,
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
    ].sort((left, right) => left.timestamp - right.timestamp);
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

  /** Apply a compaction by adding a summary entry */
  async applyCompaction(
    sessionId: string,
    summary: string,
    firstKeptEntryId: string,
    details: {
      instruction?: string;
      tokensBefore?: number;
      tokensAfter?: number;
      provider?: string;
      model?: string;
      usage?: Message['usage'];
    } = {},
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Refuse an invalid boundary rather than silently dropping almost all history.
    const firstKeptIndex = session.messages.findIndex(m => m.id === firstKeptEntryId);
    if (firstKeptIndex < 0) return;

    session.messages = session.messages.slice(firstKeptIndex);
    session.updatedAt = new Date();

    if (this.store) {
      const totalTokens = TokenEstimator.totalMessages(session.messages.map(messageToEntry));
      await this.store.appendCompaction(sessionId, summary, firstKeptEntryId, totalTokens, {
        ...details,
        parentEntryId: session.activeLeafId,
      });
      const rawEntries = await this.store.getRawEntries(sessionId);
      const compactionEntry = [...rawEntries].reverse().find(
        (entry): entry is CompactionEntry => entry.type === 'compaction',
      );
      if (compactionEntry) session.activeLeafId = compactionEntry.id;
      session.metadata = {
        ...session.metadata,
        lastCompacted: new Date(compactionEntry?.timestamp ?? session.updatedAt.getTime()).toISOString(),
        compactionSummary: summary,
        compactionStats: details,
        ...(compactionEntry ? { compactionEntryId: compactionEntry.id } : {}),
      };
    } else {
      const compactionEntry: CompactionEntry = {
        id: `compaction-${crypto.randomUUID()}`,
        type: 'compaction',
        version: SESSION_SCHEMA_VERSION,
        ...(session.activeLeafId ? { parentEntryId: session.activeLeafId } : {}),
        summary,
        firstKeptEntryId,
        tokenEstimate: TokenEstimator.totalMessages(session.messages.map(messageToEntry)),
        timestamp: session.updatedAt.getTime(),
        ...details,
      };
      this.volatileEntries.get(sessionId)?.push(compactionEntry);
      session.activeLeafId = compactionEntry.id;
      session.metadata = {
        ...session.metadata,
        lastCompacted: session.updatedAt.toISOString(),
        compactionSummary: summary,
        compactionStats: details,
        compactionEntryId: compactionEntry.id,
      };
    }

    await this.persistSession(session);
    this.onSessionUpdate?.(sessionId);
  }


  /** Load sessions from JSONL store on initialization */
  async loadAllSessions(): Promise<void> {
    if (!this.store) return;

    const sessionIds = await this.store.listSessionIds();
    for (const id of sessionIds) {
      const session = await this.store!.loadSession(id);
      if (session) {
        this.sessions.set(session.id, session);
      }
    }
  }

  /** Persist a summary for a branch without altering its messages. */
  async addBranchSummary(sessionId: string, summary: string, branchName?: string): Promise<BranchSummaryEntry | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !summary.trim()) return null;
    const resolvedBranchName = branchName || session.title || session.id;
    const entry: BranchSummaryEntry = this.store
      ? await this.store.appendBranchSummary(
          sessionId,
          resolvedBranchName,
          summary.trim(),
          session.activeLeafId,
        )
      : {
          id: `branch-summary-${crypto.randomUUID()}`,
          type: 'branch_summary',
          version: SESSION_SCHEMA_VERSION,
          ...(session.activeLeafId ? { parentEntryId: session.activeLeafId } : {}),
          branchName: resolvedBranchName,
          summary: summary.trim(),
          timestamp: Date.now(),
        };
    if (!this.store) this.volatileEntries.get(sessionId)?.push(entry);
    session.metadata = {
      ...session.metadata,
      branchSummaries: [
        ...((session.metadata?.branchSummaries as BranchSummaryEntry[] | undefined) ?? []),
        entry,
      ],
    };
    session.activeLeafId = entry.id;
    session.updatedAt = new Date();
    await this.persistSession(session);
    this.onSessionUpdate?.(sessionId);
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
    const original = this.sessions.get(sessionId);
    if (!original) return null;
    const rawEntries = await this.getRawEntries(sessionId);
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
    const original = this.sessions.get(sessionId);
    if (!original) return null;

    const sourceMessages = fromMessageIndex !== undefined
      && fromMessageIndex >= 0
      && fromMessageIndex < original.messages.length
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

    const forkedSession: Session = {
      id: crypto.randomUUID(),
      schemaVersion: SESSION_SCHEMA_VERSION,
      title: newTitle || `${original.title || 'Fork'} (fork)`,
      messages: messagesToCopy,
      commands: commandsToCopy.length ? commandsToCopy : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
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
    };

    this.sessions.set(forkedSession.id, forkedSession);
    await this.persistSession(forkedSession);
    this.onSessionUpdate?.(forkedSession.id);

    return forkedSession;
  }

  /**
   * Move the active leaf to immediately before a durable user entry.
   * Descendants remain in the journal so a later prompt creates a sibling branch.
   */
  async branchBeforeEntry(sessionId: string, entryId: string): Promise<Message | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
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

    if (this.store) {
      const reloaded = await this.store.loadSession(sessionId);
      if (reloaded) this.sessions.set(sessionId, reloaded);
    }
    this.onSessionUpdate?.(sessionId);
    return selected;
  }

  /** Clone a session as an independent root, optionally through one message. */
  async cloneSession(sessionId: string, newTitle?: string, throughMessageIndex?: number): Promise<Session | null> {
    const original = this.sessions.get(sessionId);
    if (!original) return null;
    const sourceMessages = throughMessageIndex === undefined
      ? original.messages
      : original.messages.slice(0, Math.max(0, Math.min(original.messages.length, throughMessageIndex + 1)));

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

    const clonedSession: Session = {
      id: crypto.randomUUID(),
      schemaVersion: SESSION_SCHEMA_VERSION,
      title: newTitle || `${original.title || 'Clone'} (clone)`,
      messages: clonedMessages,
      commands: clonedCommands.length ? clonedCommands : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
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
    };

    this.sessions.set(clonedSession.id, clonedSession);
    await this.persistSession(clonedSession);
    this.onSessionUpdate?.(clonedSession.id);

    return clonedSession;
  }

  /** Get the session tree structure for a given branch */
  getSessionTree(branchId?: string): Array<{ id: string; title?: string; parentId?: string; depth: number }> {
    const sessions = this.list();
    
    // Filter by branch if specified, otherwise show all
    const filteredSessions = branchId
      ? sessions.filter(s => s.branchId === branchId || s.id === branchId)
      : sessions;

    // Build tree structure
    const sessionMap = new Map<string, any>();
    for (const session of filteredSessions) {
      sessionMap.set(session.id, {
        id: session.id,
        title: session.title || 'Untitled',
        parentId: session.parentId,
        depth: 0,
        messages: session.messages.length,
      });
    }

    // Calculate depths (BFS from roots)
    const roots = filteredSessions.filter(s => !s.parentId || s.branchId === s.id);
    for (const root of roots) {
      this._calculateDepth(root.id, 0, sessionMap);
    }

    return Array.from(sessionMap.values()).sort((a: any, b: any) => a.depth - b.depth);
  }

  /** Recursively calculate depth in the tree */
  private _calculateDepth(
    sessionId: string,
    depth: number,
    sessionMap: Map<string, any>,
    visited: Set<string> = new Set(),
  ): void {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);

    const entry = sessionMap.get(sessionId);
    if (!entry) return;
    entry.depth = depth;

    for (const [id, session] of this.sessions.entries()) {
      if (session.parentId === sessionId && sessionMap.has(id)) {
        this._calculateDepth(id, depth + 1, sessionMap, visited);
      }
    }
  }

  /** Get all sessions in a branch (including forks) */
  getBranchSessions(branchId?: string): Session[] {
    if (!branchId) return this.list();
    
    return this.list().filter(s => s.branchId === branchId || s.id === branchId);
  }

  /** Delete a session and all its forks */
  async deleteWithForks(sessionId: string): Promise<number> {
    let deletedCount = 0;

    // First, recursively delete children (forks)
    const children = this.list().filter(s => s.parentId === sessionId);
    for (const child of children) {
      deletedCount += await this.deleteWithForks(child.id);
    }

    // Then delete the session itself
    if (await this.delete(sessionId)) {
      deletedCount++;
    }

    return deletedCount;
  }

  // Private persistence helpers
  private async persistSession(session: Session): Promise<void> {
    if (this.store) {
      try {
        await this.store.saveSession(session);
      } catch (error) {
        console.error('[SessionManager] Failed to save session:', error);
      }
    }
  }

  private async persistDelete(id: string): Promise<void> {
    if (this.store) {
      try {
        await this.store.deleteSession(id);
      } catch (error) {
        console.error('[SessionManager] Failed to delete session:', error);
      }
    }
  }
}
