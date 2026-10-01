import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import type { SessionManager } from '@ai-harness/core';

export interface CommandEvent {
  sequence: number;
  type: 'output' | 'exit' | 'error' | 'cancelled';
  data: Record<string, unknown>;
}

export interface CommandSnapshot {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  excludedFromContext: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  output: string;
  truncated: boolean;
  lastSequence: number;
}

interface ActiveCommand {
  snapshot: CommandSnapshot;
  process: ChildProcessWithoutNullStreams;
  events: CommandEvent[];
  listeners: Set<(event: CommandEvent) => void>;
  persisted: boolean;
}

const MAX_OUTPUT = 1_000_000;
const MAX_EVENTS = 2_000;

/** Detached, replayable shell process runtime. Commands never inherit request lifetimes. */
export class CommandRuntime {
  private readonly commands = new Map<string, ActiveCommand>();

  constructor(private readonly sessions: SessionManager) {}

  start(input: {
    sessionId: string;
    command: string;
    cwd: string;
    excludedFromContext: boolean;
  }): CommandSnapshot {
    const id = crypto.randomUUID();
    const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, PWD: input.cwd },
      stdio: 'pipe',
    });
    const active: ActiveCommand = {
      snapshot: {
        id,
        sessionId: input.sessionId,
        command: input.command,
        cwd: input.cwd,
        excludedFromContext: input.excludedFromContext,
        status: 'running',
        startedAt: new Date().toISOString(),
        output: '',
        truncated: false,
        lastSequence: 0,
      },
      process: child,
      events: [],
      listeners: new Set(),
      persisted: false,
    };
    this.commands.set(id, active);
    child.stdout.on('data', chunk => this.output(active, String(chunk), 'stdout'));
    child.stderr.on('data', chunk => this.output(active, String(chunk), 'stderr'));
    child.on('error', error => {
      active.snapshot.status = 'failed';
      this.publish(active, 'error', { message: error.message });
      void this.finish(active);
    });
    child.on('close', (code, signal) => {
      if (active.snapshot.status === 'running') {
        active.snapshot.status = code === 0 ? 'completed' : 'failed';
        active.snapshot.exitCode = code ?? (signal ? 128 : 1);
      }
      this.publish(active, active.snapshot.status === 'cancelled' ? 'cancelled' : 'exit', {
        exitCode: active.snapshot.exitCode,
        signal,
      });
      void this.finish(active);
    });
    return this.clone(active.snapshot);
  }

  get(id: string): CommandSnapshot | undefined {
    const active = this.commands.get(id);
    return active ? this.clone(active.snapshot) : undefined;
  }

  cancel(id: string): CommandSnapshot | undefined {
    const active = this.commands.get(id);
    if (!active) return undefined;
    if (active.snapshot.status === 'running') {
      active.snapshot.status = 'cancelled';
      active.snapshot.exitCode = 130;
      active.process.kill('SIGTERM');
    }
    return this.clone(active.snapshot);
  }

  replay(id: string, after: number): CommandEvent[] {
    return this.commands.get(id)?.events.filter(event => event.sequence > after).map(event => structuredClone(event)) ?? [];
  }

  subscribe(id: string, listener: (event: CommandEvent) => void): (() => void) | undefined {
    const active = this.commands.get(id);
    if (!active) return undefined;
    active.listeners.add(listener);
    return () => active.listeners.delete(listener);
  }

  private output(active: ActiveCommand, chunk: string, stream: 'stdout' | 'stderr'): void {
    const room = MAX_OUTPUT - active.snapshot.output.length;
    if (room > 0) active.snapshot.output += chunk.slice(0, room);
    if (chunk.length > room) active.snapshot.truncated = true;
    this.publish(active, 'output', { stream, chunk: room > 0 ? chunk.slice(0, room) : '', truncated: active.snapshot.truncated });
  }

  private publish(active: ActiveCommand, type: CommandEvent['type'], data: Record<string, unknown>): void {
    const event: CommandEvent = { sequence: ++active.snapshot.lastSequence, type, data };
    active.events.push(event);
    if (active.events.length > MAX_EVENTS) active.events.splice(0, active.events.length - MAX_EVENTS);
    for (const listener of active.listeners) listener(structuredClone(event));
  }

  private async finish(active: ActiveCommand): Promise<void> {
    if (active.persisted) return;
    active.persisted = true;
    active.snapshot.completedAt = new Date().toISOString();
    await this.sessions.addCommand(active.snapshot.sessionId, {
      id: `command-${active.snapshot.id}`,
      command: active.snapshot.command,
      cwd: active.snapshot.cwd,
      status: active.snapshot.status,
      output: active.snapshot.output,
      exitCode: active.snapshot.exitCode,
      durationMs: new Date(active.snapshot.completedAt).getTime() - new Date(active.snapshot.startedAt).getTime(),
      excludedFromContext: active.snapshot.excludedFromContext,
      truncated: active.snapshot.truncated,
    });
  }

  private clone(snapshot: CommandSnapshot): CommandSnapshot {
    return structuredClone(snapshot);
  }
}
