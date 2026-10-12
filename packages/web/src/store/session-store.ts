// ============================================================
// Session Store - sessions, workspace, detached runs and providers
// ============================================================

import { create } from 'zustand';
import { rememberRetirement, remembersRetirement, mergeRetirements, type RetirementFilter } from './run-retirement-filter.js';
import type {
  ProviderType,
  AgentRunSnapshot,
  Message,
  ModelCatalog,
  ProviderConfig,
  SkillCatalog,
  Session,
  WorkspaceDescriptor,
} from '@ai-harness/core';
import {
  createSession as createApiSession,
  getDefaultWorkspace,
  getModelCatalog,
  getProviders,
  getSkillCatalog,
  listSessions,
  orderedExtensionRequests,
  reconcileInteractionSnapshot,
  updateEnabledModels as updateEnabledModelsApi,
  updateEnabledSkills as updateEnabledSkillsApi,
  validateWorkspace,
} from '../services/api.js';
import type {
  ApiSession,
  SessionMessagePage,
  SessionMessagePageInfo,
} from '../services/api.js';

export interface DraftAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  url: string;
}

export interface LoadedMessageRange {
  start: number;
  end: number;
}

export interface StoredMessagePage extends SessionMessagePageInfo {
  loadedRanges: LoadedMessageRange[];
}

export interface StoredSession extends Session {
  draft?: boolean;
  unread?: boolean;
  attention?: boolean;
  messagePage?: StoredMessagePage;
}

// Session journal sequences span runs. Keep authority when visible run state disappears.
export interface RunAuthority {
  sequence: number;
  runId?: string;
  terminal: boolean;
  retired: string[];
  /** Conservative fixed-size negative history; a possible collision needs fresh current-state discovery. */
  retiredFilter?: RetirementFilter;
  /** Empty zero-sequence discovery, with no observed run or journal history. */
  pristine?: boolean;
  deleted?: boolean;
}
export interface RunRequestGuard {
  epoch: number;
  /** Only fresh current-session state/running discovery or acknowledged start, never historical run GET. */
  canonical?: boolean;
  /** Session-wide observation can advance without changing the current run snapshot version. */
  snapshotSequence?: number;
  /** Authoritative missing-run snapshot watermark; never supplied by unversioned discovery. */
  absenceSequence?: number;
  authority?: RunAuthority;
  activeSessionId?: string | null;
  [INTERACTION_REPLY]?: object;
}

export function getRunAuthority(authorities: Readonly<Record<string, RunAuthority>>, sessionId: string): RunAuthority | undefined {
  return Object.hasOwn(authorities, sessionId) ? authorities[sessionId] : undefined;
}

const INTERACTION_REPLY = Symbol('captured interaction reply');
const interactionReplyWitnesses = new WeakMap<object, { sessionId: string; runId: string; requestId: string }>();

/** Internal browser completion witness, not server authority or a closure event. */
export function captureInteractionReplyGuard(state: Pick<SessionState, 'runEpoch' | 'runAuthorities' | 'activeSessionId' | 'runs'>, sessionId: string, requestId: string): RunRequestGuard {
  const guard = { epoch: state.runEpoch, authority: getRunAuthority(state.runAuthorities, sessionId), activeSessionId: state.activeSessionId };
  const run = getStoredRun(state.runs, sessionId);
  if (!run || orderedExtensionRequests(run)[0]?.id !== requestId) return guard;
  const witness = {};
  interactionReplyWitnesses.set(witness, { sessionId, runId: run.id, requestId });
  return { ...guard, [INTERACTION_REPLY]: witness };
}

/** A current captured HTTP reply compares against precisely its acknowledged
 * head removal, without changing sequence or granting arbitrary membership.
 * The setter independently verifies the private witness against the real run. */
export function interactionReplyComparison(state: Pick<SessionState, 'runEpoch' | 'runAuthorities' | 'activeSessionId' | 'runs'>,
  sessionId: string, guard?: RunRequestGuard): AgentRunSnapshot | undefined {
  const run = getStoredRun(state.runs, sessionId);
  const reply = guard?.[INTERACTION_REPLY] && interactionReplyWitnesses.get(guard[INTERACTION_REPLY]);
  if (!run || !reply || reply.sessionId !== sessionId || reply.runId !== run.id
    || orderedExtensionRequests(run)[0]?.id !== reply.requestId || guard?.epoch !== state.runEpoch
    || guard.authority !== getRunAuthority(state.runAuthorities, sessionId)
    || guard.activeSessionId !== state.activeSessionId) return run;
  return reconcileInteractionSnapshot(run, new Set([reply.requestId]));
}

export function getSessionRecord<T>(records: Readonly<Record<string, T>>, sessionId: string): T | undefined {
  return Object.hasOwn(records, sessionId) ? records[sessionId] : undefined;
}

export function getStoredRun(runs: Readonly<Record<string, AgentRunSnapshot>>, sessionId: string): AgentRunSnapshot | undefined {
  return Object.hasOwn(runs, sessionId) ? runs[sessionId] : undefined;
}
interface CollectionHistory { generation: number; deleted?: RetirementFilter; retired?: RetirementFilter }
// Workspace/reset creates a new collection and retires its runEpoch. History is
// transient, not cached/persisted, and does not retain obsolete collections.
const collectionHistory = new WeakMap<object, CollectionHistory>();
const historyFor = (authorities: object): CollectionHistory => collectionHistory.get(authorities) ?? { generation: 0 };
function retainRunAuthority(authorities: Record<string, RunAuthority>, sessionId: string, authority: RunAuthority): Record<string, RunAuthority> {
  const entries = Object.entries(authorities).filter(([id]) => id !== sessionId);
  let history = historyFor(authorities);
  if (entries.length > 255) {
    history = { ...history, generation: history.generation + 1 };
    for (const [id, retired] of entries.slice(0, -255)) {
      if (retired.deleted) history.deleted = rememberRetirement(history.deleted, id);
      history.retired = mergeRetirements(history.retired, retired.retiredFilter);
      for (const runId of [...retired.retired, ...(retired.runId ? [retired.runId] : [])]) {
        history.retired = rememberRetirement(history.retired, JSON.stringify([id, runId]));
      }
    }
  }
  const next = Object.fromEntries([...entries.slice(-255), [sessionId, authority]]);
  collectionHistory.set(next, history);
  return next;
}
function authorityPublication(_state: SessionState, authorities: Record<string, RunAuthority>) {
  return { runAuthorities: authorities };
}
const CANONICAL = Symbol('current-state discovery');
const canonicalWitnesses = new WeakMap<object, { generation: number }>();
export function captureCanonicalRunGuard(state: Pick<SessionState, 'runEpoch' | 'runAuthorities' | 'activeSessionId'>,
  sessionId: string, observeActive = true): RunRequestGuard {
  const witness = Object.freeze({});
  canonicalWitnesses.set(witness, { generation: historyFor(state.runAuthorities).generation });
  return Object.freeze({ epoch: state.runEpoch, authority: getRunAuthority(state.runAuthorities, sessionId), canonical: true,
    ...(observeActive ? { activeSessionId: state.activeSessionId } : {}), [CANONICAL]: witness });
}
function canonicalGeneration(guard: RunRequestGuard | undefined): number | undefined {
  const witness = (guard as (RunRequestGuard & { [CANONICAL]?: object }) | undefined)?.[CANONICAL];
  return guard?.canonical && witness ? canonicalWitnesses.get(witness)?.generation : undefined;
}

export interface SessionState {
  sessions: StoredSession[];
  activeSessionId: string | null;
  workspace: WorkspaceDescriptor | null;
  recentWorkspaces: WorkspaceDescriptor[];
  runs: Record<string, AgentRunSnapshot>;
  runAuthorities: Record<string, RunAuthority>;
  runEpoch: number;
  drafts: Record<string, string>;
  attachments: Record<string, DraftAttachment[]>;
  createSession: (title?: string) => void;
  createRemoteSession: (title?: string) => Promise<string | undefined>;
  hydrateWorkspace: (requestedCwd?: string) => Promise<void>;
  /** Revalidate the selected workspace without optimistic trust changes or fallback selection. */
  refreshWorkspace: () => Promise<void>;
  setWorkspace: (workspace: WorkspaceDescriptor) => Promise<void>;
  hydrateSessions: () => Promise<void>;
  replaceSession: (localId: string, session: ApiSession) => void;
  syncSession: (session: ApiSession) => void;
  mergeMessagePage: (sessionId: string, page: SessionMessagePage) => void;
  removeSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  updateSessionSettings: (sessionId: string, changes: Partial<Pick<Session, 'model' | 'thinking' | 'toolPreset' | 'autoCompaction'>>) => void;
  addMessage: (sessionId: string, message: Omit<Message, 'id' | 'timestamp'>) => void;
  upsertAssistantMessage: (sessionId: string, messageId: string, content: string, reasoning?: string) => void;
  setActiveSession: (id: string | null) => void;
  /** Browser-local admission receipt, including accepted no-ops; not server settlement. */
  setRun: (sessionId: string, run?: AgentRunSnapshot, guard?: RunRequestGuard) => boolean;
  setDraft: (sessionId: string, value: string) => void;
  addAttachments: (sessionId: string, attachments: DraftAttachment[]) => void;
  removeAttachment: (sessionId: string, attachmentId: string) => void;
  clearAttachments: (sessionId: string) => void;
}

export interface ProviderState {
  providers: {
    active: ProviderType;
    available: Record<ProviderType, ProviderConfig>;
    catalog?: ModelCatalog;
    catalogLoading?: boolean;
    catalogError?: string;
  };
  setProvider: (type: ProviderType) => void;
  setModel: (type: ProviderType, model: string) => void;
  updateApiKey: (type: ProviderType, apiKey: string) => void;
  hydrateProviders: () => Promise<void>;
  hydrateModelCatalog: (refresh?: boolean) => Promise<void>;
  setModelEnabled: (key: string, enabled: boolean) => Promise<void>;
  setAllModelsEnabled: (enabled: boolean) => Promise<void>;
}

export interface SkillState {
  skills: {
    catalog?: SkillCatalog;
    loading?: boolean;
    error?: string;
  };
  hydrateSkillCatalog: (refresh?: boolean) => Promise<void>;
  setSkillModelInvocable: (key: string, enabled: boolean) => Promise<void>;
}

export type AppState = SessionState & ProviderState & SkillState;

// Keep this browser module independent from the Core runtime entry point, which also
// exports Node-only persistence/security classes. ProviderType is a string enum.
const PROVIDER = {
  OPENAI: 'openai' as ProviderType,
  ANTHROPIC: 'anthropic' as ProviderType,
  GOOGLE: 'google' as ProviderType,
  AZURE: 'azure' as ProviderType,
  BEDROCK: 'bedrock' as ProviderType,
  VERTEX: 'vertex' as ProviderType,
  LOCAL: 'local' as ProviderType,
  MOCK: 'mock' as ProviderType,
  CUSTOM: 'custom' as ProviderType,
} as const;

const defaultProviders = {
  [PROVIDER.OPENAI]: {
    type: PROVIDER.OPENAI,
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
  },
  [PROVIDER.ANTHROPIC]: {
    type: PROVIDER.ANTHROPIC,
    model: 'claude-3-haiku-20240307',
    baseUrl: 'https://api.anthropic.com',
  },
  [PROVIDER.GOOGLE]: { type: PROVIDER.GOOGLE, model: 'gemini-2.0-flash' },
  [PROVIDER.AZURE]: { type: PROVIDER.AZURE, model: 'gpt-4o' },
  [PROVIDER.BEDROCK]: { type: PROVIDER.BEDROCK, model: 'anthropic.claude-3-haiku-20240307-v1:0' },
  [PROVIDER.VERTEX]: { type: PROVIDER.VERTEX, model: 'gemini-2.0-flash' },
  [PROVIDER.LOCAL]: {
    type: PROVIDER.LOCAL,
    model: 'local-model',
    baseUrl: 'http://localhost:11434/v1',
  },
  [PROVIDER.MOCK]: { type: PROVIDER.MOCK, apiKey: '', model: 'mock-model' },
  [PROVIDER.CUSTOM]: { type: PROVIDER.CUSTOM },
} as Record<ProviderType, ProviderConfig>;

function asDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function omitRecordKey<T>(source: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const result = { ...source };
  delete result[key];
  return result;
}

function normalizeRanges(ranges: LoadedMessageRange[]): LoadedMessageRange[] {
  const sorted = ranges
    .filter(range => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const normalized: LoadedMessageRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else normalized.push({ ...range });
  }
  return normalized;
}

function storedPage(page: SessionMessagePageInfo, ranges?: LoadedMessageRange[]): StoredMessagePage {
  return {
    ...page,
    loadedRanges: normalizeRanges(ranges ?? (page.end > page.start ? [{ start: page.start, end: page.end }] : [])),
  };
}

function toStoredSession(session: ApiSession | StoredSession): StoredSession {
  const existingPage = session.messagePage as StoredMessagePage | undefined;
  return {
    ...session,
    createdAt: asDate(session.createdAt),
    updatedAt: asDate(session.updatedAt),
    messages: session.messages.map(message => ({ ...message, timestamp: asDate(message.timestamp) })),
    ...(session.commands ? {
      commands: session.commands.map(command => ({ ...command, timestamp: asDate(command.timestamp) })),
    } : {}),
    ...(existingPage ? { messagePage: storedPage(existingPage, existingPage.loadedRanges) } : {}),
  } as StoredSession;
}

function indexedMessages(session: StoredSession): Map<number, Message> {
  const indexed = new Map<number, Message>();
  const ranges = session.messagePage?.loadedRanges;
  if (!ranges?.length) {
    const start = session.messagePage?.start ?? 0;
    session.messages.forEach((message, offset) => indexed.set(start + offset, message));
    return indexed;
  }
  let messageOffset = 0;
  for (const range of ranges) {
    for (let index = range.start; index < range.end && messageOffset < session.messages.length; index++) {
      indexed.set(index, session.messages[messageOffset++]!);
    }
  }
  // Streaming can temporarily append a message before the next canonical snapshot.
  while (messageOffset < session.messages.length) {
    const index = Math.max((session.messagePage?.total ?? 0) - 1, ...indexed.keys(), -1) + 1;
    indexed.set(index, session.messages[messageOffset++]!);
  }
  return indexed;
}

function mergeMessageWindow(
  session: StoredSession,
  rawMessages: SessionMessagePage['messages'],
  page: SessionMessagePageInfo,
): StoredSession {
  const hydrated = rawMessages.map(message => ({ ...message, timestamp: asDate(message.timestamp) }));
  const reset = !session.messagePage || page.total < session.messagePage.total;
  const indexed = reset ? new Map<number, Message>() : indexedMessages(session);
  const indexById = new Map([...indexed].map(([index, message]) => [message.id, index]));
  hydrated.forEach((message, offset) => {
    const index = page.start + offset;
    const previousIndex = indexById.get(message.id);
    if (previousIndex !== undefined && previousIndex !== index) indexed.delete(previousIndex);
    indexed.set(index, message);
  });
  for (const index of [...indexed.keys()]) {
    if (index < 0 || index >= page.total) indexed.delete(index);
  }
  const entries = [...indexed.entries()].sort(([left], [right]) => left - right);
  const ranges: LoadedMessageRange[] = [];
  for (const [index] of entries) {
    const previous = ranges.at(-1);
    if (previous && previous.end === index) previous.end = index + 1;
    else ranges.push({ start: index, end: index + 1 });
  }
  const first = entries[0];
  const last = entries.at(-1);
  const firstIndex = first?.[0] ?? page.end;
  const lastIndex = last?.[0] ?? page.start - 1;
  return {
    ...session,
    messages: entries.map(([, message]) => message),
    messagePage: storedPage({
      ...page,
      start: firstIndex,
      end: lastIndex + 1,
      hasMoreBefore: firstIndex > 0,
      hasMoreAfter: lastIndex + 1 < page.total,
      nextBefore: firstIndex > 0 ? first?.[1].id : undefined,
      nextAfter: lastIndex + 1 < page.total ? last?.[1].id : undefined,
    }, ranges),
  };
}

function mergeStoredSession(previous: StoredSession | undefined, remote: ApiSession): StoredSession {
  const incoming = toStoredSession(remote);
  if (!previous) return incoming;
  const base: StoredSession = {
    ...previous,
    ...incoming,
    draft: incoming.draft ?? previous.draft,
    unread: incoming.unread ?? previous.unread,
    attention: incoming.attention ?? previous.attention,
  };
  if (!incoming.messagePage) return base;
  if (incoming.messages.length === 0) {
    if (previous.messagePage && incoming.messagePage.revision !== previous.messagePage.revision) {
      return { ...base, messages: [], messagePage: storedPage(incoming.messagePage) };
    }
    const ranges = previous.messagePage?.loadedRanges ?? [];
    const first = ranges[0];
    const last = ranges.at(-1);
    return {
      ...base,
      messages: previous.messages,
      messagePage: storedPage({
        ...incoming.messagePage,
        start: first?.start ?? incoming.messagePage.total,
        end: last?.end ?? incoming.messagePage.total,
        hasMoreBefore: (first?.start ?? incoming.messagePage.total) > 0,
        hasMoreAfter: (last?.end ?? incoming.messagePage.total) < incoming.messagePage.total,
        nextBefore: (first?.start ?? 0) > 0 ? previous.messages[0]?.id : undefined,
        nextAfter: (last?.end ?? incoming.messagePage.total) < incoming.messagePage.total
          ? previous.messages.at(-1)?.id
          : undefined,
      }, ranges),
    };
  }
  return mergeMessageWindow({
    ...base,
    messages: previous.messages,
    messagePage: previous.messagePage,
  }, remote.messages, incoming.messagePage);
}

function workspaceDraftId(): string {
  return `draft:${crypto.randomUUID()}`;
}

const WORKSPACE_STATE_KEY = 'ai-harness-workspaces-v1';
const SESSION_VIEW_CACHE_VERSION = 2;
const SESSION_VIEW_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_VIEW_CACHE_MAX_AGE = 24 * 60 * 60 * 1_000;
const SESSION_VIEW_CACHE_MAX_DRAFTS = 3;
const SESSION_VIEW_CACHE_MAX_DRAFT_CHARS = 256_000;
let workspaceHydrationSequence = 0;
let modelCatalogRequestSequence = 0;
let skillCatalogRequestSequence = 0;
let sessionHydrationController: AbortController | undefined;
let sessionCacheTimer: number | undefined;
type SessionCacheState = Pick<AppState,
  'workspace' | 'sessions' | 'activeSessionId' | 'drafts' | 'attachments' | 'providers'>;
let pendingSessionCacheState: SessionCacheState | undefined;

function sessionViewCacheKey(workspaceId: string, version = SESSION_VIEW_CACHE_VERSION): string {
  return `ai-harness-session-view-v${version}:${workspaceId}`;
}

function cacheBoundedSession(session: StoredSession, messageLimit = 160): StoredSession {
  const entries = messageLimit > 0 ? [...indexedMessages(session).entries()].slice(-messageLimit) : [];
  const ranges: LoadedMessageRange[] = [];
  for (const [index] of entries) {
    const previous = ranges.at(-1);
    if (previous?.end === index) previous.end = index + 1;
    else ranges.push({ start: index, end: index + 1 });
  }
  const first = entries[0]?.[0] ?? session.messagePage?.total ?? 0;
  const last = entries.at(-1)?.[0] ?? first - 1;
  const providerConfig = session.providerConfig
    ? { ...session.providerConfig, apiKey: undefined }
    : undefined;
  return {
    ...session,
    ...(providerConfig ? { providerConfig } : {}),
    messages: entries.map(([, message]) => message),
    commands: session.commands?.slice(-20).map(command => ({
      ...command,
      output: (command.output ?? '').slice(-50_000),
      truncated: command.truncated || (command.output?.length ?? 0) > 50_000,
    })),
    ...(session.messagePage ? {
      messagePage: storedPage({
        ...session.messagePage,
        start: first,
        end: last + 1,
        hasMoreBefore: first > 0,
        hasMoreAfter: last + 1 < session.messagePage.total,
        nextBefore: first > 0 ? entries[0]?.[1].id : undefined,
        nextAfter: last + 1 < session.messagePage.total ? entries.at(-1)?.[1].id : undefined,
      }, ranges),
    } : {}),
  };
}

interface SessionViewCache {
  sessions: StoredSession[];
  localDrafts: StoredSession[];
  drafts: Record<string, string>;
  attachments: Record<string, DraftAttachment[]>;
  providerSelection?: { active: string; models: Record<string, string> };
  activeSessionId?: string;
}

function normalizedCachedAttachments(
  value: unknown,
  draftIds: Set<string>,
  maxEncodedCharacters = Number.POSITIVE_INFINITY,
): Record<string, DraftAttachment[]> {
  if (!value || typeof value !== 'object') return {};
  const normalized: Record<string, DraftAttachment[]> = {};
  let encodedCharacters = 0;
  for (const [sessionId, rawItems] of Object.entries(value)) {
    if (!draftIds.has(sessionId) || !Array.isArray(rawItems)) continue;
    const items = rawItems.filter((item): item is DraftAttachment => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<DraftAttachment>;
      return typeof candidate.id === 'string' && candidate.id.length <= 200
        && typeof candidate.name === 'string' && candidate.name.length <= 255
        && typeof candidate.mediaType === 'string' && /^image\/[A-Za-z0-9.+-]{1,80}$/.test(candidate.mediaType)
        && Number.isFinite(candidate.size) && candidate.size! >= 0 && candidate.size! <= 4 * 1024 * 1024
        && typeof candidate.url === 'string' && candidate.url.length <= 6 * 1024 * 1024
        && /^data:image\/[A-Za-z0-9.+-]{1,80};base64,/i.test(candidate.url);
    }).slice(0, 8).filter(item => {
      if (encodedCharacters + item.url.length > maxEncodedCharacters) return false;
      encodedCharacters += item.url.length;
      return true;
    });
    if (items.length) Object.defineProperty(normalized, sessionId, { value: items, enumerable: true, configurable: true, writable: true });
  }
  return normalized;
}

function readSessionViewCache(workspace: WorkspaceDescriptor): SessionViewCache | undefined {
  if (typeof sessionStorage === 'undefined') return undefined;
  try {
    // v1 had only remote snapshots. Reading it here is the explicit, one-way v1 → v2 migration.
    const current = sessionStorage.getItem(sessionViewCacheKey(workspace.id));
    const legacy = current === null ? sessionStorage.getItem(sessionViewCacheKey(workspace.id, 1)) : null;
    const parsed = JSON.parse(current ?? legacy ?? 'null') as {
      version?: number;
      workspaceId?: string;
      cachedAt?: number;
      activeSessionId?: string;
      sessions?: ApiSession[];
      localDrafts?: ApiSession[];
      drafts?: Record<string, unknown>;
      attachments?: Record<string, unknown>;
      providerSelection?: { active?: unknown; models?: unknown };
    } | null;
    if (!parsed || (parsed.version !== 1 && parsed.version !== SESSION_VIEW_CACHE_VERSION)
      || parsed.workspaceId !== workspace.id || typeof parsed.cachedAt !== 'number'
      || parsed.cachedAt > Date.now() + 60_000 || Date.now() - parsed.cachedAt > SESSION_VIEW_CACHE_MAX_AGE
      || !Array.isArray(parsed.sessions)) return undefined;
    const localDrafts = parsed.version === SESSION_VIEW_CACHE_VERSION && Array.isArray(parsed.localDrafts)
      ? parsed.localDrafts.map(toStoredSession).map(session => cacheBoundedSession(session, 0)).filter(session => session.draft === true
        && session.id.startsWith('draft:') && session.workspaceId === workspace.id).slice(0, SESSION_VIEW_CACHE_MAX_DRAFTS)
      : [];
    const draftIds = new Set(localDrafts.map(session => session.id));
    const drafts = Object.fromEntries(Object.entries(parsed.drafts ?? {}).flatMap(([id, value]) => (
      draftIds.has(id) && typeof value === 'string'
        ? [[id, value.slice(0, SESSION_VIEW_CACHE_MAX_DRAFT_CHARS)]]
        : []
    )));
    const rawModels = parsed.providerSelection?.models;
    const models = rawModels && typeof rawModels === 'object'
      ? Object.fromEntries(Object.entries(rawModels).filter(([provider, model]) => (
          /^[A-Za-z0-9._-]{1,80}$/.test(provider) && !['__proto__', 'prototype', 'constructor'].includes(provider)
          && typeof model === 'string' && model.length <= 500
        ))) as Record<string, string>
      : {};
    const providerSelection = typeof parsed.providerSelection?.active === 'string'
      && /^[A-Za-z0-9._-]{1,80}$/.test(parsed.providerSelection.active)
      && !['__proto__', 'prototype', 'constructor'].includes(parsed.providerSelection.active)
      ? { active: parsed.providerSelection.active, models }
      : undefined;
    return {
      sessions: parsed.sessions.map(toStoredSession).map(session => cacheBoundedSession(session)).filter(session => !session.draft),
      localDrafts,
      drafts,
      attachments: normalizedCachedAttachments(parsed.attachments, draftIds),
      ...(providerSelection ? { providerSelection } : {}),
      ...(typeof parsed.activeSessionId === 'string' ? { activeSessionId: parsed.activeSessionId } : {}),
    };
  } catch { return undefined; }
}

function writeSessionViewCache(state: SessionCacheState): void {
  if (typeof sessionStorage === 'undefined' || !state.workspace) return;
  try {
    const eligible = state.sessions.filter(session => !session.draft
      && (!session.workspaceId || session.workspaceId === state.workspace!.id));
    const active = eligible.find(session => session.id === state.activeSessionId);
    const ordered = [...(active ? [active] : []), ...eligible.filter(session => session !== active)].slice(0, 3);
    let sessions = ordered.map(session => cacheBoundedSession(session));
    const eligibleDrafts = state.sessions.filter(session => session.draft
      && session.id.startsWith('draft:') && session.workspaceId === state.workspace!.id);
    const activeDraft = eligibleDrafts.find(session => session.id === state.activeSessionId);
    let localDrafts = [...(activeDraft ? [activeDraft] : []), ...eligibleDrafts.filter(session => session !== activeDraft)]
      .slice(0, SESSION_VIEW_CACHE_MAX_DRAFTS).map(session => cacheBoundedSession(session, 0));
    let draftIds = new Set(localDrafts.map(session => session.id));
    let drafts = Object.fromEntries(Object.entries(state.drafts).flatMap(([id, value]) => (
      draftIds.has(id) && typeof value === 'string'
        ? [[id, value.slice(0, SESSION_VIEW_CACHE_MAX_DRAFT_CHARS)]]
        : []
    )));
    const orderedAttachmentCandidates = Object.fromEntries(localDrafts.map(session => (
      [session.id, getSessionRecord(state.attachments, session.id) ?? []]
    )));
    let attachments = normalizedCachedAttachments(
      orderedAttachmentCandidates,
      draftIds,
      SESSION_VIEW_CACHE_MAX_BYTES,
    );
    const serialize = () => JSON.stringify({
      version: SESSION_VIEW_CACHE_VERSION,
      workspaceId: state.workspace!.id,
      cachedAt: Date.now(),
      activeSessionId: state.activeSessionId,
      sessions,
      localDrafts,
      drafts,
      attachments,
      providerSelection: {
        active: state.providers.active,
        models: Object.fromEntries(Object.entries(state.providers.available).flatMap(([provider, config]) => (
          typeof config.model === 'string' && config.model.length <= 500 ? [[provider, config.model]] : []
        ))),
      },
    });
    let payload = serialize();
    const exceedsBudget = () => new TextEncoder().encode(payload).byteLength > SESSION_VIEW_CACHE_MAX_BYTES;
    while (exceedsBudget() && sessions.length > 1) {
      sessions = sessions.slice(0, -1);
      payload = serialize();
    }
    // Draft text and settings take precedence over binary previews when browser storage is tight.
    while (exceedsBudget() && Object.keys(attachments).length) {
      const id = Object.keys(attachments).at(-1)!;
      const remaining = attachments[id]!.slice(0, -1);
      if (remaining.length) attachments = { ...attachments, [id]: remaining };
      else attachments = omitRecordKey(attachments, id);
      payload = serialize();
    }
    while (exceedsBudget() && localDrafts.length > 1) {
      localDrafts = localDrafts.slice(0, -1);
      draftIds = new Set(localDrafts.map(session => session.id));
      drafts = Object.fromEntries(Object.entries(drafts).filter(([id]) => draftIds.has(id)));
      attachments = Object.fromEntries(Object.entries(attachments).filter(([id]) => draftIds.has(id)));
      payload = serialize();
    }
    if (exceedsBudget() && sessions[0]) {
      sessions = [cacheBoundedSession(sessions[0], 40)];
      payload = serialize();
    }
    if (!exceedsBudget()) {
      sessionStorage.setItem(sessionViewCacheKey(state.workspace.id), payload);
    }
  } catch { /* The bounded cache is optional when storage or quota is unavailable. */ }
}

function flushSessionViewCache(): void {
  if (sessionCacheTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(sessionCacheTimer);
  sessionCacheTimer = undefined;
  const pending = pendingSessionCacheState;
  pendingSessionCacheState = undefined;
  if (pending) writeSessionViewCache(pending);
}

function scheduleSessionViewCache(state: SessionCacheState): void {
  if (typeof window === 'undefined') return;
  pendingSessionCacheState = state;
  if (sessionCacheTimer !== undefined) return;
  sessionCacheTimer = window.setTimeout(flushSessionViewCache, 300);
}

function readWorkspaceState(): { current?: string; recent: WorkspaceDescriptor[] } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_STATE_KEY) || '{}') as {
      version?: number;
      current?: string;
      recent?: WorkspaceDescriptor[];
    };
    if (parsed.version === 1 && Array.isArray(parsed.recent)) return { current: parsed.current, recent: parsed.recent.slice(0, 8) };
  } catch { /* Storage is optional. */ }
  return { recent: [] };
}

function writeWorkspaceState(current: WorkspaceDescriptor, recent: WorkspaceDescriptor[]): void {
  try {
    window.localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify({
      version: 1,
      current: current.cwd,
      recent: recent.slice(0, 8),
    }));
  } catch { /* Storage is optional. */ }
}

export const useSessionStore = create<AppState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  workspace: null,
  recentWorkspaces: [],
  runs: {},
  runAuthorities: {},
  runEpoch: 0,
  drafts: {},
  attachments: {},
  providers: {
    active: PROVIDER.MOCK,
    available: defaultProviders,
  },
  skills: {},

  createSession: title => {
    const id = workspaceDraftId();
    const now = new Date();
    const workspace = get().workspace;
    const session: StoredSession = {
      id,
      title,
      messages: [],
      createdAt: now,
      updatedAt: now,
      cwd: workspace?.cwd,
      workspaceId: workspace?.id,
      draft: true,
    };
    set(state => ({ sessions: [session, ...state.sessions], activeSessionId: id }));
  },

  createRemoteSession: async title => {
    const result = await createApiSession(title, get().workspace?.cwd);
    if (!result.success || !result.data) return undefined;
    const session = toStoredSession(result.data);
    set(state => ({ sessions: [session, ...state.sessions], activeSessionId: session.id }));
    return session.id;
  },

  hydrateWorkspace: async requestedCwd => {
    const sequence = ++workspaceHydrationSequence;
    const stored = readWorkspaceState();
    const candidate = requestedCwd || stored.current;
    const selected = candidate ? await validateWorkspace(candidate) : await getDefaultWorkspace();
    const fallback = !selected.success || !selected.data ? await getDefaultWorkspace() : selected;
    if (sequence !== workspaceHydrationSequence || !fallback.success || !fallback.data) return;
    const recent = [fallback.data, ...stored.recent.filter(item => item.cwd !== fallback.data!.cwd)].slice(0, 8);
    set({ workspace: fallback.data, recentWorkspaces: recent });
    writeWorkspaceState(fallback.data, recent);
  },

  refreshWorkspace: async () => {
    const workspace = get().workspace;
    if (!workspace) return;
    const sequence = ++workspaceHydrationSequence;
    const refreshed = await validateWorkspace(workspace.cwd);
    if (sequence !== workspaceHydrationSequence || !refreshed.success || !refreshed.data
      || get().workspace?.cwd !== workspace.cwd) return;
    const recent = [
      refreshed.data,
      ...get().recentWorkspaces.filter(item => item.cwd !== refreshed.data!.cwd),
    ].slice(0, 8);
    set({ workspace: refreshed.data, recentWorkspaces: recent });
    writeWorkspaceState(refreshed.data, recent);
  },

  setWorkspace: async workspace => {
    flushSessionViewCache();
    workspaceHydrationSequence++;
    modelCatalogRequestSequence++;
    skillCatalogRequestSequence++;
    sessionHydrationController?.abort();
    const recent = [workspace, ...get().recentWorkspaces.filter(item => item.cwd !== workspace.cwd)].slice(0, 8);
    set(state => ({
      workspace,
      recentWorkspaces: recent,
      activeSessionId: null,
      sessions: [],
      runs: {},
      runEpoch: state.runEpoch + 1,
      drafts: {},
      attachments: {},
      providers: {
        active: PROVIDER.MOCK,
        available: Object.fromEntries(Object.entries(state.providers.available).map(([type, config]) => [type, {
          ...config,
          model: defaultProviders[type as ProviderType]?.model,
        }])) as Record<ProviderType, ProviderConfig>,
        catalogLoading: true,
      },
      skills: { loading: true },
    }));
    writeWorkspaceState(workspace, recent);
    await Promise.all([get().hydrateSessions(), get().hydrateModelCatalog(), get().hydrateSkillCatalog()]);
  },

  hydrateSessions: async () => {
    const workspace = get().workspace;
    sessionHydrationController?.abort();
    const controller = new AbortController();
    sessionHydrationController = controller;
    const cached = workspace ? readSessionViewCache(workspace) : undefined;
    if (workspace && cached) {
      set(state => {
        if (state.workspace?.id !== workspace.id) return state;
        const localDrafts = state.sessions.filter(session => session.draft && session.workspaceId === workspace.id);
        const localIds = new Set(localDrafts.map(session => session.id));
        localDrafts.push(...cached.localDrafts.filter(session => !localIds.has(session.id)));
        const sessions = [...localDrafts, ...cached.sessions];
        const available = { ...state.providers.available };
        for (const [provider, model] of Object.entries(cached.providerSelection?.models ?? {})) {
          const type = provider as ProviderType;
          if (Object.prototype.hasOwnProperty.call(available, type)) available[type] = { ...available[type], model };
        }
        const cachedProvider = cached.providerSelection?.active as ProviderType | undefined;
        return {
          sessions,
          drafts: { ...cached.drafts, ...state.drafts },
          attachments: { ...cached.attachments, ...state.attachments },
          providers: {
            active: cachedProvider && Object.prototype.hasOwnProperty.call(available, cachedProvider)
              ? cachedProvider : state.providers.active,
            available,
          },
          activeSessionId: state.activeSessionId && sessions.some(session => session.id === state.activeSessionId)
            ? state.activeSessionId
            : cached.activeSessionId && sessions.some(session => session.id === cached.activeSessionId)
              ? cached.activeSessionId
              : sessions[0]?.id ?? null,
        };
      });
    }
    const result = await listSessions(workspace?.cwd, controller.signal);
    if (controller.signal.aborted || get().workspace?.id !== workspace?.id || !result.success || !result.data) return;
    if (sessionHydrationController === controller) sessionHydrationController = undefined;
    set(state => {
      const existing = new Map(state.sessions.map(session => [session.id, session]));
      const remote = result.data!.map(session => mergeStoredSession(existing.get(session.id), session));
      const localDrafts = state.sessions.filter(session => session.draft
        && (!workspace || session.workspaceId === workspace.id));
      const sessions = [...localDrafts, ...remote];
      return {
        sessions,
        activeSessionId: state.activeSessionId && sessions.some(session => session.id === state.activeSessionId)
          ? state.activeSessionId
          : sessions[0]?.id ?? null,
      };
    });
  },

  replaceSession: (localId, remote) => set(state => {
    const previous = state.sessions.find(item => item.id === remote.id);
    const session = mergeStoredSession(previous, remote);
    return {
      sessions: [session, ...state.sessions.filter(item => item.id !== localId && item.id !== session.id)],
      activeSessionId: state.activeSessionId === localId ? session.id : state.activeSessionId,
      drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => id !== localId)),
      attachments: localId === session.id ? state.attachments : {
        ...Object.fromEntries(Object.entries(state.attachments).filter(([id]) => id !== localId)),
        ...(getSessionRecord(state.attachments, localId) ? { [session.id]: getSessionRecord(state.attachments, localId)! } : {}),
      },
    };
  }),

  syncSession: remote => set(state => {
    const previous = state.sessions.find(item => item.id === remote.id);
    const session = mergeStoredSession(previous, remote);
    return { sessions: previous
      ? state.sessions.map(item => item.id === session.id ? session : item)
      : [session, ...state.sessions] };
  }),

  mergeMessagePage: (sessionId, page) => set(state => ({
    sessions: state.sessions.map(session => session.id === sessionId
      ? mergeMessageWindow(session, page.messages, page)
      : session),
  })),

  removeSession: sessionId => set(state => {
    const drafts = omitRecordKey(state.drafts, sessionId);
    const attachments = omitRecordKey(state.attachments, sessionId);
    const runs = omitRecordKey(state.runs, sessionId);
    const previous = getStoredRun(state.runs, sessionId);
    const prior = getRunAuthority(state.runAuthorities, sessionId);
    return {
      sessions: state.sessions.filter(session => session.id !== sessionId),
      activeSessionId: state.activeSessionId === sessionId
        ? state.sessions.find(session => session.id !== sessionId)?.id ?? null
        : state.activeSessionId,
      drafts,
      attachments,
      runs,
      ...authorityPublication(state, retainRunAuthority(state.runAuthorities, sessionId, {
        sequence: prior?.sequence ?? previous?.lastSequence ?? 0,
        terminal: true,
        retired: [...new Set([...(prior?.retired ?? []), ...(prior?.runId ? [prior.runId] : []), ...(previous ? [previous.id] : [])])].slice(-16),
        retiredFilter: previous ? rememberRetirement(prior?.retiredFilter, JSON.stringify([sessionId, previous.id])) : prior?.retiredFilter,
        deleted: true,
      })),
    };
  }),

  renameSession: (sessionId, title) => set(state => ({
    sessions: state.sessions.map(session => session.id === sessionId ? { ...session, title } : session),
  })),

  updateSessionSettings: (sessionId, changes) => set(state => ({
    sessions: state.sessions.map(session => session.id === sessionId ? { ...session, ...changes } : session),
  })),

  addMessage: (sessionId, message) => {
    const fullMessage: Message = { ...message, id: crypto.randomUUID(), timestamp: new Date() };
    set(state => ({
      sessions: state.sessions.map(session => session.id === sessionId
        ? {
            ...session,
            messages: [...session.messages, fullMessage],
            updatedAt: new Date(),
            title: session.title || message.content.slice(0, 50),
          }
        : session),
    }));
  },

  upsertAssistantMessage: (sessionId, messageId, content, reasoning) => set(state => ({
    sessions: state.sessions.map(session => {
      if (session.id !== sessionId) return session;
      const existingIndex = session.messages.findIndex(message => message.id === messageId);
      const messages = existingIndex >= 0
        ? session.messages.map((message, index) => index === existingIndex ? {
            ...message,
            content,
            blocks: [
              ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
              { type: 'text' as const, text: content },
            ],
          } : message)
        : [...session.messages, {
            id: messageId,
            role: 'assistant' as const,
            content,
            blocks: [
              ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
              { type: 'text' as const, text: content },
            ],
            timestamp: new Date(),
          }];
      return { ...session, messages, updatedAt: new Date() };
    }),
  })),

  setActiveSession: id => set(state => ({
    activeSessionId: id,
    sessions: id ? state.sessions.map(session => session.id === id
      ? { ...session, unread: false, attention: false }
      : session) : state.sessions,
  })),

  setRun: (sessionId, run, guard) => {
    let admitted = false;
    set(state => {
    const authority = getRunAuthority(state.runAuthorities, sessionId);
    if (guard && (guard.epoch !== state.runEpoch || guard.authority !== authority
      || ('activeSessionId' in guard && guard.activeSessionId !== state.activeSessionId))) return state;
    const previous = getStoredRun(state.runs, sessionId);
    const history = historyFor(state.runAuthorities);
    const canonical = canonicalGeneration(guard);
    // Undefined can recur after eviction. Only the captured collection generation
    // can authorize a collision-recovery read; literal canonical flags cannot.
    if (canonical !== undefined && !guard?.authority && canonical !== history.generation) return state;
    const sequence = Math.max(authority?.sequence ?? 0, previous?.lastSequence ?? 0);
    if (!run && guard?.absenceSequence !== undefined
      && (!Number.isSafeInteger(guard.absenceSequence) || guard.absenceSequence < sequence)) return state;
    // Zero before any run is startup absence, not evidence of terminal history.
    // Positive absence, deletion or any observed/retired run can never be pristine.
    const pristine = !previous && !authority?.runId && !authority?.deleted
      && !(authority?.retired.length) && sequence === 0 && (guard?.absenceSequence ?? 0) === 0
      && (!authority || authority.pristine === true);
    if (!run) {
      const nextAuthority: RunAuthority = {
        sequence: Math.max(sequence, guard?.absenceSequence ?? 0),
        terminal: !pristine,
        pristine,
        retired: [...new Set([...(authority?.retired ?? []), ...(authority?.runId ? [authority.runId] : []), ...(previous ? [previous.id] : [])])].slice(-16),
        retiredFilter: previous ? rememberRetirement(authority?.retiredFilter, JSON.stringify([sessionId, previous.id])) : authority?.retiredFilter,
        deleted: authority?.deleted,
      };
      admitted = true;
      if (!previous && JSON.stringify(nextAuthority) === JSON.stringify(authority)) return state;
      return { runs: omitRecordKey(state.runs, sessionId),
        ...authorityPublication(state, retainRunAuthority(state.runAuthorities, sessionId, nextAuthority)) };
    }
    const observed = guard?.snapshotSequence ?? run.lastSequence;
    if (!Number.isSafeInteger(observed) || observed < run.lastSequence) return state;
    const priorRunId = authority?.runId ?? previous?.id;
    if (run.sessionId !== sessionId || !Number.isSafeInteger(run.lastSequence) || run.lastSequence < 0 || authority?.deleted
      || (state.workspace && (run.workspaceId ? run.workspaceId !== state.workspace.id : run.cwd !== state.workspace.cwd))
      || (priorRunId === run.id ? run.lastSequence < (previous?.lastSequence ?? 0) : observed < sequence)
      || authority?.retired.includes(run.id)
      || (canonical === undefined && ((!authority && remembersRetirement(history.deleted, sessionId))
        || (run.id !== previous?.id && (remembersRetirement(authority?.retiredFilter, JSON.stringify([sessionId, run.id]))
          || remembersRetirement(history.retired, JSON.stringify([sessionId, run.id]))))))
      || (authority && !authority.runId && !(authority.pristine && run.lastSequence === 0) && observed <= sequence)
      || (priorRunId && priorRunId !== run.id && (canonical === undefined ? observed <= sequence : observed < sequence))) return state;
    const terminal = ['completed', 'failed', 'stopped'].includes(run.phase);
    if (previous?.id === run.id && previous.lastSequence === run.lastSequence && !terminal) {
      const before = orderedExtensionRequests(previous).map(request => request.id);
      const after = orderedExtensionRequests(run).map(request => request.id);
      if (before.length !== after.length || before.some((id, index) => id !== after[index])) {
        const reply = guard?.[INTERACTION_REPLY] && interactionReplyWitnesses.get(guard[INTERACTION_REPLY]);
        // Only a still-current successful HTTP response for the captured head
        // may acknowledge precisely that closure at an unchanged run version.
        // No snapshot flag, other removal, invented ID or reordering is admitted.
        const expected = reply && reply.sessionId === sessionId && reply.runId === run.id && before[0] === reply.requestId
          ? before.slice(1) : undefined;
        if (!expected || expected.length !== after.length || expected.some((id, index) => id !== after[index])) return state;
      }
    }
    if (priorRunId === run.id && (authority?.terminal || (previous && ['completed', 'failed', 'stopped'].includes(previous.phase))) && !terminal) return state;
    const retired = [...new Set([...(authority?.retired ?? []),
      ...(authority?.runId && authority.runId !== run.id ? [authority.runId] : [])])].slice(-16);
    const nextAuthority: RunAuthority = {
      sequence: Math.max(sequence, observed), runId: run.id, terminal, retired,
      retiredFilter: priorRunId && priorRunId !== run.id
        ? rememberRetirement(authority?.retiredFilter, JSON.stringify([sessionId, priorRunId])) : authority?.retiredFilter,
    };
    // Mere observations do not revoke outstanding callbacks. Retire the record
    // only when its version/correlation/terminal/negative-history meaning changes.
    const unchangedAuthority = JSON.stringify(nextAuthority) === JSON.stringify(authority);
    const runAuthorities = unchangedAuthority ? state.runAuthorities
      : retainRunAuthority(state.runAuthorities, sessionId, nextAuthority);
    // A terminal snapshot has no dialog authority, even if a transport retained its queue.
    const acceptedRun = terminal ? { ...run, extensionRequests: [], extensionRequest: undefined } : run;
    const previousTerminal = previous ? ['completed', 'failed', 'stopped'].includes(previous.phase) : true;
    const backgroundCompletion = terminal && !previousTerminal && state.activeSessionId !== sessionId;
    admitted = true;
    if (unchangedAuthority && JSON.stringify(previous) === JSON.stringify(acceptedRun)) return state;
    return {
      runs: { ...state.runs, [sessionId]: acceptedRun },
      ...authorityPublication(state, runAuthorities),
      sessions: backgroundCompletion ? state.sessions.map(session => session.id === sessionId ? {
        ...session,
        unread: true,
        attention: acceptedRun.phase === 'failed' || session.attention,
      } : session) : state.sessions,
    };
    });
    return admitted;
  },

  setDraft: (sessionId, value) => set(state => ({ drafts: { ...state.drafts, [sessionId]: value } })),

  addAttachments: (sessionId, attachments) => set(state => ({
    attachments: { ...state.attachments, [sessionId]: [...(getSessionRecord(state.attachments, sessionId) ?? []), ...attachments].slice(0, 8) },
  })),
  removeAttachment: (sessionId, attachmentId) => set(state => ({
    attachments: { ...state.attachments, [sessionId]: (getSessionRecord(state.attachments, sessionId) ?? []).filter(item => item.id !== attachmentId) },
  })),
  clearAttachments: sessionId => set(state => ({ attachments: { ...state.attachments, [sessionId]: [] } })),

  setProvider: type => set(state => ({ providers: { ...state.providers, active: type } })),

  setModel: (type, model) => set(state => ({
    providers: {
      ...state.providers,
      available: { ...state.providers.available, [type]: { ...state.providers.available[type], model } },
    },
  })),

  hydrateProviders: async () => {
    const result = await getProviders();
    if (!result.success || !result.data) return;
    set(state => {
      const available = { ...state.providers.available };
      for (const provider of result.data!) {
        const type = provider.type as ProviderType;
        const existing = available[type] ?? { type, model: '' };
        available[type] = { ...existing, ...(provider.configured ? { apiKey: 'configured' } : {}) };
      }
      return { providers: { ...state.providers, available } };
    });
  },

  hydrateModelCatalog: async (refresh = false) => {
    const sequence = ++modelCatalogRequestSequence;
    const projectId = get().workspace?.id;
    set(state => ({ providers: { ...state.providers, catalogLoading: true, catalogError: undefined } }));
    const result = await getModelCatalog(projectId, refresh);
    if (sequence !== modelCatalogRequestSequence || get().workspace?.id !== projectId) return;
    set(state => ({ providers: {
      ...state.providers,
      catalog: result.success ? result.data : state.providers.catalog,
      catalogLoading: false,
      catalogError: result.success ? undefined : result.error,
    } }));
  },

  setModelEnabled: async (key, enabled) => {
    const state = get();
    const catalog = state.providers.catalog;
    if (!catalog || state.providers.catalogLoading) return;
    const projectId = state.workspace?.id;
    const sequence = ++modelCatalogRequestSequence;
    const enabledKeys = new Set(catalog.providers.flatMap(provider => provider.models
      .filter(model => model.enabled)
      .map(model => model.key)));
    if (enabled) enabledKeys.add(key);
    else enabledKeys.delete(key);
    const optimisticCatalog: ModelCatalog = {
      ...catalog,
      providers: catalog.providers.map(provider => ({
        ...provider,
        models: provider.models.map(model => model.key === key ? { ...model, enabled } : model),
      })),
    };
    set(current => ({ providers: {
      ...current.providers, catalog: optimisticCatalog, catalogLoading: true, catalogError: undefined,
    } }));
    const result = await updateEnabledModelsApi([...enabledKeys], projectId);
    if (sequence !== modelCatalogRequestSequence || get().workspace?.id !== projectId) return;
    set(current => ({ providers: {
      ...current.providers,
      catalog: result.success ? result.data : catalog,
      catalogLoading: false,
      catalogError: result.success ? undefined : result.error,
    } }));
  },

  setAllModelsEnabled: async enabled => {
    const state = get();
    const catalog = state.providers.catalog;
    if (!catalog || state.providers.catalogLoading) return;
    const projectId = state.workspace?.id;
    const sequence = ++modelCatalogRequestSequence;
    const enabledKeys = enabled
      ? catalog.providers.flatMap(provider => provider.models.map(model => model.key))
      : [];
    const optimisticCatalog: ModelCatalog = {
      ...catalog,
      providers: catalog.providers.map(provider => ({
        ...provider, models: provider.models.map(model => ({ ...model, enabled })),
      })),
    };
    set(current => ({ providers: {
      ...current.providers, catalog: optimisticCatalog, catalogLoading: true, catalogError: undefined,
    } }));
    const result = await updateEnabledModelsApi(enabledKeys, projectId);
    if (sequence !== modelCatalogRequestSequence || get().workspace?.id !== projectId) return;
    set(current => ({ providers: {
      ...current.providers,
      catalog: result.success ? result.data : catalog,
      catalogLoading: false,
      catalogError: result.success ? undefined : result.error,
    } }));
  },

  hydrateSkillCatalog: async (refresh = false) => {
    const sequence = ++skillCatalogRequestSequence;
    const workspace = get().workspace;
    set({ skills: { ...get().skills, loading: true, error: undefined } });
    const result = await getSkillCatalog(workspace?.cwd, workspace?.id, refresh);
    if (sequence !== skillCatalogRequestSequence || get().workspace?.id !== workspace?.id) return;
    set(state => ({ skills: {
      catalog: result.success ? result.data : state.skills.catalog,
      loading: false,
      error: result.success ? undefined : result.error,
    } }));
  },

  setSkillModelInvocable: async (key, enabled) => {
    const state = get();
    const catalog = state.skills.catalog;
    const target = catalog?.skills.find(skill => skill.key === key);
    if (!catalog || !target || state.skills.loading || (enabled && !target.trusted)) return;
    const workspace = state.workspace;
    const sequence = ++skillCatalogRequestSequence;
    const enabledKeys = new Set(catalog.skills.filter(skill => skill.modelInvocable).map(skill => skill.key));
    if (enabled) enabledKeys.add(key);
    else enabledKeys.delete(key);
    const optimisticCatalog: SkillCatalog = {
      ...catalog,
      skills: catalog.skills.map(skill => skill.key === key ? { ...skill, modelInvocable: enabled } : skill),
    };
    set({ skills: { catalog: optimisticCatalog, loading: true, error: undefined } });
    const result = await updateEnabledSkillsApi([...enabledKeys], workspace?.cwd, workspace?.id);
    if (sequence !== skillCatalogRequestSequence || get().workspace?.id !== workspace?.id) return;
    set({ skills: {
      catalog: result.success ? result.data : catalog,
      loading: false,
      error: result.success ? undefined : result.error,
    } });
  },

  updateApiKey: (type, apiKey) => set(state => ({
    providers: {
      ...state.providers,
      available: { ...state.providers.available, [type]: { ...state.providers.available[type], apiKey } },
    },
  })),
}));

if (typeof window !== 'undefined') {
  let previousWorkspace = useSessionStore.getState().workspace;
  let previousSessions = useSessionStore.getState().sessions;
  let previousActiveSessionId = useSessionStore.getState().activeSessionId;
  let previousDrafts = useSessionStore.getState().drafts;
  let previousAttachments = useSessionStore.getState().attachments;
  let previousProviders = useSessionStore.getState().providers;
  useSessionStore.subscribe(state => {
    if (state.workspace === previousWorkspace && state.sessions === previousSessions
      && state.activeSessionId === previousActiveSessionId && state.drafts === previousDrafts
      && state.attachments === previousAttachments && state.providers === previousProviders) return;
    previousWorkspace = state.workspace;
    previousSessions = state.sessions;
    previousActiveSessionId = state.activeSessionId;
    previousDrafts = state.drafts;
    previousAttachments = state.attachments;
    previousProviders = state.providers;
    scheduleSessionViewCache(state);
  });
  window.addEventListener('pagehide', flushSessionViewCache);
}

export const baseStore = useSessionStore;
export const providerStore = useSessionStore;
