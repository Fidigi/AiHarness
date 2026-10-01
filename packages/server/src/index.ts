// ============================================================
// AiHarness Server - AI API Proxy with SSE Streaming + Session Management
// Express server that proxies requests to OpenAI/Anthropic APIs
// and manages sessions via JSONL persistence
// ============================================================

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AiProxyServer, createProxyRoutes, writeSSEStream } from './api/proxy.js';
import { serializeSession } from '@ai-harness/core';
import type { Session, SessionManager } from '@ai-harness/core';
import { EncryptedCredentialStore } from './security/credential-store.js';
import { handleWebSocketUpgrade } from './api/websocket.js';
import { createAgentRouter } from './api/agent-routes.js';
import { createWorkspaceRouter } from './api/workspace-routes.js';
import { createFileRouter } from './api/file-routes.js';
import { createConfigurationRouter } from './api/config-routes.js';
import { createModelRouter } from './api/model-routes.js';
import { createPluginRouter } from './api/plugin-routes.js';
import { createProviderRegistryRouter } from './api/provider-registry-routes.js';
import { createPushRouter } from './api/push-routes.js';
import { createSkillRouter } from './api/skill-routes.js';
import { createSubagentRouter } from './api/subagent-routes.js';
import { createToolRouter } from './api/tool-routes.js';
import { createTerminalRouter } from './api/terminal-routes.js';
import {
  boundedMessageLimit,
  serializeSessionPage,
} from './api/session-pagination.js';
import {
  authenticationMiddleware,
  createWebSession,
  originMiddleware,
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
}

const DEFAULT_PORT = 3099;
const DEFAULT_HOST = '127.0.0.1';

let proxyServer: AiProxyServer | null = null;
let appInstance: express.Application | null = null;
let httpServer: Server | null = null;
let activeServices: Promise<RuntimeServices> | undefined;
let credentialsFile = path.join(os.homedir(), '.ai-harness', 'credentials.enc');
let credentialStore: EncryptedCredentialStore | undefined;
let credentialsInitialized: Promise<void> | undefined;
const sharedSessions = new Map<string, { sessionId: string; expiresAt: number }>();

function initializeCredentials(proxy: AiProxyServer): Promise<void> {
  if (credentialsInitialized) return credentialsInitialized;
  credentialsInitialized = (async () => {
    const masterKey = process.env.AI_HARNESS_MASTER_KEY;
    if (!masterKey) return;
    credentialStore = new EncryptedCredentialStore(credentialsFile, masterKey);
    await credentialStore.load();
    for (const type of ['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local'] as const) {
      const apiKey = credentialStore.get(type);
      if (apiKey) proxy.setApiKey(type, apiKey);
    }
  })();
  return credentialsInitialized;
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

/** Create Express app with all routes configured */
export function createApp(config?: ServerConfig): express.Application {
  const port = config?.port ?? DEFAULT_PORT;
  const host = config?.host ?? DEFAULT_HOST;

  if (config?.proxy) proxyServer = config.proxy;
  if (!proxyServer) {
    proxyServer = new AiProxyServer({ enableMockProvider: config?.enableMockProvider ?? true });
  }
  const dataDir = config?.dataDir ?? process.env.AI_HARNESS_DATA_DIR
    ?? path.join(os.homedir(), '.ai-harness');
  credentialsFile = path.join(dataDir, 'credentials.enc');
  credentialsInitialized = undefined;
  credentialStore = undefined;
  const servicesPromise = createRuntimeServices(proxyServer, config);
  activeServices = servicesPromise;

  const app = express();
  appInstance = app;

  // Middleware. Browser calls are same-origin by default; explicit origins opt into CORS.
  const corsOrigins = process.env.AI_HARNESS_ALLOWED_ORIGINS
    ?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  app.use(cors({ origin: corsOrigins.length ? corsOrigins : false }));
  // Upload batches allow 9 MiB of decoded files; base64 JSON needs a bounded 14 MiB envelope.
  app.use(express.json({ limit: '14mb', strict: true }));

  // Routes
  const routes = createProxyRoutes(proxyServer);

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/share/:token', async (req: Request, res: Response): Promise<void> => {
    const share = sharedSessions.get(req.params.token);
    if (!share || share.expiresAt < Date.now()) {
      sharedSessions.delete(req.params.token);
      res.status(404).send('Partage introuvable ou expiré.');
      return;
    }
    const sm = await getSessionManager();
    const session = sm.get(share.sessionId) ?? await sm.loadFromStore(share.sessionId);
    if (!session) {
      res.status(404).send('Session introuvable.');
      return;
    }
    const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]!);
    const messages = session.messages.map(message =>
      `<article><strong>${escape(message.role)}</strong><pre>${escape(message.content)}</pre></article>`,
    ).join('');
    res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>${escape(session.title || 'Session')}</title><style>body{font:16px system-ui;max-width:900px;margin:auto;padding:2rem}article{border-left:3px solid #6366f1;padding:.5rem 1rem;margin:1rem 0}pre{white-space:pre-wrap}</style><h1>${escape(session.title || 'Session')}</h1>${messages}`);
  });

  app.use('/api', async (_request, _response, next) => {
    try {
      await initializeCredentials(proxyServer!);
      next();
    } catch (error) {
      next(error);
    }
  });
  const loginLimiter = rateLimit({ windowMs: 60_000, max: 10 });
  app.get('/api/auth/status', loginLimiter, (req, res) => res.json(webAuthenticationStatus(req)));
  app.post('/api/auth/login', originMiddleware(), loginLimiter, (req, res) => {
    if (typeof req.body?.token !== 'string' || req.body.token.length > 10_000) {
      res.status(400).json({ error: 'Token invalide.' });
      return;
    }
    const session = createWebSession(req.body.token);
    if (!session) {
      res.status(401).json({ error: 'Identifiants invalides.' });
      return;
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
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

  app.use('/api', originMiddleware(), authenticationMiddleware(), rateLimit());

  app.get('/api/app-update', async (req, res, next) => {
    try {
      res.json(await getAppUpdateStatus(req.query.refresh === 'true'));
    } catch (error) {
      next(error);
    }
  });

  // Chat routes (streaming and non-streaming)
  app.post('/api/chat', routes.chatHandler);
  
  /** POST /api/chat/stream - Streaming chat endpoint */
  app.post('/api/chat/stream', async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider, messages, options } = req.body as {
        provider: string;
        messages: Array<{ role: string; content: string }>;
        options?: Record<string, unknown>;
      };

      if (!provider || !messages) {
        res.status(400).json({ error: 'Missing required fields: provider, messages' });
        return;
      }

      const proxy = getProxy();
      const result = await proxy.sendChatSSE(provider, messages as any[], options);

      if (result.error) {
        res.status(400).json({ error: result.error.message });
        return;
      }

      // Set SSE headers and pipe stream
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      await writeSSEStream(result.stream, res);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Chat stream handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.post('/api/chat/compact', routes.compactHandler);

  // Detached agent, workspace and scoped non-secret configuration routes.
  app.use('/api/agent', requireCapability('chat'), createAgentRouter(servicesPromise));
  app.use('/api/workspaces', requireCapability('workspace:read'), createWorkspaceRouter(servicesPromise));
  app.use('/api/files', requireCapability('files:read'), createFileRouter(servicesPromise));
  app.use('/api/terminals', requireCapability('terminal'), createTerminalRouter(servicesPromise));
  const configurationRouter = createConfigurationRouter(servicesPromise);
  app.use('/api/configuration', configurationRouter);
  app.use('/api/settings', configurationRouter); // Backward-compatible alias.
  app.use('/api/models', createModelRouter(servicesPromise));
  app.use('/api/provider-registry', createProviderRegistryRouter(servicesPromise, proxyServer, () => credentialStore));
  app.use('/api/push', requireCapability('chat'), createPushRouter(servicesPromise));
  app.use('/api/plugins', createPluginRouter(servicesPromise));
  app.use('/api/skills', createSkillRouter(servicesPromise));
  app.use('/api/subagents', createSubagentRouter(servicesPromise));
  app.use('/api/tools', createToolRouter(servicesPromise));

  // Provider routes
  app.get('/api/providers', routes.providersHandler);
  app.post('/api/config', requireCapability('credentials'), async (req: Request, res: Response): Promise<void> => {
    await routes.configHandler(req, res);
    if (res.statusCode < 400 && credentialStore && typeof req.body?.type === 'string' && typeof req.body?.apiKey === 'string') {
      await credentialStore.set(req.body.type, req.body.apiKey);
    }
  });

  // ===================================================================
  // Session Management Routes
  // ===================================================================

  /** GET /api/sessions - List sessions, optionally as metadata-only summaries. */
  app.get('/api/sessions', async (req: Request, res: Response): Promise<void> => {
    try {
      const sm = (await servicesPromise).sessionManager;
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
      const paginated = req.query.messageLimit !== undefined;
      const messageLimit = boundedMessageLimit(req.query.messageLimit, 0, true);
      const sessions = sm.list()
        .filter(session => !cwd || session.cwd === cwd)
        .map(session => paginated
          ? serializeSessionPage(session, { limit: messageLimit, includeCommands: false })
          : serializeSession(session));
      res.json(sessions);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] List sessions error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to list sessions' });
      }
    }
  });

  /** POST /api/sessions - Create a new session */
  app.post('/api/sessions', async (req: Request, res: Response): Promise<void> => {
    try {
      const { title } = req.body as { title?: string };
      const services = await servicesPromise;
      let cwd: string | undefined;
      let workspaceId: string | undefined;
      if (typeof req.body?.cwd === 'string') {
        cwd = await services.workspaceManager.resolve(req.body.cwd, { kind: 'directory' });
        workspaceId = (await services.workspaceManager.describe(cwd, await services.trustManager.isTrusted(cwd))).id;
      }
      const session = await services.sessionManager.create({ title, cwd, workspaceId });
      res.status(201).json(serializeSession(session));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Create session error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create session' });
      }
    }
  });

  /** GET /api/sessions/tree - Get session tree structure */
  app.get('/api/sessions/tree', async (req: Request, res: Response): Promise<void> => {
    try {
      const { branchId } = req.query as { branchId?: string };
      const sm = await getSessionManager();
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

      res.json(enrichedTree);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Session tree error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to get session tree' });
      }
    }
  });

  /** GET /api/sessions/search - Bounded title/content search with exact message anchors. */
  app.get('/api/sessions/search', async (req: Request, res: Response): Promise<void> => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().toLocaleLowerCase() : '';
    if (query.length < 2 || query.length > 500) {
      res.status(400).json({ error: 'Search must contain between 2 and 500 characters' });
      return;
    }
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    const sm = await getSessionManager();
    await sm.loadAllSessions();
    const results: Array<Record<string, unknown>> = [];
    for (const session of sm.list()) {
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
      for (const message of session.messages) {
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
    res.json({ query: req.query.q, count: results.length, results });
  });

  /** GET /api/sessions/:id/messages - Load a bounded history page by stable message cursor. */
  app.get('/api/sessions/:id/messages', async (req: Request, res: Response, next): Promise<void> => {
    try {
      const sm = await getSessionManager();
      const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const serialized = serializeSessionPage(session, {
        limit: boundedMessageLimit(req.query.limit, 100),
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
        around: typeof req.query.around === 'string' ? req.query.around : undefined,
        includeCommands: false,
      });
      res.json({
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
  app.get('/api/sessions/:id/info', async (req: Request, res: Response): Promise<void> => {
    const sm = await getSessionManager();
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
    const aggregateUsage = session.messages.reduce((total, message) => ({
      inputTokens: total.inputTokens + (message.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (message.usage?.outputTokens ?? 0),
      cacheReadTokens: total.cacheReadTokens + (message.usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: total.cacheWriteTokens + (message.usage?.cacheWriteTokens ?? 0),
      totalTokens: total.totalTokens + (message.usage?.totalTokens ?? 0),
      costUsd: total.costUsd + (message.usage?.costUsd ?? 0),
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
  app.get('/api/sessions/:id/export', async (req: Request, res: Response): Promise<void> => {
    const sm = await getSessionManager();
    const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const format = req.query.format === 'markdown' ? 'markdown' : 'json';
    const safeName = (session.title || session.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format === 'json' ? 'json' : 'md'}"`);
    if (format === 'json') {
      res.type('application/json').send(JSON.stringify(serializeSession(session), null, 2));
    } else {
      const transcript = session.messages.map(message => `## ${message.role}\n\n${message.content}`).join('\n\n');
      res.type('text/markdown').send(`# ${session.title || 'Session'}\n\n${transcript}\n`);
    }
  });

  /** GET /api/sessions/:id - Get a specific session */
  app.get('/api/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const sm = await getSessionManager();
      let session: Session | null | undefined = sm.get(id);

      // Try loading from store if not in memory
      if (!session) session = await sm.loadFromStore(id);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const paginated = req.query.messageLimit !== undefined;
      res.json(paginated
        ? serializeSessionPage(session, {
            limit: boundedMessageLimit(req.query.messageLimit, 80, true),
            includeCommands: req.query.includeCommands !== 'false',
          })
        : serializeSession(session));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Get session error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to get session' });
      }
    }
  });

  /** POST /api/sessions/:id/share - Create an expiring public viewer link */
  app.post('/api/sessions/:id/share', async (req: Request, res: Response): Promise<void> => {
    const sm = await getSessionManager();
    const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const token = crypto.randomUUID().replace(/-/g, '');
    const ttlHours = Math.max(1, Math.min(168, Number(req.body?.ttlHours) || 24));
    sharedSessions.set(token, { sessionId: session.id, expiresAt: Date.now() + ttlHours * 3_600_000 });
    const origin = process.env.AI_HARNESS_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({ url: `${origin}/share/${token}`, expiresInHours: ttlHours });
  });

  /** POST /api/sessions/:id/messages - Persist a message from the Web client */
  app.post('/api/sessions/:id/messages', async (req: Request, res: Response): Promise<void> => {
    const sm = await getSessionManager();
    const session = sm.get(req.params.id) ?? await sm.loadFromStore(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const { role, content } = req.body as { role?: 'user' | 'assistant'; content?: string };
    if (!role || !['user', 'assistant'].includes(role) || typeof content !== 'string' || content.length > 1_000_000) {
      res.status(400).json({ error: 'Invalid message' });
      return;
    }
    const updated = await sm.addMessage(session.id, {
      role,
      content,
      blocks: Array.isArray(req.body?.blocks) ? req.body.blocks : undefined,
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      provider: typeof req.body?.provider === 'string' ? req.body.provider : undefined,
      usage: req.body?.usage && typeof req.body.usage === 'object' ? req.body.usage : undefined,
      metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : undefined,
    });
    res.status(201).json(updated ? {
      ...updated.messages.at(-1),
      timestamp: updated.messages.at(-1)?.timestamp.toISOString(),
    } : null);
  });

  /** PATCH /api/sessions/:id - Rename a session */
  app.patch('/api/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    const sm = await getSessionManager();
    const changes: Parameters<SessionManager['update']>[1] = {};
    if ('title' in (req.body ?? {})) {
      const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
      if (!title || title.length > 500) {
        res.status(400).json({ error: 'Title is required' });
        return;
      }
      changes.title = title;
    }
    if (req.body?.model === null) changes.model = null;
    else if (typeof req.body?.model === 'string' && req.body.model.trim()) changes.model = req.body.model.trim().slice(0, 500);
    if (req.body?.thinking === null) changes.thinking = null;
    else if (['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(req.body?.thinking)) changes.thinking = req.body.thinking;
    if (req.body?.toolPreset === null) changes.toolPreset = null;
    else if (['configured', 'chat-only', 'read-only', 'default', 'full'].includes(req.body?.toolPreset)) {
      changes.toolPreset = req.body.toolPreset;
    }
    if (req.body?.autoCompaction === null || typeof req.body?.autoCompaction === 'boolean') {
      changes.autoCompaction = req.body.autoCompaction;
    }
    if (typeof req.body?.activeLeafId === 'string') changes.activeLeafId = req.body.activeLeafId;
    if (Object.keys(changes).length === 0) {
      res.status(400).json({ error: 'No supported session field provided' });
      return;
    }
    const updated = await sm.update(req.params.id, changes);
    if (!updated) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(serializeSessionPage(updated, { limit: 80 }));
  });

  /** POST /api/sessions/:id/auto-name - Generate a concise title with the selected provider. */
  app.post('/api/sessions/:id/auto-name', async (req: Request, res: Response): Promise<void> => {
    try {
      const services = await servicesPromise;
      const session = services.sessionManager.get(req.params.id)
        ?? await services.sessionManager.loadFromStore(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const messages = session.messages.flatMap(message => {
        if (message.role !== 'user' && message.role !== 'assistant') return [];
        return [{
          id: `title:${message.id}`,
          role: message.role,
          content: message.content.slice(0, 4_000),
          timestamp: message.timestamp,
        }];
      }).slice(0, 8);
      if (!messages.some(message => message.role === 'user')) {
        res.status(409).json({ error: 'A user message is required before generating a title.' });
        return;
      }
      const providerName = typeof req.body?.provider === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(req.body.provider)
        ? req.body.provider
        : String(session.providerConfig?.type ?? 'mock');
      const provider = services.resolveProvider(providerName);
      if (!provider) {
        res.status(400).json({ error: 'Provider unavailable.' });
        return;
      }
      const model = typeof req.body?.model === 'string' && req.body.model.length <= 500
        ? req.body.model
        : session.model;
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
          maxTokens: 48,
          temperature: 0.2,
          signal: providerController.signal,
          systemPrompt: 'Create a concise 3-10 word title for this software-assistant conversation. Reply with plain text only, in the user language, without quotes or Markdown.',
        });
      } finally {
        clearTimeout(timeout);
        res.off('close', abortDisconnectedRequest);
      }
      if (generated.usage) services.recordUsage(providerName, generated.model ?? model, generated.usage);
      const title = normalizeGeneratedTitle(generated.content);
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
    } catch (error) {
      console.error('[Server] Session auto-name error:', error instanceof Error ? error.message : error);
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Failed to generate session title.' });
    }
  });

  /** DELETE /api/sessions/:id - Delete a session */
  app.delete('/api/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const sm = await getSessionManager();
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
        res.status(409).json({
          error: 'Cette session possède des branches. Confirmez la suppression en cascade.',
          code: 'CASCADE_CONFIRMATION_REQUIRED',
          descendants: descendants.map(session => ({ id: session.id, title: session.title })),
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
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Delete session error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to delete session' });
      }
    }
  });

  /** POST /api/sessions/:id/fork - Fork a session */
  app.post('/api/sessions/:id/fork', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { messageIndex, messageId, title } = req.body as { messageIndex?: number; messageId?: string; title?: string };

      const sm = await getSessionManager();
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
      const forked = await sm.forkSession(id, resolvedMessageIndex, title);

      if (!forked) {
        res.status(500).json({ error: 'Fork failed' });
        return;
      }

      res.status(201).json(serializeSessionPage(forked, { limit: 80 }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Fork session error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to fork session' });
      }
    }
  });

  /** POST /api/sessions/:id/clone - Clone a session */
  app.post('/api/sessions/:id/clone', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { title, messageIndex, messageId } = req.body as { title?: string; messageIndex?: number; messageId?: string };

      const sm = await getSessionManager();
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
      const cloned = await sm.cloneSession(id, title, resolvedMessageIndex);

      if (!cloned) {
        res.status(500).json({ error: 'Clone failed' });
        return;
      }

      res.status(201).json(serializeSessionPage(cloned, { limit: 80 }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Clone session error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to clone session' });
      }
    }
  });

  // Normalize errors from modular routes without leaking stack traces or secrets.
  app.use(safeErrorHandler);

  if (config?.webRoot) {
    const webRoot = path.resolve(config.webRoot);
    const indexFile = path.join(webRoot, 'index.html');
    if (!existsSync(indexFile)) {
      throw new Error(`Web bundle introuvable : ${indexFile}. Exécutez npm run build.`);
    }
    app.use(express.static(webRoot));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(indexFile);
    });
  }

  console.log(`[Server] AiHarness server running on http://${host}:${port}`);
  console.log(`[Server] Providers: ${proxyServer.getProviders().map(p => `${p.type}=${p.configured ? '✓' : '✗'}`).join(', ')}`);

  return app;
}

/** Start the Express server */
export function start(config?: ServerConfig): Promise<{ port: number; host: string; app: express.Application }> {
  const port = config?.port ?? DEFAULT_PORT;
  const host = config?.host ?? DEFAULT_HOST;
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
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

  return new Promise((resolve, reject) => {
    const server = createServer(appInstance!);
    httpServer = server;
    server.on('upgrade', (request, socket) => handleWebSocketUpgrade(request, socket, getProxy()));
    server.listen(port, host, () => {
      resolve({ port: (server.address() as any).port || port, host, app: appInstance! });
    });
    server.on('error', reject);
  });
}

/** Stop the Express server */
export async function stop(): Promise<void> {
  appInstance = null;
  const services = activeServices;
  activeServices = undefined;
  if (services) await services.then(async value => {
    value.terminalRuntime.shutdown();
    await value.subagentRuntime.shutdown();
    await value.extensionRegistry.shutdown();
    await proxyServer?.flushUsage();
  }).catch(() => undefined);
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

// ===================================================================
// CLI Entry Point - Run server directly
// ===================================================================

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config: ServerConfig = {};

  // Parse command line args
  for (let i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
      case '--port':
        config.port = parseInt(process.argv[++i] || '3099');
        break;
      case '--host':
        config.host = process.argv[++i];
        break;
    }
  }

  start(config)
    .then(({ port }) => {
      console.log(`[Server] Listening on http://127.0.0.1:${port}`);
    })
    .catch((error) => {
      console.error('[Server] Failed to start:', error);
      process.exit(1);
    });
}
