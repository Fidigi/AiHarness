import { Router, type Response } from 'express';
import type { RuntimeServices } from '../runtime/services.js';
import type { TerminalEvent, TerminalSnapshot } from '../runtime/terminal-runtime.js';

function sendEvent(response: Response, event: string, data: unknown, id?: number): void {
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function integer(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0 ? Number(parsed) : fallback;
}

async function requireTrustedTerminal(services: RuntimeServices, terminalId: string): Promise<TerminalSnapshot> {
  const snapshot = services.terminalRuntime.get(terminalId);
  if (!snapshot) throw Object.assign(new Error('Terminal introuvable.'), { status: 404 });
  const cwd = await services.workspaceManager.resolve(snapshot.cwd, { kind: 'directory' });
  if (!await services.trustManager.isTrusted(cwd)) {
    throw Object.assign(new Error('Workspace non approuvé.'), { status: 409, code: 'PROJECT_TRUST_REQUIRED' });
  }
  return snapshot;
}

export function createTerminalRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      let cwd: string | undefined;
      if (typeof request.query.cwd === 'string') {
        cwd = await services.workspaceManager.resolve(request.query.cwd, { kind: 'directory' });
      }
      const terminals = services.terminalRuntime.list(cwd);
      const visible: TerminalSnapshot[] = [];
      for (const terminal of terminals) {
        if (await services.trustManager.isTrusted(terminal.cwd)) visible.push(terminal);
      }
      response.json(visible);
    } catch (error) { next(error); }
  });

  router.post('/', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      if (typeof request.body?.cwd !== 'string') {
        response.status(400).json({ error: 'cwd requis.' });
        return;
      }
      const cwd = await services.workspaceManager.resolve(request.body.cwd, { kind: 'directory' });
      if (!await services.trustManager.isTrusted(cwd)) {
        response.status(409).json({ error: 'Workspace non approuvé.', code: 'PROJECT_TRUST_REQUIRED' });
        return;
      }
      const snapshot = services.terminalRuntime.create({
        cwd,
        name: typeof request.body?.name === 'string' ? request.body.name : undefined,
        cols: integer(request.body?.cols, 100),
        rows: integer(request.body?.rows, 30),
      });
      response.status(201).json(snapshot);
    } catch (error) { next(error); }
  });

  router.get('/:terminalId', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      response.json(await requireTrustedTerminal(services, request.params.terminalId));
    } catch (error) { next(error); }
  });

  router.post('/:terminalId/input', async (request, response, next) => {
    try {
      if (typeof request.body?.data !== 'string') {
        response.status(400).json({ error: 'Saisie terminal requise.' });
        return;
      }
      const services = await servicesPromise;
      await requireTrustedTerminal(services, request.params.terminalId);
      response.json(services.terminalRuntime.write(request.params.terminalId, request.body.data));
    } catch (error) { next(error); }
  });

  router.post('/:terminalId/resize', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      await requireTrustedTerminal(services, request.params.terminalId);
      response.json(services.terminalRuntime.resize(
        request.params.terminalId,
        request.body?.cols,
        request.body?.rows,
      ));
    } catch (error) { next(error); }
  });

  router.delete('/:terminalId', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const snapshot = services.terminalRuntime.kill(request.params.terminalId);
      services.terminalRuntime.remove(request.params.terminalId);
      response.json(snapshot);
    } catch (error) { next(error); }
  });

  router.get('/:terminalId/events', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const terminalId = request.params.terminalId;
      const snapshot = await requireTrustedTerminal(services, terminalId);
      const after = integer(request.query.after ?? request.headers['last-event-id'], 0);
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders?.();

      let sent = after;
      let exitSent = false;
      let replaying = true;
      const pending: TerminalEvent[] = [];
      const emit = (event: TerminalEvent): void => {
        if (event.endOffset < sent || (event.type === 'output' && event.endOffset === sent)
          || (event.type === 'exit' && exitSent)) return;
        if (replaying) {
          pending.push(event);
          return;
        }
        sent = Math.max(sent, event.endOffset);
        if (event.type === 'exit') exitSent = true;
        sendEvent(response, event.type, event, event.endOffset);
        if (event.type === 'exit') response.end();
      };
      const unsubscribe = services.terminalRuntime.subscribe(terminalId, emit);
      const replay = services.terminalRuntime.replay(terminalId, after);
      sendEvent(response, 'connection.ready', {
        snapshot,
        reset: replay.reset,
        oldestOffset: replay.oldestOffset,
        lastOffset: replay.lastOffset,
      });
      for (const event of replay.events) {
        sent = Math.max(sent, event.endOffset);
        if (event.type === 'exit') exitSent = true;
        sendEvent(response, event.type, event, event.endOffset);
      }
      replaying = false;
      pending.sort((left, right) => left.offset - right.offset).forEach(emit);

      const current = services.terminalRuntime.get(terminalId);
      if (!current || current.status !== 'running') {
        unsubscribe();
        response.end();
        return;
      }
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (error) { next(error); }
  });

  return router;
}
