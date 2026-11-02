import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { compilerNodeArgs, run } from './installed-process.js';

const output = 'synthetic-private-stdout';
const diagnostic = 'synthetic-private-stderr';
const script = (finish: string): string => `process.stdout.write(${JSON.stringify(output)}, () => process.stderr.write(${JSON.stringify(diagnostic)}, () => { ${finish} }));`;

describe('installed child native termination evidence', () => {
  it('flags only the exact TypeScript process without mutating compiler or application argv', () => {
    const compiler = '/resolved/typescript/bin/tsc';
    const args = Object.freeze([compiler, '--noEmit', 'consumer with spaces.ts']);
    expect(compilerNodeArgs(process.execPath, args, compiler)).toEqual(['--no-maglev', ...args]);
    expect(compilerNodeArgs('npm', args, compiler)).toEqual(args);
    expect(compilerNodeArgs(process.execPath, ['consumer.mjs', '--strict'], compiler)).toEqual(['consumer.mjs', '--strict']);
    expect(args).toEqual([compiler, '--noEmit', 'consumer with spaces.ts']);
  });

  it.each([0, 7])('preserves ordinary exit %s and exact captured channels without a signal receipt', async code => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await run(process.execPath, ['-e', script(`process.exitCode = ${code};`)], os.tmpdir(), process.env);
      expect(result).toEqual({ code, stdout: output, stderr: diagnostic });
      expect(error).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('retains real %s without command/input/environment/output data in its receipt', async signal => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = expect.getState();
    const owner = state.currentTestName;
    const getState = vi.spyOn(expect, 'getState').mockReturnValue(state);
    try {
      const pending = run(process.execPath, ['-e', script(`process.kill(process.pid, ${JSON.stringify(signal)});`), 'synthetic-private-argv'], os.tmpdir(), {
        ...process.env, AIH_SYNTHETIC_PRIVATE_VALUE: 'synthetic-private-environment',
      }, 'synthetic-private-stdin');
      // A late close must retain its launch owner, not the next displayed test.
      getState.mockReturnValue({ ...state, currentTestName: 'unrelated later test' });
      const result = await pending;
      getState.mockRestore();
      expect(result).toEqual({ code: null, stdout: output, stderr: diagnostic });
      expect(error).toHaveBeenCalledExactlyOnceWith('[installed-process] Native child termination.', { code: null, signal, testName: owner });
    } finally { getState.mockRestore(); error.mockRestore(); }
  });
});
