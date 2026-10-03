import { Router, type Request, type Response } from 'express';
import {
  resolveInstructionPrompt,
  type AgentEvent,
  type ExtensionInteractionRequest,
  type MessageContentBlock,
  type Session,
} from '@ai-harness/core';
import type { RuntimeServices } from '../runtime/services.js';
import { resolveEffectiveConfiguration } from '../config/effective-configuration.js';
import { boundedMessageLimit, serializeSessionPage } from './session-pagination.js';
import { requireCapability } from '../security/request-security.js';

function sendEvent(response: Response, event: string, data: unknown, id?: string): void {
  if (id) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function stringValue(value: unknown, name: string, options: { optional?: boolean; max?: number } = {}): string | undefined {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > (options.max ?? 100_000)) {
    throw Object.assign(new Error(`${name} invalide.`), { status: 400 });
  }
  return value.trim();
}

function userBlocks(value: unknown): MessageContentBlock[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw Object.assign(new Error('Blocs de message invalides.'), { status: 400 });
  let encodedBytes = 0;
  const blocks: MessageContentBlock[] = value.map(block => {
    if (!block || typeof block !== 'object') throw Object.assign(new Error('Bloc invalide.'), { status: 400 });
    const input = block as Record<string, unknown>;
    if (input.type === 'text' && typeof input.text === 'string' && input.text.length <= 100_000) {
      return { type: 'text', text: input.text };
    }
    if (input.type === 'image' && typeof input.url === 'string' && typeof input.mediaType === 'string'
      && /^image\/[A-Za-z0-9.+-]+$/.test(input.mediaType)
      && input.url.startsWith(`data:${input.mediaType};base64,`)) {
      encodedBytes += input.url.length;
      if (encodedBytes > 9_000_000) throw Object.assign(new Error('Images trop volumineuses.'), { status: 413 });
      return {
        type: 'image',
        mediaType: input.mediaType,
        url: input.url,
        ...(typeof input.name === 'string' ? { name: input.name.slice(0, 500) } : {}),
        ...(typeof input.size === 'number' ? { size: input.size } : {}),
      };
    }
    throw Object.assign(new Error('Type de bloc utilisateur non autorisé.'), { status: 400 });
  });
  return blocks;
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed as number)) : fallback;
}

function initialSessionTitle(input: string): string {
  const normalized = input.replace(/\s+/g, ' ').replace(/^\s*[#>*`_-]+\s*/, '').trim();
  const title = normalized || 'New conversation';
  if (title.length <= 80) return title;
  return `${title.slice(0, 77).trimEnd()}…`;
}

export function createAgentRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/palette', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const { extensionRegistry } = services;
      const builtins = [
        ['auto-compact', 'Set automatic compaction: auto, on, or off'],
        ['compact', 'Compact conversation context'],
        ['clone', 'Clone this conversation'],
        ['copy', 'Copy the latest assistant response'],
        ['name', 'Rename this conversation'],
        ['reload', 'Reload resources'],
        ['stats', 'Open session statistics'],
      ].map(([name, description]) => ({ name, description, source: 'builtin' }));
      const extensions = extensionRegistry.getCommands().map(command => ({
        ...command,
        source: 'extension',
      }));
      const cwd = typeof request.query.cwd === 'string' ? request.query.cwd : undefined;
      const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
      const [skillCatalog, pluginCatalog] = await Promise.all([
        services.skillCatalog.getCatalog({ cwd, projectId }).catch(() => undefined),
        services.pluginService.getCatalog({ cwd, projectId }).catch(() => undefined),
      ]);
      const skills = (skillCatalog?.skills ?? []).filter(skill => skill.modelInvocable).map(skill => ({
        name: skill.name,
        description: skill.description,
        source: 'skill',
      }));
      const prompts = (pluginCatalog?.packages ?? []).flatMap(pkg => pkg.resources
        .filter(resource => resource.kind === 'prompt')
        .map(resource => ({ name: resource.name, description: `Prompt from ${pkg.packageName ?? pkg.source}`, source: 'prompt' })));
      const seen = new Set<string>();
      response.json([...builtins, ...extensions, ...prompts, ...skills].filter(item => {
        const key = `${item.source}:${item.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/palette/:source/:name', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const cwd = typeof request.query.cwd === 'string' ? request.query.cwd : undefined;
      const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
      if (request.params.source === 'skill') {
        const skill = await services.skillCatalog.resolveModelInvocableSkill(request.params.name, { cwd, projectId });
        if (!skill) {
          response.status(404).json({ error: 'Skill not found or not enabled.' });
          return;
        }
        response.json({ content: `Follow the Agent Skill “${skill.name}” below.\n\n${skill.instructions}`, source: skill.filePath });
        return;
      }
      if (request.params.source === 'prompt') {
        const prompt = await services.pluginService.resolvePrompt(request.params.name, { cwd, projectId });
        if (!prompt) {
          response.status(404).json({ error: 'Prompt not found.' });
          return;
        }
        response.json(prompt);
        return;
      }
      response.status(400).json({ error: 'Unsupported palette resource.' });
    } catch (error) { next(error); }
  });

  router.post('/reload', requireCapability('packages'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const cwd = stringValue(request.body?.cwd, 'cwd', { optional: true, max: 4_096 });
      const projectId = stringValue(request.body?.projectId, 'projectId', { optional: true, max: 500 });
      response.json(await services.reloadResources({ cwd, projectId }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionId/interactions/:requestId', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const encoded = JSON.stringify(request.body?.value ?? null);
      if (encoded.length > 200_000) {
        response.status(413).json({ error: 'Extension interaction response is too large.' });
        return;
      }
      response.json(services.agentRuntime.respondToInteraction(
        request.params.sessionId,
        request.params.requestId,
        { cancelled: request.body?.cancelled === true, value: request.body?.value },
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionId/commands/:name', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const session = services.sessionManager.get(request.params.sessionId)
        ?? await services.sessionManager.loadFromStore(request.params.sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      const command = services.extensionRegistry.getCommand(request.params.name);
      if (!command) {
        response.status(404).json({ error: 'Extension command not found' });
        return;
      }
      const args = typeof request.body?.args === 'string' ? request.body.args.slice(0, 100_000) : '';
      const effective = resolveEffectiveConfiguration(services, {
        projectId: session.workspaceId, sessionId: session.id, session,
      });
      const providerName = effective.values.provider ?? String(session.providerConfig?.type ?? 'mock');
      const output = await command.handler(args, {
        sessionManager: services.sessionManager,
        currentSessionId: session.id,
        providerName,
        provider: services.resolveProvider(providerName),
        toolPreset: effective.values.toolPreset,
        cwd: session.cwd,
        workspaceId: session.workspaceId,
        projectTrusted: session.cwd ? await services.trustManager.isTrusted(session.cwd) : false,
        notify: (message, level = 'info') => services.agentRuntime.publishSessionEvent(
          session.id, 'notice', { message, level },
        ),
        requestInteraction: (interaction: ExtensionInteractionRequest) => services.agentRuntime
          .requestExtensionInteraction(session.id, interaction),
      });
      response.json({ output: typeof output === 'string' ? output.slice(0, 200_000) : '' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId/extensions', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const session = services.sessionManager.get(request.params.sessionId)
        ?? await services.sessionManager.loadFromStore(request.params.sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      const effective = resolveEffectiveConfiguration(services, { projectId: session.workspaceId, sessionId: session.id, session });
      const widgets = services.extensionRegistry.getUIComponents().flatMap(component => {
        try {
          return [{
            name: component.name,
            placement: component.placement ?? 'status',
            content: String(component.render({ currentSessionId: session.id, provider: effective.values.provider })).slice(0, 20_000),
            extensionId: component.extensionId,
          }];
        } catch {
          return [];
        }
      });
      response.json(widgets);
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId/capabilities', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const session = services.sessionManager.get(request.params.sessionId)
        ?? await services.sessionManager.loadFromStore(request.params.sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      const effective = resolveEffectiveConfiguration(services, {
        projectId: session.workspaceId,
        sessionId: session.id,
        session,
      });
      response.json({
        systemPrompt: effective.values.systemPrompt ?? '',
        toolPreset: effective.values.toolPreset ?? 'default',
        tools: services.agentRuntime.getTools(
          effective.values.toolPreset,
          effective.values.enabledTools,
        ).filter(tool => tool.name !== 'powershell' || effective.values.powershellEnabled === true).map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: 'object', properties: {} },
          extensionId: tool.extensionId,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/running', async (_request, response, next) => {
    try {
      const { agentRuntime } = await servicesPromise;
      response.json(agentRuntime.listRunning());
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs', async (request: Request, response: Response, next): Promise<void> => {
    try {
      const services = await servicesPromise;
      const body = request.body as Record<string, unknown>;
      const input = stringValue(body.input, 'input')!;
      let session: Session | undefined;
      if (typeof body.sessionId === 'string') {
        session = services.sessionManager.get(body.sessionId)
          ?? await services.sessionManager.loadFromStore(body.sessionId)
          ?? undefined;
        if (!session) {
          response.status(404).json({ error: 'Session not found' });
          return;
        }
      }
      const cwdInput = typeof body.cwd === 'string'
        ? body.cwd
        : session?.cwd ?? await services.workspaceManager.getDefaultCwd();
      const cwd = await services.workspaceManager.resolve(cwdInput, { kind: 'directory' });
      const trusted = await services.trustManager.isTrusted(cwd);
      const workspace = await services.workspaceManager.describe(cwd, trusted);
      if (!trusted) {
        throw Object.assign(new Error('Le workspace doit être approuvé avant de lancer un agent.'), {
          status: 409,
          code: 'PROJECT_TRUST_REQUIRED',
        });
      }
      const requestedModel = stringValue(body.model, 'model', { optional: true, max: 500 });
      const requestedThinking = ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(body.thinking))
        ? body.thinking as Session['thinking']
        : undefined;
      const requestedToolPreset = ['configured', 'chat-only', 'read-only', 'default', 'full'].includes(String(body.toolPreset))
        ? body.toolPreset as Session['toolPreset']
        : undefined;
      const requestedAutoCompaction = typeof body.autoCompaction === 'boolean' ? body.autoCompaction : undefined;
      const overrideKeys = new Set(
        Array.isArray(body.settingOverrides)
          ? body.settingOverrides.filter((key): key is string => ['model', 'thinking', 'toolPreset', 'autoCompaction'].includes(String(key)))
          : [
              ...(requestedModel !== undefined ? ['model'] : []),
              ...(requestedThinking !== undefined ? ['thinking'] : []),
              ...(requestedToolPreset !== undefined ? ['toolPreset'] : []),
              ...(requestedAutoCompaction !== undefined ? ['autoCompaction'] : []),
            ],
      );
      const explicitOverrideProtocol = Array.isArray(body.settingOverrides);
      if (!session) {
        session = await services.sessionManager.create({
          title: initialSessionTitle(input),
          cwd,
          workspaceId: workspace.id,
          ...(overrideKeys.has('model') ? { model: requestedModel } : {}),
          ...(overrideKeys.has('thinking') ? { thinking: requestedThinking } : {}),
          ...(overrideKeys.has('toolPreset') ? { toolPreset: requestedToolPreset } : {}),
          ...(overrideKeys.has('autoCompaction') ? { autoCompaction: requestedAutoCompaction } : {}),
        });
      } else if (explicitOverrideProtocol) {
        session = await services.sessionManager.update(session.id, {
          model: overrideKeys.has('model') ? requestedModel ?? null : null,
          thinking: overrideKeys.has('thinking') ? requestedThinking ?? null : null,
          toolPreset: overrideKeys.has('toolPreset') ? requestedToolPreset ?? null : null,
          autoCompaction: overrideKeys.has('autoCompaction') ? requestedAutoCompaction ?? null : null,
        }) ?? session;
      } else {
        // Legacy clients do not send settingOverrides; preserve their historical
        // behavior by persisting only the setting fields present in the request.
        session = await services.sessionManager.update(session.id, {
          ...(requestedModel !== undefined ? { model: requestedModel } : {}),
          ...(requestedThinking !== undefined ? { thinking: requestedThinking } : {}),
          ...(requestedToolPreset !== undefined ? { toolPreset: requestedToolPreset } : {}),
          ...(requestedAutoCompaction !== undefined ? { autoCompaction: requestedAutoCompaction } : {}),
        }) ?? session;
      }
      if (session.cwd && session.cwd !== cwd) {
        response.status(409).json({ error: 'La session appartient à un autre workspace.' });
        return;
      }
      const effective = resolveEffectiveConfiguration(services, {
        projectId: workspace.id,
        sessionId: session.id,
        session,
      });
      const selectedProvider = stringValue(body.provider, 'provider', { max: 100 })!;
      const selectedModel = effective.values.model ?? requestedModel;
      const configuredSystemPrompt = stringValue(body.systemPrompt, 'systemPrompt', { optional: true, max: 200_000 })
        ?? effective.values.systemPrompt;
      const instructions = await resolveInstructionPrompt({
        cwd,
        projectTrusted: trusted,
        systemPromptText: configuredSystemPrompt,
      });
      const modelSupportsTools = services.modelCatalog.getCapabilities(selectedProvider, selectedModel)?.toolCalls !== false;
      const run = await services.agentRuntime.start({
        sessionId: session.id,
        cwd,
        workspaceId: workspace.id,
        provider: selectedProvider,
        input,
        blocks: userBlocks(body.blocks),
        model: selectedModel,
        thinking: effective.values.thinking,
        toolPreset: effective.values.toolPreset,
        persistSettings: false,
        systemPrompt: instructions.systemPrompt,
        maxRetries: integerValue(body.maxRetries, 2, 0, 5),
        maxToolRounds: integerValue(body.maxToolRounds, 8, 1, 32),
        allowedTools: modelSupportsTools
          ? (effective.values.enabledTools ?? services.extensionRegistry.getTools().map(tool => tool.name))
            .filter(tool => tool !== 'powershell' || effective.values.powershellEnabled === true)
          : [],
      });
      response.status(202).json({ run, session: serializeSessionPage(session, { limit: 80 }), workspace });
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs/:runId', async (request, response, next) => {
    try {
      const { agentRuntime } = await servicesPromise;
      const run = agentRuntime.getRun(request.params.runId);
      if (!run) {
        response.status(404).json({ error: 'Run not found' });
        return;
      }
      response.json(run);
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:runId/stop', async (request, response, next) => {
    try {
      const { agentRuntime } = await servicesPromise;
      response.status(202).json(agentRuntime.stop(request.params.runId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:runId/queue', async (request, response, next) => {
    try {
      const { agentRuntime } = await servicesPromise;
      const kind = request.body?.kind;
      if (kind !== 'steer' && kind !== 'follow-up') {
        response.status(400).json({ error: 'kind doit valoir steer ou follow-up.' });
        return;
      }
      const content = stringValue(request.body?.content, 'content')!;
      response.status(202).json(agentRuntime.enqueue(
        request.params.runId,
        kind,
        content,
        userBlocks(request.body?.blocks),
      ));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/runs/:runId/queue', async (request, response, next) => {
    try {
      const { agentRuntime } = await servicesPromise;
      const kind = request.query.kind;
      if (kind !== undefined && kind !== 'steer' && kind !== 'follow-up') {
        response.status(400).json({ error: 'kind invalide.' });
        return;
      }
      response.json(agentRuntime.clearQueue(request.params.runId, kind));
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId/state', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const session = services.sessionManager.get(request.params.sessionId)
        ?? await services.sessionManager.loadFromStore(request.params.sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      response.json({
        ...services.agentRuntime.snapshot(session.id),
        session: serializeSessionPage(session, {
          limit: boundedMessageLimit(request.query.messageLimit, 80, true),
          includeCommands: request.query.includeCommands !== 'false',
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionId/compact', async (request, response, next) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', () => {
      if (!response.writableEnded) abort();
    });
    try {
      const services = await servicesPromise;
      const session = services.sessionManager.get(request.params.sessionId)
        ?? await services.sessionManager.loadFromStore(request.params.sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      const activeRun = services.agentRuntime.getSessionRun(session.id);
      if (activeRun && !['completed', 'failed', 'stopped'].includes(activeRun.phase)) {
        response.status(409).json({ error: 'Arrêtez l’agent avant de compacter la session.' });
        return;
      }
      if (session.messages.length < 4) {
        response.status(400).json({ error: 'Au moins quatre messages sont requis.' });
        return;
      }
      const effective = resolveEffectiveConfiguration(services, {
        projectId: session.workspaceId,
        sessionId: session.id,
        session,
      });
      const providerName = typeof request.body?.provider === 'string'
        ? request.body.provider
        : effective.values.provider ?? session.providerConfig?.type ?? 'mock';
      const instruction = typeof request.body?.instruction === 'string'
        ? request.body.instruction.slice(0, 10_000)
        : 'Summarize concisely while preserving decisions, constraints, commands, and unresolved work.';
      const before = services.sessionManager.getTokenCount(session.id);
      const firstKeptIndex = Math.max(1, session.messages.length - 2);
      const compacted = session.messages.slice(0, firstKeptIndex);
      services.agentRuntime.publishSessionEvent(session.id, 'compaction.started', { tokensBefore: before });
      const provider = services.resolveProvider(providerName);
      if (!provider) throw Object.assign(new Error(`Provider inconnu : ${providerName}`), { status: 400 });
      const requestedModel = typeof request.body?.model === 'string' ? request.body.model : effective.values.model;
      const summaryResponse = await provider.chat([{
        id: `compaction:${session.id}`,
        role: 'user',
        content: compacted.map(message => `${message.role}: ${message.content}`).join('\n---\n'),
        timestamp: new Date(),
      }], {
        model: requestedModel,
        systemPrompt: `You summarize an agent conversation. ${instruction}`,
        signal: controller.signal,
      });
      if (summaryResponse.usage) services.recordUsage(providerName, summaryResponse.model ?? requestedModel, summaryResponse.usage);
      const summary = summaryResponse.content.trim();
      if (!summary) throw new Error('Le provider a renvoyé un résumé vide.');
      const firstKeptEntryId = session.messages[firstKeptIndex].id;
      const afterEstimate = Math.ceil(summary.length / 4)
        + Math.ceil(session.messages.slice(firstKeptIndex).reduce((sum, message) => sum + message.content.length, 0) / 4);
      await services.sessionManager.applyCompaction(session.id, summary, firstKeptEntryId, {
        instruction,
        tokensBefore: before,
        tokensAfter: afterEstimate,
      });
      services.agentRuntime.publishSessionEvent(session.id, 'compaction.completed', {
        tokensBefore: before,
        tokensAfter: afterEstimate,
        tokensSaved: Math.max(0, before - afterEstimate),
      });
      response.json({
        session: serializeSessionPage(session, { limit: 80 }),
        summary,
        tokensBefore: before,
        tokensAfter: afterEstimate,
        tokensSaved: Math.max(0, before - afterEstimate),
      });
    } catch (error) {
      const services = await servicesPromise;
      services.agentRuntime.publishSessionEvent(request.params.sessionId, 'compaction.failed', {
        message: error instanceof Error ? error.message : 'Compaction failed',
      });
      next(error);
    }
  });

  router.post('/commands', requireCapability('terminal'), async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const sessionId = stringValue(request.body?.sessionId, 'sessionId', { max: 200 })!;
      const command = stringValue(request.body?.command, 'command', { max: 20_000 })!;
      const session = services.sessionManager.get(sessionId) ?? await services.sessionManager.loadFromStore(sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      const cwd = await services.workspaceManager.resolve(request.body?.cwd ?? session.cwd, { kind: 'directory' });
      if (session.cwd && session.cwd !== cwd) {
        response.status(409).json({ error: 'La session appartient à un autre workspace.' });
        return;
      }
      if (!await services.trustManager.isTrusted(cwd)) {
        response.status(409).json({ error: 'Workspace non approuvé.', code: 'PROJECT_TRUST_REQUIRED' });
        return;
      }
      response.status(202).json(services.commandRuntime.start({
        sessionId,
        command,
        cwd,
        excludedFromContext: request.body?.excludedFromContext === true,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/commands/:commandId', requireCapability('terminal'), async (request, response) => {
    const services = await servicesPromise;
    const command = services.commandRuntime.get(request.params.commandId);
    if (!command) {
      response.status(404).json({ error: 'Command not found' });
      return;
    }
    response.json(command);
  });

  router.delete('/commands/:commandId', requireCapability('terminal'), async (request, response) => {
    const services = await servicesPromise;
    const command = services.commandRuntime.cancel(request.params.commandId);
    if (!command) {
      response.status(404).json({ error: 'Command not found' });
      return;
    }
    response.status(202).json(command);
  });

  router.get('/commands/:commandId/events', requireCapability('terminal'), async (request, response) => {
    const services = await servicesPromise;
    const snapshot = services.commandRuntime.get(request.params.commandId);
    if (!snapshot) {
      response.status(404).json({ error: 'Command not found' });
      return;
    }
    const after = integerValue(request.query.after ?? request.headers['last-event-id'], 0, 0, Number.MAX_SAFE_INTEGER);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();
    let sent = after;
    let replaying = true;
    const pending: import('../runtime/command-runtime.js').CommandEvent[] = [];
    const emit = (event: import('../runtime/command-runtime.js').CommandEvent): void => {
      if (event.sequence <= sent) return;
      if (replaying) {
        pending.push(event);
        return;
      }
      sent = event.sequence;
      sendEvent(response, event.type, event, String(event.sequence));
    };
    const unsubscribe = services.commandRuntime.subscribe(request.params.commandId, emit);
    sendEvent(response, 'connection.ready', { snapshot });
    for (const event of services.commandRuntime.replay(request.params.commandId, after)) {
      sent = Math.max(sent, event.sequence);
      sendEvent(response, event.type, event, String(event.sequence));
    }
    replaying = false;
    pending.sort((left, right) => left.sequence - right.sequence).forEach(emit);
    const current = services.commandRuntime.get(request.params.commandId);
    if (current && current.status !== 'running') {
      unsubscribe?.();
      response.end();
      return;
    }
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    });
  });

  router.get('/sessions/:sessionId/events', async (request, response, next) => {
    try {
      const services = await servicesPromise;
      const session = services.sessionManager.get(request.params.sessionId)
        ?? await services.sessionManager.loadFromStore(request.params.sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      const lastEventId = request.headers['last-event-id'];
      const after = integerValue(request.query.after ?? lastEventId, 0, 0, Number.MAX_SAFE_INTEGER);
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders?.();

      const pending: AgentEvent[] = [];
      let replaying = true;
      let sent = after;
      const emit = (event: AgentEvent): void => {
        if (event.sequence <= sent) return;
        if (replaying) {
          pending.push(event);
          return;
        }
        sent = event.sequence;
        sendEvent(response, event.type, event, event.id);
      };
      const unsubscribe = services.agentRuntime.journal.subscribe(session.id, emit);
      const replay = services.agentRuntime.journal.replay(session.id, after);
      sendEvent(response, 'connection.ready', {
        protocolVersion: 1,
        reset: replay.reset,
        snapshot: services.agentRuntime.snapshot(session.id),
      });
      for (const event of replay.events) {
        sent = Math.max(sent, event.sequence);
        sendEvent(response, event.type, event, event.id);
      }
      replaying = false;
      pending.sort((left, right) => left.sequence - right.sequence).forEach(emit);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
