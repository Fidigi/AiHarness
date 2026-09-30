// ============================================================
// API Service Layer - Connects React frontend to Express backend
// Handles: chat streaming, session management, provider config
// ============================================================

const API_BASE = '/api';
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
  authToken = token.trim();
  if (typeof sessionStorage !== 'undefined') {
    if (authToken) sessionStorage.setItem('ai-harness-auth-token', authToken);
    else sessionStorage.removeItem('ai-harness-auth-token');
  }
}

function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(input, { ...init, headers });
}

/** Standardized response wrapper */
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Session type synced with core types */
export interface ApiSession {
  id: string;
  title?: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
  parentId?: string;
  branchId?: string;
}

/** Provider configuration from backend */
export interface ApiProvider {
  type: string;
  configured: boolean;
}

// ===================================================================
// Chat API - Streaming responses via SSE
// ===================================================================

/** Send a chat message and stream the response back */
export async function* streamChat(
  providerType: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: Record<string, unknown>,
): AsyncGenerator<{ type: string; content?: string }, void> {
  if (options?.transport === 'websocket' || (!options?.transport && chatTransport === 'websocket')) {
    yield* streamChatWebSocket(providerType, messages, options ?? {});
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

    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        // Parse SSE format: "event: <type>\ndata: <json>"
        if (!line.trim()) continue;

        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            const data = JSON.parse(dataStr) as { type?: unknown; content?: unknown };
            const type = typeof data.type === 'string' ? data.type : currentEvent;
            const content = typeof data.content === 'string'
              ? data.content
              : typeof (data as { message?: unknown }).message === 'string'
                ? (data as { message: string }).message
                : undefined;
            yield { type, content };
          } catch {
            // Skip malformed SSE events
          }
        } else if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim() || 'message';
        }
      }
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
  const token = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
  const socket = new WebSocket(`${protocol}//${location.host}/api/chat/ws${token}`);
  const queue: Array<{ type: string; content?: string }> = [];
  let wake: (() => void) | undefined;
  let complete = false;
  socket.onopen = () => socket.send(JSON.stringify({ provider, messages, options: { ...options, transport: undefined } }));
  socket.onmessage = event => {
    const lines = String(event.data).split('\n');
    let eventType = 'message';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6)) as { content?: unknown; message?: unknown };
        queue.push({
          type: eventType,
          content: typeof data.content === 'string' ? data.content : typeof data.message === 'string' ? data.message : undefined,
        });
      } catch { /* Ignore malformed event frames. */ }
    }
    wake?.();
  };
  socket.onerror = () => {
    queue.push({ type: 'error', content: 'Connexion WebSocket impossible' });
    complete = true;
    wake?.();
  };
  socket.onclose = () => { complete = true; wake?.(); };
  while (!complete || queue.length) {
    if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
    wake = undefined;
    while (queue.length) yield queue.shift()!;
  }
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

/** Get all sessions from the server */
export async function listSessions(): Promise<ApiResponse<ApiSession[]>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions`);
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
export async function createSession(title?: string): Promise<ApiResponse<{ id: string; title?: string }>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
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

/** Get a single session with messages */
export async function getSession(sessionId: string): Promise<ApiResponse<ApiSession>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${sessionId}`);
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

/** Delete a session */
export async function deleteSession(sessionId: string): Promise<ApiResponse<void>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${sessionId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to delete session' 
    };
  }
}

/** Fork a session from a specific message index */
export async function forkSession(
  sessionId: string,
  options?: { messageIndex?: number; title?: string },
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
): Promise<ApiResponse<{ id: string; title?: string }>> {
  try {
    const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
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
// Provider API - Configuration and management
// ===================================================================

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

// ===================================================================
// Health check utility
// ===================================================================

/** Check if the backend server is running */
export async function healthCheck(): Promise<boolean> {
  try {
    const response = await apiFetch(`${API_BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
