// ============================================================
// Session Store - sessions, workspace, detached runs and providers
// ============================================================

import { create } from 'zustand';
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

export interface SessionState {
  sessions: StoredSession[];
  activeSessionId: string | null;
  workspace: WorkspaceDescriptor | null;
  recentWorkspaces: WorkspaceDescriptor[];
  runs: Record<string, AgentRunSnapshot>;
  drafts: Record<string, string>;
  attachments: Record<string, DraftAttachment[]>;
  createSession: (title?: string) => void;
  createRemoteSession: (title?: string) => Promise<string | undefined>;
  hydrateWorkspace: (requestedCwd?: string) => Promise<void>;
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
  setRun: (sessionId: string, run?: AgentRunSnapshot) => void;
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
    if (items.length) normalized[sessionId] = items;
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
      [session.id, state.attachments[session.id] ?? []]
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
      else {
        const { [id]: _removed, ...rest } = attachments;
        attachments = rest;
      }
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
        ...(state.attachments[localId] ? { [session.id]: state.attachments[localId] } : {}),
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
    const { [sessionId]: _draft, ...drafts } = state.drafts;
    const { [sessionId]: _attachments, ...attachments } = state.attachments;
    const { [sessionId]: _run, ...runs } = state.runs;
    return {
      sessions: state.sessions.filter(session => session.id !== sessionId),
      activeSessionId: state.activeSessionId === sessionId
        ? state.sessions.find(session => session.id !== sessionId)?.id ?? null
        : state.activeSessionId,
      drafts,
      attachments,
      runs,
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

  setRun: (sessionId, run) => set(state => {
    if (!run) {
      const { [sessionId]: _removed, ...runs } = state.runs;
      return { runs };
    }
    const previous = state.runs[sessionId];
    if (previous?.id === run.id && previous.lastSequence > run.lastSequence) return state;
    const terminal = ['completed', 'failed', 'stopped'].includes(run.phase);
    const previousTerminal = previous ? ['completed', 'failed', 'stopped'].includes(previous.phase) : true;
    const backgroundCompletion = terminal && !previousTerminal && state.activeSessionId !== sessionId;
    return {
      runs: { ...state.runs, [sessionId]: run },
      sessions: backgroundCompletion ? state.sessions.map(session => session.id === sessionId ? {
        ...session,
        unread: true,
        attention: run.phase === 'failed' || session.attention,
      } : session) : state.sessions,
    };
  }),

  setDraft: (sessionId, value) => set(state => ({ drafts: { ...state.drafts, [sessionId]: value } })),

  addAttachments: (sessionId, attachments) => set(state => ({
    attachments: { ...state.attachments, [sessionId]: [...(state.attachments[sessionId] ?? []), ...attachments].slice(0, 8) },
  })),
  removeAttachment: (sessionId, attachmentId) => set(state => ({
    attachments: { ...state.attachments, [sessionId]: (state.attachments[sessionId] ?? []).filter(item => item.id !== attachmentId) },
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
