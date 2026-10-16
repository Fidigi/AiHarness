import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const headless = fileURLToPath(new URL('./fixtures/startup-fork-state.mjs', import.meta.url));
const terminal = fileURLToPath(new URL('./fixtures/extension-state-terminal.mjs', import.meta.url));
const cases = [
  ...['print', 'json', 'rpc'].flatMap(mode => ['id', 'prefix', 'file'].map(selector => ({
    name: `${mode}/${selector}`, fixture: headless, args: [mode, selector], terminal: false, marker: 'STARTUP_FORK_SESSION_STATE_OK',
  }))),
  ...['regular-durable', 'fullscreen-durable'].map(scenario => ({
    name: `terminal/${scenario}`, fixture: terminal, args: [scenario], terminal: true, marker: 'STARTUP_FORK_TERMINAL_STATE_OK',
  })),
];
for (const scenario of cases) {
  it(`retains private state through actual startup --fork: ${scenario.name}`, async () => {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [scenario.fixture, ...scenario.args], {
        env: { ...process.env, ...(scenario.terminal ? { AIH_STATE_STARTUP_FORK: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain(scenario.marker);
  }, 25_000);
}
