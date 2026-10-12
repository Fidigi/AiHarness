import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdtemp, open, rename, rm, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readStableDirectoryEntries } from '../security/stable-directory.js';
import {
  DEFAULT_TOOL_MAX_BYTES,
  formatToolBytes,
  truncateToolTail,
} from './truncation.js';

const DEFAULT_PROCESS_CAPTURE_BYTES = 10 * 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 500;
const MAX_PROCESS_TIMEOUT_MS = 60 * 60_000;
const MAX_PROCESS_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_ARGUMENTS = 4_096;
const MAX_PROCESS_ARGUMENT_BYTES = 1024 * 1024;
const PROCESS_OUTPUT_SINK_TIMEOUT_MS = 5_000;
const MAX_TEMPORARY_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_TEMPORARY_OUTPUT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|PRIVATE_?KEY|MASTER_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?|COOKIE|DSN|CONNECTION_?STRING)(?:$|_)/i;
const SENSITIVE_ENV_CHANNEL = /^(?:HTTP|HTTPS|ALL)_PROXY$|^SSH_AUTH_SOCK$/i;
const SENSITIVE_URL_PARAMETER = /(?:^|_)(?:token|secret|password|passwd|api_?key|credential)(?:$|_)/i;

/** Classify inherited process variables that can act as credential channels. */
export function isSensitiveEnvironmentEntry(name: string, value: string | undefined): boolean {
  if (SENSITIVE_ENV_NAME.test(name) || SENSITIVE_ENV_CHANNEL.test(name)) return true;
  if (!value) return false;
  // Oversized inherited values are unusual and cannot be inspected safely within the
  // environment-classification budget, so fail closed instead of forwarding them.
  if (value.length > 64 * 1024) return true;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return true;
    for (const key of parsed.searchParams.keys()) if (SENSITIVE_URL_PARAMETER.test(key)) return true;
  } catch {
    if (/(?:^|[;\s])(?:password|passwd|token|secret|api_?key)\s*=/iu.test(value)) return true;
  }
  return false;
}

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
  /** Optional shell executable override. */
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
      Object.entries(process.env).filter(([name, value]) => !isSensitiveEnvironmentEntry(name, value)),
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
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
    || input.timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new Error('Process timeout must be a bounded positive safe integer.');
  }
  const maxCaptureBytes = input.maxCaptureBytes ?? DEFAULT_PROCESS_CAPTURE_BYTES;
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1
    || maxCaptureBytes > MAX_PROCESS_CAPTURE_BYTES) {
    throw new Error('Process capture limit must be a bounded positive safe integer.');
  }
  if (typeof input.executable !== 'string' || !input.executable
    || Buffer.byteLength(input.executable) > 32 * 1024 || input.executable.includes('\0')
    || typeof input.cwd !== 'string' || !input.cwd || Buffer.byteLength(input.cwd) > 32 * 1024
    || input.cwd.includes('\0') || !Array.isArray(input.args) || input.args.length > MAX_PROCESS_ARGUMENTS) {
    throw new Error('Process invocation is invalid.');
  }
  let argumentBytes = 0;
  for (const argument of input.args) {
    if (typeof argument !== 'string' || argument.includes('\0')) throw new Error('Process invocation is invalid.');
    argumentBytes += Buffer.byteLength(argument);
    if (argumentBytes > MAX_PROCESS_ARGUMENT_BYTES) throw new Error('Process invocation is invalid.');
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
    let forcedCompletion: NodeJS.Timeout | undefined;
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
          if (outputError || !input.onOutput) return;
          let timer: NodeJS.Timeout | undefined;
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Process output sink timed out.')),
              PROCESS_OUTPUT_SINK_TIMEOUT_MS);
            timer.unref?.();
          });
          try { await Promise.race([Promise.resolve(input.onOutput(chunk, source)), deadline]); }
          finally { if (timer) clearTimeout(timer); }
        })
        .catch(error => {
          outputError ??= error instanceof Error ? error : new Error(String(error));
          forceKill ??= terminateProcess(child, detached);
          scheduleForcedCompletion();
        })
        .finally(() => stream.resume());
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (forcedCompletion) clearTimeout(forcedCompletion);
      input.signal?.removeEventListener('abort', abort);
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
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
    };
    const scheduleForcedCompletion = (): void => {
      if (forcedCompletion || settled) return;
      forcedCompletion = setTimeout(() => finish(child.exitCode), PROCESS_KILL_GRACE_MS + 1_000);
      forcedCompletion.unref?.();
    };
    const abort = (): void => {
      aborted = true;
      forceKill ??= terminateProcess(child, detached);
      scheduleForcedCompletion();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      forceKill ??= terminateProcess(child, detached);
      scheduleForcedCompletion();
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
      void outputTail.then(() => finish(code)).catch(error => {
        outputError ??= error instanceof Error ? error : new Error(String(error));
        finish(code);
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
  if (!/^[A-Za-z0-9._-]+-$/u.test(prefix) || Buffer.byteLength(prefix) > 64) {
    throw new Error('Temporary process output prefix is invalid.');
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1
    || retentionMs > MAX_TEMPORARY_OUTPUT_RETENTION_MS) {
    throw new Error('Temporary process output retention must be a bounded positive safe integer.');
  }
  return { prefix, retentionMs };
}

interface TemporaryDirectoryIdentity { dev: number | bigint; ino: number | bigint }

async function removeIdentifiedOutputDirectory(
  outputDirectory: string,
  expected: TemporaryDirectoryIdentity,
): Promise<void> {
  const quarantine = path.join(
    path.dirname(outputDirectory),
    `.${path.basename(outputDirectory)}.cleanup-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  try {
    await rename(outputDirectory, quarantine);
  } catch {
    return;
  }
  const claimed = await lstat(quarantine).catch(() => undefined);
  if (!claimed?.isDirectory() || claimed.isSymbolicLink()
    || claimed.dev !== expected.dev || claimed.ino !== expected.ino) {
    // Never delete an entry that replaced the snapshotted directory. Best-effort
    // restoration avoids disrupting a concurrently created legitimate output.
    const sourceExists = await lstat(outputDirectory).then(() => true, () => false);
    if (!sourceExists) await rename(quarantine, outputDirectory).catch(() => undefined);
    return;
  }
  await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
}

export async function cleanupExpiredProcessOutputs(options: TemporaryProcessOutputOptions = {}): Promise<void> {
  const { prefix, retentionMs } = validateOutputOptions(options);
  const temporaryDirectory = os.tmpdir();
  const expiry = Date.now() - retentionMs;
  const listing = await readStableDirectoryEntries(temporaryDirectory, 10_000).catch(() => undefined);
  if (!listing || listing.truncated) return;
  for (const entry of listing.entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const outputDirectory = path.join(temporaryDirectory, entry.name);
    const stats = await lstat(outputDirectory).catch(() => undefined);
    if (stats?.isDirectory() && !stats.isSymbolicLink() && stats.mtimeMs < expiry
      && (typeof process.getuid !== 'function' || stats.uid === process.getuid())) {
      await removeIdentifiedOutputDirectory(outputDirectory, stats);
    }
  }
}

function scheduleOutputRemoval(
  outputDirectory: string,
  retentionMs: number,
  identity: TemporaryDirectoryIdentity,
): void {
  const timer = setTimeout(() => {
    void removeIdentifiedOutputDirectory(outputDirectory, identity);
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
  const directoryIdentity = await lstat(outputDirectory);
  if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()
    || (typeof process.getuid === 'function' && directoryIdentity.uid !== process.getuid())) {
    throw new Error('Temporary process output directory is unsafe.');
  }
  const filePath = path.join(outputDirectory, 'output.log');
  let handle: FileHandle | undefined = await open(filePath, 'wx', 0o600).catch(async error => {
    await removeIdentifiedOutputDirectory(outputDirectory, directoryIdentity);
    throw error;
  });
  let writeTail = Promise.resolve();
  let writtenBytes = 0;
  let outputExceeded = false;
  let writeFailed = false;
  let finalized: Promise<string | undefined> | undefined;

  return {
    filePath,
    write(chunk: string): Promise<void> {
      if (!handle || finalized) return Promise.reject(new Error('Temporary process output is already closed.'));
      if (typeof chunk !== 'string' || Buffer.byteLength(chunk) > 1024 * 1024) {
        return Promise.reject(new Error('Temporary process output chunk is invalid.'));
      }
      const operation = writeTail.then(async () => {
        const bytes = Buffer.byteLength(chunk);
        if (writeFailed || outputExceeded || writtenBytes + bytes > MAX_TEMPORARY_OUTPUT_BYTES) {
          outputExceeded = true;
          throw new Error('Temporary process output exceeded its size limit.');
        }
        await handle!.writeFile(chunk);
        writtenBytes += bytes;
      });
      writeTail = operation.catch(() => { writeFailed = true; });
      return operation;
    },
    finalize(retain: boolean): Promise<string | undefined> {
      finalized ??= (async () => {
        await writeTail;
        const activeHandle = handle;
        handle = undefined;
        await activeHandle?.close();
        if (!retain) {
          await removeIdentifiedOutputDirectory(outputDirectory, directoryIdentity);
          return undefined;
        }
        scheduleOutputRemoval(outputDirectory, retentionMs, directoryIdentity);
        return filePath;
      })();
      return finalized;
    },
  };
}
