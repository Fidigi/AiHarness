import crypto from 'node:crypto';
import type { SessionManager } from '../sessions/session-manager.js';
import {
  createTemporaryProcessOutput,
  executeShellCommand,
  ProcessAbortedError,
  type ProcessOutputStream,
  type TemporaryProcessOutput,
} from './process-execution.js';

export interface ShellCommandEvent {
  sequence: number;
  type: 'output' | 'exit' | 'error' | 'cancelled';
  data: Record<string, unknown>;
}

export interface ShellCommandSnapshot {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  excludedFromContext: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  durationMs?: number;
  output: string;
  truncated: boolean;
  /** Local owner-only file retained for truncated output when the host opted in. */
  fullOutputPath?: string;
  lastSequence: number;
}

export interface StartShellCommandInput {
  sessionId: string;
  command: string;
  cwd: string;
  excludedFromContext: boolean;
}

export interface ShellCommandRuntimeOptions {
  maxOutputBytes?: number;
  maxEvents?: number;
  maxCommands?: number;
  commandTimeoutMs?: number;
  retainFullOutput?: boolean;
  fullOutputRetentionMs?: number;
  outputTruncation?: 'head' | 'tail';
  shellPath?: string | (() => string | undefined);
  commandPrefix?: string | (() => string | undefined);
}

interface ActiveCommand {
  snapshot: ShellCommandSnapshot;
  controller: AbortController;
  events: ShellCommandEvent[];
  listeners: Set<(event: ShellCommandEvent) => void>;
  outputEventBytes: number;
  done: Promise<void>;
  settled: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_MAX_COMMANDS = 256;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;
const SHELL_OUTPUT_PREFIX = 'ai-harness-shell-output-';

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive safe integer.`);
  return resolved;
}

function utf8Head(value: string, maximum: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximum) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maximum; end >= Math.max(0, maximum - 4); end--) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { /* Try the previous code-point boundary. */ }
  }
  return '';
}

function utf8Tail(value: string, maximum: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximum) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const minimum = Math.max(0, bytes.length - maximum);
  for (let start = minimum; start <= Math.min(bytes.length, minimum + 4); start++) {
    try { return decoder.decode(bytes.subarray(start)); } catch { /* Try the next code-point boundary. */ }
  }
  return '';
}

/**
 * Shared detached shell runtime used by the Web command API and the interactive
 * CLI. Interface adapters own trust checks and presentation; execution,
 * cancellation, bounds, persistence, and context policy stay in Core.
 */
export class ShellCommandRuntime {
  private readonly commands = new Map<string, ActiveCommand>();
  private readonly maxOutputBytes: number;
  private readonly maxEvents: number;
  private readonly maxCommands: number;
  private readonly commandTimeoutMs: number;
  private readonly retainFullOutput: boolean;
  private readonly fullOutputRetentionMs?: number;
  private readonly outputTruncation: 'head' | 'tail';
  private readonly shellPath?: string | (() => string | undefined);
  private readonly commandPrefix?: string | (() => string | undefined);

  constructor(
    private readonly sessions: SessionManager,
    options: ShellCommandRuntimeOptions = {},
  ) {
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes');
    this.maxEvents = positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS, 'maxEvents');
    this.maxCommands = positiveInteger(options.maxCommands, DEFAULT_MAX_COMMANDS, 'maxCommands');
    this.commandTimeoutMs = positiveInteger(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 'commandTimeoutMs');
    this.retainFullOutput = options.retainFullOutput === true;
    this.fullOutputRetentionMs = options.fullOutputRetentionMs;
    this.outputTruncation = options.outputTruncation ?? 'head';
    this.shellPath = options.shellPath;
    this.commandPrefix = options.commandPrefix;
  }

  start(
    input: StartShellCommandInput,
    listener?: (event: ShellCommandEvent) => void,
  ): ShellCommandSnapshot {
    if (!input.command.trim()) throw new Error('Shell command must not be empty.');
    if (input.command.length > 100_000) throw new Error('Shell command exceeds the 100000 character limit.');
    if (!input.sessionId || !input.cwd) throw new Error('Shell command session and cwd are required.');
    this.pruneCompleted();
    if (this.commands.size >= this.maxCommands) throw new Error('Too many shell commands are retained.');

    const id = crypto.randomUUID();
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
      controller: new AbortController(),
      events: [],
      listeners: new Set(listener ? [listener] : []),
      outputEventBytes: 0,
      done: Promise.resolve(),
      settled: false,
    };
    this.commands.set(id, active);
    active.done = this.execute(active).finally(() => { active.settled = true; });
    void active.done.catch(() => undefined);
    return this.clone(active.snapshot);
  }

  get(id: string): ShellCommandSnapshot | undefined {
    const active = this.commands.get(id);
    return active ? this.clone(active.snapshot) : undefined;
  }

  cancel(id: string): ShellCommandSnapshot | undefined {
    const active = this.commands.get(id);
    if (!active) return undefined;
    if (active.snapshot.status === 'running') {
      active.snapshot.status = 'cancelled';
      active.snapshot.exitCode = 130;
      active.controller.abort();
    }
    return this.clone(active.snapshot);
  }

  replay(id: string, after: number): ShellCommandEvent[] {
    return this.commands.get(id)?.events
      .filter(event => event.sequence > after)
      .map(event => structuredClone(event)) ?? [];
  }

  subscribe(id: string, listener: (event: ShellCommandEvent) => void): (() => void) | undefined {
    const active = this.commands.get(id);
    if (!active) return undefined;
    active.listeners.add(listener);
    return () => active.listeners.delete(listener);
  }

  async wait(id: string): Promise<ShellCommandSnapshot | undefined> {
    const active = this.commands.get(id);
    if (!active) return undefined;
    await active.done;
    return this.clone(active.snapshot);
  }

  async shutdown(): Promise<void> {
    const pending = [...this.commands.values()].filter(active => !active.settled);
    for (const active of pending) {
      if (active.snapshot.status === 'running') this.cancel(active.snapshot.id);
    }
    await Promise.all(pending.map(active => active.done));
  }

  private async execute(active: ActiveCommand): Promise<void> {
    let completeOutput: TemporaryProcessOutput | undefined;
    let terminalEvent: ShellCommandEvent['type'] = 'exit';
    let terminalData: Record<string, unknown> = {};
    try {
      if (this.retainFullOutput) {
        completeOutput = await createTemporaryProcessOutput({
          prefix: SHELL_OUTPUT_PREFIX,
          retentionMs: this.fullOutputRetentionMs,
        });
      }
      const result = await executeShellCommand({
        command: active.snapshot.command,
        cwd: active.snapshot.cwd,
        signal: active.controller.signal,
        timeoutMs: this.commandTimeoutMs,
        maxCaptureBytes: this.maxOutputBytes,
        shellPath: typeof this.shellPath === 'function' ? this.shellPath() : this.shellPath,
        commandPrefix: typeof this.commandPrefix === 'function' ? this.commandPrefix() : this.commandPrefix,
        onOutput: async (chunk, stream) => {
          await completeOutput?.write(chunk);
          this.output(active, chunk, stream);
        },
      });
      active.snapshot.durationMs = result.durationMs;
      active.snapshot.exitCode = result.exitCode;
      active.snapshot.truncated ||= result.captureTruncated;
      if (active.snapshot.status === 'running') {
        active.snapshot.status = result.exitCode === 0 ? 'completed' : 'failed';
      }
      terminalData = {
        exitCode: active.snapshot.exitCode,
        ...(result.timedOut ? { timedOut: true } : {}),
      };
    } catch (error) {
      if (error instanceof ProcessAbortedError || active.controller.signal.aborted) {
        const result = error instanceof ProcessAbortedError ? error.result : undefined;
        active.snapshot.status = 'cancelled';
        active.snapshot.exitCode = 130;
        active.snapshot.durationMs = result?.durationMs ?? Date.now() - new Date(active.snapshot.startedAt).getTime();
        active.snapshot.truncated ||= result?.captureTruncated ?? false;
        terminalEvent = 'cancelled';
        terminalData = { exitCode: 130 };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        active.snapshot.status = 'failed';
        active.snapshot.exitCode ??= 1;
        active.snapshot.durationMs ??= Date.now() - new Date(active.snapshot.startedAt).getTime();
        if (!active.snapshot.output) active.snapshot.output = message;
        terminalEvent = 'error';
        terminalData = { message, exitCode: active.snapshot.exitCode };
      }
    }

    try {
      const retainedPath = await completeOutput?.finalize(active.snapshot.truncated);
      if (retainedPath) active.snapshot.fullOutputPath = retainedPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      active.snapshot.status = 'failed';
      active.snapshot.exitCode ??= 1;
      terminalEvent = 'error';
      terminalData = { message, exitCode: active.snapshot.exitCode };
    }

    active.snapshot.completedAt = new Date().toISOString();
    this.publish(active, terminalEvent, terminalData);
    try {
      await this.sessions.addCommand(active.snapshot.sessionId, {
        id: `command-${active.snapshot.id}`,
        command: active.snapshot.command,
        cwd: active.snapshot.cwd,
        status: active.snapshot.status,
        output: active.snapshot.output,
        exitCode: active.snapshot.exitCode,
        durationMs: active.snapshot.durationMs,
        excludedFromContext: active.snapshot.excludedFromContext,
        truncated: active.snapshot.truncated,
        ...(active.snapshot.fullOutputPath ? { downloadPath: active.snapshot.fullOutputPath } : {}),
      });
    } catch (error) {
      active.snapshot.status = 'failed';
      this.publish(active, 'error', {
        message: error instanceof Error ? error.message : String(error),
        exitCode: active.snapshot.exitCode,
      });
    }
  }

  private output(active: ActiveCommand, chunk: string, stream: ProcessOutputStream): void {
    const previous = active.snapshot.output;
    const combined = `${previous}${chunk}`;
    const combinedBytes = Buffer.byteLength(combined, 'utf8');
    active.snapshot.output = this.outputTruncation === 'tail'
      ? utf8Tail(combined, this.maxOutputBytes)
      : utf8Head(combined, this.maxOutputBytes);
    if (combinedBytes > this.maxOutputBytes) active.snapshot.truncated = true;

    const remainingEventBytes = Math.max(0, this.maxOutputBytes - active.outputEventBytes);
    const eventChunk = utf8Head(chunk, remainingEventBytes);
    active.outputEventBytes += Buffer.byteLength(eventChunk, 'utf8');
    if (eventChunk !== chunk) active.snapshot.truncated = true;
    this.publish(active, 'output', {
      stream,
      chunk: eventChunk,
      truncated: active.snapshot.truncated,
    });
  }

  private publish(active: ActiveCommand, type: ShellCommandEvent['type'], data: Record<string, unknown>): void {
    const event: ShellCommandEvent = { sequence: ++active.snapshot.lastSequence, type, data };
    active.events.push(event);
    if (active.events.length > this.maxEvents) active.events.splice(0, active.events.length - this.maxEvents);
    for (const listener of active.listeners) {
      try { listener(structuredClone(event)); }
      catch { active.listeners.delete(listener); }
    }
  }

  private pruneCompleted(): void {
    if (this.commands.size < this.maxCommands) return;
    for (const [id, active] of this.commands) {
      if (active.settled) this.commands.delete(id);
      if (this.commands.size < this.maxCommands) return;
    }
  }

  private clone(snapshot: ShellCommandSnapshot): ShellCommandSnapshot {
    return structuredClone(snapshot);
  }
}
