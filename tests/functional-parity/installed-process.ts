import { spawn } from 'node:child_process';
import { expect } from 'vitest';

// Private harness utility: captured child channels and legacy result shape stay exact.
const byteLimit = 1024 * 1024;
export interface Result { code: number | null; stdout: string; stderr: string }

/** Scope the build-tool JIT mitigation to the exact resolved TypeScript entry. */
export function compilerNodeArgs(command: string, args: readonly string[], compiler: string): string[] {
  return command === process.execPath && args[0] === compiler ? ['--no-maglev', ...args] : [...args];
}

export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input = '', timeoutMs = 20_000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const testName = expect.getState().currentTestName;
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    const timer = setTimeout(() => fail(new Error(`Process deadline: ${command}`)), timeoutMs);
    function fail(error: Error): void { clearTimeout(timer); child.kill('SIGKILL'); reject(error); }
    function collect(channel: 'stdout' | 'stderr', chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > byteLimit) return fail(new Error(`Process byte budget: ${command}`));
      if (channel === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    }
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') fail(error); });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) console.error('[installed-process] Native child termination.', { code, signal, testName });
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
