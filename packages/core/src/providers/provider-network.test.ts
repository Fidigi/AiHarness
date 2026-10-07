import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProviderNetworkSettings } from '../config/agent-settings.js';
import { OpenAiProvider } from './index.js';
import {
  acquireProviderWebSocket,
  closeProviderNetworkDispatchers,
  createProviderNetworkScope,
  fetchProviderResponse,
  ProviderNetworkError,
  type ProviderWebSocket,
} from './provider-network.js';

const policy = (overrides: Partial<AgentProviderNetworkSettings> = {}): AgentProviderNetworkSettings => ({
  transport: 'auto',
  httpIdleTimeoutMs: 300_000,
  websocketConnectTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
  maxRetries: 0,
  maxRetryDelayMs: 60_000,
  ...overrides,
});

afterEach(async () => {
  vi.useRealTimers();
  await closeProviderNetworkDispatchers();
});

class NetworkTestWebSocket implements ProviderWebSocket {
  readyState = 0;
  close = vi.fn(() => { this.readyState = 3; });
  send = vi.fn();
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(open = true) {
    if (open) void Promise.resolve().then(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
}

describe('provider WebSocket policy', () => {
  it('bounds the connection handshake and closes the unfinished socket', async () => {
    vi.useFakeTimers();
    const socket = new NetworkTestWebSocket(false);
    const acquisition = acquireProviderWebSocket(
      'wss://provider.example.test/responses', {}, policy({ websocketConnectTimeoutMs: 25 }),
      { factory: () => socket },
    );
    const assertion = expect(acquisition).rejects.toMatchObject({
      code: 'websocket-connect-timeout',
      message: 'The provider WebSocket connection timed out.',
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(socket.close).toHaveBeenCalled();
  });

  it('leases cached sockets exclusively and expires an idle lease', async () => {
    vi.useFakeTimers();
    const sockets: NetworkTestWebSocket[] = [];
    const factory = () => {
      const socket = new NetworkTestWebSocket();
      sockets.push(socket);
      return socket;
    };
    const first = await acquireProviderWebSocket(
      'wss://provider.example.test/responses', {}, policy(), { cacheKey: 'session', factory },
    );
    first.release({ keep: true });
    const reused = await acquireProviderWebSocket(
      'wss://provider.example.test/responses', {}, policy(), { cacheKey: 'session', factory },
    );
    expect(reused.reused).toBe(true);
    expect(reused.socket).toBe(first.socket);
    const concurrent = await acquireProviderWebSocket(
      'wss://provider.example.test/responses', {}, policy(), { cacheKey: 'session', factory },
    );
    expect(concurrent.reused).toBe(false);
    expect(concurrent.entry).toBeUndefined();
    concurrent.release();
    expect(sockets[1]?.close).toHaveBeenCalled();
    reused.release({ keep: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sockets[0]?.close).toHaveBeenCalled();
  });

  it('closes one lifecycle scope without touching the replacement scope', async () => {
    const firstScope = createProviderNetworkScope();
    const replacementScope = createProviderNetworkScope();
    let firstSocket!: NetworkTestWebSocket;
    let replacementSocket!: NetworkTestWebSocket;
    const first = await acquireProviderWebSocket(
      'wss://provider.example.test/responses', {}, policy(), {
        cacheKey: 'session',
        scope: firstScope,
        factory: () => (firstSocket = new NetworkTestWebSocket()),
      },
    );
    const replacement = await acquireProviderWebSocket(
      'wss://provider.example.test/responses', {}, policy(), {
        cacheKey: 'session',
        scope: replacementScope,
        factory: () => (replacementSocket = new NetworkTestWebSocket()),
      },
    );
    first.release({ keep: true });
    replacement.release({ keep: true });

    await closeProviderNetworkDispatchers(firstScope, { permanent: true });

    expect(firstSocket.close).toHaveBeenCalled();
    expect(replacementSocket.close).not.toHaveBeenCalled();
    const reused = await acquireProviderWebSocket(
      'wss://provider.example.test/responses', {}, policy(),
      { cacheKey: 'session', scope: replacementScope, factory: () => new NetworkTestWebSocket() },
    );
    expect(reused.reused).toBe(true);
    reused.release();
    await expect(acquireProviderWebSocket(
      'wss://provider.example.test/responses', {}, policy(),
      { scope: firstScope, factory: () => new NetworkTestWebSocket() },
    )).rejects.toMatchObject({ code: 'request-failed' });
  });

  it('keeps the session cache bounded to 64 idle connections', async () => {
    const sockets: NetworkTestWebSocket[] = [];
    for (let index = 0; index < 65; index++) {
      const lease = await acquireProviderWebSocket(
        'wss://provider.example.test/responses', {}, policy(), {
          cacheKey: `session-${index}`,
          factory: () => {
            const socket = new NetworkTestWebSocket();
            sockets.push(socket);
            return socket;
          },
        },
      );
      lease.release({ keep: true });
    }
    expect(sockets).toHaveLength(65);
    expect(sockets.filter(socket => socket.close.mock.calls.length > 0)).toHaveLength(1);
  });
});

describe('provider network policy', () => {
  it('retries only to the configured bound and caps server retry delays', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '999999' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const delays: number[] = [];

    const response = await fetchProviderResponse('https://provider.example.test/v1', {}, policy({
      httpProxy: 'http://proxy.example.test/',
      maxRetries: 1,
      maxRetryDelayMs: 123,
    }), {
      fetcher,
      sleep: async milliseconds => { delays.push(milliseconds); },
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([123]);
    expect(fetcher.mock.calls[0]?.[1]).toHaveProperty('dispatcher');
  });

  it('bounds the whole request and streamed response idle interval independently', async () => {
    vi.useFakeTimers();
    const pendingFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const request = fetchProviderResponse('https://provider.test', {}, policy({ requestTimeoutMs: 25 }), {
      fetcher: pendingFetch as typeof fetch,
    });
    const requestAssertion = expect(request).rejects.toMatchObject({ code: 'request-timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await requestAssertion;

    const response = await fetchProviderResponse('https://provider.test', {}, policy({
      requestTimeoutMs: 0,
      httpIdleTimeoutMs: 30,
    }), {
      fetcher: vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))),
    });
    const bodyAssertion = expect(response.text()).rejects.toMatchObject({ code: 'response-idle-timeout' });
    await vi.advanceTimersByTimeAsync(30);
    await bodyAssertion;
  });

  it('returns stable failures without URL, proxy credentials, response body, or secrets', async () => {
    const secret = 'tiny';
    const proxySecret = 'proxy-password';
    const fetcher = vi.fn().mockRejectedValue(new Error(
      `connect https://provider.example.test/?key=${secret} through http://user:${proxySecret}@proxy.invalid`,
    ));
    let failure: unknown;
    try {
      await fetchProviderResponse('https://provider.example.test/', {
        headers: { Authorization: `Bearer ${secret}` },
      }, policy({ httpProxy: `http://user:${proxySecret}@proxy.invalid` }), { fetcher });
    } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(ProviderNetworkError);
    expect(failure).toMatchObject({ code: 'request-failed', message: 'The provider request failed.' });
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(proxySecret);
    expect(String(failure)).not.toContain('provider.example.test');
  });

  it('makes resolved transport, timeouts, and provider retry visible without exposing the proxy', () => {
    const provider = new OpenAiProvider({
      type: 'openai', apiKey: 'secret', transport: 'websocket-cached',
      httpProxy: 'http://operator:secret@proxy.example.test',
      httpIdleTimeoutMs: 12_000, websocketConnectTimeoutMs: 4_000,
      requestTimeoutMs: 9_000, providerMaxRetries: 2, providerMaxRetryDelayMs: 700,
    });

    expect(provider.getNetworkSettings()).toEqual({
      transport: 'websocket-cached',
      httpIdleTimeoutMs: 12_000,
      websocketConnectTimeoutMs: 4_000,
      requestTimeoutMs: 9_000,
      maxRetries: 2,
      maxRetryDelayMs: 700,
      proxyConfigured: true,
    });
    expect(JSON.stringify(provider.getNetworkSettings())).not.toContain('operator');
    expect(JSON.stringify(provider.getNetworkSettings())).not.toContain('secret');
  });
});
