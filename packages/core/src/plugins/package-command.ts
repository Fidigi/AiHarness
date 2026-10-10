import { spawn } from 'node:child_process';
import path from 'node:path';
import type { PluginCommandRunner } from './plugin-service.js';
import type { ResolvedAgentSettings } from '../config/agent-settings.js';
import { filteredProcessEnvironment } from '../tools/process-execution.js';

/** Host-only explicit process choice for one exact canonical declaring workspace.
 * Never derive this from cached/resolved trust or copy it from an HTTP request.
 */
export interface PluginNpmSourceTrustOverride {
  readonly cwd: string;
  readonly trusted: boolean;
}

export interface PluginNpmCommandOptions {
  /** Executable followed by literal prefix argv; never a shell command string.
   * Explicit host options without source provenance are privileged operator policy,
   * not implicit authority to execute project settings.
   */
  readonly npmCommand?: readonly string[];
  /** Explicit relative executable paths resolve here, not in the installation staging cwd. */
  readonly npmCommandBaseDirectory?: string;
  /** Loader diagnostics made executable selection unsafe; checked lazily, never by catalogue reads. */
  readonly npmCommandBlocked?: boolean;
  /** Project-selected executable OR prefix: Core validates this canonical source at
   * every npm/Git boundary, then uses an exact explicit override or fresh saved trust.
   * Neither target package scope/cwd nor a projectTrusted input can authorize it.
   */
  readonly npmCommandSourceWorkspace?: string;
  /** Privileged host policy only; true/false outranks saved trust for the exact source.
   * An orphan, malformed, inherited or mismatched override fails closed.
   */
  readonly npmCommandSourceTrustOverride?: PluginNpmSourceTrustOverride;
}

const MAX_COMMAND_ITEMS = 64;
const MAX_ITEM_BYTES = 4_096;
const MAX_COMMAND_BYTES = 32 * 1024;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/;

function invalidCommand(): Error {
  return Object.assign(new Error('Invalid npmCommand: expected bounded executable and literal argv.'), {
    status: 400, code: 'INVALID_PLUGIN_NPM_COMMAND',
  });
}

export function pluginNpmSourceTrustFailure(): Error {
  return Object.assign(new Error('Le workspace source de npmCommand doit être approuvé.'), {
    status: 409, code: 'PROJECT_TRUST_REQUIRED',
  });
}

function ownData(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Capture only bounded own primitive slots, never array iteration or inherited values.
 * Validate all slots/bytes before creating argv. Descriptor/capability errors propagate;
 * this is passive admission of ordinary arrays, not a hostile-Proxy sandbox.
 */
function captureCommand(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = ownData(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > MAX_COMMAND_ITEMS) {
    return undefined;
  }
  const slots: PropertyDescriptor[] = [];
  let bytes = 0;
  for (let index = 0; index < length; index++) {
    const slot = Object.getOwnPropertyDescriptor(value, String(index));
    if (!slot || !('value' in slot)) return undefined;
    const item: unknown = slot.value;
    // Code-unit length is a cheap lower bound on UTF-8 bytes, bounding all scans.
    if (typeof item !== 'string' || item.length > MAX_ITEM_BYTES || !item.trim()
      || UNSAFE_CHARACTERS.test(item) || (index === 0 && item.startsWith('-'))) return undefined;
    const itemBytes = Buffer.byteLength(item, 'utf8');
    bytes += itemBytes;
    if (itemBytes > MAX_ITEM_BYTES || bytes > MAX_COMMAND_BYTES) return undefined;
    slots.push(slot);
  }
  return Object.freeze(slots.map(slot => slot.value as string));
}

function captureSourceOverride(value: unknown): PluginNpmSourceTrustOverride {
  if (!value || typeof value !== 'object') throw pluginNpmSourceTrustFailure();
  const cwd = ownData(value, 'cwd');
  const trusted = ownData(value, 'trusted');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || UNSAFE_CHARACTERS.test(cwd)
    || Buffer.byteLength(cwd, 'utf8') > MAX_ITEM_BYTES || typeof trusted !== 'boolean') {
    throw pluginNpmSourceTrustFailure();
  }
  return Object.freeze({ cwd, trusted });
}

/** Internal admission snapshot. Accessors/inherited policy never become authority.
 * Invalid authority is retained as a lazy refusal so catalogue operations remain passive.
 */
export function capturePluginNpmCommandOptions(input: PluginNpmCommandOptions): {
  options: PluginNpmCommandOptions; sourceTrustInvalid: boolean;
} {
  let sourceTrustInvalid = false;
  const values: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') sourceTrustInvalid = true;
  else for (const key of ['npmCommand', 'npmCommandBaseDirectory', 'npmCommandBlocked',
    'npmCommandSourceWorkspace', 'npmCommandSourceTrustOverride']) {
    if (!(key in input)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) sourceTrustInvalid = true;
    else values[key] = descriptor.value;
  }
  let override: PluginNpmSourceTrustOverride | undefined;
  if (Object.hasOwn(values, 'npmCommandSourceTrustOverride')) {
    try {
      override = captureSourceOverride(values.npmCommandSourceTrustOverride);
      if (override.cwd !== values.npmCommandSourceWorkspace) sourceTrustInvalid = true;
    } catch { sourceTrustInvalid = true; }
  }
  const command = values.npmCommand === undefined ? undefined : captureCommand(values.npmCommand);
  const commandInvalid = values.npmCommand !== undefined && command === undefined;
  const options = Object.freeze({
    npmCommand: command,
    npmCommandBaseDirectory: values.npmCommandBaseDirectory,
    npmCommandBlocked: commandInvalid ? true : values.npmCommandBlocked,
    npmCommandSourceWorkspace: values.npmCommandSourceWorkspace,
    ...(override ? { npmCommandSourceTrustOverride: override } : {}),
  }) as PluginNpmCommandOptions;
  return { options, sourceTrustInvalid };
}

/** Validate again at the process boundary, including trusted callers not using the settings schema. */
export function pluginNpmInvocation(options: PluginNpmCommandOptions, args: readonly string[]): {
  executable: string;
  args: string[];
} {
  if (options.npmCommandBlocked) throw invalidCommand();
  const command = captureCommand(options.npmCommand === undefined ? ['npm'] : options.npmCommand);
  if (!command) throw invalidCommand();
  let executable = command[0]!;
  // Bare names use PATH; any relative path is anchored to the declaring settings file.
  if (!path.isAbsolute(executable) && /[\\/]/.test(executable)) {
    const base = options.npmCommandBaseDirectory;
    if (typeof base !== 'string' || !path.isAbsolute(base) || UNSAFE_CHARACTERS.test(base)) throw invalidCommand();
    executable = path.resolve(base, executable);
    if (Buffer.byteLength(executable, 'utf8') > MAX_ITEM_BYTES) throw invalidCommand();
  }
  const prefixArgs = command.slice(1);
  if (Buffer.byteLength(executable, 'utf8') + prefixArgs.reduce((bytes, item) => bytes + Buffer.byteLength(item, 'utf8'), 0)
    > MAX_COMMAND_BYTES) throw invalidCommand();
  return { executable, args: [...prefixArgs, ...args] };
}

/**
 * Preserve rejected overrides instead of treating loader omissions as permission to run npm.
 * Any diagnostic in the winning or higher trusted layer blocks execution: the loader's
 * diagnostics are untyped and may describe unreadable/root-invalid/future source policy.
 * A clean project command replaces the entire lower layer, including its diagnostics.
 * Missing files produce no diagnostic and permit inheritance/default. Untrusted project
 * settings are ignored. Selection is passive; invocation validates/rejects lazily.
 */
export function resolvePluginNpmCommand(
  resolved: ResolvedAgentSettings,
  sourceTrustOverride?: PluginNpmSourceTrustOverride,
): PluginNpmCommandOptions {
  const override = sourceTrustOverride === undefined ? undefined : captureSourceOverride(sourceTrustOverride);
  if (override && override.cwd !== ownData(resolved, 'cwd')) throw pluginNpmSourceTrustFailure();
  // The current loader caps diagnostics at 128, without a truncation indicator. At the
  // cap, even a clean-looking higher layer may have had its rejection suppressed.
  if (!resolved.agentDirTrusted || resolved.diagnostics.length >= 128) return Object.freeze({ npmCommandBlocked: true });
  const scopes = resolved.projectTrusted ? ['project', 'global'] as const : ['global'] as const;
  for (const scope of scopes) {
    if (resolved.diagnostics.some(diagnostic => diagnostic.scope === scope)) return Object.freeze({ npmCommandBlocked: true });
    const settings = ownData(resolved, scope === 'project' ? 'projectSettings' : 'globalSettings');
    if (!settings || typeof settings !== 'object') return Object.freeze({ npmCommandBlocked: true });
    const descriptor = Object.getOwnPropertyDescriptor(settings, 'npmCommand');
    if ('npmCommand' in settings && (!descriptor || !('value' in descriptor))) {
      return Object.freeze({ npmCommandBlocked: true });
    }
    const command = ownData(settings, 'npmCommand');
    if (command !== undefined) {
      const captured = captureCommand(command);
      if (!captured || (scope === 'project' && typeof ownData(resolved, 'cwd') !== 'string')) {
        return Object.freeze({ npmCommandBlocked: true });
      }
      return Object.freeze({
        npmCommand: captured,
        npmCommandBaseDirectory: path.dirname(resolved.paths[scope]),
        ...(scope === 'project' ? {
          npmCommandSourceWorkspace: resolved.cwd,
          ...(override ? { npmCommandSourceTrustOverride: override } : {}),
        } : {}),
      });
    }
  }
  return Object.freeze({});
}

/** No inherited npm config, Node loaders, Git helpers or credential channels. */
export function pluginCommandEnvironment(): NodeJS.ProcessEnv {
  const safe = filteredProcessEnvironment();
  const allowed = /^(?:PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|LANG|LC_ALL|LC_CTYPE|TZ)$/i;
  return {
    ...Object.fromEntries(Object.entries(safe).filter(([name]) => allowed.test(name))),
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Shell-free bounded capture/deadline; POSIX wrappers and descendants share a killable process group. */
export function createPluginCommandRunner(): PluginCommandRunner {
  return {
    run(command, args, options) {
      const label = command === 'git' ? 'git' : 'npm';
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) { reject(pluginCommandFailure({ code: 'ABORT_ERR' }, label)); return; }
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 120_000) {
          reject(pluginCommandFailure(undefined, label)); return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        let failure: Error | undefined;
        let closing: NodeJS.Timeout | undefined;
        const child = (() => {
          try {
            return spawn(command, args, {
              ...(options.cwd ? { cwd: options.cwd } : {}),
              detached: process.platform !== 'win32',
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
              shell: false,
              env: pluginCommandEnvironment(),
            });
          } catch (error) { throw pluginCommandFailure(error, label); }
        })();
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          clearTimeout(closing);
          options.signal?.removeEventListener('abort', abort);
          child.stdout.destroy();
          child.stderr.destroy();
          if (error) reject(error);
          else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
        };
        const stop = (code: string): void => {
          if (settled || failure) return;
          failure = pluginCommandFailure({ code }, label);
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
            else {
              if (child.pid) {
                const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                  stdio: 'ignore', windowsHide: true, shell: false, env: pluginCommandEnvironment(),
                });
                const killDeadline = setTimeout(() => { killer.kill('SIGKILL'); }, 500);
                killer.once('error', () => clearTimeout(killDeadline));
                killer.once('close', () => clearTimeout(killDeadline));
              }
              child.kill('SIGKILL');
            }
          } catch { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
          // A non-cooperating descendant retaining a pipe must not hold the operation forever.
          closing = setTimeout(() => finish(failure), 500);
        };
        const abort = (): void => stop('ABORT_ERR');
        const deadline = setTimeout(() => stop('ETIMEDOUT'), options.timeoutMs);
        const capture = (chunks: Buffer[], chunk: Buffer): void => {
          if (failure || settled) return;
          bytes += chunk.length;
          if (bytes > 1024 * 1024) stop('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
          else chunks.push(chunk);
        };
        child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
        child.once('error', error => finish(pluginCommandFailure(error, label)));
        child.once('close', code => finish(failure ?? (code === 0 ? undefined : pluginCommandFailure({ code }, label))));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    },
  };
}

/** Never reflect executable paths, prefix arguments, process output or arbitrary errno text. */
export function pluginCommandFailure(error: unknown, label: 'npm' | 'git'): Error {
  const code = (error as { code?: unknown } | undefined)?.code;
  const safeCode = typeof code === 'number' && Number.isSafeInteger(code) ? String(code)
    : typeof code === 'string' && /^(?:ENOENT|EACCES|EPERM|E2BIG|ENOEXEC|ENOMEM|EIO|EMFILE|ENFILE|ETIMEDOUT|ABORT_ERR|ERR_INVALID_ARG_VALUE|ERR_INVALID_ARG_TYPE|ERR_CHILD_PROCESS_STDIO_MAXBUFFER)$/.test(code)
      ? code : 'FAILED';
  return Object.assign(new Error(`${label} a échoué (${safeCode}).`), {
    status: 502, code: 'PLUGIN_COMMAND_FAILED',
  });
}
