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
}

const TERMINAL_PHASES = new Set(['completed', 'failed', 'stopped']);
const MAX_INHERITED_MESSAGES = 40;
const MAX_INHERITED_CHARACTERS = 120_000;
const MAX_RUN_HISTORY = 200;

function inheritedMessages(parent: Session): Session['messages'] {
  const selected: Session['messages'] = [];
  let characters = 0;
  for (const message of [...parent.messages].reverse()) {
    if (selected.length >= MAX_INHERITED_MESSAGES) break;
    if (characters + message.content.length > MAX_INHERITED_CHARACTERS) break;
    characters += message.content.length;
    selected.push({
      ...structuredClone(message),
      id: `inherited:${crypto.randomUUID()}`,
      timestamp: new Date(message.timestamp),
      metadata: { ...message.metadata, inheritedFromSession: parent.id },
    });
  }
  return selected.reverse();
}

function outputFor(session: Session | undefined): string | undefined {
  return [...(session?.messages ?? [])].reverse().find(message => (
    message.role === 'assistant' && !message.metadata?.inheritedFromSession
  ))?.content;
}

/** Coordinates bounded child runs while AgentRuntime remains the execution engine. */
export class SubagentRuntime {
  private readonly runs = new Map<string, SubagentRunSnapshot>();
  private readonly childAgentRuns = new Map<string, string>();
  private readonly unsubscribers = new Map<string, () => void>();
  private startQueue = Promise.resolve();

  constructor(
    private readonly profiles: SubagentService,
    private readonly agentRuntime: AgentRuntime,
    private readonly sessionManager: SessionManager,
    private readonly resolveSystemPrompt: SubagentSystemPromptResolver = async input => input.basePrompt,
  ) {}

  async start(request: StartSubagentRequest): Promise<SubagentRunSnapshot> {
    let release!: () => void;
    const previous = this.startQueue;
    this.startQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await this.startUnlocked(request);
    } finally {
      release();
    }
  }

  get(id: string): SubagentRunSnapshot | undefined {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  list(parentSessionId?: string): SubagentRunSnapshot[] {
    return [...this.runs.values()]
      .filter(run => !parentSessionId || run.parentSessionId === parentSessionId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(run => structuredClone(run));
  }

  async wait(id: string): Promise<SubagentRunSnapshot | undefined> {
    const agentRunId = this.childAgentRuns.get(id);
    if (agentRunId) await this.agentRuntime.wait(agentRunId);
    return this.get(id);
  }

  stop(id: string): SubagentRunSnapshot {
    const run = this.requireRun(id);
    if (TERMINAL_PHASES.has(run.status)) return structuredClone(run);
    const agentRunId = this.childAgentRuns.get(id);
    if (agentRunId) this.agentRuntime.stop(agentRunId);
    run.status = 'stopped';
    run.phase = 'stopped';
    run.completedAt = new Date().toISOString();
    run.attention = true;
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    this.publishParent(run, 'subagent.updated');
    return structuredClone(run);
  }

  acknowledge(id: string): SubagentRunSnapshot {
    const run = this.requireRun(id);
    run.attention = false;
    return structuredClone(run);
  }

  async shutdown(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const run of this.runs.values()) {
      if (!TERMINAL_PHASES.has(run.status)) {
        const agentRunId = this.childAgentRuns.get(run.id);
        if (agentRunId) {
          try {
            this.agentRuntime.stop(agentRunId);
            pending.push(this.agentRuntime.wait(agentRunId));
          } catch { /* Already terminal. */ }
        }
      }
    }
    await Promise.allSettled(pending);
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
  }

  private async startUnlocked(request: StartSubagentRequest): Promise<SubagentRunSnapshot> {
    const parent = this.sessionManager.get(request.parentSessionId)
      ?? await this.sessionManager.loadFromStore(request.parentSessionId);
    if (!parent?.cwd) throw Object.assign(new Error('Session parente introuvable ou sans workspace.'), { status: 404 });
    if (typeof request.task !== 'string' || !request.task.trim() || request.task.length > 100_000) {
      throw Object.assign(new Error('Tâche de sous-agent invalide.'), { status: 400 });
    }
    const configuration = await this.profiles.getConfiguration({
      cwd: parent.cwd,
      projectId: parent.workspaceId,
      scope: 'project',
    });
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
    if (!Number.isSafeInteger(parentDepth) || parentDepth >= 3) throw Object.assign(
      new Error('Profondeur maximale de délégation atteinte.'), { status: 409, code: 'SUBAGENT_DEPTH_LIMIT' },
    );

    const id = crypto.randomUUID();
    const child = await this.sessionManager.create({
      title: `${profile.name}: ${request.task.trim().replace(/\s+/g, ' ').slice(0, 64)}`,
      cwd: parent.cwd,
      workspaceId: parent.workspaceId,
      gitBranch: parent.gitBranch,
      parentId: parent.id,
      branchId: parent.branchId ?? parent.id,
      parentAgentId: parent.agentId,
      agentId: id,
      model: profile.model ?? parent.model,
      thinking: profile.thinking ?? parent.thinking,
      toolPreset: request.parentToolPreset ?? parent.toolPreset ?? 'default',
      autoCompaction: false,
      messages: profile.inheritContext ? inheritedMessages(parent) : [],
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
      profileName: profile.name,
      task: request.task.trim(),
      provider: request.provider,
      model: profile.model ?? parent.model,
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

    const unsubscribe = this.agentRuntime.journal.subscribe(child.id, event => this.onChildEvent(id, event));
    this.unsubscribers.set(id, unsubscribe);
    let agentRun: AgentRunSnapshot;
    try {
      const systemPrompt = await this.resolveSystemPrompt({
        cwd: parent.cwd,
        basePrompt: this.systemPrompt(profile),
      });
      agentRun = await this.agentRuntime.start({
        sessionId: child.id,
        cwd: parent.cwd,
        workspaceId: parent.workspaceId,
        provider: request.provider,
        input: request.task.trim(),
        model: profile.model ?? parent.model,
        thinking: profile.thinking ?? parent.thinking,
        toolPreset: request.parentToolPreset ?? parent.toolPreset ?? 'default',
        persistSettings: false,
        systemPrompt,
        maxToolRounds: profile.maxTurns,
        agentId: id,
        allowedTools: this.allowedTools(profile, parentDepth + 1),
        allowedSkills: profile.skills.length ? profile.skills : undefined,
        allowedExtensions: profile.extensions.length ? profile.extensions : undefined,
      });
    } catch (error) {
      snapshot.status = 'failed';
      snapshot.phase = 'failed';
      snapshot.completedAt = new Date().toISOString();
      snapshot.error = error instanceof Error ? error.message : String(error);
      snapshot.attention = true;
      unsubscribe();
      this.unsubscribers.delete(id);
      this.publishParent(snapshot, 'subagent.failed');
      throw error;
    }
    this.childAgentRuns.set(id, agentRun.id);
    snapshot.status = 'running';
    snapshot.phase = agentRun.phase;
    this.publishParent(snapshot, 'subagent.started');
    void this.agentRuntime.wait(agentRun.id).then(() => this.complete(id));
    return structuredClone(snapshot);
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
    const agent = agentRunId ? this.agentRuntime.getRun(agentRunId) : undefined;
    run.phase = agent?.phase ?? 'failed';
    run.status = agent?.phase === 'completed'
      ? 'completed'
      : agent?.phase === 'stopped' ? 'stopped' : 'failed';
    run.completedAt = agent?.completedAt ?? new Date().toISOString();
    run.output = outputFor(this.sessionManager.get(run.childSessionId));
    run.error = agent?.error;
    run.attention = true;
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    this.publishParent(run, run.status === 'completed' ? 'subagent.completed' : 'subagent.failed');
  }

  private publishParent(
    run: SubagentRunSnapshot,
    type: 'subagent.started' | 'subagent.updated' | 'subagent.completed' | 'subagent.failed',
  ): void {
    this.agentRuntime.publishSessionEvent(run.parentSessionId, type, structuredClone(run));
  }

  private allowedTools(profile: SubagentProfile, depth: number): string[] | undefined {
    if (!profile.tools.length) return depth >= 3 ? this.agentRuntime.getTools('default')
      .map(tool => tool.name).filter(name => name !== 'spawn_subagent') : undefined;
    return depth >= 3 ? profile.tools.filter(name => name !== 'spawn_subagent') : profile.tools;
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
    const removable = [...this.runs.values()]
      .filter(run => TERMINAL_PHASES.has(run.status))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    while (this.runs.size > MAX_RUN_HISTORY && removable.length) {
      const run = removable.shift()!;
      this.runs.delete(run.id);
      this.childAgentRuns.delete(run.id);
    }
  }
}
