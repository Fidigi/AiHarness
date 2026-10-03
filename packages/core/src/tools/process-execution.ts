import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TOOL_MAX_BYTES,
  formatToolBytes,
  truncateToolTail,
} from './truncation.js';

const DEFAULT_PROCESS_CAPTURE_BYTES = 10 * 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 500;
const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|PRIVATE_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?|COOKIE)(?:$|_)/i;

export type ProcessOutputStream = 'stdout' | 'stderr';

export interface ProcessExecutionResult {
  output: string;
  exitCode: number;
  durationMs: number;
  captureTruncated: boolean;
  timedOut: boolean;
}

export interface ExecuteProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  detached?: boolean;
  maxCaptureBytes?: number;
  /** Awaited for each chunk so protocol and persistence sinks can apply backpressure. */
  onOutput?(chunk: string, stream: ProcessOutputStream): void | Promise<void>;
  /** Adds the non-secret marker used by model-invocable command tools. */
  agentEnvironment?: boolean;
}

export interface ExecuteShellCommandOptions {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxCaptureBytes?: number;
  /** Optional Pi-compatible shell executable override. */
  shellPath?: string;
  /** Trusted prefix evaluated by the shell before the requested command. */
  commandPrefix?: string;
  agentEnvironment?: boolean;
  onOutput?(chunk: string, stream: ProcessOutputStream): void | Promise<void>;
}

export interface FormattedProcessOutput {
  content: string;
  details: {
    exitCode: number;
    durationMs: number;
    truncated: boolean;
    truncation?: ReturnType<typeof truncateToolTail>;
    timedOut?: true;
  };
}

export class ProcessAbortedError extends Error {
  constructor(readonly result: ProcessExecutionResult) {
    super('Operation aborted.');
    this.name = 'AbortError';
  }
}

/** Remove credential-like parent variables before any agent or direct shell process starts. */
export function filteredProcessEnvironment(agentEnvironment = false): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !SENSITIVE_ENV_NAME.test(name)),
    ),
    ...(agentEnvironment ? { AI_HARNESS_AGENT: '1' } : {}),
  };
}

function emptyAbortedResult(): ProcessExecutionResult {
  return {
    output: '',
    exitCode: 130,
    durationMs: 0,
    captureTruncated: false,
    timedOut: false,
  };
}

function terminateProcess(child: ReturnType<typeof spawn>, detached: boolean): NodeJS.Timeout | undefined {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  const signalTree = (force: boolean): void => {
    if (process.platform === 'win32' && child.pid) {
      try {
        const killer = spawn('taskkill.exe', [
          '/PID', String(child.pid), '/T', ...(force ? ['/F'] : []),
        ], {
          windowsHide: true,
          stdio: 'ignore',
          env: filteredProcessEnvironment(),
        });
        const fallback = (): void => {
          try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Process already exited. */ }
        };
        killer.once('error', fallback);
        killer.once('close', code => { if (code !== 0) fallback(); });
        killer.unref();
        return;
      } catch { /* Fall through to the direct child signal. */ }
    }
    try {
      if (detached && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      else child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Process already exited. */ }
    }
  };
  signalTree(false);
  const force = setTimeout(() => signalTree(true), PROCESS_KILL_GRACE_MS);
  force.unref();
  return force;
}

function boundedUtf8Tail(chunks: Buffer[], bytes: number, maximum: number): {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
} {
  let nextBytes = bytes;
  let truncated = false;
  while (nextBytes > maximum && chunks.length) {
    const excess = nextBytes - maximum;
    const first = chunks[0]!;
    if (first.length <= excess) {
      chunks.shift();
      nextBytes -= first.length;
    } else {
      chunks[0] = first.subarray(excess);
      nextBytes -= excess;
    }
    truncated = true;
  }
  if (truncated && chunks.length) {
    const first = chunks[0]!;
    let offset = 0;
    while (offset < first.length && (first[offset]! & 0xc0) === 0x80) offset++;
    if (offset > 0) {
      chunks[0] = first.subarray(offset);
      nextBytes -= offset;
    }
  }
  return { chunks, bytes: nextBytes, truncated };
}

/**
 * Execute one process with bounded capture, ordered output backpressure, secret-filtered
 * environment, timeout, and process-tree cancellation.
 */
export async function executeProcess(input: ExecuteProcessOptions): Promise<ProcessExecutionResult> {
  if (input.signal?.aborted) throw new ProcessAbortedError(emptyAbortedResult());
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error('Process timeout must be a positive safe integer.');
  }
  const maxCaptureBytes = input.maxCaptureBytes ?? DEFAULT_PROCESS_CAPTURE_BYTES;
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1) {
    throw new Error('Process capture limit must be a positive safe integer.');
  }

  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const detached = Boolean(input.detached && process.platform !== 'win32');
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      detached,
      windowsHide: true,
      env: filteredProcessEnvironment(input.agentEnvironment),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capturedChunks: Buffer[] = [];
    let capturedBytes = 0;
    let captureTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    let outputError: Error | undefined;
    let outputTail = Promise.resolve();

    const capturedOutput = (): string => Buffer.concat(capturedChunks, capturedBytes).toString('utf8');
    const append = (stream: NodeJS.ReadableStream, chunk: string, source: ProcessOutputStream): void => {
      const buffer = Buffer.from(chunk, 'utf8');
      capturedChunks.push(buffer);
      capturedBytes += buffer.length;
      const bounded = boundedUtf8Tail(capturedChunks, capturedBytes, maxCaptureBytes);
      capturedBytes = bounded.bytes;
      captureTruncated ||= bounded.truncated;
      if (!input.onOutput) return;
      stream.pause();
      outputTail = outputTail
        .then(async () => {
          if (!outputError) await input.onOutput?.(chunk, source);
        })
        .catch(error => {
          outputError ??= error instanceof Error ? error : new Error(String(error));
          forceKill ??= terminateProcess(child, detached);
        })
        .finally(() => stream.resume());
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      input.signal?.removeEventListener('abort', abort);
    };
    const abort = (): void => {
      aborted = true;
      forceKill ??= terminateProcess(child, detached);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      forceKill ??= terminateProcess(child, detached);
    }, input.timeoutMs);
    timeout.unref();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => append(child.stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk: string) => append(child.stderr, chunk, 'stderr'));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', code => {
      void outputTail.then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (outputError) {
          reject(outputError);
          return;
        }
        const result: ProcessExecutionResult = {
          output: capturedOutput(),
          exitCode: aborted ? 130 : timedOut ? 124 : code ?? 1,
          durationMs: Date.now() - startedAt,
          captureTruncated,
          timedOut: timedOut && !aborted,
        };
        if (aborted) reject(new ProcessAbortedError(result));
        else resolve(result);
      });
    });
  });
}

/** Execute a direct user shell command with platform defaults or a trusted settings override. */
export function executeShellCommand(input: ExecuteShellCommandOptions): Promise<ProcessExecutionResult> {
  const windows = process.platform === 'win32';
  const configuredShell = input.shellPath?.trim();
  const shellPath = configuredShell?.startsWith('~/')
    ? path.join(os.homedir(), configuredShell.slice(2))
    : configuredShell;
  const executable = shellPath || (windows ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash');
  const command = input.commandPrefix?.trim()
    ? `${input.commandPrefix}\n${input.command}`
    : input.command;
  return executeProcess({
    executable,
    args: windows && !shellPath ? ['/d', '/s', '/c', command] : ['-lc', command],
    cwd: input.cwd,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    detached: true,
    maxCaptureBytes: input.maxCaptureBytes,
    onOutput: input.onOutput,
    agentEnvironment: input.agentEnvironment,
  });
}

export function formatProcessOutput(
  result: ProcessExecutionResult,
  empty = '(no output)',
): FormattedProcessOutput {
  const truncation = truncateToolTail(result.output);
  let content = truncation.content || empty;
  const notices: string[] = [];
  if (result.captureTruncated) notices.push('Process output exceeded the capture limit; the beginning was discarded');
  if (truncation.truncated) {
    notices.push(`Showing the last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatToolBytes(DEFAULT_TOOL_MAX_BYTES)} limit)`);
  }
  if (result.timedOut) notices.push('Command timed out');
  if (result.exitCode !== 0 && !result.timedOut) notices.push(`Command exited with code ${result.exitCode}`);
  if (notices.length) content += `\n\n[${notices.join('. ')}]`;
  return {
    content,
    details: {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.captureTruncated || truncation.truncated,
      ...(truncation.truncated ? { truncation } : {}),
      ...(result.timedOut ? { timedOut: true as const } : {}),
    },
  };
}

export interface TemporaryProcessOutput {
  readonly filePath: string;
  write(chunk: string): Promise<void>;
  /** Close the file, retaining it for the configured period only when requested. */
  finalize(retain: boolean): Promise<string | undefined>;
}

export interface TemporaryProcessOutputOptions {
  prefix?: string;
  retentionMs?: number;
}

export const DEFAULT_PROCESS_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_PROCESS_OUTPUT_PREFIX = 'ai-harness-process-output-';

function validateOutputOptions(options: TemporaryProcessOutputOptions): { prefix: string; retentionMs: number } {
  const prefix = options.prefix ?? DEFAULT_PROCESS_OUTPUT_PREFIX;
  const retentionMs = options.retentionMs ?? DEFAULT_PROCESS_OUTPUT_RETENTION_MS;
  if (!/^[A-Za-z0-9._-]+-$/.test(prefix)) throw new Error('Temporary process output prefix is invalid.');
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) {
    throw new Error('Temporary process output retention must be a positive safe integer.');
  }
  return { prefix, retentionMs };
}

export async function cleanupExpiredProcessOutputs(options: TemporaryProcessOutputOptions = {}): Promise<void> {
  const { prefix, retentionMs } = validateOutputOptions(options);
  const temporaryDirectory = os.tmpdir();
  const names = await readdir(temporaryDirectory).catch(() => []);
  const expiry = Date.now() - retentionMs;
  await Promise.all(names.filter(name => name.startsWith(prefix)).map(async name => {
    const outputDirectory = path.join(temporaryDirectory, name);
    const stats = await lstat(outputDirectory).catch(() => undefined);
    if (stats?.isDirectory() && !stats.isSymbolicLink() && stats.mtimeMs < expiry) {
      await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }));
}

function scheduleOutputRemoval(outputDirectory: string, retentionMs: number): void {
  const timer = setTimeout(() => {
    void rm(outputDirectory, { recursive: true, force: true });
  }, retentionMs);
  timer.unref();
}

export async function createTemporaryProcessOutput(
  options: TemporaryProcessOutputOptions = {},
): Promise<TemporaryProcessOutput> {
  const { prefix, retentionMs } = validateOutputOptions(options);
  await cleanupExpiredProcessOutputs({ prefix, retentionMs });
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(outputDirectory, 0o700);
  const filePath = path.join(outputDirectory, 'output.log');
  let handle: FileHandle | undefined = await open(filePath, 'wx', 0o600).catch(async error => {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  });
  let writeTail = Promise.resolve();
  let finalized: Promise<string | undefined> | undefined;

  return {
    filePath,
    write(chunk: string): Promise<void> {
      if (!handle || finalized) return Promise.reject(new Error('Temporary process output is already closed.'));
      const operation = writeTail.then(async () => { await handle!.write(chunk); });
      writeTail = operation.catch(() => undefined);
      return operation;
    },
    finalize(retain: boolean): Promise<string | undefined> {
      finalized ??= (async () => {
        await writeTail;
        const activeHandle = handle;
        handle = undefined;
        await activeHandle?.close();
        if (!retain) {
          await rm(outputDirectory, { recursive: true, force: true });
          return undefined;
        }
        scheduleOutputRemoval(outputDirectory, retentionMs);
        return filePath;
      })();
      return finalized;
    },
  };
}
