// ============================================================
// Session Manager with JSONL Persistence & Compaction
// Features: Event system for lifecycle hooks and extensions
// ============================================================

import { Message, Session } from '../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter, EventHandler, EventMap } from '../utils/event-emitter.js';

// ===================================================================
// JSONL Entry types for session persistence
// ===================================================================

/** Base entry stored in the JSONL file */
export interface SessionEntryBase {
  id: string;
  type: 'message' | 'compaction' | 'branch_summary' | 'metadata';
  timestamp: number; // Unix timestamp (ms)
}

/** Regular message entry */
export interface MessageEntry extends SessionEntryBase {
  type: 'message';
  role: Message['role'];
  content: string;
  toolCalls?: Message['toolCalls'];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
}

/** Compaction summary entry */
export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string; // ID of the first message kept after compaction
  tokenEstimate?: number;
}

/** Branch summary entry (when navigating tree) */
export interface BranchSummaryEntry extends SessionEntryBase {
  type: 'branch_summary';
  branchName: string;
  summary: string;
}

export interface SessionMetadataEntry extends SessionEntryBase {
  type: 'metadata';
  title?: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  branchId?: string;
  providerConfig?: Session['providerConfig'];
  metadata?: Record<string, unknown>;
}

export type SessionEntry = MessageEntry | CompactionEntry | BranchSummaryEntry | SessionMetadataEntry;

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id || typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) {
    return false;
  }

  switch (entry.type) {
    case 'message':
      return ['user', 'assistant', 'system', 'tool'].includes(String(entry.role))
        && typeof entry.content === 'string';
    case 'compaction':
      return typeof entry.summary === 'string' && typeof entry.firstKeptEntryId === 'string';
    case 'branch_summary':
      return typeof entry.branchName === 'string' && typeof entry.summary === 'string';
    case 'metadata':
      return typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
        && typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt);
    default:
      return false;
  }
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

  /** List all session IDs (from .jsonl files) */
  async listSessionIds(): Promise<string[]> {
    if (!this.enabled) return [];
    try {
      await this.ensureDir();
      const files = await fs.readdir(this.sessionsDir);
      // Sort by last modified time (newest first)
      const sessionFiles = files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace(/\.jsonl$/, ''));

      for (let i = 0; i < sessionFiles.length; i++) {
        for (let j = i + 1; j < sessionFiles.length; j++) {
          const aStat = await fs.stat(path.join(this.sessionsDir, `${sessionFiles[i]}.jsonl`)).catch(() => ({ mtimeMs: 0 }));
          const bStat = await fs.stat(path.join(this.sessionsDir, `${sessionFiles[j]}.jsonl`)).catch(() => ({ mtimeMs: 0 }));
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

    try {
      await fs.access(filePath);
    } catch {
      return null; // File doesn't exist
    }

    const content = await fs.readFile(filePath, 'utf-8');
    if (!content.trim()) {
      return { id: sessionId, messages: [], createdAt: new Date(), updatedAt: new Date() };
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
    let title: string | undefined;
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;
    let parentId: string | undefined;
    let branchId: string | undefined;
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
        const timestamp = new Date(entry.timestamp);
        if (Number.isNaN(timestamp.getTime())) continue;
        const msg: Message = {
          id: entry.id,
          role: entry.role,
          content: entry.content,
          timestamp,
          toolCalls: entry.toolCalls,
          toolCallId: entry.toolCallId,
          name: entry.name,
          isError: entry.isError,
        };
        messages.push(msg);

        if (!title && entry.role === 'user') {
          title = entry.content.slice(0, 50) + (entry.content.length > 50 ? '...' : '');
        }
      } else if (entry.type === 'metadata') {
        title = entry.title ?? title;
        const metadataCreatedAt = new Date(entry.createdAt);
        const metadataUpdatedAt = new Date(entry.updatedAt);
        if (!Number.isNaN(metadataCreatedAt.getTime())) createdAt = metadataCreatedAt;
        if (!Number.isNaN(metadataUpdatedAt.getTime())) updatedAt = metadataUpdatedAt;
        parentId = entry.parentId;
        branchId = entry.branchId;
        providerConfig = entry.providerConfig;
        metadata = entry.metadata;
      } else if (entry.type === 'compaction') {
        latestCompaction = entry;
      }

      includeTimestamp(entry.timestamp);
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
      title,
      messages,
      createdAt: createdAt ?? now,
      updatedAt: updatedAt ?? now,
      parentId,
      branchId,
      providerConfig,
      metadata,
    };
  }

  /** Save a session to JSONL file */
  async saveSession(session: Session): Promise<void> {
    if (!this.enabled) return;
    await this.ensureDir();

    const filePath = this.getFilePath(session.id);

    // Read existing entries if any (to avoid duplicates)
    let existingEntries: string[] = [];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      existingEntries = content.split('\n').filter(l => l.trim());
    } catch {
      // File doesn't exist yet
    }

    // Build new entries (only messages that aren't already in the file)
    const existingIds = new Set(existingEntries.map(e => {
      try {
        return JSON.parse(e).id;
      } catch {
        return null;
      }
    }).filter(Boolean));

    const lines: string[] = existingEntries.filter(line => {
      try { return JSON.parse(line).type !== 'metadata'; } catch { return true; }
    });
    const metadataEntry: SessionMetadataEntry = {
      id: 'session-metadata',
      type: 'metadata',
      timestamp: session.updatedAt.getTime(),
      title: session.title,
      createdAt: session.createdAt.getTime(),
      updatedAt: session.updatedAt.getTime(),
      parentId: session.parentId,
      branchId: session.branchId,
      providerConfig: session.providerConfig,
      metadata: session.metadata,
    };
    lines.unshift(JSON.stringify(metadataEntry));

    for (const msg of session.messages) {
      if (!existingIds.has(msg.id)) {
        const entry: MessageEntry = {
          id: msg.id,
          type: 'message',
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp.getTime(),
          ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
          ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
          ...(msg.name ? { name: msg.name } : {}),
          ...(msg.isError !== undefined ? { isError: msg.isError } : {}),
        };
        lines.push(JSON.stringify(entry));
      }
    }

    await fs.writeFile(filePath, lines.join('\n') + '\n');
  }

  /** Append a message entry to the session file */
  async appendMessage(
    sessionId: string,
    role: Message['role'],
    content: string,
    metadata: Pick<Message, 'toolCalls' | 'toolCallId' | 'name' | 'isError'> = {},
  ): Promise<string> {
    const msgId = crypto.randomUUID();
    if (!this.enabled) return msgId;
    const timestamp = Date.now();

    const line = JSON.stringify({
      id: msgId,
      type: 'message',
      role,
      content,
      timestamp,
      ...(metadata.toolCalls ? { toolCalls: metadata.toolCalls } : {}),
      ...(metadata.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
      ...(metadata.name ? { name: metadata.name } : {}),
      ...(metadata.isError !== undefined ? { isError: metadata.isError } : {}),
    });

    await this.ensureDir();
    await fs.appendFile(this.getFilePath(sessionId), line + '\n');

    return msgId;
  }

  /** Append a compaction entry to the session file */
  async appendCompaction(
    sessionId: string,
    summary: string,
    firstKeptEntryId: string,
    tokenEstimate?: number,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.ensureDir();
    const line = JSON.stringify({
      id: `compaction-${crypto.randomUUID()}`,
      type: 'compaction',
      summary,
      firstKeptEntryId,
      timestamp: Date.now(),
      ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    });

    await fs.appendFile(this.getFilePath(sessionId), line + '\n');
  }

  /** Append a summary describing an abandoned or completed branch. */
  async appendBranchSummary(sessionId: string, branchName: string, summary: string): Promise<void> {
    if (!this.enabled) return;
    const entry: BranchSummaryEntry = {
      id: `branch-summary-${crypto.randomUUID()}`,
      type: 'branch_summary',
      branchName,
      summary,
      timestamp: Date.now(),
    };
    await this.ensureDir();
    await fs.appendFile(this.getFilePath(sessionId), `${JSON.stringify(entry)}\n`);
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
      const content = await fs.readFile(filePath, 'utf-8');
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

/** Callback type for auto-compaction trigger */
export type AutoCompactionCallback = (
  sessionId: string,
  toCompact: SessionEntry[],
  keptEntries: SessionEntry[],
) => Promise<string>;

/** Main session manager with in-memory storage and optional JSONL persistence */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private onSessionUpdate?: (sessionId: string) => void;
  private store: JsonlSessionStore | null = null;
  private compactionSettings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS;
  private autoCompactionCallback?: AutoCompactionCallback;
  
  // Event system for lifecycle hooks and extensions
  private emitter = new EventEmitter<EventMap>();

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

  /** Check if a session needs compaction and trigger it automatically */
  async checkAndTriggerCompaction(sessionId: string): Promise<boolean> {
    const result = this.requestCompaction(sessionId);
    if (!result) return false;

    // Auto-compaction requires both an enabled policy and a summarization callback.
    if (!this.compactionSettings.enabled || !this.autoCompactionCallback) return false;

    try {
      // Emit compaction:start event
      await this.emitter.emit('compaction:start', { sessionId });
      
      const summary = await this.autoCompactionCallback!(
        sessionId,
        result.toCompact,
        result.keptEntries,
      );

      // Apply the compaction - keep only the last kept entry and add summary
      if (result.keptEntries.length > 0) {
        const firstKeptEntryId = result.keptEntries[0].id;
        await this.applyCompaction(sessionId, summary, firstKeptEntryId);
      }

      // Emit compaction:end event
      await this.emitter.emit('compaction:end', { sessionId, summaryLength: summary.length });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SessionManager] Auto-compaction failed:', error);
      await this.emitter.emit('compaction:error', { sessionId, error: errorMessage });
      // Don't throw - just log and continue
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

  /** Create a new session and optionally persist imported messages. */
  async create(options?: { id?: string; title?: string; messages?: Message[] }): Promise<Session> {
    const session: Session = {
      id: options?.id ?? crypto.randomUUID(),
      title: options?.title,
      messages: options?.messages?.map(message => ({
        ...message,
        timestamp: new Date(message.timestamp),
      })) ?? [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.sessions.set(session.id, session);
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
  async addMessage(sessionId: string, message: Omit<Message, 'id' | 'timestamp'>): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Persist to JSONL first (for streaming scenarios where we don't have the full message object yet)
    let msgId: string;
    if (this.store) {
      msgId = await this.store.appendMessage(sessionId, message.role, message.content, {
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        name: message.name,
        isError: message.isError,
      });
    } else {
      msgId = crypto.randomUUID();
    }

    const fullMessage: Message = {
      id: msgId,
      ...message,
      timestamp: new Date(),
    };

    session.messages.push(fullMessage);
    session.updatedAt = new Date();

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
      await this.checkAndTriggerCompaction(session.id);
    }

    return session;
  }

  /** Update mutable session metadata and persist it. */
  async update(
    id: string,
    changes: Partial<Pick<Session, 'title' | 'metadata' | 'providerConfig'>>,
  ): Promise<Session | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (changes.title !== undefined) session.title = changes.title;
    if (changes.metadata !== undefined) session.metadata = changes.metadata;
    if (changes.providerConfig !== undefined) session.providerConfig = changes.providerConfig;
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

    const entries: SessionEntry[] = session.messages.map(m => ({
      id: m.id,
      type: 'message' as const,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp.getTime(),
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
      name: m.name,
      isError: m.isError,
    }));
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
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Refuse an invalid boundary rather than silently dropping almost all history.
    const firstKeptIndex = session.messages.findIndex(m => m.id === firstKeptEntryId);
    if (firstKeptIndex < 0) return;

    session.messages = session.messages.slice(firstKeptIndex);
    session.updatedAt = new Date();

    if (this.store) {
      const totalTokens = TokenEstimator.totalMessages(
        session.messages.map(m => ({
          ...m,
          type: 'message' as const,
          timestamp: m.timestamp.getTime(),
        })),
      );
      await this.store.appendCompaction(sessionId, summary, firstKeptEntryId, totalTokens);
      const rawEntries = await this.store.getRawEntries(sessionId);
      const compactionEntry = [...rawEntries].reverse().find(
        (entry): entry is CompactionEntry => entry.type === 'compaction',
      );
      session.metadata = {
        ...session.metadata,
        lastCompacted: new Date(compactionEntry?.timestamp ?? session.updatedAt.getTime()).toISOString(),
        compactionSummary: summary,
        ...(compactionEntry ? { compactionEntryId: compactionEntry.id } : {}),
      };
    } else {
      session.metadata = {
        ...session.metadata,
        lastCompacted: session.updatedAt.toISOString(),
        compactionSummary: summary,
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
    const entry: BranchSummaryEntry = {
      id: `branch-summary-${crypto.randomUUID()}`,
      type: 'branch_summary',
      branchName: branchName || session.title || session.id,
      summary: summary.trim(),
      timestamp: Date.now(),
    };
    if (this.store) await this.store.appendBranchSummary(sessionId, entry.branchName, entry.summary);
    session.metadata = {
      ...session.metadata,
      branchSummaries: [
        ...((session.metadata?.branchSummaries as Array<{ branchName: string; summary: string }> | undefined) ?? []),
        { branchName: entry.branchName, summary: entry.summary },
      ],
    };
    session.updatedAt = new Date();
    return entry;
  }

  async getBranchSummaries(sessionId: string): Promise<BranchSummaryEntry[]> {
    if (this.store) {
      return (await this.store.getRawEntries(sessionId)).filter(
        (entry): entry is BranchSummaryEntry => entry.type === 'branch_summary',
      );
    }
    const session = this.sessions.get(sessionId);
    return ((session?.metadata?.branchSummaries as Array<{ branchName: string; summary: string }> | undefined) ?? [])
      .map((entry, index) => ({
        id: `branch-summary-memory-${index}`,
        type: 'branch_summary' as const,
        branchName: entry.branchName,
        summary: entry.summary,
        timestamp: session?.updatedAt.getTime() ?? Date.now(),
      }));
  }

  // ===================================================================
  // Session Tree Operations (fork/clone/tree)
  // ===================================================================

  /** Fork a session from a specific message index */
  async forkSession(
    sessionId: string,
    fromMessageIndex?: number,
    newTitle?: string,
  ): Promise<Session | null> {
    const original = this.sessions.get(sessionId);
    if (!original) return null;

    // Determine which messages to include in the fork (up to fromMessageIndex)
    let messagesToCopy: Message[];
    if (fromMessageIndex !== undefined && fromMessageIndex >= 0 && fromMessageIndex < original.messages.length) {
      messagesToCopy = original.messages.slice(0, fromMessageIndex + 1);
    } else {
      // Fork from the beginning
      messagesToCopy = [...original.messages];
    }

    const forkedSession: Session = {
      id: crypto.randomUUID(),
      title: newTitle || `${original.title || 'Fork'} (fork)`,
      messages: messagesToCopy,
      createdAt: new Date(),
      updatedAt: new Date(),
      parentId: sessionId,
      branchId: original.branchId || sessionId, // Group forks under the same branch
    };

    this.sessions.set(forkedSession.id, forkedSession);
    await this.persistSession(forkedSession);
    this.onSessionUpdate?.(forkedSession.id);

    return forkedSession;
  }

  /** Clone a session (full copy with all messages) */
  async cloneSession(sessionId: string, newTitle?: string): Promise<Session | null> {
    const original = this.sessions.get(sessionId);
    if (!original) return null;

    // Deep clone the messages array to avoid shared references
    const clonedMessages = original.messages.map(m => ({
      ...m,
      id: crypto.randomUUID(), // New IDs for cloned messages
    }));

    const clonedSession: Session = {
      id: crypto.randomUUID(),
      title: newTitle || `${original.title || 'Clone'} (clone)`,
      messages: clonedMessages,
      createdAt: new Date(),
      updatedAt: new Date(),
      parentId: sessionId,
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
