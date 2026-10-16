import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const fixtures = {
  rpc: fileURLToPath(new URL('./fixtures/extension-state-rpc.mjs', import.meta.url)),
  terminal: fileURLToPath(new URL('./fixtures/extension-state-terminal.mjs', import.meta.url)),
  headless: fileURLToPath(new URL('./fixtures/extension-state-headless.mjs', import.meta.url)),
};
const cases: Array<{ fixture: keyof typeof fixtures; scenario: string; marker: string }> = [
  ...['memory', 'durable'].map(scenario => ({ fixture: 'rpc' as const, scenario, marker: 'EXTENSION_SESSION_CLI_OK' })),
  ...['print-memory', 'print-durable', 'json-memory', 'json-durable'].map(scenario => ({ fixture: 'headless' as const, scenario, marker: 'EXTENSION_SESSION_HEADLESS_OK' })),
  ...['regular-memory', 'regular-durable', 'fullscreen-memory', 'fullscreen-durable'].map(scenario => ({ fixture: 'terminal' as const, scenario, marker: 'EXTENSION_SESSION_TERMINAL_OK' })),
];
for (const { fixture, scenario, marker } of cases) {
  it(`emitted extension session state: ${fixture}/${scenario}`, async () => {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [fixtures[fixture], scenario], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain(marker);
  }, 25_000);
}
