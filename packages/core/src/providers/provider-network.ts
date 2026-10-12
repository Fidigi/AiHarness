import {
  ProxyAgent,
  WebSocket as UndiciWebSocket,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici';
import type { AgentProviderNetworkSettings } from '../config/agent-settings.js';

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const providerNetworkScopeBrand: unique symbol = Symbol('ProviderNetworkScopeBrand');
/** Process-local ProviderConfig key; symbol properties never cross JSON boundaries. */
export const PROVIDER_NETWORK_SCOPE: unique symbol = Symbol('ProviderNetworkScope');

/** Opaque lifecycle owner used to isolate provider transports between application generations. */
export interface ProviderNetworkScope { readonly [providerNetworkScopeBrand]: true }

const defaultNetworkScope = Object.freeze({}) as ProviderNetworkScope;
interface ProviderNetworkScopeState { id: number; closed: boolean; controller: AbortController }
const scopeStates = new WeakMap<object, ProviderNetworkScopeState>();
const knownScopes = new Set<ProviderNetworkScope>();
let nextScopeId = 1;

export function createProviderNetworkScope(): ProviderNetworkScope {
  return Object.freeze({}) as ProviderNetworkScope;
}

function scopeState(scope: ProviderNetworkScope): ProviderNetworkScopeState {
  let state = scopeStates.get(scope as object);
  if (!state) {
    state = { id: nextScopeId++, closed: false, controller: new AbortController() };
    scopeStates.set(scope as object, state);
    knownScopes.add(scope);
  }
  return state;
}

function scopeId(scope: ProviderNetworkScope): number {
  return scopeState(scope).id;
}

function activeScope(scope: ProviderNetworkScope | undefined): ProviderNetworkScope {
  const resolved = scope ?? defaultNetworkScope;
  if (scopeState(resolved).closed) {
    throw new ProviderNetworkError('request-failed', 'The provider network runtime is closed.');
  }
  return resolved;
}

interface ScopedProxyDispatcher { scope: ProviderNetworkScope; dispatcher: ProxyAgent }
interface ScopedWebSocketEntry extends ProviderWebSocketCacheEntry { scope: ProviderNetworkScope }

const proxyDispatchers = new Map<string, ScopedProxyDispatcher>();
const websocketPool = new Map<string, ScopedWebSocketEntry>();
const MAX_PROXY_DISPATCHERS = 32;
const MAX_CACHED_WEBSOCKETS = 64;
const WEBSOCKET_IDLE_TTL_MS = 5 * 60_000;
const WEBSOCKET_MAX_AGE_MS = 55 * 60_000;

export interface ProviderFetchOptions {
  fetcher?: typeof fetch;
  scope?: ProviderNetworkScope;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export type ProviderWebSocketEvent = 'open' | 'message' | 'error' | 'close';
export type ProviderWebSocketListener = (event: unknown) => void;

export interface ProviderWebSocket {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: ProviderWebSocketEvent, listener: ProviderWebSocketListener): void;
  removeEventListener(type: ProviderWebSocketEvent, listener: ProviderWebSocketListener): void;
}

const activeProviderSockets = new Map<ProviderWebSocket, ProviderNetworkScope>();

export type ProviderWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string>; dispatcher?: Dispatcher },
) => ProviderWebSocket;

export interface AcquireProviderWebSocketOptions {
  /** Omit to create an ephemeral, one-request socket. */
  cacheKey?: string;
  scope?: ProviderNetworkScope;
  signal?: AbortSignal;
  factory?: ProviderWebSocketFactory;
}

export interface ProviderWebSocketCacheEntry {
  socket: ProviderWebSocket;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Provider-specific continuation state; never serialized. */
  continuation?: unknown;
}

export interface ProviderWebSocketLease {
  socket: ProviderWebSocket;
  entry?: ProviderWebSocketCacheEntry;
  reused: boolean;
  release(options?: { keep?: boolean }): void;
}

function retireProxyDispatcher(dispatcher: ProxyAgent): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  timer = setTimeout(() => {
    void dispatcher.destroy(new Error('Provider network runtime closed.')).catch(() => undefined);
  }, 5_000);
  timer.unref?.();
  void dispatcher.close().catch(() => {
    void dispatcher.destroy(new Error('Provider network runtime closed.')).catch(() => undefined);
  }).finally(() => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  });
}

export class ProviderNetworkError extends Error {
  constructor(
    public readonly code:
      | 'request-failed'
      | 'request-timeout'
      | 'response-idle-timeout'
      | 'websocket-failed'
      | 'websocket-connect-timeout'
      | 'websocket-idle-timeout',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderNetworkError';
  }
}

function proxyDispatcher(proxyUrl: string, scope: ProviderNetworkScope): ProxyAgent {
  const key = `${scopeId(scope)}:${proxyUrl}`;
  let entry = proxyDispatchers.get(key);
  if (!entry) {
    entry = { scope, dispatcher: new ProxyAgent({ uri: proxyUrl }) };
    if (proxyDispatchers.size >= MAX_PROXY_DISPATCHERS) {
      const oldest = proxyDispatchers.entries().next().value as [string, ScopedProxyDispatcher] | undefined;
      if (oldest) {
        proxyDispatchers.delete(oldest[0]);
        retireProxyDispatcher(oldest[1].dispatcher);
      }
    }
    proxyDispatchers.set(key, entry);
  }
  return entry.dispatcher;
}

function closeWebSocket(socket: ProviderWebSocket, reason = 'done'): void {
  activeProviderSockets.delete(socket);
  try { socket.close(1000, reason); } catch { /* Best-effort transport cleanup. */ }
}

function webSocketReusable(socket: ProviderWebSocket): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

function removeWebSocketEntry(key: string, entry: ProviderWebSocketCacheEntry, reason: string): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  closeWebSocket(entry.socket, reason);
  if (websocketPool.get(key) === entry) websocketPool.delete(key);
}

function scheduleWebSocketExpiry(key: string, entry: ProviderWebSocketCacheEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (!entry.busy) removeWebSocketEntry(key, entry, 'idle_timeout');
  }, WEBSOCKET_IDLE_TTL_MS);
  entry.idleTimer.unref?.();
}

function pruneWebSocketPool(): void {
  const now = Date.now();
  for (const [key, entry] of websocketPool) {
    if (!entry.busy && (now - entry.createdAt >= WEBSOCKET_MAX_AGE_MS || !webSocketReusable(entry.socket))) {
      removeWebSocketEntry(key, entry, 'connection_expired');
    }
  }
  if (websocketPool.size < MAX_CACHED_WEBSOCKETS) return;
  const idle = [...websocketPool.entries()]
    .filter(([, entry]) => !entry.busy)
    .sort(([, left], [, right]) => left.createdAt - right.createdAt);
  while (websocketPool.size >= MAX_CACHED_WEBSOCKETS && idle.length) {
    const [key, entry] = idle.shift()!;
    removeWebSocketEntry(key, entry, 'cache_evicted');
  }
}

async function connectProviderWebSocket(
  url: string,
  headers: Record<string, string>,
  policy: AgentProviderNetworkSettings,
  options: AcquireProviderWebSocketOptions,
): Promise<ProviderWebSocket> {
  let parsed: URL;
  if (typeof url !== 'string' || Buffer.byteLength(url) > 8_192 || /[\u0000-\u001f\u007f]/u.test(url)) {
    throw new ProviderNetworkError('websocket-failed', 'The provider WebSocket connection failed.');
  }
  try { parsed = new URL(url); }
  catch { throw new ProviderNetworkError('websocket-failed', 'The provider WebSocket connection failed.'); }
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new ProviderNetworkError('websocket-failed', 'The provider WebSocket connection failed.');
  }
  const scope = activeScope(options.scope);
  const scopeSignal = scopeState(scope).controller.signal;
  const signal = options.signal ? AbortSignal.any([options.signal, scopeSignal]) : scopeSignal;
  if (signal.aborted) throw abortError(signal);
  let dispatcher: ProxyAgent | undefined;
  try { dispatcher = policy.httpProxy ? proxyDispatcher(policy.httpProxy, scope) : undefined; }
  catch { throw new ProviderNetworkError('websocket-failed', 'The provider WebSocket connection failed.'); }
  const factory: ProviderWebSocketFactory = options.factory ?? ((target, init) => (
    new UndiciWebSocket(target, init as ConstructorParameters<typeof UndiciWebSocket>[1]) as unknown as ProviderWebSocket
  ));
  let socket: ProviderWebSocket;
  try {
    socket = factory(parsed.toString(), {
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch {
    throw new ProviderNetworkError('websocket-failed', 'The provider WebSocket connection failed.');
  }
  activeProviderSockets.set(socket, scope);
  socket.addEventListener('close', () => { activeProviderSockets.delete(socket); });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', failed);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        closeWebSocket(socket, 'connect_failed');
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const opened: ProviderWebSocketListener = () => finish();
    const failed: ProviderWebSocketListener = () => finish(new ProviderNetworkError(
      'websocket-failed',
      'The provider WebSocket connection failed.',
    ));
    const aborted = (): void => finish(abortError(signal));
    socket.addEventListener('open', opened);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (policy.websocketConnectTimeoutMs > 0) {
      timer = setTimeout(() => finish(new ProviderNetworkError(
        'websocket-connect-timeout',
        'The provider WebSocket connection timed out.',
      )), policy.websocketConnectTimeoutMs);
      timer.unref?.();
    }
    if (signal.aborted) aborted();
  });
}

/** Acquire an ephemeral or bounded session-cached provider WebSocket. */
export async function acquireProviderWebSocket(
  url: string,
  headers: Record<string, string>,
  policy: AgentProviderNetworkSettings,
  options: AcquireProviderWebSocketOptions = {},
): Promise<ProviderWebSocketLease> {
  const scope = activeScope(options.scope);
  const requestedKey = options.cacheKey;
  if (!requestedKey || requestedKey.length > 1_000) {
    const socket = await connectProviderWebSocket(url, headers, policy, { ...options, scope });
    let released = false;
    return {
      socket,
      reused: false,
      release: () => {
        if (released) return;
        released = true;
        closeWebSocket(socket);
      },
    };
  }

  const key = `${scopeId(scope)}:${requestedKey}`;
  pruneWebSocketPool();
  const cached = websocketPool.get(key);
  if (cached) {
    if (cached.idleTimer) clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
    if (!cached.busy && webSocketReusable(cached.socket)
      && Date.now() - cached.createdAt < WEBSOCKET_MAX_AGE_MS) {
      cached.busy = true;
      let released = false;
      return {
        socket: cached.socket,
        entry: cached,
        reused: true,
        release: ({ keep = false } = {}) => {
          if (released) return;
          released = true;
          if (!keep || !webSocketReusable(cached.socket)
            || Date.now() - cached.createdAt >= WEBSOCKET_MAX_AGE_MS) {
            removeWebSocketEntry(key, cached, 'done');
          }
          else {
            cached.busy = false;
            scheduleWebSocketExpiry(key, cached);
          }
        },
      };
    }
    if (!cached.busy) removeWebSocketEntry(key, cached, 'connection_expired');
  }

  const socket = await connectProviderWebSocket(url, headers, policy, { ...options, scope });
  // Recheck after the asynchronous handshake: another caller may have populated this key meanwhile.
  const concurrent = websocketPool.get(key);
  // Concurrent work for one session gets an ephemeral socket and cannot corrupt continuation state.
  if (concurrent || cached?.busy || websocketPool.size >= MAX_CACHED_WEBSOCKETS) {
    let released = false;
    return {
      socket,
      reused: false,
      release: () => {
        if (released) return;
        released = true;
        closeWebSocket(socket);
      },
    };
  }
  const entry: ScopedWebSocketEntry = { socket, busy: true, createdAt: Date.now(), scope };
  websocketPool.set(key, entry);
  let released = false;
  return {
    socket,
    entry,
    reused: false,
    release: ({ keep = false } = {}) => {
      if (released) return;
      released = true;
      if (!keep || !webSocketReusable(entry.socket)
        || Date.now() - entry.createdAt >= WEBSOCKET_MAX_AGE_MS) {
        removeWebSocketEntry(key, entry, 'done');
      }
      else {
        entry.busy = false;
        scheduleWebSocketExpiry(key, entry);
      }
    },
  };
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const complete = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(complete, milliseconds);
    timer.unref?.();
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function retryAfterMs(response: Response, now: () => number): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Math.min(Number(value.trim()) * 1_000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - now(), MAX_RETRY_AFTER_MS)) : undefined;
}

function retryDelay(attempt: number, response: Response | undefined, policy: AgentProviderNetworkSettings, now: () => number): number {
  const requested = response ? retryAfterMs(response, now) : undefined;
  const exponential = Math.min(500 * 2 ** attempt, 10_000);
  const delay = requested ?? exponential;
  return Math.min(delay, policy.maxRetryDelayMs);
}

function abortable<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError(signal));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

function withTimeout(signal: AbortSignal | null | undefined, timeoutMs: number): {
  signal?: AbortSignal;
  timedOut: () => boolean;
} {
  if (timeoutMs === 0) return { ...(signal ? { signal } : {}), timedOut: () => false };
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    timedOut: () => timeout.aborted && !signal?.aborted,
  };
}

function idleTimeoutResponse(response: Response, idleTimeoutMs: number): Response {
  if (!response.body || idleTimeoutMs === 0) return response;
  const reader = response.body.getReader();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ProviderNetworkError(
            'response-idle-timeout',
            'The provider response was idle for too long.',
          )), idleTimeoutMs);
          timer.unref?.();
        });
        const result = await Promise.race([reader.read(), timeout]);
        if (result.done) {
          release();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        // A hostile reader may ignore cancellation; surface the bounded timeout without awaiting it.
        void reader.cancel(error).catch(() => undefined);
        try { release(); } catch { /* The pending read may retain the lock until it settles. */ }
        controller.error(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      try { release(); } catch { /* The source may retain a pending read after cancellation. */ }
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Apply one bounded provider policy without placing URLs, response bodies, proxy
 * credentials, or request headers in diagnostics.
 */
export async function fetchProviderResponse(
  url: string | URL,
  init: RequestInit,
  policy: AgentProviderNetworkSettings,
  options: ProviderFetchOptions = {},
): Promise<Response> {
  let endpoint: URL;
  try {
    const source = typeof url === 'string' ? url : url.href;
    if (Buffer.byteLength(source) > 8_192 || /[\u0000-\u001f\u007f]/u.test(source)) throw new Error('invalid');
    endpoint = new URL(source);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('invalid');
    }
  } catch {
    throw new ProviderNetworkError('request-failed', 'The provider request failed.');
  }
  const scope = activeScope(options.scope);
  const scopeSignal = scopeState(scope).controller.signal;
  const requestSignal = init.signal ? AbortSignal.any([init.signal, scopeSignal]) : scopeSignal;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const proxy = policy.httpProxy;
  const fetcher = options.fetcher ?? (proxy ? undiciFetch as unknown as typeof fetch : fetch);

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    const timeout = withTimeout(requestSignal, policy.requestTimeoutMs);
    try {
      const requestInit = {
        ...init,
        // Never forward provider credentials across an implicit cross-origin redirect.
        redirect: 'manual' as const,
        ...(timeout.signal ? { signal: timeout.signal } : {}),
        ...(proxy ? { dispatcher: proxyDispatcher(proxy, scope) as Dispatcher } : {}),
      } as RequestInit;
      const response = await abortable(fetcher(endpoint.toString(), requestInit), timeout.signal);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= policy.maxRetries) {
        return idleTimeoutResponse(response, policy.httpIdleTimeoutMs);
      }
      // Do not let a non-cooperative body prevent the bounded retry policy from progressing.
      void response.body?.cancel().catch(() => undefined);
      await sleep(retryDelay(attempt, response, policy, now), requestSignal);
    } catch {
      if (init.signal?.aborted) throw abortError(init.signal);
      if (scopeSignal.aborted) {
        throw new ProviderNetworkError('request-failed', 'The provider network runtime is closed.');
      }
      if (attempt >= policy.maxRetries) {
        throw new ProviderNetworkError(
          timeout.timedOut() ? 'request-timeout' : 'request-failed',
          timeout.timedOut() ? 'The provider request timed out.' : 'The provider request failed.',
        );
      }
      await sleep(retryDelay(attempt, undefined, policy, now), requestSignal);
    }
  }
  throw new ProviderNetworkError('request-failed', 'The provider request failed.');
}

/** Close cached transports globally, or only those owned by one lifecycle scope. */
export async function closeProviderNetworkDispatchers(
  scope?: ProviderNetworkScope,
  options: { permanent?: boolean } = {},
): Promise<void> {
  const closingScopes = scope ? [scope] : [...knownScopes];
  for (const closingScope of closingScopes) {
    const state = scopeState(closingScope);
    state.controller.abort(new DOMException('Provider network runtime closed.', 'AbortError'));
    if (scope && options.permanent) {
      state.closed = true;
      knownScopes.delete(closingScope);
    } else if (!state.closed) {
      state.controller = new AbortController();
    }
  }
  for (const [socket, owner] of [...activeProviderSockets]) {
    if (!scope || owner === scope) closeWebSocket(socket, 'shutdown');
  }
  for (const [key, entry] of [...websocketPool]) {
    if (!scope || entry.scope === scope) removeWebSocketEntry(key, entry, 'shutdown');
  }
  const dispatchers: ProxyAgent[] = [];
  for (const [key, entry] of [...proxyDispatchers]) {
    if (!scope || entry.scope === scope) {
      proxyDispatchers.delete(key);
      dispatchers.push(entry.dispatcher);
    }
  }
  if (!dispatchers.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), 5_000);
    timer.unref?.();
  });
  const result = await Promise.race([
    Promise.all(dispatchers.map(async dispatcher => {
      try { await dispatcher.close(); }
      catch { void dispatcher.destroy(new Error('Provider network runtime closed.')).catch(() => undefined); }
    })).then(() => 'closed' as const),
    deadline,
  ]);
  if (timer) clearTimeout(timer);
  if (result === 'timeout') {
    for (const dispatcher of dispatchers) {
      void dispatcher.destroy(new Error('Provider network runtime closed.')).catch(() => undefined);
    }
  }
}
