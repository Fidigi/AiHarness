import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export type ExternalOpenKind = 'url' | 'directory';
export type ExternalOpenErrorCode = 'INVALID_TARGET' | 'UNSUPPORTED_PLATFORM' | 'LAUNCH_FAILED';

export class ExternalOpenError extends Error {
  constructor(readonly code: ExternalOpenErrorCode, message: string) {
    super(message);
    this.name = 'ExternalOpenError';
  }
}

export interface ExternalOpenCommand {
  command: string;
  args: string[];
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

const SAFE_ENVIRONMENT_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
] as const;

/** Return a shell-free native opener command, or undefined on unsupported systems. */
export function externalOpenCommand(
  target: string,
  kind: ExternalOpenKind,
  platform: NodeJS.Platform = process.platform,
): ExternalOpenCommand | undefined {
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'win32') {
    return kind === 'directory'
      ? { command: 'explorer.exe', args: [target] }
      : { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
  }
  if (platform === 'linux') return { command: 'xdg-open', args: [target] };
  return undefined;
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** Launch a URL or directory with the host desktop without a shell or inherited secrets. */
export async function openExternalTarget(
  target: string,
  kind: ExternalOpenKind,
  options: {
    platform?: NodeJS.Platform;
    spawnProcess?: SpawnProcess;
    environment?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  if (!target || target.includes('\0') || Buffer.byteLength(target, 'utf8') > 16_384) {
    throw new ExternalOpenError('INVALID_TARGET', 'The external target is invalid.');
  }
  const platform = options.platform ?? process.platform;
  const invocation = externalOpenCommand(target, kind, platform);
  if (!invocation) throw new ExternalOpenError('UNSUPPORTED_PLATFORM', 'The host platform cannot open this target.');
  if (kind === 'url') {
    try {
      const parsed = new URL(target);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported protocol');
    } catch {
      throw new ExternalOpenError('INVALID_TARGET', 'The external URL is invalid.');
    }
  } else {
    const absolute = platform === 'win32' ? path.win32.isAbsolute(target) : path.posix.isAbsolute(target);
    if (!absolute) throw new ExternalOpenError('INVALID_TARGET', 'The external directory is invalid.');
  }

  let child: ChildProcess;
  try {
    child = (options.spawnProcess ?? spawn)(invocation.command, invocation.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: safeEnvironment(options.environment ?? process.env),
    });
  } catch {
    throw new ExternalOpenError('LAUNCH_FAILED', 'The host application could not be started.');
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutMs = Math.max(100, Math.min(5_000, options.timeoutMs ?? 2_000));
    const timer = setTimeout(() => {
      cleanup();
      try { child.kill(); } catch { /* The launcher may already have disappeared. */ }
      reject(new ExternalOpenError('LAUNCH_FAILED', 'The host application did not start in time.'));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      child.off('spawn', launched);
      child.off('error', failed);
    };
    const launched = () => {
      cleanup();
      child.unref();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new ExternalOpenError('LAUNCH_FAILED', 'The host application could not be started.'));
    };
    child.once('spawn', launched);
    child.once('error', failed);
  });
}
