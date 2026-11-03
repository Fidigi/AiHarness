import type {
  AgentEvent,
  AgentRunSnapshot,
  AgentRuntime,
  Session,
  SessionManager,
  SubagentProfile,
  SubagentRunSnapshot,
} from '@ai-harness/core';
import type { SubagentService } from './subagent-service.js';

type SubagentSystemPromptResolver = (input: { cwd: string; basePrompt: string }) => Promise<string>;

export interface StartSubagentRequest {
  parentSessionId: string;
  profileId: string;
  task: string;
  provider: string;
  background?: boolean;
  parentToolPreset?: Session['toolPreset'];
  parentPolicy?: ReturnType<AgentRuntime['getSessionDelegationPolicy']>;
  /** Withdraw unpublished delegation; accepted background work is independent. */
  signal?: AbortSignal;
}

const TERMINAL_PHASES = new Set(['completed', 'failed', 'stopped']);
const MAX_INHERITED_MESSAGES = 40;
const MAX_INHERITED_CHARACTERS = 120_000;
const MAX_RUN_HISTORY = 200;

function inheritedMessages(parent: Session): Session['messages'] {
  const selected: Session['messages'] = [];
  let characters = 0;
  for (const message of [...parent.messages].reverse()) {
    // Public text only; omit private replay/loadout, binary data and orphaned tool groups.
    if ((message.role !== 'user' && message.role !== 'assistant') || !message.content) continue;
    if (selected.length >= MAX_INHERITED_MESSAGES) break;
    if (characters + message.content.length > MAX_INHERITED_CHARACTERS) break;
    characters += message.content.length;
    selected.push({
      role: message.role,
      content: message.content,
      id: `inherited:${crypto.randomUUID()}`,
      timestamp: new Date(message.timestamp),
      metadata: { inheritedFromSession: parent.id },
    });
  }
  selected.reverse();
  for (let index = 1; index < selected.length; index++) selected[index]!.parentMessageId = selected[index - 1]!.id;
  return selected;
}

function outputFor(session: Session | undefined): string | undefined {
  return [...(session?.messages ?? [])].reverse().find(message => (
    message.role === 'assistant' && !message.metadata?.inheritedFromSession
  ))?.content;
}

function intersect(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  if (left === undefined) return right ? [...right] : undefined;
  if (right === undefined) return [...left];
  const allowed = new Set(right.map(value => value.toLowerCase()));
  return left.filter(value => allowed.has(value.toLowerCase()));
}

/** Coordinates bounded child runs while AgentRuntime remains the execution engine. */
export class SubagentRuntime {
  private readonly runs = new Map<string, SubagentRunSnapshot>();
  private readonly childAgentRuns = new Map<string, string>();
  private readonly unsubscribers = new Map<string, () => void>();
  private startQueue = Promise.resolve();
  private readonly controllers = new Map<string, AbortController>();
  private closed = false;

  constructor(
    private readonly profiles: SubagentService,
    private readonly agentRuntime: AgentRuntime,
    private readonly sessionManager: SessionManager,
    private readonly resolveSystemPrompt: SubagentSystemPromptResolver = async input => input.basePrompt,
    private readonly redactText: (value: string) => string = value => value,
    private readonly redactJson: <T>(value: T) => T = value => value,
  ) {}

  async start(request: StartSubagentRequest): Promise<SubagentRunSnapshot> {
    request = { ...request, parentPolicy: request.parentPolicy ? structuredClone(request.parentPolicy) : undefined };
    let release!: () => void;
    const previous = this.startQueue;
    this.startQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (this.closed) throw new Error('Subagent runtime is closed.');
      request.signal?.throwIfAborted();
      return await this.startUnlocked(request);
    } finally {
      release();
    }
  }

  get(id: string): SubagentRunSnapshot | undefined {
    const run = this.runs.get(id);
    return run ? this.redactJson(structuredClone(run)) : undefined;
  }

  list(parentSessionId?: string): SubagentRunSnapshot[] {
    return [...this.runs.values()].reverse()
      .filter(run => !parentSessionId || run.parentSessionId === parentSessionId)
      .map(run => this.redactJson(structuredClone(run)));
  }

  async wait(id: string): Promise<SubagentRunSnapshot | undefined> {
    const agentRunId = this.childAgentRuns.get(id);
    if (agentRunId) { await this.agentRuntime.wait(agentRunId); this.complete(id); }
    return this.get(id);
  }

  stop(id: string): SubagentRunSnapshot {
    const run = this.requireRun(id);
    if (TERMINAL_PHASES.has(run.status)) return this.redactJson(structuredClone(run));
    const agentRunId = this.childAgentRuns.get(id);
    if (agentRunId && !TERMINAL_PHASES.has(this.agentRuntime.getRun(agentRunId)?.phase ?? '')) {
      this.agentRuntime.stop(agentRunId);
    }
    this.controllers.get(id)?.abort();
    // Retain the concurrency lease until durable settlement, not cancellation acknowledgement.
    run.phase = 'stopping';
    this.publishParent(run, 'subagent.updated');
    return this.redactJson(structuredClone(run));
  }

  acknowledge(id: string): SubagentRunSnapshot {
    const run = this.requireRun(id);
    run.attention = false;
    this.publishParent(run, 'subagent.updated');
    return this.redactJson(structuredClone(run));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const pending: Promise<unknown>[] = [];
    for (const run of this.runs.values()) {
      if (!TERMINAL_PHASES.has(run.status)) {
        this.stop(run.id);
        const agentRunId = this.childAgentRuns.get(run.id);
        if (agentRunId) pending.push(this.agentRuntime.wait(agentRunId));
      }
    }
    await Promise.allSettled(pending);
    for (const run of this.runs.values()) this.complete(run.id);
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
  }

  private async startUnlocked(request: StartSubagentRequest): Promise<SubagentRunSnapshot> {
    const parent = this.sessionManager.get(request.parentSessionId)
      ?? await this.sessionManager.loadFromStore(request.parentSessionId);
    if (!parent?.cwd) throw Object.assign(new Error('Session parente introuvable ou sans workspace.'), { status: 404 });
    const parentKey = () => JSON.stringify([parent.cwd, parent.workspaceId, parent.gitBranch, parent.branchId,
      parent.agentId, parent.model, parent.thinking, parent.toolPreset, parent.metadata?.subagentDepth]);
    const admittedKey = parentKey();
    const parentRun = this.agentRuntime.getSessionRun(parent.id)?.id;
    const inherited = this.agentRuntime.getSessionDelegationPolicy(parent.id) ?? request.parentPolicy;
    const assertParent = () => {
      if (this.sessionManager.get(parent.id) !== parent || parentKey() !== admittedKey
        || this.agentRuntime.getSessionRun(parent.id)?.id !== parentRun) throw new Error('Parent session changed.');
    };
    if (typeof request.task !== 'string' || !request.task.trim() || request.task.length > 100_000) {
      throw Object.assign(new Error('Tâche de sous-agent invalide.'), { status: 400 });
    }
    const safeTask = this.redactText(request.task);
    const configuration = await this.profiles.getConfiguration({
      cwd: parent.cwd,
      projectId: parent.workspaceId,
      scope: 'project',
      requireTrusted: true,
    });
    request.signal?.throwIfAborted();
    assertParent();
    if (this.closed) throw new Error('Subagent runtime is closed.');
    if (!configuration.engineEnabled) throw Object.assign(
      new Error('Le moteur de sous-agents est désactivé.'), { status: 409, code: 'SUBAGENTS_DISABLED' },
    );
    const profile = configuration.profiles.find(item => item.id === request.profileId && item.enabled);
    if (!profile) throw Object.assign(new Error('Profil de sous-agent indisponible.'), { status: 404 });
    const active = [...this.runs.values()].filter(run => !TERMINAL_PHASES.has(run.status)).length;
    if (active >= configuration.maxConcurrency) throw Object.assign(
      new Error('Limite de concurrence des sous-agents atteinte.'), { status: 409, code: 'SUBAGENT_CONCURRENCY_LIMIT' },
    );
    const parentDepth = Number(parent.metadata?.subagentDepth ?? 0);
    if (!Number.isSafeInteger(parentDepth) || parentDepth < 0 || parentDepth >= 3) throw Object.assign(
      new Error('Profondeur maximale de délégation atteinte.'), { status: 409, code: 'SUBAGENT_DEPTH_LIMIT' },
    );

    const model = profile.model ?? inherited?.model ?? parent.model;
    const thinking = profile.thinking ?? inherited?.thinking ?? parent.thinking;
    const presets = [inherited?.toolPreset, request.parentToolPreset, parent.toolPreset];
    const readOnly = presets.includes('read-only') || ['explore', 'plan'].includes(profile.kind);
    const toolPreset = presets.includes('chat-only') ? 'chat-only' : readOnly ? 'read-only'
      : inherited?.toolPreset ?? request.parentToolPreset ?? parent.toolPreset ?? 'default';
    const allowedTools = intersect(inherited?.allowedTools, profile.tools.length ? profile.tools : undefined);
    const allowedSkills = intersect(inherited?.allowedSkills, profile.skills.length ? profile.skills : undefined);
    const allowedExtensions = intersect(inherited?.allowedExtensions, profile.extensions.length ? profile.extensions : undefined);
    const excludedTools = [...inherited?.excludedTools ?? [], ...(parentDepth + 1 >= 3 ? ['spawn_subagent'] : [])];
    const id = crypto.randomUUID();
    const messages = profile.inheritContext ? this.redactJson(inheritedMessages(parent)) : [];
    const child = await this.sessionManager.create({
      title: this.redactText(`${profile.name}: ${safeTask.trim().replace(/\s+/g, ' ').slice(0, 64)}`),
      cwd: parent.cwd,
      workspaceId: parent.workspaceId,
      gitBranch: parent.gitBranch,
      parentId: parent.id,
      branchId: parent.branchId ?? parent.id,
      parentAgentId: parent.agentId,
      agentId: id,
      model, thinking, toolPreset,
      autoCompaction: false,
      messages, activeLeafId: messages.at(-1)?.id,
      metadata: {
        subagent: true,
        subagentRunId: id,
        subagentProfileId: profile.id,
        subagentDepth: parentDepth + 1,
      },
    });
    const background = request.background ?? profile.background;
    const snapshot: SubagentRunSnapshot = {
      id,
      parentSessionId: parent.id,
      childSessionId: child.id,
      workspaceId: parent.workspaceId,
      profileId: profile.id,
      profileName: this.redactText(profile.name),
      task: safeTask.trim(),
      provider: this.redactText(request.provider),
      model: model ? this.redactText(model) : undefined,
      status: 'queued',
      phase: 'queued',
      background,
      attention: false,
      turn: 0,
      maxTurns: profile.maxTurns,
      startedAt: new Date().toISOString(),
    };
    this.runs.set(id, snapshot);
    this.trimHistory();

    const controller = new AbortController();
    this.controllers.set(id, controller);
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted || this.closed) controller.abort();
    const unsubscribe = this.agentRuntime.journal.subscribe(child.id, event => this.onChildEvent(id, event));
    this.unsubscribers.set(id, unsubscribe);
    let agentRun: AgentRunSnapshot;
    try {
      controller.signal.throwIfAborted();
      assertParent();
      const systemPrompt = await this.resolveSystemPrompt({
        cwd: parent.cwd,
        basePrompt: this.systemPrompt(profile),
      });
      controller.signal.throwIfAborted();
      assertParent();
      agentRun = await this.agentRuntime.start({
        sessionId: child.id,
        cwd: parent.cwd,
        workspaceId: parent.workspaceId,
        provider: request.provider,
        input: request.task.trim(),
        model, thinking, thinkingBudgets: inherited?.thinkingBudgets, toolPreset,
        signal: controller.signal,
        persistSettings: false,
        systemPrompt,
        maxToolRounds: profile.maxTurns,
        agentId: id,
        allowedTools, excludedTools, allowedSkills, allowedExtensions,
        codemode: inherited?.codemode,
      });
    } catch (error) {
      snapshot.status = controller.signal.aborted ? 'stopped' : 'failed';
      snapshot.phase = snapshot.status;
      snapshot.completedAt = new Date().toISOString();
      snapshot.error = controller.signal.aborted ? undefined : this.redactText(error instanceof Error ? error.message : String(error)).slice(0, 16_384);
      snapshot.attention = true;
      unsubscribe();
      this.unsubscribers.delete(id);
      this.controllers.delete(id);
      this.publishParent(snapshot, 'subagent.failed');
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', abort);
    }
    this.childAgentRuns.set(id, agentRun.id);
    snapshot.status = 'running';
    snapshot.phase = controller.signal.aborted ? 'stopping' : agentRun.phase;
    this.publishParent(snapshot, 'subagent.started');
    void this.agentRuntime.wait(agentRun.id).then(() => this.complete(id));
    return this.redactJson(structuredClone(snapshot));
  }

  private onChildEvent(id: string, event: AgentEvent): void {
    const run = this.runs.get(id);
    if (!run || TERMINAL_PHASES.has(run.status)) return;
    let changed = false;
    if (event.type === 'run.phase') {
      const phase = (event.data as { phase?: unknown }).phase;
      if (typeof phase === 'string' && phase !== run.phase) {
        run.phase = phase;
        changed = true;
      }
    } else if (event.type === 'message.start') {
      const turn = Math.min(run.maxTurns, run.turn + 1);
      changed = turn !== run.turn;
      run.turn = turn;
    } else if (event.type === 'tool.started' && run.phase !== 'tool') {
      run.phase = 'tool';
      changed = true;
    }
    if (changed && run.status === 'running') this.publishParent(run, 'subagent.updated');
  }

  private complete(id: string): void {
    const run = this.runs.get(id);
    if (!run || TERMINAL_PHASES.has(run.status)) return;
    const agentRunId = this.childAgentRuns.get(id);
    if (!agentRunId) return;
    const agent = agentRunId ? this.agentRuntime.getRun(agentRunId) : undefined;
    run.phase = agent?.phase ?? 'failed';
    run.status = agent?.phase === 'completed'
      ? 'completed'
      : agent?.phase === 'stopped' ? 'stopped' : 'failed';
    run.completedAt = agent?.completedAt ?? new Date().toISOString();
    const output = outputFor(this.sessionManager.get(run.childSessionId));
    const safeOutput = output === undefined ? undefined : this.redactText(output);
    const suffix = '\n[Truncated; open the child session for complete output.]';
    run.output = safeOutput && safeOutput.length > 16_384
      ? safeOutput.slice(0, 16_384 - suffix.length) + suffix : safeOutput;
    run.error = agent?.error?.slice(0, 16_384);
    run.attention = true;
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    this.controllers.delete(id);
    this.publishParent(run, run.status === 'completed' ? 'subagent.completed' : 'subagent.failed');
  }

  private publishParent(
    run: SubagentRunSnapshot,
    type: 'subagent.started' | 'subagent.updated' | 'subagent.completed' | 'subagent.failed',
  ): void {
    this.agentRuntime.publishSessionEvent(run.parentSessionId, type, structuredClone(run));
  }

  private systemPrompt(profile: SubagentProfile): string {
    return [
      `You are the ${profile.name} child agent.`,
      profile.instructions,
      'Work only on the delegated task. Return a clear result to the parent agent.',
    ].join('\n\n');
  }

  private requireRun(id: string): SubagentRunSnapshot {
    const run = this.runs.get(id);
    if (!run) throw Object.assign(new Error('Sous-agent introuvable.'), { status: 404 });
    return run;
  }

  private trimHistory(): void {
    if (this.runs.size <= MAX_RUN_HISTORY) return;
    const removable = [...this.runs.values()].filter(run => TERMINAL_PHASES.has(run.status));
    while (this.runs.size > MAX_RUN_HISTORY && removable.length) {
      const run = removable.shift()!;
      this.runs.delete(run.id);
      this.childAgentRuns.delete(run.id);
    }
  }
}
