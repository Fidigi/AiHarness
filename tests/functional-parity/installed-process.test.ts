import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { run } from './installed-process.js';

const output = 'synthetic-private-stdout';
const diagnostic = 'synthetic-private-stderr';
const script = (finish: string): string => `process.stdout.write(${JSON.stringify(output)}, () => process.stderr.write(${JSON.stringify(diagnostic)}, () => { ${finish} }));`;

describe('installed child native termination evidence', () => {
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
    try {
      const result = await run(process.execPath, ['-e', script(`process.kill(process.pid, ${JSON.stringify(signal)});`), 'synthetic-private-argv'], os.tmpdir(), {
        ...process.env, AIH_SYNTHETIC_PRIVATE_VALUE: 'synthetic-private-environment',
      }, 'synthetic-private-stdin');
      expect(result).toEqual({ code: null, stdout: output, stderr: diagnostic });
      expect(error).toHaveBeenCalledExactlyOnceWith('[installed-process] Native child termination.', { code: null, signal });
    } finally { error.mockRestore(); }
  });
});
