// ============================================================
// AiHarness Server - AI API Proxy with SSE Streaming + Session Management
// Express server that proxies requests to OpenAI/Anthropic APIs
// and manages sessions via JSONL persistence
// ============================================================

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'node:fs';
import os from 'os';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AiProxyServer, createProxyRoutes, writeSSEStream } from './api/proxy.js';
import { SessionManager, JsonlSessionStore } from '@ai-harness/core';
import type { Session } from '@ai-harness/core';
import { EncryptedCredentialStore } from './security/credential-store.js';
import { handleWebSocketUpgrade } from './api/websocket.js';

export type { ChatOptions } from '@ai-harness/core';

/** Server configuration */
export interface ServerConfig {
  port?: number;
  host?: string;
  /** Optional production Web bundle directory. */
  webRoot?: string;
}

const DEFAULT_PORT = 3099;
const DEFAULT_HOST = '127.0.0.1';

let proxyServer: AiProxyServer | null = null;
let appInstance: express.Application | null = null;
let httpServer: Server | null = null;
let sessionManager: SessionManager | null = null;
let jsonlStore: JsonlSessionStore | null = null;
const SESSIONS_DIR = path.join(os.homedir(), '.ai-harness', 'sessions');
const CREDENTIALS_FILE = path.join(os.homedir(), '.ai-harness', 'credentials.enc');
let credentialStore: EncryptedCredentialStore | undefined;
let credentialsInitialized: Promise<void> | undefined;
const sharedSessions = new Map<string, { sessionId: string; expiresAt: number }>();

function initializeCredentials(proxy: AiProxyServer): Promise<void> {
  if (credentialsInitialized) return credentialsInitialized;
  credentialsInitialized = (async () => {
    const masterKey = process.env.AI_HARNESS_MASTER_KEY;
    if (!masterKey) return;
    credentialStore = new EncryptedCredentialStore(CREDENTIALS_FILE, masterKey);
    await credentialStore.load();
    for (const type of ['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local'] as const) {
      const apiKey = credentialStore.get(type);
      if (apiKey) proxy.setApiKey(type, apiKey);
    }
  })();
  return credentialsInitialized;
}

/** Ensure sessions directory exists */
async function ensureSessionsDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

/** Get or create the singleton proxy server */
export function getProxy(): AiProxyServer {
  if (!proxyServer) {
    proxyServer = new AiProxyServer();
  }
  return proxyServer;
}

/** Get or create the session manager */
export async function getSessionManager(): Promise<SessionManager> {
  if (!sessionManager || !jsonlStore) {
    await ensureSessionsDir();
    jsonlStore = new JsonlSessionStore(SESSIONS_DIR);
    sessionManager = new SessionManager();
    sessionManager.setStore(jsonlStore);
    await sessionManager.loadAllSessions();
  }
  return sessionManager;
}

/** Create Express app with all routes configured */
export function createApp(config?: ServerConfig): express.Application {
  const port = config?.port ?? DEFAULT_PORT;
  const host = config?.host ?? DEFAULT_HOST;

  if (!proxyServer) {
    proxyServer = new AiProxyServer();
  }

  const app = express();
  appInstance = app;

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

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

  app.use('/api', async (req, res, next) => {
    try {
      await initializeCredentials(proxyServer!);
      const userToken = process.env.AI_HARNESS_AUTH_TOKEN;
      const adminToken = process.env.AI_HARNESS_ADMIN_TOKEN || userToken;
      if (!userToken && !adminToken) return next();
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token || (token !== userToken && token !== adminToken)) {
        res.status(401).json({ error: 'Authentification requise' });
        return;
      }
      if (req.path === '/config' && req.method !== 'GET' && token !== adminToken) {
        res.status(403).json({ error: 'Permission administrateur requise' });
        return;
      }
      next();
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
  
  // Provider routes
  app.get('/api/providers', routes.providersHandler);
  app.post('/api/config', async (req: Request, res: Response): Promise<void> => {
    await routes.configHandler(req, res);
    if (res.statusCode < 400 && credentialStore && typeof req.body?.type === 'string' && typeof req.body?.apiKey === 'string') {
      await credentialStore.set(req.body.type, req.body.apiKey);
    }
  });

  // ===================================================================
  // Session Management Routes
  // ===================================================================

  /** GET /api/sessions - List all sessions */
  app.get('/api/sessions', async (_req: Request, res: Response): Promise<void> => {
    try {
      const sm = await getSessionManager();
      const sessions = sm.list().map(s => ({
        id: s.id,
        title: s.title,
        messages: s.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp.toISOString(),
        })),
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }));
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
      const sm = await getSessionManager();
      const session = await sm.create({ title });
      
      // Return minimal representation
      res.json({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Create session error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create session' });
      }
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

      res.json({
        id: session.id,
        title: session.title,
        messages: session.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp.toISOString(),
        })),
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      });
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
    if (!role || !['user', 'assistant'].includes(role) || typeof content !== 'string') {
      res.status(400).json({ error: 'Invalid message' });
      return;
    }
    const message = await sm.addMessage(session.id, { role, content });
    res.status(201).json(message);
  });

  /** PATCH /api/sessions/:id - Rename a session */
  app.patch('/api/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    const sm = await getSessionManager();
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    const updated = await sm.update(req.params.id, { title });
    if (!updated) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ id: updated.id, title: updated.title });
  });

  /** DELETE /api/sessions/:id - Delete a session */
  app.delete('/api/sessions/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const sm = await getSessionManager();
      
      // Delete with all forks
      const deletedCount = await (sm as any).deleteWithForks(id);
      
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
      const { messageIndex, title } = req.body as { messageIndex?: number; title?: string };
      
      const sm = await getSessionManager();
      let session: Session | null | undefined = sm.get(id);

      // Try loading from store if not in memory
      if (!session) session = await sm.loadFromStore(id);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const forked = await (sm as any).forkSession(id, messageIndex, title);

      if (!forked) {
        res.status(500).json({ error: 'Fork failed' });
        return;
      }

      res.json({
        id: forked.id,
        title: forked.title,
        createdAt: forked.createdAt.toISOString(),
        updatedAt: forked.updatedAt.toISOString(),
      });
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
      const { title } = req.body as { title?: string };

      const sm = await getSessionManager();
      let session: Session | null | undefined = sm.get(id);

      // Try loading from store if not in memory
      if (!session) session = await sm.loadFromStore(id);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const cloned = await (sm as any).cloneSession(id, title);

      if (!cloned) {
        res.status(500).json({ error: 'Clone failed' });
        return;
      }

      res.json({
        id: cloned.id,
        title: cloned.title,
        createdAt: cloned.createdAt.toISOString(),
        updatedAt: cloned.updatedAt.toISOString(),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Server] Clone session error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to clone session' });
      }
    }
  });

  /** GET /api/sessions/tree - Get session tree structure */
  app.get('/api/sessions/tree', async (req: Request, res: Response): Promise<void> => {
    try {
      const { branchId } = req.query as { branchId?: string };
      
      const sm = await getSessionManager();
      const tree = (sm as any).getSessionTree(branchId);

      // Enrich with message counts from actual sessions
      const enrichedTree = tree.map((node: any) => {
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
export function stop(): Promise<void> {
  return new Promise((resolve, reject) => {
    appInstance = null;
    if (!httpServer) return resolve();
    const server = httpServer;
    httpServer = null;
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
