import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('physical run ownership without other Node handles', () => {
  it('keeps an aborted provider promise owned until real completion instead of naturally exiting with success', async () => {
    // Unlike held sockets/fixture polling, this provider promise has no handle.
    // Signal listeners alone do not retain Node's event loop.
    const source = `import assert from 'node:assert/strict';
      import { AgentRuntime, SessionManager, ExtensionRegistry, MockProvider } from '@ai-harness/core';
      const manager = new SessionManager(), registry = new ExtensionRegistry();
      const session = await manager.create({ cwd: process.cwd() });
      const provider = new MockProvider({ type: 'mock' });
      provider.streamChat = async () => { await new Promise(resolve => {
        process.once('SIGUSR1', resolve); console.log('provider');
      }); };
      const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry,
        isProjectTrusted: () => true, resolveProvider: () => provider });
      let run;
      process.once('SIGTERM', () => { runtime.stop(run.id); console.log('ack'); });
      run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'owned', maxRetries: 0 });
      assert.equal((await runtime.wait(run.id)).phase, 'stopped');
      assert.deepEqual(session.messages.map(message => message.role), ['user']);
      await registry.shutdown(); console.log('done');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', release: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout === 'provider\n') child.kill('SIGTERM');
      if (stdout === 'provider\nack\n' && !release) release = setTimeout(() => child.kill('SIGUSR1'), 50);
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      expect(result, stderr).toEqual({ code: 0, signal: null }); expect(stderr).toBe('');
      expect(stdout).toBe('provider\nack\ndone\n');
    } finally { clearTimeout(deadline); clearTimeout(release); if (child.exitCode === null) child.kill('SIGKILL'); }
  });
});
