import process from 'node:process';
import * as pty from 'node-pty';

export type TerminalStatus = 'running' | 'exited' | 'killed' | 'failed';

export interface TerminalSnapshot {
  id: string;
  cwd: string;
  name: string;
  shell: string;
  pid: number;
  cols: number;
  rows: number;
  status: TerminalStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: number;
  lastOffset: number;
}

export interface TerminalOutputEvent {
  type: 'output';
  terminalId: string;
  offset: number;
  endOffset: number;
  data: string;
  timestamp: string;
}

export interface TerminalExitEvent {
  type: 'exit';
  terminalId: string;
  offset: number;
  endOffset: number;
  exitCode: number;
  signal?: number;
  timestamp: string;
}

export type TerminalEvent = TerminalOutputEvent | TerminalExitEvent;

export interface TerminalReplay {
  events: TerminalEvent[];
  reset: boolean;
  oldestOffset: number;
  lastOffset: number;
}

export interface PseudoTerminal {
  readonly pid: number;
  readonly process: string;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface TerminalOutputRedactionStream {
  push(chunk: string): string;
  flush(): string;
}

export type SpawnPseudoTerminal = (
  file: string,
  args: string[] | string,
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PseudoTerminal;

interface TerminalRecord {
  snapshot: TerminalSnapshot;
  terminal: PseudoTerminal;
  events: TerminalEvent[];
  bufferedBytes: number;
  listeners: Set<(event: TerminalEvent) => void>;
  disposables: Array<{ dispose(): void }>;
  redaction?: TerminalOutputRedactionStream;
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'powershell.exe', args: [] };
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-l'] };
}

function safeEnvironment(cwd: string): Record<string, string> {
  // A browser terminal must not turn provider/server credentials into readable shell variables.
  const allowed = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ',
    'TMPDIR', 'TMP', 'TEMP', 'TERM', 'COLORTERM',
    // Variables required by the default Windows shells and user profile lookup.
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  ]);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && (allowed.has(key.toUpperCase()) || /^LC_[A-Z_]+$/i.test(key))) {
      environment[key] = value;
    }
  }
  environment.PWD = cwd;
  environment.TERM = environment.TERM || 'xterm-256color';
  environment.COLORTERM = environment.COLORTERM || 'truecolor';
  return environment;
}

function cloneSnapshot(snapshot: TerminalSnapshot): TerminalSnapshot {
  return { ...snapshot };
}

/**
 * In-process PTY owner with bounded output replay. Terminals are intentionally
 * detached from HTTP requests, but are killed during server shutdown.
 */
export class TerminalRuntime {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(
    private readonly options: {
      maxReplayBytes?: number;
      maxTerminals?: number;
      maxRecords?: number;
      maxListenersPerTerminal?: number;
      spawn?: SpawnPseudoTerminal;
      createRedactionStream?: () => TerminalOutputRedactionStream;
    } = {},
  ) {}

  create(input: { cwd: string; name?: string; cols?: number; rows?: number }): TerminalSnapshot {
    this.pruneCompleted();
    const maxRecords = this.boundedOption(this.options.maxRecords, 100, 1, 10_000);
    if (this.terminals.size >= maxRecords) {
      throw Object.assign(new Error('Limite de terminaux conservés atteinte.'), {
        status: 429,
        code: 'TERMINAL_RECORD_LIMIT_REACHED',
      });
    }
    const running = [...this.terminals.values()].filter(record => record.snapshot.status === 'running');
    const maxTerminals = this.boundedOption(this.options.maxTerminals, 12, 1, 128);
    if (running.length >= maxTerminals) {
      throw Object.assign(new Error(`Limite de ${maxTerminals} terminaux actifs atteinte.`), {
        status: 429,
        code: 'TERMINAL_LIMIT_REACHED',
      });
    }

    const cols = Math.max(20, Math.min(500, Math.floor(input.cols ?? 100)));
    const rows = Math.max(5, Math.min(200, Math.floor(input.rows ?? 30)));
    const shell = defaultShell();
    const spawn = this.options.spawn ?? ((file, args, options) => pty.spawn(file, args, options));
    const terminal = spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: input.cwd,
      env: safeEnvironment(input.cwd),
    });
    const id = crypto.randomUUID();
    const snapshot: TerminalSnapshot = {
      id,
      cwd: input.cwd,
      name: input.name?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, 80)
        || `Terminal ${this.terminals.size + 1}`,
      shell: terminal.process || shell.file,
      pid: terminal.pid,
      cols,
      rows,
      status: 'running',
      startedAt: new Date().toISOString(),
      lastOffset: 0,
    };
    const record: TerminalRecord = {
      snapshot,
      terminal,
      events: [],
      bufferedBytes: 0,
      listeners: new Set(),
      disposables: [],
      redaction: this.options.createRedactionStream?.(),
    };
    record.disposables.push(terminal.onData(data => this.appendOutput(record, data)));
    record.disposables.push(terminal.onExit(event => this.complete(record, event.exitCode, event.signal)));
    this.terminals.set(id, record);
    return cloneSnapshot(snapshot);
  }

  list(cwd?: string): TerminalSnapshot[] {
    return [...this.terminals.values()]
      .filter(record => !cwd || record.snapshot.cwd === cwd)
      .map(record => cloneSnapshot(record.snapshot))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  get(id: string): TerminalSnapshot | undefined {
    const record = this.terminals.get(id);
    return record ? cloneSnapshot(record.snapshot) : undefined;
  }

  write(id: string, data: string): TerminalSnapshot {
    const record = this.requireRunning(id);
    if (!data || Buffer.byteLength(data, 'utf8') > 64 * 1024) {
      throw Object.assign(new Error('Saisie terminal invalide ou trop volumineuse.'), { status: 400 });
    }
    record.terminal.write(data);
    return cloneSnapshot(record.snapshot);
  }

  resize(id: string, cols: number, rows: number): TerminalSnapshot {
    const record = this.requireRunning(id);
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)
      || cols < 20 || cols > 500 || rows < 5 || rows > 200) {
      throw Object.assign(new Error('Dimensions terminal invalides.'), { status: 400 });
    }
    record.terminal.resize(cols, rows);
    record.snapshot.cols = cols;
    record.snapshot.rows = rows;
    return cloneSnapshot(record.snapshot);
  }

  kill(id: string): TerminalSnapshot {
    const record = this.terminals.get(id);
    if (!record) throw Object.assign(new Error('Terminal introuvable.'), { status: 404 });
    if (record.snapshot.status === 'running') {
      record.snapshot.status = 'killed';
      record.snapshot.completedAt = new Date().toISOString();
      try { record.terminal.kill(); } catch { /* The PTY may have exited concurrently. */ }
    }
    return cloneSnapshot(record.snapshot);
  }

  remove(id: string): boolean {
    const record = this.terminals.get(id);
    if (!record) return false;
    if (record.snapshot.status === 'running') this.kill(id);
    this.flushOutput(record);
    for (const disposable of record.disposables) disposable.dispose();
    record.listeners.clear();
    return this.terminals.delete(id);
  }

  replay(id: string, after = 0): TerminalReplay {
    const record = this.terminals.get(id);
    if (!record) throw Object.assign(new Error('Terminal introuvable.'), { status: 404 });
    if (!Number.isSafeInteger(after) || after < 0) {
      throw Object.assign(new Error('Offset terminal invalide.'), { status: 400 });
    }
    const oldestOffset = record.events[0]?.offset ?? record.snapshot.lastOffset;
    return {
      events: record.events.filter(event => event.endOffset > after).map(event => ({ ...event })),
      reset: after > 0 && after < oldestOffset,
      oldestOffset,
      lastOffset: record.snapshot.lastOffset,
    };
  }

  subscribe(id: string, listener: (event: TerminalEvent) => void): () => void {
    const record = this.terminals.get(id);
    if (!record) throw Object.assign(new Error('Terminal introuvable.'), { status: 404 });
    const maxListeners = this.boundedOption(this.options.maxListenersPerTerminal, 64, 1, 1_024);
    if (record.listeners.size >= maxListeners) {
      throw Object.assign(new Error('Trop d’abonnés pour ce terminal.'), { status: 429 });
    }
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  shutdown(): void {
    for (const id of [...this.terminals.keys()]) this.remove(id);
  }

  private appendOutput(record: TerminalRecord, data: string): void {
    if (!data) return;
    this.appendSafeOutput(record, record.redaction?.push(data) ?? data);
  }

  private appendSafeOutput(record: TerminalRecord, data: string): void {
    if (!data) return;
    const size = Buffer.byteLength(data, 'utf8');
    const event: TerminalOutputEvent = {
      type: 'output',
      terminalId: record.snapshot.id,
      offset: record.snapshot.lastOffset,
      endOffset: record.snapshot.lastOffset + size,
      data,
      timestamp: new Date().toISOString(),
    };
    record.snapshot.lastOffset = event.endOffset;
    this.append(record, event, size);
  }

  private flushOutput(record: TerminalRecord): void {
    this.appendSafeOutput(record, record.redaction?.flush() ?? '');
  }

  private complete(record: TerminalRecord, exitCode: number, signal?: number): void {
    this.flushOutput(record);
    if (record.snapshot.status === 'running') record.snapshot.status = exitCode === 0 ? 'exited' : 'failed';
    record.snapshot.exitCode = exitCode;
    if (signal !== undefined) record.snapshot.signal = signal;
    record.snapshot.completedAt ??= new Date().toISOString();
    const event: TerminalExitEvent = {
      type: 'exit',
      terminalId: record.snapshot.id,
      offset: record.snapshot.lastOffset,
      endOffset: record.snapshot.lastOffset,
      exitCode,
      ...(signal !== undefined ? { signal } : {}),
      timestamp: record.snapshot.completedAt,
    };
    this.append(record, event, 0);
    this.pruneCompleted();
  }

  private append(record: TerminalRecord, event: TerminalEvent, bytes: number): void {
    record.events.push(event);
    record.bufferedBytes += bytes;
    const maxBytes = this.boundedOption(this.options.maxReplayBytes, 2 * 1024 * 1024, 1, 64 * 1024 * 1024);
    while (record.events.length > 0 && record.bufferedBytes > maxBytes) {
      const removed = record.events.shift()!;
      if (removed.type === 'output') record.bufferedBytes -= Buffer.byteLength(removed.data, 'utf8');
    }
    for (const listener of record.listeners) listener({ ...event });
  }

  private pruneCompleted(): void {
    const maxRecords = this.boundedOption(this.options.maxRecords, 100, 1, 10_000);
    while (this.terminals.size >= maxRecords) {
      const completed = [...this.terminals].find(([, record]) => record.snapshot.status !== 'running');
      if (!completed) break;
      this.remove(completed[0]);
    }
  }

  private boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
    return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback;
  }

  private requireRunning(id: string): TerminalRecord {
    const record = this.terminals.get(id);
    if (!record) throw Object.assign(new Error('Terminal introuvable.'), { status: 404 });
    if (record.snapshot.status !== 'running') {
      throw Object.assign(new Error('Le terminal est terminé.'), { status: 409 });
    }
    return record;
  }
}
