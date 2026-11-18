import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const good = { name: 'NATIVE_SCHEMA_GOOD', appearance: 'dark', colors: { accent: '#123456' } };
const failures = [
  ['name', { ...good, name: '' }, 'The theme name is invalid.'],
  ['appearance', { ...good, appearance: 'automatic' }, 'The theme appearance must be dark or light.'],
  ['variable name', { ...good, vars: { '0_PRIVATE_SCHEMA_VALUE': '#abc' } }, 'Theme variable name is invalid.'],
  ['variable cycle', { ...good, vars: { Alpha: 'Beta', Beta: 'Alpha' }, colors: { accent: 'Alpha' } }, 'Theme variables contain a cycle.'],
  ['color metadata', { ...good, colors: { PRIVATE_SCHEMA_VALUE: '#abc' } }, 'Unknown theme color token.'],
  ['export metadata', { ...good, export: { PRIVATE_SCHEMA_VALUE: '#abc' } }, 'Unknown theme export token.'],
] as const;

for (const mode of ['regular', 'fullscreen'] as const) describe(`native ${mode} startup/reload theme validation`, () => {
  it.each(failures)('applies the same %s refusal, safe fallback and last-good reload authority', async (_kind, malformed, diagnostic) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-theme-editor-native-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), target = path.join(agent, 'palette.json');
    let terminal: ReturnType<typeof spawnPty> | undefined;
    let exited: { exitCode: number; signal?: number } | undefined;
    try {
      await mkdir(cwd); await mkdir(agent);
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true }));
      await writeFile(target, JSON.stringify(malformed));
      terminal = spawnPty(process.execPath, [cli, '--approve', '--no-session', '--no-extensions', '--no-context-files', '--model', 'mock/mock-model', '--theme', target, '--tui-mode', mode, '--name', 'schema-theme'], {
        cwd, cols: 180, rows: 35, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
          AI_HARNESS_THEME: '', AI_HARNESS_EXTENSIONS: '', AI_HARNESS_KEYBINDINGS: '', AI_HARNESS_OFFLINE: '1', TERM: 'xterm-256color', NO_COLOR: '1' },
      });
      let output = '', complete = '';
      terminal.onData(text => { output += text; complete += text; }); terminal.onExit(value => { exited = value; });
      const visible = () => stripVTControlCharacters(output);
      const wait = (text: string) => vi.waitFor(() => expect(visible()).toContain(text), { timeout: 10_000 });
      await wait(diagnostic); await wait('schema-theme: ');
      output = ''; terminal.write('/theme\r'); await wait('● dark'); await wait('schema-theme: ');
      await writeFile(target, JSON.stringify(good));
      output = ''; terminal.write('/reload\r'); await wait('Reloaded '); await wait('schema-theme: ');
      output = ''; terminal.write('/theme\r'); await wait('● NATIVE_SCHEMA_GOOD'); await wait('schema-theme: ');
      await writeFile(target, JSON.stringify(malformed));
      output = ''; terminal.write('/reload\r'); await wait(diagnostic); await wait('Reloaded '); await wait('schema-theme: ');
      output = ''; terminal.write('/theme\r'); await wait('● NATIVE_SCHEMA_GOOD'); await wait('schema-theme: ');
      expect(stripVTControlCharacters(complete)).not.toContain('PRIVATE_SCHEMA_VALUE');
      terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
    } finally {
      if (terminal && !exited) { terminal.kill(); await vi.waitFor(() => expect(exited).toBeDefined(), { timeout: 5_000 }); }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
