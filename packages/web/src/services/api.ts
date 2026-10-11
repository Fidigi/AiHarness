// ============================================================
// API Service Layer - Connects React frontend to Express backend
// Handles: detached agents, sessions, workspaces and provider config
// ============================================================

import type {
  AgentEvent,
  AgentRunSnapshot,
  AgentStateSnapshot,
  CustomModelDefinition,
  CustomProviderDefinition,
  EffectiveConfiguration,
  GitWorktree,
  Message,
  McpConfigInventory,
  ModelCatalog,
  PluginCatalog,
  PluginEnableBatchResult,
  PluginEnableChange,
  PluginReloadResult,
  PluginScope,
  PluginUpdateResult,
  ProjectTrustStatus,
  ProviderAuthStatus,
  SkillCatalog,
  SkillRegistry,
  SkillRegistryEntry,
  SerializedSession,
  Session,
  ShellCommandEvent,
  ShellCommandSnapshot,
  SubagentConfiguration,
  SubagentProfile,
  SubagentRunSnapshot,
  ToolSettings,
  WorkspaceDescriptor,
} from '@ai-harness/core';

const API_BASE = '/api';
const MAX_CHAT_STREAM_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHAT_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_STREAM_EVENTS = 100_000;
const MAX_CHAT_WEBSOCKET_QUEUE = 1_024;
const MAX_CHAT_WEBSOCKET_QUEUE_BYTES = 32 * 1024 * 1024;
const CHAT_STREAM_IDLE_TIMEOUT_MS = 120_000;
let authToken = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ai-harness-auth-token') ?? '' : '';
let chatTransport: 'sse' | 'websocket' = typeof localStorage !== 'undefined' && localStorage.getItem('ai-harness-transport') === 'websocket'
  ? 'websocket' : 'sse';

export function setChatTransport(transport: 'sse' | 'websocket'): void {
  chatTransport = transport;
  if (typeof localStorage !== 'undefined') localStorage.setItem('ai-harness-transport', transport);
}

export function getChatTransport(): 'sse' | 'websocket' {
  return chatTransport;
}

export function setAuthToken(token: string): void {
  const candidate = typeof token === 'string' ? token.trim() : '';
  authToken = candidate.length <= 10_000 && utf8ByteLength(candidate) <= 10_000
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(candidate)
    ? candidate : '';
  if (typeof sessionStorage !== 'undefined') {
    if (authToken) sessionStorage.setItem('ai-harness-auth-token', authToken);
    else sessionStorage.removeItem('ai-harness-auth-token');
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(input, { ...init, headers, credentials: init.credentials ?? 'same-origin' }).then(response => {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('aih-auth-required'));
    return response;
  });
}

export interface WebAuthStatus {
  required: boolean;
  authenticated: boolean;
  role?: 'anonymous' | 'user' | 'admin';
  expiresAt?: string;
}

export async function getWebAuthStatus(): Promise<ApiResponse<WebAuthStatus>> {
  try {
    const response = await fetch(`${API_BASE}/auth/status`, { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({})) as WebAuthStatus & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Authentication status failed' };
  }
}

export async function loginWeb(token: string): Promise<ApiResponse<WebAuthStatus>> {
  try {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await response.json().catch(() => ({})) as WebAuthStatus & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data: { ...data, required: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Login failed' };
  }
}

export async function logoutWeb(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'same-origin' });
  setAuthToken('');
}

export interface AppUpdateStatus {
  webVersion: string;
  agentVersion: string;
  checkedAt: string;
  available: boolean;
  release?: {
    version: string;
    name: string;
    url: string;
    publishedAt?: string;
    notes?: string;
  };
  error?: { code: 'disabled' | 'unavailable' | 'invalid-response'; message: string };
}

export async function getAppUpdateStatus(refresh = false): Promise<ApiResponse<AppUpdateStatus>> {
  try {
    const suffix = refresh ? '?refresh=true' : '';
    const response = await apiFetch(`${API_BASE}/app-update${suffix}`);
    const data = await response.json().catch(() => ({})) as Omit<AppUpdateStatus, 'error'> & { error?: AppUpdateStatus['error'] | string };
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
    return { success: true, data: data as AppUpdateStatus };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Update check failed' };
  }
}

/** Standardized response wrapper */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface SessionMessagePageInfo {
  start: number;
  end: number;
  total: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  nextBefore?: string;
  nextAfter?: string;
  revision: number;
  targetIndex?: number;
}

/** Session JSON contract. Dates are ISO strings until the store hydrates them. */
export type ApiSession = SerializedSession & { messagePage?: SessionMessagePageInfo };

export interface SessionMessagePage extends SessionMessagePageInfo {
  messages: SerializedSession['messages'];
  /** Compatibility with the first server-side pagination response. */
  hasMore?: boolean;
}

export interface AgentStartResponse {
  run: AgentRunSnapshot;
  session: ApiSession;
  workspace: WorkspaceDescriptor;
}

export interface AgentStateResponse extends AgentStateSnapshot {
  session: ApiSession;
}

export interface WorkspaceBrowseResponse {
  cwd: string;
  parent?: string;
  entries: Array<{ name: string; path: string; isDirectory: boolean; isSymbolicLink: boolean }>;
  truncated?: boolean;
}

export interface FileManagerAvailability {
  available: boolean;
  reason?: 'remote-request' | 'unsupported-platform';
}

/** Provider configuration from backend */
export interface ApiProvider {
  type: string;
  configured: boolean;
}

/** Resolve non-secret settings and their winning scope for the active context. */
export async function getEffectiveConfiguration(
  projectId?: string,
  sessionId?: string,
): Promise<ApiResponse<EffectiveConfiguration>> {
  try {
    const query = new URLSearchParams();
    if (projectId) query.set('projectId', projectId);
    if (sessionId) query.set('sessionId', sessionId);
    const response = await apiFetch(`${API_BASE}/configuration/effective${query.size ? `?${query}` : ''}`);
    const data = await response.json().catch(() => ({})) as EffectiveConfiguration & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load effective configuration' };
  }
}

// ===================================================================
// Detached agent API - survives browser navigation and reconnects by sequence
// ===================================================================

export async function startAgentRun(input: {
  sessionId?: string;
  cwd: string;
  provider: string;
  input: string;
  blocks?: Message['blocks'];
  model?: string;
  thinking?: string;
  toolPreset?: string;
  autoCompaction?: boolean;
  settingOverrides?: Array<'model' | 'thinking' | 'toolPreset' | 'autoCompaction'>;
}): Promise<ApiResponse<AgentStartResponse>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as AgentStartResponse & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to start agent' };
  }
}

export async function getAgentState(sessionId: string, messageLimit = 80): Promise<ApiResponse<AgentStateResponse>> {
  try {
    const params = new URLSearchParams({ messageLimit: String(messageLimit) });
    const response = await apiFetch(`${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/state?${params}`);
    const data = await response.json().catch(() => ({})) as AgentStateResponse & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load agent state' };
  }
}

export async function listRunningAgentRuns(signal?: AbortSignal): Promise<ApiResponse<AgentRunSnapshot[]>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/running`, { signal });
    const data = await response.json().catch(() => []) as AgentRunSnapshot[] & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load running agents' };
  }
}

export async function getAgentRun(runId: string, signal?: AbortSignal): Promise<ApiResponse<AgentRunSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/runs/${encodeURIComponent(runId)}`, { signal });
    const data = await response.json().catch(() => ({})) as AgentRunSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load agent run' };
  }
}

export async function stopAgentRun(runId: string): Promise<ApiResponse<AgentRunSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
    const data = await response.json().catch(() => ({})) as AgentRunSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to stop agent' };
  }
}

export async function enqueueAgentMessage(
  runId: string,
  kind: 'steer' | 'follow-up',
  content: string,
  blocks?: Message['blocks'],
): Promise<ApiResponse<AgentRunSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/runs/${encodeURIComponent(runId)}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, content, blocks }),
    });
    const data = await response.json().catch(() => ({})) as AgentRunSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to queue message' };
  }
}

export type CommandSnapshot = ShellCommandSnapshot;

export type CommandEvent = Omit<ShellCommandEvent, 'data'> & {
  data: { stream?: string; chunk?: string; truncated?: boolean; exitCode?: number; message?: string };
};

export interface PaletteItem {
  name: string;
  description: string;
  usage?: string;
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
}

export async function getAgentPalette(cwd?: string, projectId?: string): Promise<ApiResponse<PaletteItem[]>> {
  try {
    const query = new URLSearchParams();
    if (cwd) query.set('cwd', cwd);
    if (projectId) query.set('projectId', projectId);
    const response = await apiFetch(`${API_BASE}/agent/palette${query.size ? `?${query}` : ''}`);
    const data = await response.json().catch(() => []) as PaletteItem[];
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load commands' };
  }
}

export async function reloadAgentResources(input: { cwd?: string; projectId?: string } = {}): Promise<ApiResponse<{
  generation: number;
  loadedExtensions: string[];
  errors: Array<{ path: string; message: string }>;
}>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/reload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as {
      generation: number; loadedExtensions: string[]; errors: Array<{ path: string; message: string }>; error?: string;
    };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Resource reload failed' };
  }
}

export async function getPaletteResource(
  source: 'prompt' | 'skill',
  name: string,
  cwd?: string,
  projectId?: string,
): Promise<ApiResponse<{ content: string; source: string }>> {
  try {
    const query = new URLSearchParams();
    if (cwd) query.set('cwd', cwd);
    if (projectId) query.set('projectId', projectId);
    const response = await apiFetch(`${API_BASE}/agent/palette/${source}/${encodeURIComponent(name)}${query.size ? `?${query}` : ''}`);
    const data = await response.json().catch(() => ({})) as { content: string; source: string; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Palette resource failed' };
  }
}

export interface AgentCapabilities {
  systemPrompt: string;
  toolPreset: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; extensionId: string }>;
}

export interface ExtensionWidget {
  name: string;
  placement: 'header' | 'status';
  content: string;
  extensionId: string;
}

export async function getExtensionWidgets(sessionId: string): Promise<ApiResponse<ExtensionWidget[]>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/extensions`);
    const data = await response.json().catch(() => []) as ExtensionWidget[] & { error?: string };
    if (!response.ok) throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load extension widgets' };
  }
}

export async function runExtensionCommand(
  sessionId: string,
  name: string,
  args: string,
): Promise<ApiResponse<{ output: string }>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args }),
    });
    const data = await response.json().catch(() => ({})) as { output: string; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Extension command failed' };
  }
}

export async function respondToExtensionInteraction(
  sessionId: string,
  requestId: string,
  responseValue: { cancelled: boolean; value?: unknown },
): Promise<ApiResponse<AgentRunSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(requestId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(responseValue),
    });
    const data = await response.json().catch(() => ({})) as AgentRunSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Extension interaction failed' };
  }
}

export async function getAgentCapabilities(sessionId: string): Promise<ApiResponse<AgentCapabilities>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/capabilities`);
    const data = await response.json().catch(() => ({})) as AgentCapabilities & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load agent capabilities' };
  }
}

export async function compactSession(input: {
  sessionId: string;
  provider: string;
  model?: string;
  instruction?: string;
}, signal?: AbortSignal): Promise<ApiResponse<{
  session: ApiSession;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
}>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/sessions/${encodeURIComponent(input.sessionId)}/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    const data = await response.json().catch(() => ({})) as {
      session: ApiSession;
      summary: string;
      tokensBefore: number;
      tokensAfter: number;
      tokensSaved: number;
      error?: string;
    };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Compaction failed' };
  }
}

export async function startCommand(input: {
  sessionId: string;
  command: string;
  cwd: string;
  excludedFromContext: boolean;
}): Promise<ApiResponse<CommandSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as CommandSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to run command' };
  }
}

export async function cancelCommand(commandId: string): Promise<ApiResponse<CommandSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/agent/commands/${encodeURIComponent(commandId)}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({})) as CommandSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to cancel command' };
  }
}

export async function* streamCommandEvents(
  commandId: string,
  after = 0,
  signal?: AbortSignal,
): AsyncGenerator<{ snapshot?: CommandSnapshot; event?: CommandEvent }, void> {
  const response = await apiFetch(
    `${API_BASE}/agent/commands/${encodeURIComponent(commandId)}/events?after=${after}`,
    { headers: { Accept: 'text/event-stream' }, signal },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  for await (const record of boundedSseRecords(response)) {
    const parsed: unknown = JSON.parse(record.data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Command event stream was invalid.');
    if (record.event === 'connection.ready' && 'snapshot' in parsed) {
      yield { snapshot: (parsed as { snapshot: CommandSnapshot }).snapshot };
    } else if ('sequence' in parsed) yield { event: parsed as CommandEvent };
  }
}

export async function clearAgentQueue(
  runId: string,
  kind?: 'steer' | 'follow-up',
): Promise<ApiResponse<AgentRunSnapshot>> {
  try {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    const response = await apiFetch(`${API_BASE}/agent/runs/${encodeURIComponent(runId)}/queue${query}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({})) as AgentRunSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to clear queue' };
  }
}

export type AgentStreamRecord =
  | { type: 'connection.ready'; snapshot: AgentStateSnapshot; reset: boolean }
  | { type: 'event'; event: AgentEvent };

export async function* streamAgentEvents(
  sessionId: string,
  after = 0,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamRecord, void> {
  const response = await apiFetch(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
    { headers: { Accept: 'text/event-stream' }, signal },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  for await (const record of boundedSseRecords(response)) {
    const data: unknown = JSON.parse(record.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Agent event stream was invalid.');
    if (record.event === 'connection.ready' && 'snapshot' in data) {
      const ready = data as { snapshot: AgentStateSnapshot; reset?: boolean };
      yield { type: 'connection.ready', snapshot: ready.snapshot, reset: Boolean(ready.reset) };
    } else if ('sequence' in data) {
      yield { type: 'event', event: data as AgentEvent };
    }
  }
}

// ===================================================================
// Legacy stateless chat API - retained for API compatibility
// ===================================================================

async function readChatStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Provider stream was idle for too long.')), CHAT_STREAM_IDLE_TIMEOUT_MS);
  });
  try { return await Promise.race([reader.read(), deadline]); }
  finally { if (timer) clearTimeout(timer); }
}

async function* boundedSseRecords(response: Response): AsyncGenerator<{ event: string; data: string }, void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No event stream');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let event = 'message';
  let dataLines: string[] = [];
  let eventBytes = 0;
  let transportedBytes = 0;
  let events = 0;
  let linesSeen = 0;
  let completed = false;
  const dispatch = (): { event: string; data: string } | undefined => {
    if (!dataLines.length) { event = 'message'; return undefined; }
    if (++events > MAX_CHAT_STREAM_EVENTS) throw new Error('Event stream exceeded its limit.');
    const record = { event, data: dataLines.join('\n') };
    event = 'message';
    dataLines = [];
    eventBytes = 0;
    return record;
  };
  try {
    while (true) {
      const { done, value } = await readChatStreamChunk(reader);
      if (value) {
        transportedBytes += value.byteLength;
        if (value.byteLength > MAX_CHAT_STREAM_CHUNK_BYTES || transportedBytes > MAX_CHAT_STREAM_BYTES) {
          throw new Error('Event stream exceeded its output limit.');
        }
        buffer += decoder.decode(value, { stream: !done });
      }
      if (done) { buffer += decoder.decode(); completed = true; }
      if (utf8ByteLength(buffer) > MAX_CHAT_STREAM_CHUNK_BYTES) {
        throw new Error('Event stream record exceeded its output limit.');
      }
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop() ?? '';
      for (const rawLine of lines) {
        if (++linesSeen > MAX_CHAT_STREAM_EVENTS * 4) throw new Error('Event stream exceeded its limit.');
        const line = rawLine.replace(/\r$/u, '');
        if (!line) {
          const record = dispatch();
          if (record) yield record;
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          const candidate = line.slice(6).trim();
          if (!/^[A-Za-z0-9._-]{1,128}$/u.test(candidate)) throw new Error('Event stream was invalid.');
          event = candidate;
          continue;
        }
        if (line.startsWith('data:')) {
          const valueText = line.slice(5).replace(/^ /u, '');
          eventBytes += utf8ByteLength(valueText);
          if (eventBytes > MAX_CHAT_STREAM_CHUNK_BYTES || dataLines.length >= 10_000) {
            throw new Error('Event stream record exceeded its output limit.');
          }
          dataLines.push(valueText);
        }
      }
      if (done) {
        const record = dispatch();
        if (record) yield record;
        break;
      }
    }
  } finally {
    if (!completed) void reader.cancel('event-stream-abandoned').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A pending hostile reader may retain the lock. */ }
  }
}

/** Send a chat message and stream the response back */
export async function* streamChat(
  providerType: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: Record<string, unknown>,
): AsyncGenerator<{ type: string; content?: string }, void> {
  if (options?.transport === 'websocket' || (!options?.transport && chatTransport === 'websocket')) {
    try { yield* streamChatWebSocket(providerType, messages, options ?? {}); }
    catch { yield { type: 'error', content: 'Connexion WebSocket impossible' }; }
    return;
  }
  try {
    const response = await apiFetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerType, messages, options }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No streaming body');

    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let currentEvent = 'message';
    let transportedBytes = 0;
    let events = 0;
    let linesSeen = 0;
    let terminalReceived = false;
    let completed = false;

    try {
      while (true) {
        const { done, value } = await readChatStreamChunk(reader);
        if (value) {
          transportedBytes += value.byteLength;
          if (value.byteLength > MAX_CHAT_STREAM_CHUNK_BYTES || transportedBytes > MAX_CHAT_STREAM_BYTES) {
            throw new Error('Provider stream exceeded its output limit.');
          }
          buffer += decoder.decode(value, { stream: !done });
        }
        if (done) {
          buffer += decoder.decode();
          completed = true;
        }
        if (utf8ByteLength(buffer) > MAX_CHAT_STREAM_CHUNK_BYTES) {
          throw new Error('Provider stream event exceeded its output limit.');
        }

        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop() || '';
        for (const rawLine of lines) {
          if (++linesSeen > MAX_CHAT_STREAM_EVENTS * 4) throw new Error('Provider stream exceeded its event limit.');
          const line = rawLine.replace(/\r$/u, '');
          if (!line) {
            currentEvent = 'message';
            continue;
          }
          if (line.startsWith('event:')) {
            const candidate = line.slice(6).trim();
            if (!/^[A-Za-z0-9._-]{1,128}$/u.test(candidate)) {
              throw new Error('Provider stream was invalid.');
            }
            currentEvent = candidate;
            continue;
          }
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trimStart();
          if (++events > MAX_CHAT_STREAM_EVENTS || utf8ByteLength(dataStr) > MAX_CHAT_STREAM_CHUNK_BYTES) {
            throw new Error('Provider stream exceeded its event limit.');
          }
          let data: { type?: unknown; content?: unknown; message?: unknown };
          try { data = JSON.parse(dataStr) as { type?: unknown; content?: unknown; message?: unknown }; }
          catch { throw new Error('Provider stream was invalid.'); }
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Provider stream was invalid.');
          }
          const type = typeof data.type === 'string' ? data.type : currentEvent;
          if (!/^[A-Za-z0-9._-]{1,128}$/u.test(type)) throw new Error('Provider stream was invalid.');
          const content = typeof data.content === 'string'
            ? data.content : typeof data.message === 'string' ? data.message : undefined;
          if (content !== undefined && utf8ByteLength(content) > MAX_CHAT_STREAM_CHUNK_BYTES) {
            throw new Error('Provider stream event exceeded its output limit.');
          }
          if (type === 'message_end' || type === 'error') terminalReceived = true;
          yield { type, content };
          if (terminalReceived) return;
        }
        if (done) {
          if (!terminalReceived) throw new Error('Provider stream ended without a terminal event.');
          break;
        }
      }
    } finally {
      if (!completed) void reader.cancel('chat-stream-abandoned').catch(() => undefined);
      try { reader.releaseLock(); } catch { /* A pending hostile reader may retain the lock. */ }
    }
  } catch (error) {
    yield { type: 'error', content: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function* streamChatWebSocket(
  provider: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: Record<string, unknown>,
): AsyncGenerator<{ type: string; content?: string }, void> {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/api/chat/ws`;
  // The server selects only the fixed application protocol; the bearer protocol
  // authenticates the upgrade but is deliberately never reflected.
  const socket = new WebSocket(url, authToken
    ? ['aih.v1', `aih.bearer.${encodeBase64Url(authToken)}`]
    : ['aih.v1']);
  const queue: Array<{ record: { type: string; content?: string }; bytes: number }> = [];
  let queueBytes = 0;
  let transportedBytes = 0;
  let events = 0;
  let linesSeen = 0;
  let buffer = '';
  let eventType = 'message';
  let wake: (() => void) | undefined;
  let complete = false;
  let failed = false;
  let terminalReceived = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (): void => { wake?.(); wake = undefined; };
  const closeSocket = (): void => {
    try { socket.close(); } catch { /* The socket may not have completed its handshake. */ }
  };
  const fail = (message = 'Provider stream was invalid.'): void => {
    if (failed) return;
    failed = true;
    complete = true;
    queue.length = 0;
    queueBytes = 0;
    queue.push({ record: { type: 'error', content: message }, bytes: utf8ByteLength(message) });
    queueBytes = utf8ByteLength(message);
    if (idleTimer) clearTimeout(idleTimer);
    closeSocket();
    notify();
  };
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail('Provider stream was idle for too long.'), CHAT_STREAM_IDLE_TIMEOUT_MS);
  };
  const enqueue = (record: { type: string; content?: string }): void => {
    const bytes = utf8ByteLength(record.type) + (record.content ? utf8ByteLength(record.content) : 0);
    if (queue.length >= MAX_CHAT_WEBSOCKET_QUEUE || bytes > MAX_CHAT_STREAM_CHUNK_BYTES
      || queueBytes + bytes > MAX_CHAT_WEBSOCKET_QUEUE_BYTES) {
      fail('Provider stream exceeded its queue limit.');
      return;
    }
    queue.push({ record, bytes });
    queueBytes += bytes;
  };
  const consume = (chunk: string, final = false): void => {
    if (failed) return;
    buffer += chunk;
    if (utf8ByteLength(buffer) > MAX_CHAT_STREAM_CHUNK_BYTES) {
      throw new Error('Provider stream event exceeded its output limit.');
    }
    const lines = buffer.split('\n');
    buffer = final ? '' : lines.pop() ?? '';
    for (const rawLine of lines) {
      if (++linesSeen > MAX_CHAT_STREAM_EVENTS * 4) throw new Error('limit');
      const line = rawLine.replace(/\r$/u, '');
      if (!line) { eventType = 'message'; continue; }
      if (line.startsWith('event:')) {
        const candidate = line.slice(6).trim();
        if (!/^[A-Za-z0-9._-]{1,128}$/u.test(candidate)) throw new Error('invalid');
        eventType = candidate;
        continue;
      }
      if (!line.startsWith('data:')) continue;
      if (terminalReceived || ++events > MAX_CHAT_STREAM_EVENTS) throw new Error('limit');
      const dataText = line.slice(5).trimStart();
      if (utf8ByteLength(dataText) > MAX_CHAT_STREAM_CHUNK_BYTES) throw new Error('limit');
      const data: unknown = JSON.parse(dataText);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
      const payload = data as { type?: unknown; content?: unknown; message?: unknown };
      const type = typeof payload.type === 'string' ? payload.type : eventType;
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(type)) throw new Error('invalid');
      const content = typeof payload.content === 'string'
        ? payload.content : typeof payload.message === 'string' ? payload.message : undefined;
      enqueue({ type, content });
      if (type === 'message_end' || type === 'error') terminalReceived = true;
      eventType = 'message';
      if (failed) return;
    }
  };

  socket.onopen = () => {
    try {
      const payload = JSON.stringify({ provider, messages, options: { ...options, transport: undefined } });
      if (utf8ByteLength(payload) > 14 * 1024 * 1024) throw new Error('limit');
      socket.send(payload);
      resetIdleTimer();
    } catch { fail('Invalid chat request.'); }
  };
  socket.onmessage = event => {
    try {
      if (typeof event.data !== 'string') throw new Error('invalid');
      const bytes = utf8ByteLength(event.data);
      transportedBytes += bytes;
      if (bytes > MAX_CHAT_STREAM_CHUNK_BYTES || transportedBytes > MAX_CHAT_STREAM_BYTES) throw new Error('limit');
      consume(event.data);
      if (terminalReceived) {
        complete = true;
        if (idleTimer) clearTimeout(idleTimer);
        closeSocket();
      } else {
        resetIdleTimer();
      }
      notify();
    } catch { fail(); }
  };
  socket.onerror = () => fail('Connexion WebSocket impossible');
  socket.onclose = () => {
    try { if (buffer) consume('', true); }
    catch { fail(); return; }
    if (!failed && !terminalReceived) { fail('Provider stream closed before completion.'); return; }
    complete = true;
    if (idleTimer) clearTimeout(idleTimer);
    notify();
  };
  resetIdleTimer();

  try {
    while (!complete || queue.length) {
      if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      while (queue.length) {
        const item = queue.shift()!;
        queueBytes = Math.max(0, queueBytes - item.bytes);
        yield item.record;
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    closeSocket();
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Non-streaming chat request */
export async function sendChat(
  providerType: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: Record<string, unknown>,
): Promise<ApiResponse<{ content: string; model?: string; usage?: Record<string, number> }>> {
  try {
    const response = await apiFetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerType, messages, options }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// ===================================================================
// Session API - CRUD operations via backend
// ===================================================================

/** Get lightweight session summaries; message history is loaded only for the active conversation. */
export async function listSessions(cwd?: string, signal?: AbortSignal): Promise<ApiResponse<ApiSession[]>> {
  try {
    const params = new URLSearchParams({ messageLimit: '0', includeCommands: 'false' });
    if (cwd) params.set('cwd', cwd);
    const response = await apiFetch(`${API_BASE}/sessions?${params}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to load sessions' 
    };
  }
}

/** Create a new session on the server */
export async function createSession(title?: string, cwd?: string): Promise<ApiResponse<ApiSession>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, cwd }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to create session' 
    };
  }
}

export interface SessionSearchResult {
  sessionId: string;
  messageId?: string;
  title?: string;
  cwd?: string;
  updatedAt: string;
  excerpt?: string;
  matchStart?: number;
  matchLength?: number;
  field: 'title' | 'content';
}

export async function searchSessions(
  query: string,
  cwd?: string,
  signal?: AbortSignal,
): Promise<ApiResponse<{ query: string; count: number; results: SessionSearchResult[] }>> {
  try {
    const params = new URLSearchParams({ q: query });
    if (cwd) params.set('cwd', cwd);
    const response = await apiFetch(`${API_BASE}/sessions/search?${params}`, { signal });
    const data = await response.json().catch(() => ({})) as {
      query: string;
      count: number;
      results: SessionSearchResult[];
      error?: string;
    };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
  }
}

/** Get the bounded tail of a session. */
export async function getSession(sessionId: string, messageLimit = 80, signal?: AbortSignal): Promise<ApiResponse<ApiSession>> {
  try {
    const params = new URLSearchParams({ messageLimit: String(messageLimit) });
    const response = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}?${params}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load session'
    };
  }
}

/** Load a bounded page before a cursor or around an exact search result. */
export async function getSessionMessages(
  sessionId: string,
  options: { before?: string; around?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<ApiResponse<SessionMessagePage>> {
  try {
    const params = new URLSearchParams({ limit: String(options.limit ?? 80) });
    if (options.before) params.set('before', options.before);
    if (options.around) params.set('around', options.around);
    const response = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/messages?${params}`, {
      signal: options.signal,
    });
    const data = await response.json().catch(() => ({})) as SessionMessagePage & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load message history' };
  }
}

export interface SessionInfo {
  id: string;
  file: string;
  cwd?: string;
  gitBranch?: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  counts: Record<'user' | 'assistant' | 'tool' | 'toolCalls' | 'toolResults' | 'system' | 'commands' | 'total', number>;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number; costUsd?: number };
  contextWindowTokens?: number;
  contextUsedTokens?: number;
  contextUtilization?: number;
  cacheHitRate?: number;
  model?: string;
  provider?: string;
}

export async function getSessionInfo(sessionId: string): Promise<ApiResponse<SessionInfo>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/info`);
    const data = await response.json().catch(() => ({})) as SessionInfo & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load session information' };
  }
}

/** Persist a message in an existing server session. */
export async function appendSessionMessage(
  sessionId: string,
  message: { role: 'user' | 'assistant'; content: string },
): Promise<ApiResponse<{ id: string }>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { success: true, data: await response.json() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to persist message' };
  }
}

/** Update mutable session settings. */
export async function updateSession(
  sessionId: string,
  changes: {
    title?: string;
    model?: string | null;
    thinking?: string | null;
    toolPreset?: string | null;
    autoCompaction?: boolean | null;
    activeLeafId?: string;
  },
): Promise<ApiResponse<ApiSession>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    const data = await response.json().catch(() => ({})) as ApiSession & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to update session' };
  }
}

export interface AutoNameSessionResult {
  id: string;
  title: string;
  updatedAt: string;
}

/** Generate and persist a concise session title with a server-side provider. */
export async function autoNameSession(
  sessionId: string,
  provider: string,
  model?: string,
  signal?: AbortSignal,
): Promise<ApiResponse<AutoNameSessionResult>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, ...(model ? { model } : {}) }),
      signal,
    });
    const data = await response.json().catch(() => ({})) as AutoNameSessionResult & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate session title' };
  }
}

export interface DeleteSessionResult {
  deletedCount?: number;
  requiresCascade?: boolean;
  descendants?: Array<{ id: string; title?: string }>;
}

/** Delete a session, surfacing branch descendants before an explicit cascade. */
export async function deleteSession(sessionId: string, cascade = false): Promise<ApiResponse<DeleteSessionResult>> {
  try {
    const query = cascade ? '?cascade=true' : '';
    const response = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}${query}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({})) as {
      error?: string; code?: string; deletedCount?: number; descendants?: Array<{ id: string; title?: string }>;
    };
    if (response.status === 409 && payload.code === 'CASCADE_CONFIRMATION_REQUIRED') {
      return {
        success: false,
        error: payload.error || 'Cascade confirmation required',
        data: { requiresCascade: true, descendants: payload.descendants ?? [] },
      };
    }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return { success: true, data: { deletedCount: payload.deletedCount } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete session',
    };
  }
}

/** Fork a session from a specific message index */
export async function forkSession(
  sessionId: string,
  options?: { messageIndex?: number; messageId?: string; before?: boolean; title?: string },
): Promise<ApiResponse<{ id: string; title?: string }>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fork session' 
    };
  }
}

/** Clone a session */
export async function cloneSession(
  sessionId: string,
  title?: string,
  messageTarget?: number | string,
): Promise<ApiResponse<{ id: string; title?: string }>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        ...(typeof messageTarget === 'string' ? { messageId: messageTarget } : { messageIndex: messageTarget }),
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to clone session' 
    };
  }
}

/** Get the session tree structure */
export async function getSessionTree(branchId?: string): Promise<ApiResponse<Array<{ id: string; title?: string; parentId?: string; depth: number }>>> {
  try {
    const params = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
    const response = await apiFetch(`${API_BASE}/sessions/tree${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to load session tree' 
    };
  }
}

// ===================================================================
// Workspace and trust API
// ===================================================================

export async function getDefaultWorkspace(): Promise<ApiResponse<WorkspaceDescriptor>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/default`);
    const data = await response.json().catch(() => ({})) as WorkspaceDescriptor & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load workspace' };
  }
}

export async function validateWorkspace(cwd: string): Promise<ApiResponse<WorkspaceDescriptor>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
    const data = await response.json().catch(() => ({})) as WorkspaceDescriptor & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Invalid workspace' };
  }
}

export async function browseWorkspace(path?: string, parent = false): Promise<ApiResponse<WorkspaceBrowseResponse>> {
  try {
    const query = new URLSearchParams();
    if (path) query.set('path', path);
    if (parent) query.set('parent', '1');
    const response = await apiFetch(`${API_BASE}/workspaces/browse?${query}`);
    const data = await response.json().catch(() => ({})) as WorkspaceBrowseResponse & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to browse workspace' };
  }
}

export async function createWorkspaceDirectory(parent: string, name: string): Promise<ApiResponse<{ path: string }>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, name }),
    });
    const data = await response.json().catch(() => ({})) as { path?: string; error?: string; code?: string };
    if (!response.ok || !data.path) return {
      success: false,
      error: data.error || `HTTP ${response.status}`,
      code: data.code,
    };
    return { success: true, data: { path: data.path } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create directory' };
  }
}

export async function getFileManagerAvailability(signal?: AbortSignal): Promise<ApiResponse<FileManagerAvailability>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/file-manager`, { signal, cache: 'no-store' });
    const data = await response.json().catch(() => ({})) as FileManagerAvailability & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'File manager availability failed' };
  }
}

export async function openWorkspaceInFileManager(cwd: string): Promise<ApiResponse<void>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/file-manager`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
    const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
    if (!response.ok) return { success: false, error: data.error || `HTTP ${response.status}`, code: data.code };
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to open the file manager' };
  }
}

export async function listWorktrees(cwd: string, signal?: AbortSignal): Promise<ApiResponse<GitWorktree[]>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/worktrees?cwd=${encodeURIComponent(cwd)}`, { signal });
    const data = await response.json().catch(() => []) as GitWorktree[] & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list worktrees' };
  }
}

export async function createWorktree(input: {
  cwd: string;
  path: string;
  branch: string;
  createBranch?: boolean;
  startPoint?: string;
}): Promise<ApiResponse<WorkspaceDescriptor>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/worktrees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as WorkspaceDescriptor & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create worktree' };
  }
}

export async function removeWorktree(cwd: string, path: string, force = false): Promise<ApiResponse<void>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/worktrees`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, path, force, confirm: true }),
    });
    const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
    if (!response.ok) return {
      success: false,
      error: data.error || `HTTP ${response.status}`,
      code: data.code,
    };
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to remove worktree' };
  }
}

export type WorkspaceTrustStatus = ProjectTrustStatus & { operationTrusted: boolean };

export async function setWorkspaceTrust(cwd: string, trusted: boolean): Promise<ApiResponse<WorkspaceTrustStatus>> {
  try {
    const response = await apiFetch(`${API_BASE}/workspaces/trust`, {
      method: trusted ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, confirm: true }),
    });
    const data = await response.json().catch(() => ({})) as WorkspaceTrustStatus & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to change trust' };
  }
}

// ===================================================================
// Workspace files and Git
// ===================================================================

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  hidden: boolean;
  gitStatus?: string;
}

export interface WorkspaceFileContent {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  language: string;
  binary: boolean;
  tooLarge?: boolean;
  lineCount?: number;
  content?: string;
}

export async function listFiles(cwd: string, path = '.', signal?: AbortSignal): Promise<ApiResponse<{ cwd: string; path: string; entries: WorkspaceFileEntry[] }>> {
  try {
    const response = await apiFetch(`${API_BASE}/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`, { signal });
    const data = await response.json().catch(() => ({})) as { cwd: string; path: string; entries: WorkspaceFileEntry[]; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list files' };
  }
}

export async function getFileContent(cwd: string, path: string, signal?: AbortSignal): Promise<ApiResponse<WorkspaceFileContent>> {
  try {
    const response = await apiFetch(`${API_BASE}/files/content?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`, { signal });
    const data = await response.json().catch(() => ({})) as WorkspaceFileContent & { error?: string; downloadable?: boolean };
    if (!response.ok) {
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
        ...(data.downloadable && data.path ? { data } : {}),
      };
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
  }
}

export interface WorkspaceFileIndex {
  files: string[];
  directories?: string[];
  truncated: boolean;
  total: number;
  directoryTotal?: number;
}

export async function searchFiles(cwd: string, query: string, signal?: AbortSignal): Promise<ApiResponse<WorkspaceFileIndex>> {
  try {
    const response = await apiFetch(`${API_BASE}/files/index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`, { signal });
    const data = await response.json().catch(() => ({})) as WorkspaceFileIndex & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to search files' };
  }
}

export interface GitStatusFile {
  path: string;
  originalPath?: string;
  status: string;
  staged: boolean;
  additions?: number;
  deletions?: number;
}
export async function getGitStatus(cwd: string, signal?: AbortSignal): Promise<ApiResponse<{
  repository: boolean;
  files: GitStatusFile[];
  total: number;
  additions: number;
  deletions: number;
}>> {
  try {
    const response = await apiFetch(`${API_BASE}/files/git/status?cwd=${encodeURIComponent(cwd)}`, { signal });
    const data = await response.json().catch(() => ({})) as {
      repository: boolean; files: GitStatusFile[]; total: number; additions: number; deletions: number; error?: string;
    };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load Git status' };
  }
}

export async function getFileDiff(cwd: string, path: string, signal?: AbortSignal): Promise<ApiResponse<{ path: string; diff: string; binary: boolean }>> {
  try {
    const response = await apiFetch(`${API_BASE}/files/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`, { signal });
    const data = await response.json().catch(() => ({})) as { path: string; diff: string; binary: boolean; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load diff' };
  }
}

export interface FileUploadProgress {
  phase: 'preparing' | 'uploading' | 'complete';
  loadedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
}

export async function uploadFiles(
  cwd: string,
  path: string,
  files: File[],
  options: {
    collision?: 'reject' | 'rename' | 'overwrite';
    onProgress?: (progress: FileUploadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ApiResponse<{ files: string[]; collision?: string }>> {
  try {
    if (!Array.isArray(files) || files.length < 1 || files.length > 20
      || files.some(file => !file || !Number.isSafeInteger(file.size) || file.size < 0
        || file.size > 6 * 1024 * 1024 || typeof file.name !== 'string' || file.name.length > 255)) {
      throw new Error('Invalid upload selection.');
    }
    const totalSourceBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalSourceBytes > 9 * 1024 * 1024) throw new Error('Upload selection is too large.');
    const encoded: Array<{ name: string; content: string }> = [];
    let preparedBytes = 0;
    options.onProgress?.({
      phase: 'preparing', loadedBytes: 0, totalBytes: totalSourceBytes,
      completedFiles: 0, totalFiles: files.length,
    });
    for (const [fileIndex, file] of files.entries()) {
      if (options.signal?.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > 6 * 1024 * 1024 || preparedBytes + bytes.byteLength > 9 * 1024 * 1024) {
        throw new Error('Upload selection is too large.');
      }
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      encoded.push({ name: file.name, content: btoa(binary) });
      preparedBytes += bytes.byteLength;
      options.onProgress?.({
        phase: 'preparing', loadedBytes: preparedBytes, totalBytes: totalSourceBytes,
        completedFiles: fileIndex + 1, totalFiles: files.length,
      });
    }

    const body = JSON.stringify({ cwd, path, files: encoded, collision: options.collision ?? 'reject' });
    const data = await new Promise<{ files: string[]; collision?: string; error?: string }>((resolve, reject) => {
      const request = new XMLHttpRequest();
      const abort = () => request.abort();
      request.open('POST', `${API_BASE}/files/upload`);
      request.timeout = 120_000;
      request.withCredentials = true;
      request.setRequestHeader('Content-Type', 'application/json');
      if (authToken) request.setRequestHeader('Authorization', `Bearer ${authToken}`);
      request.upload.addEventListener('progress', event => {
        options.onProgress?.({
          phase: 'uploading', loadedBytes: event.loaded,
          totalBytes: event.lengthComputable ? event.total : body.length,
          completedFiles: 0, totalFiles: files.length,
        });
      });
      request.addEventListener('load', () => {
        options.signal?.removeEventListener('abort', abort);
        let response: { files: string[]; collision?: string; error?: string };
        try {
          if (request.responseText.length > 1024 * 1024) throw new Error('limit');
          response = JSON.parse(request.responseText || '{}') as typeof response;
        } catch { response = { files: [], error: `HTTP ${request.status}` }; }
        if (request.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('aih-auth-required'));
        if (request.status < 200 || request.status >= 300) reject(new Error(response.error || `HTTP ${request.status}`));
        else resolve(response);
      });
      request.addEventListener('error', () => {
        options.signal?.removeEventListener('abort', abort);
        reject(new Error('Upload network failure.'));
      });
      request.addEventListener('abort', () => {
        options.signal?.removeEventListener('abort', abort);
        reject(new DOMException('Upload cancelled.', 'AbortError'));
      });
      request.addEventListener('timeout', () => {
        options.signal?.removeEventListener('abort', abort);
        reject(new Error('Upload timed out.'));
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      request.send(body);
    });
    options.onProgress?.({
      phase: 'complete', loadedBytes: totalSourceBytes, totalBytes: totalSourceBytes,
      completedFiles: files.length, totalFiles: files.length,
    });
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Upload failed' };
  }
}

export async function* streamFileChanges(
  cwd: string,
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<{ type: 'connection.ready' | 'file.changed' | 'file.unavailable'; revision: number }, void> {
  const response = await apiFetch(
    `${API_BASE}/files/watch?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
    { headers: { Accept: 'text/event-stream' }, signal },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  for await (const record of boundedSseRecords(response)) {
    const payload: unknown = JSON.parse(record.data);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('File event stream was invalid.');
    const revision = (payload as { revision?: unknown }).revision ?? 0;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error('File event stream was invalid.');
    if (record.event === 'connection.ready' || record.event === 'file.changed' || record.event === 'file.unavailable') {
      yield { type: record.event, revision: revision as number };
    }
  }
}

// ===================================================================
// Interactive workspace terminals
// ===================================================================

export type TerminalStatus = 'running' | 'exited' | 'killed' | 'failed';
export interface TerminalSnapshot {
  id: string;
  cwd: string;
  name: string;
  shell: string;
  pid: number;
  cols: number;
  rows: number;
  status: TerminalStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: number;
  lastOffset: number;
}

export type TerminalEvent =
  | { type: 'output'; terminalId: string; offset: number; endOffset: number; data: string; timestamp: string }
  | { type: 'exit'; terminalId: string; offset: number; endOffset: number; exitCode: number; signal?: number; timestamp: string };

export type TerminalStreamRecord =
  | { type: 'connection.ready'; snapshot: TerminalSnapshot; reset: boolean; oldestOffset: number; lastOffset: number }
  | { type: 'event'; event: TerminalEvent };

export async function listTerminals(cwd: string): Promise<ApiResponse<TerminalSnapshot[]>> {
  try {
    const response = await apiFetch(`${API_BASE}/terminals?cwd=${encodeURIComponent(cwd)}`);
    const data = await response.json().catch(() => []) as TerminalSnapshot[] & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list terminals' };
  }
}

export async function createTerminal(input: {
  cwd: string;
  name?: string;
  cols?: number;
  rows?: number;
}): Promise<ApiResponse<TerminalSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as TerminalSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create terminal' };
  }
}

export async function writeTerminal(terminalId: string, data: string): Promise<ApiResponse<TerminalSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/terminals/${encodeURIComponent(terminalId)}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
    });
    const payload = await response.json().catch(() => ({})) as TerminalSnapshot & { error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return { success: true, data: payload };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to write terminal input' };
  }
}

export async function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<ApiResponse<TerminalSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/terminals/${encodeURIComponent(terminalId)}/resize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols, rows }),
    });
    const payload = await response.json().catch(() => ({})) as TerminalSnapshot & { error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return { success: true, data: payload };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to resize terminal' };
  }
}

export async function closeTerminal(terminalId: string): Promise<ApiResponse<TerminalSnapshot>> {
  try {
    const response = await apiFetch(`${API_BASE}/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({})) as TerminalSnapshot & { error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return { success: true, data: payload };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to close terminal' };
  }
}

export async function* streamTerminalEvents(
  terminalId: string,
  after = 0,
  signal?: AbortSignal,
): AsyncGenerator<TerminalStreamRecord, void> {
  const response = await apiFetch(
    `${API_BASE}/terminals/${encodeURIComponent(terminalId)}/events?after=${after}`,
    { headers: { Accept: 'text/event-stream' }, signal },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  for await (const record of boundedSseRecords(response)) {
    const data: unknown = JSON.parse(record.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Terminal event stream was invalid.');
    if (record.event === 'connection.ready' && 'snapshot' in data) {
      const ready = data as { snapshot: TerminalSnapshot; reset: boolean; oldestOffset: number; lastOffset: number };
      yield { type: 'connection.ready', ...ready };
    } else if ('terminalId' in data) {
      yield { type: 'event', event: data as TerminalEvent };
    }
  }
}

// ===================================================================
// Provider API - Configuration and management
// ===================================================================

/** Load the provider-grouped model catalogue and its effective enabled state. */
export async function getModelCatalog(projectId?: string, refresh = false): Promise<ApiResponse<ModelCatalog>> {
  try {
    const query = new URLSearchParams();
    if (projectId) query.set('projectId', projectId);
    if (refresh) query.set('refresh', 'true');
    const response = await apiFetch(`${API_BASE}/models${query.size ? `?${query}` : ''}`);
    const data = await response.json().catch(() => ({})) as ModelCatalog & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load model catalogue' };
  }
}

/** Replace the project (or global) enabled-model set. */
export async function updateEnabledModels(
  enabledModels: string[],
  projectId?: string,
): Promise<ApiResponse<ModelCatalog>> {
  try {
    const response = await apiFetch(`${API_BASE}/models/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledModels, ...(projectId ? { projectId } : {}) }),
    });
    const data = await response.json().catch(() => ({})) as ModelCatalog & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to update enabled models' };
  }
}

/** Discover skills for a workspace without transferring their instruction bodies. */
export async function getSkillCatalog(
  cwd?: string,
  projectId?: string,
  refresh = false,
): Promise<ApiResponse<SkillCatalog>> {
  try {
    const query = new URLSearchParams();
    if (cwd) query.set('cwd', cwd);
    if (projectId) query.set('projectId', projectId);
    if (refresh) query.set('refresh', 'true');
    const response = await apiFetch(`${API_BASE}/skills${query.size ? `?${query}` : ''}`);
    const data = await response.json().catch(() => ({})) as SkillCatalog & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
  }
}

/** Replace the workspace set of skills available for autonomous model invocation. */
export async function updateEnabledSkills(
  enabledSkills: string[],
  cwd?: string,
  projectId?: string,
): Promise<ApiResponse<SkillCatalog>> {
  try {
    const response = await apiFetch(`${API_BASE}/skills/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledSkills, ...(cwd ? { cwd } : {}), ...(projectId ? { projectId } : {}) }),
    });
    const data = await response.json().catch(() => ({})) as SkillCatalog & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to update enabled skills' };
  }
}

/** Read a redacted file-only inventory. The server never connects or resolves MCP values for this request. */
export async function getMcpConfig(cwd?: string): Promise<ApiResponse<McpConfigInventory>> {
  try {
    const query = new URLSearchParams();
    if (cwd) query.set('cwd', cwd);
    const response = await apiFetch(`${API_BASE}/mcp${query.size ? `?${query}` : ''}`);
    const data = await response.json().catch(() => ({})) as McpConfigInventory & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load MCP configuration' };
  }
}

export type PluginMutationAction = 'install' | 'enable' | 'disable' | 'remove' | 'update';

/** Read metadata only. Install and remote checks always require an explicit POST action. */
export async function getPluginCatalog(
  cwd?: string,
  projectId?: string,
  refresh = false,
): Promise<ApiResponse<PluginCatalog>> {
  try {
    const query = new URLSearchParams();
    if (cwd) query.set('cwd', cwd);
    if (projectId) query.set('projectId', projectId);
    if (refresh) query.set('refresh', 'true');
    const response = await apiFetch(`${API_BASE}/plugins${query.size ? `?${query}` : ''}`);
    const data = await response.json().catch(() => ({})) as PluginCatalog & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load plugins' };
  }
}

export async function mutatePlugin(input: {
  action: PluginMutationAction;
  cwd?: string;
  projectId?: string;
  key?: string;
  source?: string;
  scope?: PluginScope;
}): Promise<ApiResponse<PluginCatalog>> {
  try {
    const response = await apiFetch(`${API_BASE}/plugins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as PluginCatalog & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Plugin action failed' };
  }
}

export async function setPluginsEnabled(input: {
  cwd?: string;
  projectId?: string;
  changes: PluginEnableChange[];
}): Promise<ApiResponse<PluginEnableBatchResult>> {
  try {
    const response = await apiFetch(`${API_BASE}/plugins/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as PluginEnableBatchResult & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Plugin group action failed' };
  }
}

export async function checkPluginUpdates(input: {
  cwd?: string;
  projectId?: string;
  key?: string;
  scope?: PluginScope;
}): Promise<ApiResponse<PluginUpdateResult[]>> {
  try {
    const response = await apiFetch(`${API_BASE}/plugins/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as { updates?: PluginUpdateResult[]; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data: data.updates ?? [] };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Plugin update check failed' };
  }
}

export async function reloadPluginResources(input: {
  cwd?: string;
  projectId?: string;
  sessionId?: string;
}): Promise<ApiResponse<{ catalog: PluginCatalog; reload: PluginReloadResult }>> {
  try {
    const response = await apiFetch(`${API_BASE}/plugins/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({})) as {
      catalog: PluginCatalog;
      reload: PluginReloadResult;
      error?: string;
    };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Plugin reload failed' };
  }
}

async function jsonApi<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const response = await apiFetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
  }
}

export function getProviderAuthStatuses(): Promise<ApiResponse<ProviderAuthStatus[]>> {
  return jsonApi('/provider-registry/auth');
}

export interface ProviderOAuthFlow {
  id: string;
  provider: string;
  state: 'pending' | 'connected' | 'failed' | 'cancelled' | 'expired';
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt: string;
  error?: string;
}

export function startProviderOAuth(type: string): Promise<ApiResponse<ProviderOAuthFlow>> {
  return jsonApi(`/provider-registry/auth/${encodeURIComponent(type)}/oauth`, { method: 'POST' });
}

export function getProviderOAuth(flowId: string): Promise<ApiResponse<ProviderOAuthFlow>> {
  return jsonApi(`/provider-registry/auth/oauth/${encodeURIComponent(flowId)}`);
}

export function cancelProviderOAuth(flowId: string): Promise<ApiResponse<{ state: 'cancelled' }>> {
  return jsonApi(`/provider-registry/auth/oauth/${encodeURIComponent(flowId)}`, { method: 'DELETE' });
}

export function testProviderConnection(type: string): Promise<ApiResponse<{ ok: true; models: string[]; checkedAt: string }>> {
  return jsonApi(`/provider-registry/auth/${encodeURIComponent(type)}/test`, { method: 'POST' });
}

export function disconnectProvider(type: string): Promise<ApiResponse<unknown>> {
  return jsonApi(`/provider-registry/auth/${encodeURIComponent(type)}`, { method: 'DELETE' });
}

export interface ProviderRenameCapability {
  supported: boolean;
  mode: 'disabled' | 'exclusive-host-single-writer';
  reason: 'exclusive-host-required' | 'restricted-single-writer' | 'unavailable';
}

/** Array data remains compatible; capability is additive to the client envelope.
 * Missing/invalid metadata fails closed, including older/shared hosts. */
export async function getCustomProviders(): Promise<ApiResponse<CustomProviderDefinition[]> & {
  renameCapability: ProviderRenameCapability;
}> {
  const disabled: ProviderRenameCapability = { supported: false, mode: 'disabled', reason: 'unavailable' };
  try {
    const response = await apiFetch(`${API_BASE}/provider-registry/custom`);
    if (!response.ok) return { success: false, renameCapability: disabled };
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return { success: false, renameCapability: disabled };
    let renameCapability = disabled;
    try {
      const metadata = JSON.parse(response.headers.get('X-AiHarness-Provider-Rename') || '{}') as ProviderRenameCapability;
      if (metadata.supported === true && metadata.mode === 'exclusive-host-single-writer'
        && metadata.reason === 'restricted-single-writer') renameCapability = metadata;
      else if (metadata.supported === false && metadata.mode === 'disabled'
        && metadata.reason === 'exclusive-host-required') renameCapability = metadata;
    } catch { /* Older hosts have no capability metadata. */ }
    return { success: true, data: data as CustomProviderDefinition[], renameCapability };
  } catch { return { success: false, renameCapability: disabled }; }
}

export function saveCustomProvider(
  input: Record<string, unknown>,
  id?: string,
): Promise<ApiResponse<CustomProviderDefinition>> {
  return jsonApi(`/provider-registry/custom${id ? `/${encodeURIComponent(id)}` : ''}`, {
    method: id ? 'PUT' : 'POST', body: JSON.stringify(input),
  });
}

export function deleteCustomProvider(id: string): Promise<ApiResponse<{ success: true }>> {
  return jsonApi(`/provider-registry/custom/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function importCustomProviderModels(id: string): Promise<ApiResponse<CustomModelDefinition[]>> {
  return jsonApi(`/provider-registry/custom/${encodeURIComponent(id)}/import-models`, { method: 'POST' });
}

export function getCustomModels(): Promise<ApiResponse<CustomModelDefinition[]>> {
  return jsonApi('/provider-registry/models');
}

export function saveCustomModel(
  input: Record<string, unknown>,
  key?: string,
): Promise<ApiResponse<CustomModelDefinition>> {
  return jsonApi(`/provider-registry/models${key ? `/${encodeURIComponent(key)}` : ''}`, {
    method: key ? 'PUT' : 'POST', body: JSON.stringify(input),
  });
}

export function deleteCustomModel(key: string): Promise<ApiResponse<{ success: true }>> {
  return jsonApi(`/provider-registry/models/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export function testCustomModel(key: string): Promise<ApiResponse<{ ok: true; model: string; checkedAt: string }>> {
  return jsonApi(`/provider-registry/models/${encodeURIComponent(key)}/test`, { method: 'POST' });
}

export function getSkillRegistry(
  query?: string, cwd?: string, projectId?: string, refresh = false,
): Promise<ApiResponse<SkillRegistry>> {
  const parameters = new URLSearchParams();
  if (query) parameters.set('query', query);
  if (cwd) parameters.set('cwd', cwd);
  if (projectId) parameters.set('projectId', projectId);
  if (refresh) parameters.set('refresh', 'true');
  return jsonApi(`/skills/registry${parameters.size ? `?${parameters}` : ''}`);
}

export function installRegistrySkill(input: {
  id: string; scope: 'global' | 'project'; cwd?: string; projectId?: string;
}): Promise<ApiResponse<{ entry: SkillRegistryEntry; catalog: SkillCatalog }>> {
  return jsonApi('/skills/registry/install', { method: 'POST', body: JSON.stringify(input) });
}

export function updateRegistrySkills(input: {
  id?: string; all?: boolean; scope: 'global' | 'project'; cwd?: string; projectId?: string;
}): Promise<ApiResponse<unknown>> {
  return jsonApi('/skills/registry/update', { method: 'POST', body: JSON.stringify(input) });
}

export function getToolSettings(cwd?: string, projectId?: string): Promise<ApiResponse<ToolSettings>> {
  const parameters = new URLSearchParams();
  if (cwd) parameters.set('cwd', cwd);
  if (projectId) parameters.set('projectId', projectId);
  return jsonApi(`/tools${parameters.size ? `?${parameters}` : ''}`);
}

export function updateToolSettings(input: {
  enabledTools: string[]; toolPreset: string; powershellEnabled: boolean; cwd?: string; projectId?: string;
  codemodeEnabled?: boolean; codemodeMode?: 'on' | 'only'; codemodeInlineBudget?: number;
}): Promise<ApiResponse<ToolSettings>> {
  return jsonApi('/tools', { method: 'PATCH', body: JSON.stringify(input) });
}

export function saveNewSessionDefault(
  input: ({ kind: 'model'; provider: string; model: string } | { kind: 'thinking'; thinking: NonNullable<Session['thinking']> }) & { projectId?: string },
): Promise<ApiResponse<{ values: Record<string, unknown>; overridden: string[]; effective: EffectiveConfiguration }>> {
  return jsonApi('/configuration/defaults', { method: 'PATCH', body: JSON.stringify(input) });
}

export function getConfigurationScope(scope: 'global' | 'project', scopeId?: string): Promise<ApiResponse<{ values: Record<string, unknown> }>> {
  const parameters = new URLSearchParams({ scope });
  if (scopeId) parameters.set('scopeId', scopeId);
  return jsonApi(`/configuration/scope?${parameters}`);
}

export function updateConfigurationScope(
  scope: 'global' | 'project', values: Record<string, unknown>, scopeId?: string,
): Promise<ApiResponse<{ values: Record<string, unknown> }>> {
  return jsonApi('/configuration/scope', {
    method: 'PATCH', body: JSON.stringify({ scope, scopeId, values }),
  });
}

/** Get configured providers from the backend */
export async function getProviders(): Promise<ApiResponse<ApiProvider[]>> {
  try {
    const response = await apiFetch(`${API_BASE}/providers`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to load providers' 
    };
  }
}

/** Set API key for a provider */
export async function setProviderApiKey(
  type: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ApiResponse<{ success: boolean; message: string }>> {
  try {
    const response = await apiFetch(`${API_BASE}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, apiKey, baseUrl }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to configure provider' 
    };
  }
}

export function getPushPublicKey(): Promise<ApiResponse<{ publicKey: string; persistent: boolean }>> {
  return jsonApi('/push/public-key');
}

export function registerPushSubscription(
  subscription: PushSubscriptionJSON,
  categories: Array<'completion' | 'attention'>,
): Promise<ApiResponse<{ subscribed: true; categories: string[] }>> {
  return jsonApi('/push/subscribe', {
    method: 'POST', body: JSON.stringify({ subscription, categories }),
  });
}

export function unregisterPushSubscription(endpoint: string): Promise<ApiResponse<{ subscribed: false }>> {
  return jsonApi('/push/subscribe', {
    method: 'DELETE', body: JSON.stringify({ endpoint }),
  });
}

// ===================================================================
// Health check utility
// ===================================================================

async function subagentRequest<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  try {
    const response = await apiFetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Subagent request failed' };
  }
}

export async function getSubagentConfiguration(
  cwd?: string,
  projectId?: string,
  scope?: 'global' | 'project',
): Promise<ApiResponse<SubagentConfiguration>> {
  const query = new URLSearchParams();
  if (cwd) query.set('cwd', cwd);
  if (projectId) query.set('projectId', projectId);
  if (scope) query.set('scope', scope);
  return subagentRequest<SubagentConfiguration>(`/subagents/settings${query.size ? `?${query}` : ''}`);
}

export async function updateSubagentSettings(
  changes: { engineEnabled?: boolean; maxConcurrency?: number },
  cwd?: string,
  projectId?: string,
  scope?: 'global' | 'project',
): Promise<ApiResponse<SubagentConfiguration>> {
  return subagentRequest<SubagentConfiguration>('/subagents/settings', {
    method: 'PATCH',
    body: JSON.stringify({ ...changes, cwd, projectId, scope: scope ?? (projectId ? 'project' : 'global') }),
  });
}

export async function createSubagentProfile(
  profile: Omit<SubagentProfile, 'id' | 'builtIn'> & { id?: string },
  cwd?: string,
  projectId?: string,
  scope?: 'global' | 'project',
): Promise<ApiResponse<SubagentConfiguration>> {
  return subagentRequest<SubagentConfiguration>('/subagents/profiles', {
    method: 'POST',
    body: JSON.stringify({ profile, cwd, projectId, scope: scope ?? (projectId ? 'project' : 'global') }),
  });
}

export async function updateSubagentProfile(
  profileId: string,
  profile: Partial<SubagentProfile>,
  cwd?: string,
  projectId?: string,
  scope?: 'global' | 'project',
): Promise<ApiResponse<SubagentConfiguration>> {
  return subagentRequest<SubagentConfiguration>(`/subagents/profiles/${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ profile, cwd, projectId, scope: scope ?? (projectId ? 'project' : 'global') }),
  });
}

export async function duplicateSubagentProfile(
  profileId: string,
  cwd?: string,
  projectId?: string,
  scope?: 'global' | 'project',
): Promise<ApiResponse<SubagentConfiguration>> {
  return subagentRequest<SubagentConfiguration>(`/subagents/profiles/${encodeURIComponent(profileId)}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ cwd, projectId, scope: scope ?? (projectId ? 'project' : 'global') }),
  });
}

export async function deleteSubagentProfile(
  profileId: string,
  cwd?: string,
  projectId?: string,
  scope?: 'global' | 'project',
): Promise<ApiResponse<SubagentConfiguration>> {
  return subagentRequest<SubagentConfiguration>(`/subagents/profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ cwd, projectId, scope: scope ?? (projectId ? 'project' : 'global') }),
  });
}

export async function listSubagentRuns(parentSessionId?: string): Promise<ApiResponse<SubagentRunSnapshot[]>> {
  const query = parentSessionId ? `?parentSessionId=${encodeURIComponent(parentSessionId)}` : '';
  return subagentRequest<SubagentRunSnapshot[]>(`/subagents/runs${query}`);
}

export async function startSubagentRun(input: {
  parentSessionId: string;
  profileId: string;
  task: string;
  provider: string;
  background?: boolean;
}): Promise<ApiResponse<SubagentRunSnapshot>> {
  return subagentRequest<SubagentRunSnapshot>('/subagents/runs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function stopSubagentRun(runId: string): Promise<ApiResponse<SubagentRunSnapshot>> {
  return subagentRequest<SubagentRunSnapshot>(`/subagents/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
}

export async function acknowledgeSubagentRun(runId: string): Promise<ApiResponse<SubagentRunSnapshot>> {
  return subagentRequest<SubagentRunSnapshot>(`/subagents/runs/${encodeURIComponent(runId)}/acknowledge`, { method: 'POST' });
}

/** Check if the backend server is running */
export async function healthCheck(): Promise<boolean> {
  try {
    const response = await apiFetch('/health');
    return response.ok;
  } catch {
    return false;
  }
}
