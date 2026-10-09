import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerTestTarget } from './config-inventory.js';
import {
  isSameMcpOAuthTarget,
  McpOAuthCredentialWriteError,
  McpOAuthSignedOutError,
  mcpOAuthStorageName,
  mcpOAuthUrl,
  type McpOAuthCredentialManager,
  type McpOAuthIdentity,
} from './oauth.js';
import { boundedMcpOAuthFetch } from './oauth-fetch.js';
import {
  MCP_TEST_CLOSE_WAIT_MS,
  MCP_TEST_COMMAND_TIMEOUT_MS,
  closeClient,
  resolveMcpOAuthSettings,
  resolveRuntimeConfig,
} from './server-test.js';

export const MCP_OAUTH_FLOW_TTL_MS = 5 * 60_000;
export const MCP_OAUTH_FLOW_KEEP_MS = 60_000;
export const MCP_OAUTH_FLOW_MAX = 100;
export const MCP_OAUTH_FLOW_MAX_ACTIVE = 32;
export const MCP_OAUTH_REDIRECT_MAX_CHARS = 16 * 1024;

const CALLBACK_PATH = '/oauth/callback';
const CALLBACK_HOST = '127.0.0.1';
const FLOW_SHUTDOWN_WAIT_MS = 2_000;
const FLOW_REQUEST_TIMEOUT_MS = 15_000;
const ENDED_PHASES = new Set<McpOAuthFlowPhase>([
  'connected', 'failed', 'cancelled', 'expired',
]);

export type McpOAuthFlowPhase =
  | 'starting'
  | 'authorize'
  | 'exchanging'
  | 'verifying'
  | 'connected'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type McpOAuthFlowFailure =
  | 'authorization-failed'
  | 'configuration-changed'
  | 'connection-failed'
  | 'credential-write-rejected'
  | 'verification-failed';

export interface McpOAuthFlowInfo {
  flowId: string;
  scope: 'global' | 'project';
  name: string;
  configKey: string;
  phase: McpOAuthFlowPhase;
  expiresAt: string;
  authorizationUrl?: string;
  redirectUrl?: string;
  alreadyConnected?: true;
  refreshed?: true;
  failure?: McpOAuthFlowFailure;
}

export interface McpOAuthFlowTarget {
  target: McpServerTestTarget;
  /** Fresh config/trust check used before OAuth writes and post-login verification. */
  validate(): Promise<McpServerTestTarget>;
}

export interface McpOAuthFlowStartResult {
  flow: McpOAuthFlowInfo;
  joined: boolean;
}

export type McpOAuthRedirectResult =
  | { ok: true; flow: McpOAuthFlowInfo }
  | {
    ok: false;
    code: 'flow-not-authorizing' | 'invalid-redirect' | 'redirect-denied' | 'state-mismatch';
  };

export interface McpOAuthFlowDriverContext {
  target: McpServerTestTarget;
  manager: McpOAuthCredentialManager;
  redirectUrl: string;
  state: string;
  signal: AbortSignal;
  publishAuthorizationUrl(url: URL): void;
  publishVerifying(): void;
  waitForAuthorizationCode(): Promise<string>;
  validateTarget(): Promise<McpServerTestTarget>;
}

export interface McpOAuthFlowDriverResult {
  alreadyConnected?: true;
  refreshed?: true;
}

export type McpOAuthFlowDriver = (
  context: McpOAuthFlowDriverContext,
) => Promise<McpOAuthFlowDriverResult>;

interface AuthorizationResponse {
  code: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
}

interface LoopbackListener {
  redirectUrl: string;
  close(): Promise<void>;
}

interface InternalFlow {
  id: string;
  key: string;
  target: McpServerTestTarget;
  validate: () => Promise<McpServerTestTarget>;
  phase: McpOAuthFlowPhase;
  expiresAt: number;
  state: string;
  controller: AbortController;
  response: Deferred<AuthorizationResponse>;
  authorizationUrl?: string;
  redirectUrl?: string;
  alreadyConnected?: true;
  refreshed?: true;
  failure?: McpOAuthFlowFailure;
  expiry?: ReturnType<typeof setTimeout>;
  forget?: ReturnType<typeof setTimeout>;
  listener?: LoopbackListener;
  run?: Promise<void>;
}

export interface McpOAuthFlowServiceOptions {
  driver?: McpOAuthFlowDriver;
  ttlMs?: number;
  keepMs?: number;
  maxFlows?: number;
  maxActive?: number;
  now?: () => number;
  createId?: () => string;
  requestTimeoutMs?: number;
  commandTimeoutMs?: number;
  closeWaitMs?: number;
}

export class McpOAuthFlowServiceError extends Error {
  constructor(
    readonly code: 'closed' | 'flow-limit' | 'invalid-target' | 'not-oauth',
    message: string,
  ) {
    super(message);
    this.name = 'McpOAuthFlowServiceError';
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const value: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(result) {
      if (value.settled) return;
      value.settled = true;
      resolvePromise(result);
    },
    reject(error) {
      if (value.settled) return;
      value.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  void value.promise.catch(() => undefined);
  return value;
}

function abortError(): Error {
  const error = new Error('The MCP OAuth flow was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function flowIdentity(target: McpServerTestTarget): McpOAuthIdentity {
  const url = mcpOAuthUrl(target.config);
  if (!url) throw new McpOAuthFlowServiceError('not-oauth', 'The MCP server does not use OAuth.');
  return { name: target.name, url };
}

function assertSameTarget(
  initial: McpServerTestTarget,
  current: McpServerTestTarget,
): McpServerTestTarget {
  if (!isSameMcpOAuthTarget(initial, current)) {
    throw new McpOAuthFlowServiceError(
      'invalid-target',
      'The MCP server configuration changed during OAuth authorization.',
    );
  }
  return current;
}

function createHttpTransport(
  config: Extract<McpServerTestTarget['config'], { url: string }>,
  authProvider: Awaited<ReturnType<McpOAuthCredentialManager['createProvider']>>['provider'],
  fetcher: FetchLike,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers ?? {}, redirect: 'manual' },
    authProvider,
    redirectPolicy: 'same-origin',
    fetch: fetcher,
    reconnectionOptions: {
      maxReconnectionDelay: 500,
      initialReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  });
}

async function closeHttpClient(
  client: Client,
  transport: StreamableHTTPClientTransport,
  waitMs: number,
): Promise<void> {
  await closeClient(client, transport, waitMs, undefined).catch(() => undefined);
}

async function runDefaultDriver(
  context: McpOAuthFlowDriverContext,
  options: { requestTimeoutMs: number; commandTimeoutMs: number; closeWaitMs: number },
): Promise<McpOAuthFlowDriverResult> {
  const identity = flowIdentity(context.target);
  const validate = async (): Promise<McpServerTestTarget> => {
    if (context.signal.aborted) throw abortError();
    const current = assertSameTarget(context.target, await context.validateTarget());
    if (context.signal.aborted) throw abortError();
    return current;
  };
  const rawHttpConfig = context.target.config;
  if (!('url' in rawHttpConfig)) throw new McpOAuthFlowServiceError('not-oauth', 'The MCP server does not use OAuth.');
  let tokensSaved = false;
  let authorizationShown = false;
  const binding = await context.manager.createProvider({
    identity,
    mode: 'interactive',
    redirectUrl: context.redirectUrl,
    state: context.state,
    settings: {
      clientId: rawHttpConfig.oauth?.clientId,
      scopes: rawHttpConfig.oauth?.scopes,
      resolveClientSecret: async () => {
        const current = await validate();
        const resolved = await resolveMcpOAuthSettings(
          current,
          context.signal,
          options.commandTimeoutMs,
        );
        return resolved.clientSecret;
      },
    },
    validateWrite: async () => { await validate(); },
    onAuthorizationUrl: url => {
      authorizationShown = true;
      context.publishAuthorizationUrl(url);
    },
    onTokensSaved: () => { tokensSaved = true; },
  });
  const before = await context.manager.status(identity);
  const resolved = await resolveRuntimeConfig(
    await validate(),
    context.signal,
    options.commandTimeoutMs,
  );
  await validate();
  if (!('url' in resolved.config)) throw new McpOAuthFlowServiceError('not-oauth', 'The MCP server does not use OAuth.');
  const fetcher = boundedMcpOAuthFetch(context.signal, options.requestTimeoutMs);
  const transport = createHttpTransport(resolved.config, binding.provider, fetcher);
  const client = new Client({ name: 'ai-harness-oauth', version: '1.0.0' }, { capabilities: {} });
  try {
    try {
      await client.connect(transport, {
        signal: context.signal,
        timeout: options.requestTimeoutMs,
        maxTotalTimeout: options.requestTimeoutMs,
        resetTimeoutOnProgress: true,
      });
      await validate();
      return {
        alreadyConnected: true,
        ...(tokensSaved && before.signedIn ? { refreshed: true as const } : {}),
      };
    } catch (error) {
      if (context.signal.aborted) throw abortError();
      if (!authorizationShown) throw error;
    }

    const code = await context.waitForAuthorizationCode();
    if (context.signal.aborted) throw abortError();
    await validate();
    await transport.finishAuth(code);
    if (context.signal.aborted) throw abortError();

    context.publishVerifying();
    const current = await validate();
    const verifyResolved = await resolveRuntimeConfig(
      current,
      context.signal,
      options.commandTimeoutMs,
    );
    if (!('url' in verifyResolved.config)) throw new McpOAuthFlowServiceError('not-oauth', 'The MCP server does not use OAuth.');
    const passive = await context.manager.createProvider({
      identity,
      mode: 'passive',
      settings: {
        clientId: rawHttpConfig.oauth?.clientId,
        scopes: rawHttpConfig.oauth?.scopes,
        resolveClientSecret: async () => (await resolveMcpOAuthSettings(
          await validate(),
          context.signal,
          options.commandTimeoutMs,
        )).clientSecret,
      },
      validateWrite: async () => { await validate(); },
    });
    const verifyTransport = createHttpTransport(verifyResolved.config, passive.provider, fetcher);
    const verifyClient = new Client(
      { name: 'ai-harness-oauth-verify', version: '1.0.0' },
      { capabilities: {} },
    );
    try {
      await validate();
      await verifyClient.connect(verifyTransport, {
        signal: context.signal,
        timeout: options.requestTimeoutMs,
        maxTotalTimeout: options.requestTimeoutMs,
        resetTimeoutOnProgress: true,
      });
      await validate();
    } finally {
      await closeHttpClient(verifyClient, verifyTransport, options.closeWaitMs);
    }
    return {};
  } finally {
    await closeHttpClient(client, transport, options.closeWaitMs);
  }
}

function preferredCallbackPort(urls: readonly string[]): number | undefined {
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' && url.hostname === CALLBACK_HOST && url.pathname === CALLBACK_PATH) {
        const port = Number(url.port);
        if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
      }
    } catch { /* Ignore an obsolete registration. */ }
  }
  return undefined;
}

function callbackPage(ok: boolean): string {
  const title = ok ? 'MCP sign-in received' : 'MCP sign-in could not be accepted';
  const message = ok
    ? 'Return to AiHarness to finish connecting. You may close this page.'
    : 'Return to AiHarness and retry or paste the full redirect URL.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

async function listenOnce(
  port: number,
  onRedirect: (value: string) => boolean,
): Promise<{ server: Server; redirectUrl: string }> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || !request.url
      || request.url.length > MCP_OAUTH_REDIRECT_MAX_CHARS) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackPage(false));
      return;
    }
    let url: URL;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listener unavailable');
      url = new URL(request.url, `http://${CALLBACK_HOST}:${address.port}`);
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackPage(false));
      return;
    }
    if (url.pathname !== CALLBACK_PATH || !onRedirect(url.href)) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackPage(false));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(callbackPage(true));
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: CALLBACK_HOST, port, exclusive: true });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The OAuth callback listener is unavailable.');
  }
  return { server, redirectUrl: `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}` };
}

async function createLoopbackListener(
  preferredPort: number | undefined,
  onRedirect: (value: string) => boolean,
): Promise<LoopbackListener> {
  let opened: { server: Server; redirectUrl: string };
  try { opened = await listenOnce(preferredPort ?? 0, onRedirect); }
  catch (error) {
    if (preferredPort === undefined || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    opened = await listenOnce(0, onRedirect);
  }
  let closing: Promise<void> | undefined;
  return {
    redirectUrl: opened.redirectUrl,
    close: () => {
      if (!closing) {
        opened.server.closeAllConnections();
        closing = new Promise<void>(resolve => opened.server.close(() => resolve()));
      }
      return closing;
    },
  };
}

/** Detached, bounded OAuth flow registry shared by the Web adapter and future clients. */
export class McpOAuthFlowService {
  private readonly flows = new Map<string, InternalFlow>();
  private readonly active = new Map<string, string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly ttlMs: number;
  private readonly keepMs: number;
  private readonly maxFlows: number;
  private readonly maxActive: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly driver: McpOAuthFlowDriver;
  private readonly requestTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly closeWaitMs: number;
  private closed = false;

  constructor(
    private readonly manager: McpOAuthCredentialManager,
    options: McpOAuthFlowServiceOptions = {},
  ) {
    this.ttlMs = positiveInteger(options.ttlMs, MCP_OAUTH_FLOW_TTL_MS);
    this.keepMs = positiveInteger(options.keepMs, MCP_OAUTH_FLOW_KEEP_MS);
    this.maxFlows = positiveInteger(options.maxFlows, MCP_OAUTH_FLOW_MAX);
    this.maxActive = positiveInteger(options.maxActive, MCP_OAUTH_FLOW_MAX_ACTIVE);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, FLOW_REQUEST_TIMEOUT_MS);
    this.commandTimeoutMs = positiveInteger(options.commandTimeoutMs, MCP_TEST_COMMAND_TIMEOUT_MS);
    this.closeWaitMs = positiveInteger(options.closeWaitMs, MCP_TEST_CLOSE_WAIT_MS);
    this.driver = options.driver ?? (context => runDefaultDriver(context, {
      requestTimeoutMs: this.requestTimeoutMs,
      commandTimeoutMs: this.commandTimeoutMs,
      closeWaitMs: this.closeWaitMs,
    }));
  }

  start(input: McpOAuthFlowTarget): McpOAuthFlowStartResult {
    if (this.closed) throw new McpOAuthFlowServiceError('closed', 'The MCP OAuth service is closed.');
    const target = structuredClone(input.target);
    if (target.config.enabled === false) {
      throw new McpOAuthFlowServiceError('invalid-target', 'The MCP server is disabled.');
    }
    const identity = flowIdentity(target);
    const key = mcpOAuthStorageName(identity);
    const activeId = this.active.get(key);
    const current = activeId ? this.flows.get(activeId) : undefined;
    if (current && !this.ended(current) && isSameMcpOAuthTarget(current.target, target)) {
      return { flow: this.describe(current), joined: true };
    }
    if (current && !this.ended(current)) this.cancelInternal(current);
    this.prune();
    const activeCount = [...this.flows.values()].filter(flow => !this.ended(flow)).length;
    if (this.flows.size >= this.maxFlows || activeCount >= this.maxActive) {
      throw new McpOAuthFlowServiceError('flow-limit', 'Too many MCP OAuth flows are active.');
    }
    const id = this.createId();
    if (!/^[A-Za-z0-9-]{16,128}$/u.test(id) || this.flows.has(id)) {
      throw new McpOAuthFlowServiceError('flow-limit', 'An MCP OAuth flow id could not be allocated.');
    }
    const flow: InternalFlow = {
      id,
      key,
      target,
      validate: input.validate,
      phase: 'starting',
      expiresAt: this.now() + this.ttlMs,
      state: randomBytes(32).toString('base64url'),
      controller: new AbortController(),
      response: deferred<AuthorizationResponse>(),
    };
    flow.expiry = setTimeout(() => this.expire(flow), this.ttlMs);
    flow.expiry.unref?.();
    this.flows.set(id, flow);
    this.active.set(key, id);
    flow.run = this.run(flow, identity);
    return { flow: this.describe(flow), joined: false };
  }

  read(flowId: string): McpOAuthFlowInfo | undefined {
    const flow = this.flows.get(flowId);
    return flow ? this.describe(flow) : undefined;
  }

  pasteRedirect(flowId: string, redirectUrl: unknown): McpOAuthRedirectResult | undefined {
    const flow = this.flows.get(flowId);
    if (!flow) return undefined;
    if (flow.phase !== 'authorize' || !flow.redirectUrl || flow.response.settled) {
      return { ok: false, code: 'flow-not-authorizing' };
    }
    if (typeof redirectUrl !== 'string' || redirectUrl.length === 0
      || redirectUrl.length > MCP_OAUTH_REDIRECT_MAX_CHARS
      || /[\u0000-\u001f\u007f]/u.test(redirectUrl)) {
      return { ok: false, code: 'invalid-redirect' };
    }
    let received: URL;
    let expected: URL;
    try {
      received = new URL(redirectUrl.trim());
      expected = new URL(flow.redirectUrl);
    } catch { return { ok: false, code: 'invalid-redirect' }; }
    if (received.origin !== expected.origin || received.pathname !== expected.pathname
      || received.username || received.password || received.hash
      || received.searchParams.getAll('state').length !== 1
      || received.searchParams.getAll('code').length !== 1) {
      return { ok: false, code: 'invalid-redirect' };
    }
    if (received.searchParams.has('error')) return { ok: false, code: 'redirect-denied' };
    if (received.searchParams.get('state') !== flow.state) return { ok: false, code: 'state-mismatch' };
    const code = received.searchParams.get('code');
    if (!code || code.length > MCP_OAUTH_REDIRECT_MAX_CHARS || /[\u0000-\u001f\u007f]/u.test(code)) {
      return { ok: false, code: 'invalid-redirect' };
    }
    flow.phase = 'exchanging';
    flow.response.resolve({ code });
    return { ok: true, flow: this.describe(flow) };
  }

  cancel(flowId: string): McpOAuthFlowInfo | undefined {
    const flow = this.flows.get(flowId);
    if (!flow) return undefined;
    this.cancelInternal(flow);
    return this.describe(flow);
  }

  async signOut(identity: McpOAuthIdentity): Promise<boolean> {
    const key = mcpOAuthStorageName(identity);
    const activeId = this.active.get(key);
    const active = activeId ? this.flows.get(activeId) : undefined;
    if (active) this.cancelInternal(active);
    return this.manager.signOut(identity);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const flow of this.flows.values()) this.cancelInternal(flow);
    const runs = [...this.flows.values()].flatMap(flow => flow.run ? [flow.run] : []);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(runs).then(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, FLOW_SHUTDOWN_WAIT_MS); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async run(flow: InternalFlow, identity: McpOAuthIdentity): Promise<void> {
    const previous = this.tails.get(flow.key) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => finished);
    this.tails.set(flow.key, tail);
    try {
      await previous.catch(() => undefined);
      if (this.ended(flow)) return;
      const redirects = await this.manager.registeredRedirectUrls(identity);
      if (this.ended(flow)) return;
      flow.listener = await createLoopbackListener(preferredCallbackPort(redirects), value => {
        const result = this.pasteRedirect(flow.id, value);
        return result?.ok === true;
      });
      flow.redirectUrl = flow.listener.redirectUrl;
      if (this.ended(flow)) return;
      const result = await this.driver({
        target: flow.target,
        manager: this.manager,
        redirectUrl: flow.listener.redirectUrl,
        state: flow.state,
        signal: flow.controller.signal,
        publishAuthorizationUrl: url => {
          if (this.ended(flow)) return;
          flow.authorizationUrl = url.href;
          flow.phase = 'authorize';
        },
        publishVerifying: () => {
          if (!this.ended(flow)) flow.phase = 'verifying';
        },
        waitForAuthorizationCode: async () => {
          const response = await flow.response.promise;
          if (flow.controller.signal.aborted) throw abortError();
          flow.phase = 'exchanging';
          return response.code;
        },
        validateTarget: async () => {
          if (flow.controller.signal.aborted) throw abortError();
          const current = await flow.validate();
          if (flow.controller.signal.aborted) throw abortError();
          return assertSameTarget(flow.target, current);
        },
      });
      if (this.ended(flow)) return;
      flow.alreadyConnected = result.alreadyConnected;
      flow.refreshed = result.refreshed;
      this.finish(flow, 'connected');
    } catch (error) {
      if (this.ended(flow)) return;
      if (flow.controller.signal.aborted || isAbort(error)) {
        this.finish(flow, 'cancelled');
      } else if (error instanceof McpOAuthFlowServiceError && error.code === 'invalid-target') {
        this.finish(flow, 'failed', 'configuration-changed');
      } else if (error instanceof McpOAuthCredentialWriteError || error instanceof McpOAuthSignedOutError) {
        this.finish(flow, 'failed', 'credential-write-rejected');
      } else if (flow.phase === 'authorize' || flow.phase === 'exchanging') {
        this.finish(flow, 'failed', 'authorization-failed');
      } else if (flow.phase === 'verifying') {
        this.finish(flow, 'failed', 'verification-failed');
      } else {
        this.finish(flow, 'failed', 'connection-failed');
      }
    } finally {
      clearTimeout(flow.expiry);
      await flow.listener?.close().catch(() => undefined);
      if (this.active.get(flow.key) === flow.id) this.active.delete(flow.key);
      release();
      if (this.tails.get(flow.key) === tail) {
        void tail.then(() => {
          if (this.tails.get(flow.key) === tail) this.tails.delete(flow.key);
        });
      }
      if (!flow.forget) {
        flow.forget = setTimeout(() => {
          if (this.flows.get(flow.id) === flow) this.flows.delete(flow.id);
        }, this.keepMs);
        flow.forget.unref?.();
      }
    }
  }

  private describe(flow: InternalFlow): McpOAuthFlowInfo {
    return {
      flowId: flow.id,
      scope: flow.target.scope,
      name: flow.target.name,
      configKey: flow.target.configKey,
      phase: flow.phase,
      expiresAt: new Date(flow.expiresAt).toISOString(),
      ...(flow.phase === 'authorize' && flow.authorizationUrl
        ? {
          authorizationUrl: flow.authorizationUrl,
          ...(flow.redirectUrl ? { redirectUrl: flow.redirectUrl } : {}),
        }
        : {}),
      ...(flow.alreadyConnected ? { alreadyConnected: true as const } : {}),
      ...(flow.refreshed ? { refreshed: true as const } : {}),
      ...(flow.failure ? { failure: flow.failure } : {}),
    };
  }

  private ended(flow: InternalFlow): boolean {
    return ENDED_PHASES.has(flow.phase);
  }

  private finish(
    flow: InternalFlow,
    phase: Extract<McpOAuthFlowPhase, 'connected' | 'failed' | 'cancelled' | 'expired'>,
    failure?: McpOAuthFlowFailure,
  ): void {
    if (this.ended(flow)) return;
    flow.phase = phase;
    flow.failure = failure;
    clearTimeout(flow.expiry);
    if (phase !== 'connected') {
      flow.controller.abort(phase);
      flow.response.reject(abortError());
      // Do not keep a callback listener alive while an async driver ignores cancellation.
      void flow.listener?.close().catch(() => undefined);
    }
  }

  private cancelInternal(flow: InternalFlow): void {
    this.finish(flow, 'cancelled');
  }

  private expire(flow: InternalFlow): void {
    this.finish(flow, 'expired');
  }

  private prune(): void {
    for (const [id, flow] of this.flows) {
      if (this.flows.size < this.maxFlows) break;
      if (!this.ended(flow)) continue;
      clearTimeout(flow.forget);
      this.flows.delete(id);
    }
  }
}
