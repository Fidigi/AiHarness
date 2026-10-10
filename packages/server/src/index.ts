// ============================================================
// AiHarness Server - AI API Proxy with SSE Streaming + Session Management
// Express server that proxies requests to OpenAI/Anthropic APIs
// and manages sessions via JSONL persistence
// ============================================================

import type { Request, Response } from 'express';
import express, { type NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { AiProxyServer, createProxyRoutes } from './api/proxy.js';
import {
  createMcpOAuthProviderFactory,
  CredentialRedactor,
  EncryptedCredentialStore,
  isValidSessionId,
  McpOAuthCredentialManager,
  McpOAuthFlowService,
  ProviderCredentialService,
  serializeSession,
} from '@ai-harness/core';
import type { AgentSettings, Session, SessionManager } from '@ai-harness/core';
import { closeServerWebSockets, handleWebSocketUpgrade } from './api/websocket.js';
import { createAgentRouter, userBlocks } from './api/agent-routes.js';
import { createWorkspaceRouter } from './api/workspace-routes.js';
import type { WorkspaceFileManagerOptions } from './api/workspace-file-manager.js';
import { createFileRouter } from './api/file-routes.js';
import { createConfigurationRouter } from './api/config-routes.js';
import { createMcpRouter } from './api/mcp-routes.js';
import { createModelRouter } from './api/model-routes.js';
import { createPluginRouter } from './api/plugin-routes.js';
import { createProviderRegistryRouter } from './api/provider-registry-routes.js';
import { createPushRouter } from './api/push-routes.js';
import { createSkillRouter } from './api/skill-routes.js';
import { createSubagentRouter } from './api/subagent-routes.js';
import { createToolRouter } from './api/tool-routes.js';
import { createTerminalRouter } from './api/terminal-routes.js';
import {
  MAX_MESSAGE_PAGE_SIZE,
  serializeSessionPage,
} from './api/session-pagination.js';
import {
  authenticationMiddleware,
  clearWebSessions,
  createWebSession,
  credentialRedactionMiddleware,
  originMiddleware,
  publicRequestOrigin,
  rateLimit,
  requireCapability,
  revokeWebSession,
  safeErrorHandler,
  webAuthenticationStatus,
  WEB_SESSION_COOKIE,
} from './security/request-security.js';
import {
  createRuntimeServices,
  type RuntimeServiceOptions,
  type RuntimeServices,
} from './runtime/services.js';
import { getAppUpdateStatus } from './runtime/app-update.js';
import { ProviderOAuthService } from './runtime/provider-oauth.js';

export type { ChatOptions } from '@ai-harness/core';

/** Server configuration */
export interface ServerConfig extends RuntimeServiceOptions {
  port?: number;
  host?: string;
  /** Optional production Web bundle directory. */
  webRoot?: string;
  /** Injectable provider controller for integration tests and embedders. */
  proxy?: AiProxyServer;
  enableMockProvider?: boolean;
  /** Injectable host desktop integration for tests and embedders. */
  fileManager?: WorkspaceFileManagerOptions;
  /** Injectable composition factory for lifecycle integration tests and embedders. */
  runtimeServicesFactory?: typeof createRuntimeServices;
}

const DEFAULT_PORT = 3099;
const DEFAULT_HOST = '127.0.0.1';

function serverAddress(config?: ServerConfig): { port: number; host: string } {
  const port = config?.port ?? DEFAULT_PORT;
  const host = config?.host ?? DEFAULT_HOST;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535
    || typeof host !== 'string' || !host || Buffer.byteLength(host) > 255
    || /[\u0000-\u0020\u007f-\u009f]/u.test(host)) {
    throw new Error('Invalid server address.');
  }
  return { port, host };
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost') return true;
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  if (isIP(normalized) !== 6) return false;
  try { return new URL(`http://[${normalized}]/`).hostname === '[::1]'; }
  catch { return false; }
}

let proxyServer: AiProxyServer | null = null;
let appInstance: express.Application | null = null;
let httpServer: Server | null = null;
let activeServices: Promise<RuntimeServices> | undefined;
interface CredentialRuntime {
  readonly filePath: string;
  readonly services: Promise<RuntimeServices>;
  service?: ProviderCredentialService;
  mcpOAuth?: McpOAuthCredentialManager;
  mcpOAuthFlows?: McpOAuthFlowService;
  initialization?: Promise<void>;
  closed?: boolean;
}
let activeCredentialRuntime: CredentialRuntime | undefined;
let activeProviderOAuth: ProviderOAuthService | undefined;
let applicationGeneration = 0;
const sharedSessions = new Map<string, { sessionId: string; expiresAt: number }>();

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shutdownRuntimeServices(
  services: Promise<RuntimeServices> | undefined,
  proxy: AiProxyServer | null,
): Promise<void> {
  if (!services) return;
  const resolution = services.then(
    value => ({ value }),
    () => ({ value: undefined }),
  );
  const resolved = await settleWithin(resolution, 2_000);
  if (!resolved) {
    // Initialization itself may be blocked in external I/O. Do not block replacement or
    // process shutdown, but close the runtime if that initialization eventually completes.
    void resolution.then(async late => {
      if (late.value) await Promise.allSettled([
        Promise.resolve().then(() => late.value!.close()),
        Promise.resolve().then(() => proxy?.flushUsage()),
      ]);
    });
    return;
  }
  if (!resolved.value) return;
  await settleWithin(Promise.allSettled([
    Promise.resolve().then(() => resolved.value!.close()),
    Promise.resolve().then(() => proxy?.flushUsage()),
  ]).then(() => undefined), 6_000);
}

function providerOAuthRefresh(provider: string): { tokenUrl: string; clientId: string; clientSecret?: string } | undefined {
  const prefix = `AI_HARNESS_OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const tokenUrl = process.env[`${prefix}_TOKEN_URL`];
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  if (!tokenUrl || !clientId) return undefined;
  return {
    tokenUrl,
    clientId,
    ...(process.env[`${prefix}_CLIENT_SECRET`] ? { clientSecret: process.env[`${prefix}_CLIENT_SECRET`] } : {}),
  };
}

function credentialCommandVariable(provider: string): string {
  return `AI_HARNESS_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY_COMMAND`;
}

function initializeCredentials(
  runtime: CredentialRuntime,
  proxy: AiProxyServer,
  settings: AgentSettings,
): Promise<void> {
  if (runtime.initialization) return runtime.initialization;
  runtime.initialization = (async () => {
    if (runtime.closed) throw new Error('Application runtime is no longer active.');
    const masterKey = process.env.AI_HARNESS_MASTER_KEY;
    const store = masterKey ? new EncryptedCredentialStore(runtime.filePath, masterKey) : undefined;
    const credentials = new ProviderCredentialService({
      store,
      redactor: proxy.getCredentialRedactor(),
    });
    await credentials.load();
    const services = await runtime.services;
    await services.sessionManager.loadAllSessions();
    const credentialEnvironment = { ...process.env };
    for (const [provider, command] of Object.entries(settings.providerApiKeyCommands ?? {})) {
      credentialEnvironment[credentialCommandVariable(provider)] = command;
    }
    for (const type of ['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local'] as const) {
      if (runtime.closed) throw new Error('Application runtime is no longer active.');
      // Migrate the pre-Core encrypted key namespace in place without exposing its value.
      const legacy = store?.get(type);
      if (legacy && !store?.get(`provider:${type}`)) {
        await credentials.setApiKey(type, legacy);
        await store?.delete(type);
      }
      const resolved = await credentials.resolve(type, {
        env: credentialEnvironment,
        oauth: providerOAuthRefresh(type),
      });
      if (runtime.closed) throw new Error('Application runtime is no longer active.');
      if (!resolved) continue;
      const value = resolved.credential.type === 'api-key'
        ? resolved.credential.apiKey : resolved.credential.accessToken;
      proxy.setApiKey(type, value);
    }
    if (runtime.closed) throw new Error('Application runtime is no longer active.');
    let mcpOAuth: McpOAuthCredentialManager | undefined;
    let mcpOAuthFlows: McpOAuthFlowService | undefined;
    if (store) {
      mcpOAuth = new McpOAuthCredentialManager(store, proxy.getCredentialRedactor());
      mcpOAuthFlows = new McpOAuthFlowService(mcpOAuth);
      services.mcpHost.setOAuthProviderFactory(createMcpOAuthProviderFactory({
        manager: mcpOAuth,
        resolveTarget: async target => (
          await services.mcpInventory.resolveServerTarget({
            scope: target.scope,
            name: target.name,
            expectedConfigKey: target.configKey,
            cwd: target.cwd,
          })
        ).target,
      }));
    }
    runtime.service = credentials;
    runtime.mcpOAuth = mcpOAuth;
    runtime.mcpOAuthFlows = mcpOAuthFlows;
  })();
  return runtime.initialization;
}

/** Get or create the singleton proxy server */
export function getProxy(): AiProxyServer {
  if (!proxyServer) {
    proxyServer = new AiProxyServer();
  }
  return proxyServer;
}

/** Get the session manager associated with the active application. */
export async function getSessionManager(): Promise<SessionManager> {
  if (!activeServices) activeServices = createRuntimeServices(getProxy());
  return (await activeServices).sessionManager;
}

function normalizeGeneratedTitle(content: string): string | undefined {
  const firstLine = content.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!firstLine) return undefined;
  const normalized = firstLine
    .replace(/^\s*(?:title\s*:\s*)?/i, '')
    .replace(/^[#>*`'"\s_-]+|[#>*`'"\s_-]+$/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  const codePoints = Array.from(normalized);
  return codePoints.length <= 100 ? normalized : `${codePoints.slice(0, 99).join('').trimEnd()}…`;
}

const UNSAFE_SESSION_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;

function optionalSessionString(value: unknown, maxBytes: number, trim = true): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes
    || UNSAFE_SESSION_TEXT.test(value)) return undefined;
  return trim ? value.trim() : value;
}

function boundedQueryInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function sessionUsage(value: unknown): Session['usage'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: NonNullable<Session['usage']> = {};
  const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const;
  for (const field of tokenFields) {
    const candidate = source[field];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) return undefined;
    result[field] = candidate as number;
  }
  if (source.costUsd !== undefined) {
    if (typeof source.costUsd !== 'number' || !Number.isFinite(source.costUsd)
      || source.costUsd < 0 || source.costUsd > 1_000_000_000) return undefined;
    result.costUsd = source.costUsd;
  }
  return result;
}

function sendBoundedJson(response: Response, value: unknown, maxBytes = 32 * 1024 * 1024): boolean {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) {
      response.status(413).json({ error: 'Response exceeds its size limit.' });
      return false;
    }
  } catch {
    response.status(500).json({ error: 'Response could not be serialized.' });
    return false;
  }
  response.json(value);
  return true;
}

function sessionMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++nodes > 4_096 || current.depth > 16) return undefined;
    if (!current.value || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      if (current.value.length > 1_024) return undefined;
      for (const nested of current.value) stack.push({ value: nested, depth: current.depth + 1 });
      continue;
    }
    const keys = Object.keys(current.value);
    if (keys.length > 256) return undefined;
    for (const key of keys) {
      if (Buffer.byteLength(key) > 256 || UNSAFE_SESSION_TEXT.test(key)) return undefined;
      stack.push({ value: (current.value as Record<string, unknown>)[key], depth: current.depth + 1 });
    }
  }
  try {
    const encoded = JSON.stringify(value);
    if (!encoded || Buffer.byteLength(encoded) > 256 * 1_024) return undefined;
  } catch { return undefined; }
  return value as Record<string, unknown>;
}

/** Create Express app with all routes configured */
export function createApp(config?: ServerConfig): express.Application {
  const { port, host } = serverAddress(config);
  if (config?.webRoot !== undefined && (typeof config.webRoot !== 'string'
    || Buffer.byteLength(config.webRoot) > 4_096 || config.webRoot.includes('\0'))) {
    throw new Error('Invalid web root.');
  }
  const dataDirInput = config?.dataDir ?? process.env.AI_HARNESS_DATA_DIR
    ?? path.join(os.homedir(), '.ai-harness');
  if (typeof dataDirInput !== 'string' || !dataDirInput || Buffer.byteLength(dataDirInput) > 4_096
    || dataDirInput.includes('\0')) throw new Error('Invalid server data directory.');
  const dataDir = path.resolve(dataDirInput);
  const webRoot = config?.webRoot ? path.resolve(config.webRoot) : undefined;
  const webIndexFile = webRoot ? path.join(webRoot, 'index.html') : undefined;
  if (webIndexFile && !existsSync(webIndexFile)) {
    throw new Error(`Web bundle introuvable : ${webIndexFile}. Exécutez npm run build.`);
  }
  const generation = ++applicationGeneration;
  closeServerWebSockets();
  const replacedServices = activeServices;
  const replacedProxy = proxyServer;
  const replacedCredentials = activeCredentialRuntime;
  activeServices = undefined;
  if (replacedCredentials) replacedCredentials.closed = true;
  activeCredentialRuntime = undefined;
  if (replacedCredentials?.mcpOAuthFlows) void replacedCredentials.mcpOAuthFlows.shutdown();
  if (replacedServices) void shutdownRuntimeServices(replacedServices, replacedProxy);
  if (replacedProxy) void replacedProxy.closeNetworkDispatchers();
  clearWebSessions();
  sharedSessions.clear();
  activeProviderOAuth?.close();
  activeProviderOAuth = undefined;
  const redactor = new CredentialRedactor();
  redactor.addEnvironment(process.env);

  const applicationProxy = config?.proxy ?? new AiProxyServer({
    enableMockProvider: config?.enableMockProvider ?? true,
    redactor,
  });
  if (config?.proxy && config.proxy === replacedProxy) void applicationProxy.rotateNetworkScope();
  proxyServer = applicationProxy;
  if (config?.proxy) applicationProxy.setCredentialRedactor(redactor);
  const runtimeConfig = { ...(config ?? {}), dataDir };
  const servicesPromise = (config?.runtimeServicesFactory ?? createRuntimeServices)(applicationProxy, runtimeConfig);
  const credentialRuntime: CredentialRuntime = {
    filePath: path.join(dataDir, 'credentials.enc'),
    services: servicesPromise,
  };
  activeServices = servicesPromise;
  activeCredentialRuntime = credentialRuntime;

  const app = express();
  appInstance = app;
  type AsyncRoute = (request: Request, response: Response, next: NextFunction) => Promise<void>;
  const wrapAsync = (handler: AsyncRoute) => (
    request: Request,
    response: Response,
    next: NextFunction,
  ): void => { void handler(request, response, next).catch(next); };
  const asyncGet = (route: string, handler: AsyncRoute): void => { app.get(route, wrapAsync(handler)); };
  const asyncPost = (route: string, handler: AsyncRoute): void => { app.post(route, wrapAsync(handler)); };
  const asyncPatch = (route: string, handler: AsyncRoute): void => { app.patch(route, wrapAsync(handler)); };
  const asyncDelete = (route: string, handler: AsyncRoute): void => { app.delete(route, wrapAsync(handler)); };
  app.use((_request, response, next) => {
    if (generation !== applicationGeneration) {
      response.status(503).json({ error: 'Application runtime is no longer active.' });
      return;
    }
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    let staleTerminated = false;
    const terminateStaleResponse = (): void => {
      if (staleTerminated || response.destroyed) return;
      staleTerminated = true;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      for (const name of response.getHeaderNames()) response.removeHeader(name);
      const body = JSON.stringify({ error: 'Application runtime is no longer active.' });
      response.statusCode = 503;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Content-Length', Buffer.byteLength(body));
      originalEnd(body);
    };
    response.write = ((...args: Parameters<typeof response.write>) => {
      if (generation !== applicationGeneration) {
        terminateStaleResponse();
        return false;
      }
      return originalWrite(...args);
    }) as typeof response.write;
    response.end = ((...args: Parameters<typeof response.end>) => {
      if (generation !== applicationGeneration) {
        terminateStaleResponse();
        return response;
      }
      return originalEnd(...args);
    }) as typeof response.end;
    next();
  });

  // Validate before CORS can terminate a preflight; only then reflect the approved origin.
  app.use(originMiddleware());
  app.use(cors({ origin: true }));
  // Upload batches allow 9 MiB of decoded files; base64 JSON needs a bounded 14 MiB envelope.
  // Authentication and rate limiting run before this parser for every protected endpoint.
  const jsonBody = express.json({ limit: '14mb', strict: true });
  app.use('/api', credentialRedactionMiddleware(redactor));

  // Routes
  const routes = createProxyRoutes(applicationProxy, {
    persistApiKey: async (provider, apiKey) => {
      const credentials = credentialRuntime.service;
      if (!(credentials as (ProviderCredentialService & { hasPersistentStore?: () => boolean }) | undefined)
        ?.hasPersistentStore?.()) throw new Error('Credential storage is unavailable.');
      await credentials!.setApiKey(provider, apiKey);
    },
  });

  // Public reads still reject hostile browser origins and share the bounded IP/method limiter.
  const publicReadLimiter = rateLimit({ windowMs: 60_000, max: 240 });
  app.get('/health', originMiddleware(), publicReadLimiter, (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/share/:token', originMiddleware(), publicReadLimiter, wrapAsync(async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    if (!/^[a-f0-9]{32}$/u.test(req.params.token)) {
      res.status(404).send('Partage introuvable ou expiré.');
      return;
    }
    const share = sharedSessions.get(req.params.token);
    if (!share || share.expiresAt < Date.now()) {
      sharedSessions.delete(req.params.token);
      res.status(404).send('Partage introuvable ou expiré.');
      return;
    }
    const sm = (await servicesPromise).sessionManager;
    const session = sm.get(share.sessionId) ?? await sm.loadFromStore(share.sessionId);
    if (!session) {
      res.status(404).send('Session introuvable.');
      return;
    }
    const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]!);
    const renderedMessages: string[] = [];
    let renderedBytes = 0;
    for (const message of session.messages) {
      const rendered = `<article><strong>${escape(redactor.redact(message.role))}</strong><pre>${escape(redactor.redact(message.content))}</pre></article>`;
      const bytes = Buffer.byteLength(rendered);
      if (renderedBytes + bytes > 4 * 1024 * 1024) {
        renderedMessages.push('<p>Transcript truncated.</p>');
        break;
      }
      renderedMessages.push(rendered);
      renderedBytes += bytes;
    }
    const title = redactor.redact(session.title || 'Session');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:16px system-ui;max-width:900px;margin:auto;padding:2rem}article{border-left:3px solid #6366f1;padding:.5rem 1rem;margin:1rem 0}pre{white-space:pre-wrap}</style><h1>${escape(title)}</h1>${renderedMessages.join('')}`);
  }));

  const loginLimiter = rateLimit({ windowMs: 60_000, max: 10 });
  const authStatusLimiter = rateLimit({ windowMs: 60_000, max: 120 });
  app.get('/api/auth/status', originMiddleware(), authStatusLimiter, (req, res) => res.json(webAuthenticationStatus(req)));
  app.post('/api/auth/login', originMiddleware(), loginLimiter, jsonBody, (req, res) => {
    if (typeof req.body?.token !== 'string' || Buffer.byteLength(req.body.token) > 10_000
      || /[\u0000-\u001f\u007f-\u009f]/u.test(req.body.token)) {
      res.status(400).json({ error: 'Token invalide.' });
      return;
    }
    const session = createWebSession(req.body.token);
    if (!session) {
      res.status(401).json({ error: 'Identifiants invalides.' });
      return;
    }
    const secure = req.secure || (process.env.AI_HARNESS_TRUST_PROXY === '1'
      && req.headers['x-forwarded-proto'] === 'https');
    res.cookie(WEB_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      expires: session.expiresAt,
      path: '/',
    });
    res.json({ authenticated: true, role: session.role, expiresAt: session.expiresAt.toISOString() });
  });
  app.post('/api/auth/logout', originMiddleware(), loginLimiter, (req, res) => {
    revokeWebSession(req);
    res.clearCookie(WEB_SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json({ success: true });
  });

  app.use('/api', originMiddleware(), authenticationMiddleware(), rateLimit(), jsonBody);
  app.use('/api', async (request, _response, next) => {
    // Inventory is a passive file/trust read. It must not create or open the credential store.
    if (request.method === 'GET' && request.path === '/mcp') {
      next();
      return;
    }
    try {
      const services = await servicesPromise;
      await initializeCredentials(credentialRuntime, applicationProxy, services.agentSettings.settings);
      next();
    } catch (error) {
      next(error);
    }
  });

  asyncGet('/api/app-update', async (req, res, next) => {
    try {
      res.json(await getAppUpdateStatus(req.query.refresh === 'true'));
    } catch (error) {
      next(error);
    }
  });

  // Chat routes (streaming and non-streaming)
  app.post('/api/chat', routes.chatHandler);
  
  /** Backward-compatible alias for the same bounded SSE chat handler. */
  app.post('/api/chat/stream', routes.chatHandler);

  app.post('/api/chat/compact', routes.compactHandler);

  // Detached agent, workspace and scoped non-secret configuration routes.
  app.use('/api/agent', requireCapability('chat'), createAgentRouter(servicesPromise));
  app.use('/api/workspaces', requireCapability('workspace:read'), createWorkspaceRouter(servicesPromise, config?.fileManager));
  app.use('/api/files', requireCapability('files:read'), createFileRouter(servicesPromise));
  app.use('/api/mcp', requireCapability('workspace:read'), createMcpRouter(servicesPromise, {
    getOAuthRuntime: async () => {
      const services = await servicesPromise;
      await initializeCredentials(credentialRuntime, applicationProxy, services.agentSettings.settings);
      if (!credentialRuntime.mcpOAuth || !credentialRuntime.mcpOAuthFlows) return undefined;
      return {
        credentials: credentialRuntime.mcpOAuth,
        flows: credentialRuntime.mcpOAuthFlows,
      };
    },
  }));
  app.use('/api/terminals', requireCapability('terminal'), createTerminalRouter(servicesPromise));
  const configurationRouter = createConfigurationRouter(servicesPromise);
  app.use('/api/configuration', configurationRouter);
  app.use('/api/settings', configurationRouter); // Backward-compatible alias.
  app.use('/api/models', createModelRouter(servicesPromise));
  const providerOAuth = new ProviderOAuthService(applicationProxy, () => credentialRuntime.service);
  activeProviderOAuth = providerOAuth;
  app.use('/api/provider-registry', createProviderRegistryRouter(
    servicesPromise,
    applicationProxy,
    () => credentialRuntime.service,
    providerOAuth,
  ));
  app.use('/api/push', requireCapability('chat'), createPushRouter(servicesPromise));
  app.use('/api/plugins', createPluginRouter(servicesPromise));
  app.use('/api/skills', createSkillRouter(servicesPromise));
  app.use('/api/subagents', createSubagentRouter(servicesPromise));
  app.use('/api/tools', createToolRouter(servicesPromise));

  // Provider routes
  app.get('/api/providers', routes.providersHandler);
  app.post('/api/config', requireCapability('credentials'), routes.configHandler);

  // ===================================================================
  // Session Management Routes
  // ===================================================================

  /** GET /api/sessions - List sessions, optionally as metadata-only summaries. */
  asyncGet('/api/sessions', async (req: Request, res: Response): Promise<void> => {
    try {
      const sm = (await servicesPromise).sessionManager;
      const cwd = typeof req.query.cwd === 'string' && Buffer.byteLength(req.query.cwd) <= 4_096
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(req.query.cwd) ? req.query.cwd : undefined;
      if (req.query.cwd !== undefined && cwd === undefined) {
        res.status(400).json({ error: 'Invalid workspace filter.' });
        return;
      }
      const paginated = req.query.messageLimit !== undefined;
      const parsedMessageLimit = paginated
        ? boundedQueryInteger(req.query.messageLimit, 0, MAX_MESSAGE_PAGE_SIZE)
        : 0;
      if (parsedMessageLimit === undefined
        || (req.query.includeCommands !== undefined
          && (typeof req.query.includeCommands !== 'string'
            || !['true', 'false'].includes(req.query.includeCommands)))) {
        res.status(400).json({ error: 'Invalid session list pagination.' });
        return;
      }
      const messageLimit = parsedMessageLimit;
      const sessions: ReturnType<typeof serializeSession>[] = [];
      let responseBytes = 2;
      for (const session of sm.list()) {
        if (cwd && session.cwd !== cwd) continue;
        const serialized = paginated
          ? serializeSessionPage(session, { limit: messageLimit, includeCommands: false })
          : serializeSession(session);
        const value = paginated && messageLimit === 0
          ? { ...serialized, metadata: undefined, commands: undefined }
          : serialized;
        let encoded: string;
        try { encoded = JSON.stringify(value); }
        catch { res.status(500).json({ error: 'Failed to list sessions' }); return; }
        responseBytes += Buffer.byteLength(encoded) + 1;
        if (responseBytes > 32 * 1024 * 1024) {
          res.status(413).json({ error: 'Session list exceeds its response limit.' });
          return;
        }
        sessions.push(value);
      }
      res.json(sessions);
    } catch {
      console.error('[Server] Failed to list sessions.');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to list sessions' });
      }
    }
  });

  /** POST /api/sessions - Create a new session */
  asyncPost('/api/sessions', async (req: Request, res: Response): Promise<void> => {
    const title = optionalSessionString(req.body?.title, 500);
    if (req.body?.title !== undefined && !title) {
      res.status(400).json({ error: 'Invalid session title.' });
      return;
    }
    const requestedCwd = optionalSessionString(req.body?.cwd, 4_096, false);
    if (req.body?.cwd !== undefined && !requestedCwd) {
      res.status(400).json({ error: 'Invalid workspace path.' });
      return;
    }
    try {
      const services = await servicesPromise;
      let cwd: string | undefined;
      let workspaceId: string | undefined;
      if (requestedCwd) {
        cwd = await services.workspaceManager.resolve(requestedCwd, { kind: 'directory' });
        workspaceId = (await services.workspaceManager.describe(cwd, await services.trustManager.isTrusted(cwd))).id;
      }
      const session = await services.sessionManager.create({ title, cwd, workspaceId });
      res.status(201).json(serializeSession(session));
    } catch {
      console.error('[Server] Failed to create session.');
      if (!res.headersSent) {
        res.status(requestedCwd ? 400 : 500).json({ error: requestedCwd ? 'Invalid workspace path.' : 'Failed to create session' });
      }
    }
  });

  /** GET /api/sessions/tree - Get session tree structure */
  asyncGet('/api/sessions/tree', async (req: Request, res: Response): Promise<void> => {
    try {
      const branchId = optionalSessionString(req.query.branchId, 256);
      if (req.query.branchId !== undefined && !isValidSessionId(branchId)) {
        res.status(400).json({ error: 'Invalid branch ID.' });
        return;
      }
      const sm = (await servicesPromise).sessionManager;
      const tree = sm.getSessionTree(branchId);

      const enrichedTree = tree.map(node => {
        const session = sm.get(node.id);
        return {
          id: node.id,
          title: node.title,
          parentId: node.parentId,
          depth: node.depth,
          messageCount: session?.messages.length || 0,
        };
      });

      sendBoundedJson(res, enrichedTree);
    } catch {
      console.error('[Server] Failed to build the session tree.');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to get session tree' });
      }
    }
  });

  /** GET /api/sessions/search - Bounded title/content search with exact message anchors. */
  asyncGet('/api/sessions/search', async (req: Request, res: Response): Promise<void> => {
    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (Array.from(rawQuery).length < 2 || Buffer.byteLength(rawQuery) > 500
      || /[\u0000-\u001f\u007f-\u009f]/u.test(rawQuery)) {
      res.status(400).json({ error: 'Search must contain between 2 and 500 bounded characters' });
      return;
    }
    const query = rawQuery.toLocaleLowerCase();
    const cwd = typeof req.query.cwd === 'string' && Buffer.byteLength(req.query.cwd) <= 4_096
      && !UNSAFE_SESSION_TEXT.test(req.query.cwd) ? req.query.cwd : undefined;
    const limit = req.query.limit === undefined ? 30 : boundedQueryInteger(req.query.limit, 1, 100);
    if ((req.query.cwd !== undefined && cwd === undefined) || limit === undefined) {
      res.status(400).json({ error: 'Invalid search parameters.' });
      return;
    }
    const sm = (await servicesPromise).sessionManager;
    const results: Array<Record<string, unknown>> = [];
    let scannedBytes = 0;
    let scannedMessages = 0;
    let truncated = false;
    outer: for (const session of sm.list()) {
      if (cwd && session.cwd !== cwd) continue;
      if (session.title?.toLocaleLowerCase().includes(query)) {
        results.push({
          sessionId: session.id,
          title: session.title,
          cwd: session.cwd,
          updatedAt: session.updatedAt.toISOString(),
          excerpt: session.title,
          field: 'title',
        });
      }
      if (results.length >= limit) break;
      for (const message of session.messages) {
        scannedBytes += Buffer.byteLength(message.content);
        scannedMessages++;
        if (scannedBytes > 64 * 1024 * 1024 || scannedMessages > 100_000) {
          truncated = true;
          break outer;
        }
        const match = message.content.toLocaleLowerCase().indexOf(query);
        if (match < 0) continue;
        const start = Math.max(0, match - 80);
        results.push({
          sessionId: session.id,
          messageId: message.id,
          title: session.title,
          cwd: session.cwd,
          updatedAt: session.updatedAt.toISOString(),
          excerpt: message.content.slice(start, match + query.length + 120),
          matchStart: match - start,
          matchLength: query.length,
          field: 'content',
        });
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    res.json({ query: rawQuery, count: results.length, truncated, results });
  });

  app.use('/api/sessions/:id', (req: Request, res: Response, next: NextFunction) => {
    if (!isValidSessionId(req.params.id)) {
      res.status(400).json({ error: 'Invalid session ID.' });
      return;
    }
    next();
  });

  /** GET /api/sessions/:id/messages - Load a bounded history page by stable message cursor. */
  asyncGet('/api/sessions/:id/messages', async (req: Request, res: Response, next): Promise<void> => {
    try {
      const sm = (await servicesPromise).sessionManager;
      const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const before = optionalSessionString(req.query.before, 256);
      const around = optionalSessionString(req.query.around, 256);
      const limit = req.query.limit === undefined
        ? 100 : boundedQueryInteger(req.query.limit, 1, MAX_MESSAGE_PAGE_SIZE);
      if ((req.query.before !== undefined && !before) || (req.query.around !== undefined && !around)
        || (before && around) || limit === undefined) {
        res.status(400).json({ error: 'Invalid message pagination.' });
        return;
      }
      const serialized = serializeSessionPage(session, {
        limit,
        before,
        around,
        includeCommands: false,
      });
      sendBoundedJson(res, {
        messages: serialized.messages,
        ...serialized.messagePage,
        // Retained for clients of the first paged-route revision.
        hasMore: serialized.messagePage.hasMoreBefore,
      });
    } catch (error) {
      next(error);
    }
  });

  /** GET /api/sessions/:id/info - Aggregate non-secret session diagnostics. */
  asyncGet('/api/sessions/:id/info', async (req: Request, res: Response): Promise<void> => {
    const sm = (await servicesPromise).sessionManager;
    const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const roleCount = (role: Session['messages'][number]['role']): number => session.messages
      .filter(message => message.role === role).length;
    const blockCount = (type: string): number => session.messages.reduce((total, message) => (
      total + (message.blocks?.filter(block => block.type === type).length ?? 0)
    ), 0);
    const toolCalls = Math.max(
      blockCount('tool_call'),
      session.messages.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0),
    );
    const toolResultsInBlocks = blockCount('tool_result');
    const toolResults = toolResultsInBlocks || roleCount('tool');
    const numericValue = (...values: unknown[]): number | undefined => {
      const value = values.find(candidate => typeof candidate === 'number' && Number.isFinite(candidate));
      return typeof value === 'number' ? value : undefined;
    };
    const contextWindowTokens = numericValue(
      session.metadata?.contextWindowTokens,
      session.metadata?.contextWindow,
      session.providerConfig?.contextWindowTokens,
      session.providerConfig?.contextWindow,
    );
    const addUsage = (left: number, right: number | undefined): number => Math.min(
      Number.MAX_SAFE_INTEGER,
      left + (typeof right === 'number' && Number.isFinite(right) && right >= 0 ? right : 0),
    );
    const aggregateUsage = session.messages.reduce((total, message) => ({
      inputTokens: addUsage(total.inputTokens, message.usage?.inputTokens),
      outputTokens: addUsage(total.outputTokens, message.usage?.outputTokens),
      cacheReadTokens: addUsage(total.cacheReadTokens, message.usage?.cacheReadTokens),
      cacheWriteTokens: addUsage(total.cacheWriteTokens, message.usage?.cacheWriteTokens),
      totalTokens: addUsage(total.totalTokens, message.usage?.totalTokens),
      costUsd: addUsage(total.costUsd, message.usage?.costUsd),
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 });
    const hasMessageUsage = session.messages.some(message => message.usage !== undefined);
    const usage = (session.usage || hasMessageUsage) ? {
      inputTokens: session.usage?.inputTokens ?? aggregateUsage.inputTokens,
      outputTokens: session.usage?.outputTokens ?? aggregateUsage.outputTokens,
      cacheReadTokens: session.usage?.cacheReadTokens ?? aggregateUsage.cacheReadTokens,
      cacheWriteTokens: session.usage?.cacheWriteTokens ?? aggregateUsage.cacheWriteTokens,
      totalTokens: session.usage?.totalTokens ?? aggregateUsage.totalTokens,
      costUsd: session.usage?.costUsd ?? aggregateUsage.costUsd,
    } : undefined;
    const contextUsedTokens = usage?.totalTokens;
    const inputTokens = usage?.inputTokens ?? 0;
    const cacheReadTokens = usage?.cacheReadTokens ?? 0;
    const cacheHitRate = inputTokens > 0 ? Math.min(1, cacheReadTokens / inputTokens) : undefined;
    res.json({
      id: session.id,
      file: `${session.id}.jsonl`,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      durationMs: session.updatedAt.getTime() - session.createdAt.getTime(),
      counts: {
        user: roleCount('user'),
        assistant: roleCount('assistant'),
        tool: roleCount('tool'),
        toolCalls,
        toolResults,
        system: roleCount('system'),
        commands: session.commands?.length ?? 0,
        total: session.messages.length,
      },
      usage,
      contextWindowTokens,
      contextUsedTokens,
      contextUtilization: contextWindowTokens && contextUsedTokens !== undefined
        ? Math.min(1, contextUsedTokens / contextWindowTokens)
        : undefined,
      cacheHitRate,
      model: session.model,
      provider: session.providerConfig?.type,
    });
  });

  /** GET /api/sessions/:id/export - Download a complete transcript without client-side assembly. */
  asyncGet('/api/sessions/:id/export', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const sm = (await servicesPromise).sessionManager;
    const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (req.query.format !== undefined
      && (typeof req.query.format !== 'string' || !['json', 'markdown'].includes(req.query.format))) {
      res.status(400).json({ error: 'Invalid export format.' });
      return;
    }
    const format = req.query.format === 'markdown' ? 'markdown' : 'json';
    const maximumBytes = 64 * 1024 * 1024;
    let payload: string;
    try {
      if (format === 'json') {
        const serialized = serializeSession(session);
        const { messages, commands, ...metadata } = serialized;
        payload = JSON.stringify({
          ...redactor.redactJson(metadata),
          messages: messages.map(message => redactor.redactJson(message)),
          ...(commands ? { commands: commands.map(command => redactor.redactJson(command)) } : {}),
        }, null, 2);
      } else {
        const chunks = [redactor.redact(`# ${session.title || 'Session'}\n`)];
        let bytes = Buffer.byteLength(chunks[0]!);
        for (const message of session.messages) {
          const chunk = redactor.redact(`\n## ${message.role}\n\n${message.content}\n`);
          bytes += Buffer.byteLength(chunk);
          if (bytes > maximumBytes) {
            res.status(413).json({ error: 'Session export exceeds its size limit.' });
            return;
          }
          chunks.push(chunk);
        }
        payload = chunks.join('');
      }
    } catch {
      res.status(500).json({ error: 'Session export could not be serialized.' });
      return;
    }
    if (Buffer.byteLength(payload) > maximumBytes) {
      res.status(413).json({ error: 'Session export exceeds its size limit.' });
      return;
    }
    const safeName = redactor.redact(session.title || session.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)
      || 'session';
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format === 'json' ? 'json' : 'md'}"`);
    res.type(format === 'json' ? 'application/json' : 'text/markdown').send(payload);
  });

  /** GET /api/sessions/:id - Get a specific session */
  asyncGet('/api/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const sm = (await servicesPromise).sessionManager;
      let session: Session | null | undefined = sm.get(id);

      // Try loading from store if not in memory
      if (!session) session = await sm.loadFromStore(id);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const paginated = req.query.messageLimit !== undefined;
      const messageLimit = paginated
        ? boundedQueryInteger(req.query.messageLimit, 0, MAX_MESSAGE_PAGE_SIZE)
        : undefined;
      const includeCommands = req.query.includeCommands;
      if ((paginated && messageLimit === undefined)
        || (includeCommands !== undefined
          && (typeof includeCommands !== 'string' || !['true', 'false'].includes(includeCommands)))) {
        res.status(400).json({ error: 'Invalid session pagination.' });
        return;
      }
      sendBoundedJson(res, paginated
        ? serializeSessionPage(session, {
            limit: messageLimit,
            includeCommands: includeCommands !== 'false',
          })
        : serializeSession(session));
    } catch {
      console.error('[Server] Failed to get a session.');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to get session' });
      }
    }
  });

  /** POST /api/sessions/:id/share - Create an expiring public viewer link */
  asyncPost('/api/sessions/:id/share', async (req: Request, res: Response): Promise<void> => {
    const sm = (await servicesPromise).sessionManager;
    const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const requestedTtl = req.body?.ttlHours;
    if (requestedTtl !== undefined && (!Number.isSafeInteger(requestedTtl)
      || (requestedTtl as number) < 1 || (requestedTtl as number) > 168)) {
      res.status(400).json({ error: 'Invalid share lifetime.' });
      return;
    }
    const ttlHours = (requestedTtl as number | undefined) ?? 24;
    const now = Date.now();
    if (sharedSessions.size >= 10_000) {
      for (const [existing, share] of sharedSessions) {
        if (share.expiresAt <= now) sharedSessions.delete(existing);
      }
      while (sharedSessions.size >= 10_000) {
        const oldest = sharedSessions.keys().next().value as string | undefined;
        if (!oldest) break;
        sharedSessions.delete(oldest);
      }
    }
    const token = crypto.randomUUID().replace(/-/g, '');
    sharedSessions.set(token, { sessionId: session.id, expiresAt: now + ttlHours * 3_600_000 });
    const sharePath = `/share/${token}`;
    const origin = publicRequestOrigin(req);
    res.status(201).json({ url: origin ? `${origin}${sharePath}` : sharePath, expiresInHours: ttlHours });
  });

  /** POST /api/sessions/:id/messages - Persist a message from the Web client */
  asyncPost('/api/sessions/:id/messages', async (req: Request, res: Response): Promise<void> => {
    const sm = (await servicesPromise).sessionManager;
    const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const { role, content } = (req.body ?? {}) as { role?: 'user' | 'assistant'; content?: string };
    if (!role || !['user', 'assistant'].includes(role) || typeof content !== 'string'
      || Buffer.byteLength(content) > 1_000_000) {
      res.status(400).json({ error: 'Invalid message' });
      return;
    }
    let blocks: ReturnType<typeof userBlocks>;
    try { blocks = userBlocks(req.body?.blocks); }
    catch (error) {
      const status = (error as { status?: unknown }).status === 413 ? 413 : 400;
      res.status(status).json({ error: status === 413 ? 'Message attachments are too large.' : 'Invalid message blocks.' });
      return;
    }
    const model = optionalSessionString(req.body?.model, 500);
    const provider = optionalSessionString(req.body?.provider, 128);
    const usage = sessionUsage(req.body?.usage);
    const metadata = sessionMetadata(req.body?.metadata);
    if ((req.body?.model !== undefined && !model) || (req.body?.provider !== undefined && !provider)
      || (req.body?.usage !== undefined && !usage) || (req.body?.metadata !== undefined && !metadata)) {
      res.status(400).json({ error: 'Invalid message metadata.' });
      return;
    }
    const updated = await sm.addMessage(session.id, {
      role,
      content,
      blocks,
      model,
      provider,
      usage,
      metadata,
    });
    if (!updated) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.status(201);
    sendBoundedJson(res, {
      ...updated.messages.at(-1),
      timestamp: updated.messages.at(-1)?.timestamp.toISOString(),
    });
  });

  /** PATCH /api/sessions/:id - Rename a session */
  asyncPatch('/api/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    const services = await servicesPromise;
    const sm = services.sessionManager;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown> : {};
    const run = services.agentRuntime.getSessionRun(req.params.id);
    if (body.activeLeafId !== undefined && run
      && (!['completed', 'failed', 'stopped'].includes(run.phase) || !run.completedAt)) {
      res.status(409).json({ error: 'Stop the agent before switching its active branch.', code: 'SESSION_BUSY' });
      return;
    }
    const changes: Parameters<SessionManager['update']>[1] = {};
    if ('title' in body) {
      const title = optionalSessionString(body.title, 500);
      if (!title) {
        res.status(400).json({ error: 'Title is required' });
        return;
      }
      changes.title = title;
    }
    if (body.model === null) changes.model = null;
    else if (body.model !== undefined) {
      const model = optionalSessionString(body.model, 500);
      if (!model) { res.status(400).json({ error: 'Invalid model.' }); return; }
      changes.model = model;
    }
    if (body.thinking === null) changes.thinking = null;
    else if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.thinking as string)) {
      changes.thinking = body.thinking as NonNullable<typeof changes.thinking>;
    } else if (body.thinking !== undefined) { res.status(400).json({ error: 'Invalid thinking level.' }); return; }
    if (body.toolPreset === null) changes.toolPreset = null;
    else if (['configured', 'chat-only', 'read-only', 'default', 'full'].includes(body.toolPreset as string)) {
      changes.toolPreset = body.toolPreset as NonNullable<typeof changes.toolPreset>;
    } else if (body.toolPreset !== undefined) { res.status(400).json({ error: 'Invalid tool preset.' }); return; }
    if (body.autoCompaction === null || typeof body.autoCompaction === 'boolean') {
      changes.autoCompaction = body.autoCompaction;
    } else if (body.autoCompaction !== undefined) { res.status(400).json({ error: 'Invalid compaction preference.' }); return; }
    if (body.activeLeafId !== undefined) {
      const activeLeafId = optionalSessionString(body.activeLeafId, 256);
      if (!activeLeafId) { res.status(400).json({ error: 'Invalid active message.' }); return; }
      changes.activeLeafId = activeLeafId;
    }
    if (Object.keys(changes).length === 0) {
      res.status(400).json({ error: 'No supported session field provided' });
      return;
    }
    const updated = await sm.update(req.params.id, changes);
    if (!updated) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    sendBoundedJson(res, serializeSessionPage(updated, { limit: 80 }));
  });

  /** POST /api/sessions/:id/auto-name - Generate a concise title with the selected provider. */
  asyncPost('/api/sessions/:id/auto-name', async (req: Request, res: Response): Promise<void> => {
    try {
      const services = await servicesPromise;
      const session = services.sessionManager.get(req.params.id)
        ?? await services.sessionManager.loadFromStore(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const messages = services.redactJson(session.messages.flatMap(message => {
        if (message.role !== 'user' && message.role !== 'assistant') return [];
        return [{
          id: `title:${message.id}`,
          role: message.role,
          content: message.content.slice(0, 4_000),
          timestamp: message.timestamp,
        }];
      }).slice(0, 8));
      if (!messages.some(message => message.role === 'user')) {
        res.status(409).json({ error: 'A user message is required before generating a title.' });
        return;
      }
      const requestedProvider = req.body?.provider;
      if (requestedProvider !== undefined && (typeof requestedProvider !== 'string'
        || !/^[A-Za-z0-9._-]{1,80}$/u.test(requestedProvider))) {
        res.status(400).json({ error: 'Invalid provider.' });
        return;
      }
      const providerName = requestedProvider ?? String(session.providerConfig?.type ?? 'mock');
      const provider = services.resolveProvider(providerName);
      if (!provider) {
        res.status(400).json({ error: 'Provider unavailable.' });
        return;
      }
      const requestedModel = optionalSessionString(req.body?.model, 500);
      if (req.body?.model !== undefined && !requestedModel) {
        res.status(400).json({ error: 'Invalid model.' });
        return;
      }
      const rawModel = requestedModel ?? session.model;
      const model = rawModel ? services.redactText(rawModel) : undefined;
      const providerController = new AbortController();
      const abortDisconnectedRequest = () => {
        if (!res.writableEnded) providerController.abort();
      };
      const timeout = setTimeout(() => providerController.abort(), 60_000);
      res.once('close', abortDisconnectedRequest);
      let generated: Awaited<ReturnType<typeof provider.chat>>;
      try {
        generated = await provider.chat(messages, {
          model,
          sessionId: session.id,
          maxTokens: 48,
          temperature: 0.2,
          signal: providerController.signal,
          systemPrompt: 'Create a concise 3-10 word title for this software-assistant conversation. Reply with plain text only, in the user language, without quotes or Markdown.',
        });
      } finally {
        clearTimeout(timeout);
        res.off('close', abortDisconnectedRequest);
      }
      generated = services.redactJson(generated);
      if (generated.usage) services.recordUsage(providerName, generated.model ?? model, generated.usage);
      const generatedTitle = normalizeGeneratedTitle(generated.content);
      const title = generatedTitle ? services.redactText(generatedTitle) : undefined;
      if (!title) {
        res.status(502).json({ error: 'Provider returned an empty title.' });
        return;
      }
      const updated = await services.sessionManager.update(session.id, { title });
      if (!updated) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json({ id: updated.id, title: updated.title, updatedAt: updated.updatedAt.toISOString() });
    } catch {
      console.error('[Server] Failed to generate a session title.');
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Failed to generate session title.' });
    }
  });

  /** DELETE /api/sessions/:id - Delete a session */
  asyncDelete('/api/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const sm = (await servicesPromise).sessionManager;
      const sessions = sm.list();
      const descendantIds = new Set<string>([id]);
      let discovered = true;
      while (discovered) {
        discovered = false;
        for (const session of sessions) {
          if (session.parentId && descendantIds.has(session.parentId) && !descendantIds.has(session.id)) {
            descendantIds.add(session.id);
            discovered = true;
          }
        }
      }
      const descendants = sessions.filter(session => session.id !== id && descendantIds.has(session.id));
      if (descendants.length > 0 && req.query.cascade !== 'true') {
        res.status(409);
        sendBoundedJson(res, {
          error: 'Cette session possède des branches. Confirmez la suppression en cascade.',
          code: 'CASCADE_CONFIRMATION_REQUIRED',
          descendants: descendants.slice(0, 1_000).map(session => ({ id: session.id, title: session.title })),
          descendantsTruncated: descendants.length > 1_000,
        });
        return;
      }
      const deletedCount = descendants.length > 0
        ? await sm.deleteWithForks(id)
        : Number(await sm.delete(id));
      if (deletedCount === 0) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json({ success: true, deletedCount });
    } catch {
      console.error('[Server] Failed to delete a session.');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to delete session' });
      }
    }
  });

  /** POST /api/sessions/:id/fork - Fork a session */
  asyncPost('/api/sessions/:id/fork', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { messageIndex, messageId, before, title: rawTitle } = (req.body ?? {}) as {
        messageIndex?: number; messageId?: string; before?: boolean; title?: string;
      };
      if (before !== undefined && (typeof before !== 'boolean' || typeof messageId !== 'string' || messageIndex !== undefined)) {
        res.status(400).json({ error: 'Invalid fork position.' });
        return;
      }
      const title = optionalSessionString(rawTitle, 500);
      if ((rawTitle !== undefined && !title) || (messageId !== undefined
        && (typeof messageId !== 'string' || Buffer.byteLength(messageId) > 256 || UNSAFE_SESSION_TEXT.test(messageId)))) {
        res.status(400).json({ error: 'Invalid fork request.' });
        return;
      }

      const sm = (await servicesPromise).sessionManager;
      let session: Session | null | undefined = sm.get(id);

      // Try loading from store if not in memory
      if (!session) session = await sm.loadFromStore(id);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const resolvedMessageIndex = typeof messageId === 'string'
        ? session.messages.findIndex(message => message.id === messageId)
        : messageIndex;
      if (typeof messageId === 'string' && resolvedMessageIndex === -1) {
        res.status(404).json({ error: 'Message target not found', code: 'MESSAGE_TARGET_NOT_FOUND' });
        return;
      }
      if (resolvedMessageIndex !== undefined
        && (!Number.isSafeInteger(resolvedMessageIndex) || resolvedMessageIndex < 0 || resolvedMessageIndex >= session.messages.length)) {
        res.status(400).json({ error: 'Invalid message target' });
        return;
      }
      const run = (await servicesPromise).agentRuntime.getSessionRun(id);
      if (resolvedMessageIndex === undefined && run
        && (!['completed', 'failed', 'stopped'].includes(run.phase) || !run.completedAt)) {
        res.status(409).json({ error: 'An active source requires a persisted message target.', code: 'SESSION_BUSY' });
        return;
      }
      const cutoff = resolvedMessageIndex === undefined ? undefined : session.messages[resolvedMessageIndex]?.timestamp;
      if (session.commands?.some(command => command.status === 'running'
        && (!cutoff || command.timestamp <= cutoff))) {
        res.status(409).json({ error: 'A running command cannot be copied.', code: 'RUNNING_COMMAND_SOURCE' });
        return;
      }
      if (before && session.messages[resolvedMessageIndex!]?.role !== 'user') {
        res.status(400).json({ error: 'Only a persisted user message can be edited.' });
        return;
      }
      const forked = before && messageId
        ? await sm.forkSessionAtEntry(id, messageId, title, { before: true })
        : await sm.forkSession(id, messageId ?? resolvedMessageIndex, title);

      if (!forked) {
        res.status(409).json({ error: 'The source message changed before copying.', code: 'MESSAGE_TARGET_CHANGED' });
        return;
      }

      res.status(201);
      sendBoundedJson(res, serializeSessionPage(forked, { limit: 80 }));
    } catch {
      console.error('[Server] Failed to fork a session.');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to fork session' });
      }
    }
  });

  /** POST /api/sessions/:id/clone - Clone a session */
  asyncPost('/api/sessions/:id/clone', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { title: rawTitle, messageIndex, messageId } = (req.body ?? {}) as {
        title?: string; messageIndex?: number; messageId?: string;
      };
      const title = optionalSessionString(rawTitle, 500);
      if ((rawTitle !== undefined && !title) || (messageId !== undefined
        && (typeof messageId !== 'string' || Buffer.byteLength(messageId) > 256 || UNSAFE_SESSION_TEXT.test(messageId)))) {
        res.status(400).json({ error: 'Invalid clone request.' });
        return;
      }

      const sm = (await servicesPromise).sessionManager;
      let session: Session | null | undefined = sm.get(id);

      // Try loading from store if not in memory
      if (!session) session = await sm.loadFromStore(id);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const resolvedMessageIndex = typeof messageId === 'string'
        ? session.messages.findIndex(message => message.id === messageId)
        : messageIndex;
      if (typeof messageId === 'string' && resolvedMessageIndex === -1) {
        res.status(404).json({ error: 'Message target not found', code: 'MESSAGE_TARGET_NOT_FOUND' });
        return;
      }
      if (resolvedMessageIndex !== undefined
        && (!Number.isSafeInteger(resolvedMessageIndex) || resolvedMessageIndex < 0 || resolvedMessageIndex >= session.messages.length)) {
        res.status(400).json({ error: 'Invalid message target' });
        return;
      }
      const run = (await servicesPromise).agentRuntime.getSessionRun(id);
      if (resolvedMessageIndex === undefined && run
        && (!['completed', 'failed', 'stopped'].includes(run.phase) || !run.completedAt)) {
        res.status(409).json({ error: 'An active source requires a persisted message target.', code: 'SESSION_BUSY' });
        return;
      }
      const cutoff = resolvedMessageIndex === undefined ? undefined : session.messages[resolvedMessageIndex]?.timestamp;
      if (session.commands?.some(command => command.status === 'running'
        && (!cutoff || command.timestamp <= cutoff))) {
        res.status(409).json({ error: 'A running command cannot be copied.', code: 'RUNNING_COMMAND_SOURCE' });
        return;
      }
      const cloned = await sm.cloneSession(id, title, messageId ?? resolvedMessageIndex);

      if (!cloned) {
        res.status(409).json({ error: 'The source message changed before copying.', code: 'MESSAGE_TARGET_CHANGED' });
        return;
      }

      res.status(201);
      sendBoundedJson(res, serializeSessionPage(cloned, { limit: 80 }));
    } catch {
      console.error('[Server] Failed to clone a session.');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to clone session' });
      }
    }
  });

  // Normalize errors from modular routes without leaking stack traces or secrets.
  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    safeErrorHandler(error, request, response, next, redactor);
  });

  if (webRoot && webIndexFile) {
    app.use(express.static(webRoot));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(webIndexFile);
    });
  }

  console.log(redactor.redact(`[Server] AiHarness server running on http://${host}:${port}`));
  console.log(redactor.redact(`[Server] Providers: ${applicationProxy.getProviders().map(p => `${p.type}=${p.configured ? '✓' : '✗'}`).join(', ')}`));

  return app;
}

/** Start the Express server */
export async function start(config?: ServerConfig): Promise<{ port: number; host: string; app: express.Application }> {
  let port: number;
  let host: string;
  try { ({ port, host } = serverAddress(config)); }
  catch { return Promise.reject(new Error('Invalid server address.')); }
  const loopback = isLoopbackBindHost(host);
  if (!loopback
    && !process.env.AI_HARNESS_AUTH_TOKEN
    && !process.env.AI_HARNESS_ADMIN_TOKEN
    && process.env.AI_HARNESS_ALLOW_INSECURE_REMOTE !== '1') {
    return Promise.reject(new Error(
      'Une authentification est obligatoire pour écouter hors loopback. '
      + 'Configurez AI_HARNESS_AUTH_TOKEN.',
    ));
  }

  if (!appInstance) {
    createApp(config);
  }

  // start() publishes a usable composition, not merely a bound socket.
  const startingGeneration = applicationGeneration;
  await activeServices;
  if (startingGeneration !== applicationGeneration) {
    throw new Error('Application runtime is no longer active.');
  }

  return new Promise((resolve, reject) => {
    const server = createServer(appInstance!);
    const serverGeneration = applicationGeneration;
    const serverProxy = getProxy();
    httpServer = server;
    server.on('upgrade', (request, socket, head) => {
      if (serverGeneration !== applicationGeneration) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      handleWebSocketUpgrade(request, socket, serverProxy, head);
    });
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo | string | null;
      resolve({ port: typeof address === 'object' && address ? address.port : port, host, app: appInstance! });
    });
    server.on('error', reject);
  });
}

/** Stop the Express server */
export async function stop(): Promise<void> {
  applicationGeneration++;
  appInstance = null;
  closeServerWebSockets();
  activeProviderOAuth?.close();
  activeProviderOAuth = undefined;
  const services = activeServices;
  const closingProxy = proxyServer;
  const server = httpServer;
  activeServices = undefined;
  httpServer = null;
  proxyServer = null;
  const closingCredentials = activeCredentialRuntime;
  if (closingCredentials) closingCredentials.closed = true;
  activeCredentialRuntime = undefined;
  const cleanup = Promise.allSettled([
    shutdownRuntimeServices(services, closingProxy),
    closingCredentials?.mcpOAuthFlows?.shutdown(),
    closingProxy?.closeNetworkDispatchers(),
  ]);
  if (!server) {
    await cleanup;
    return;
  }
  const closeServer = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      clearTimeout(bound);
      if (error) reject(error);
      else resolve();
    };
    const force = setTimeout(() => {
      try { server.closeAllConnections(); } catch { finish(); }
    }, 5_000);
    const bound = setTimeout(() => finish(), 10_000);
    server.close(error => finish(error ?? undefined));
  });
  const [, serverResult] = await Promise.all([cleanup, closeServer.then(
    () => ({ error: undefined as Error | undefined }),
    error => ({ error: error instanceof Error ? error : new Error('Server shutdown failed.') }),
  )]);
  if (serverResult.error) throw serverResult.error;
}

// ===================================================================
// CLI Entry Point - Run server directly
// ===================================================================

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config: ServerConfig = {};

  // Parse command line args
  for (let i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
      case '--port': {
        const value = process.argv[++i];
        config.port = value && /^(?:0|[1-9]\d{0,4})$/u.test(value) ? Number(value) : Number.NaN;
        break;
      }
      case '--host':
        config.host = process.argv[++i] ?? '';
        break;
    }
  }

  start(config)
    .then(({ port }) => {
      console.log(getProxy().redactText(`[Server] Listening on http://127.0.0.1:${port}`));
    })
    .catch(() => {
      console.error('[Server] Failed to start.');
      process.exit(1);
    });
}
