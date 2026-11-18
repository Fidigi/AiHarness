import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { JsonlSessionStore } from '@ai-harness/core';
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_ACTIONS } from '../utils/terminal-actions.js';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const sequences = { f1: '\u001bOP', f2: '\u001bOQ', f3: '\u001bOR' };
type Mode = 'regular' | 'fullscreen';
async function fixture(source: 'global' | 'explicit' | 'project' = 'global') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-keybindings-[literal]-'));
  const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  const file = async (target: string, text: string) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); };
  await mkdir(cwd); await mkdir(agent);
  await file(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark' }));
  const target = source === 'global' ? path.join(agent, 'keybindings.json')
    : source === 'explicit' ? path.join(root, 'operator/[keys].json') : path.join(cwd, '.ai-harness/keybindings.json');
  const configure = async (key = source === 'explicit' ? 'f3' : 'f2', caption = 'KEY_MENU_V1') => file(target, JSON.stringify([
    { id: 'menu', keys: [key], action: 'app.hotkeys', description: caption },
    { id: 'view-letter-guard', keys: ['v'], action: 'input.externalEditor' },
    { id: 'help-pass-through', keys: ['ctrl+u'], action: 'app.help', preventDefault: false },
  ]));
  await configure();
  if (source === 'explicit') await file(path.join(agent, 'keybindings.json'), JSON.stringify([{ id: 'shadowed', keys: ['f2'], action: 'app.hotkeys', description: 'SHADOWED_GLOBAL_KEYS' }]));
  const marker = path.join(root, 'editor-marker');
  const turnMarker = path.join(root, 'turn-hook-next-tick'), startMarker = path.join(root, 'agent-start'), probe = path.join(root, 'probe.mjs');
  await file(probe, `import{writeFileSync}from'node:fs';export default api=>{api.on('agent:start',()=>writeFileSync(${JSON.stringify(startMarker)},'observed'));api.on('agent:end',()=>{setImmediate(()=>writeFileSync(${JSON.stringify(turnMarker)},'observed'));});};`);
  const editor = path.join(root, 'editor.mjs');
  await file(editor, `import{readFileSync,writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');const f=process.argv[2];writeFileSync(f,readFileSync(f,'utf8')+'-edited');`);
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
    AI_HARNESS_SESSIONS_DIR: sessions, AI_HARNESS_KEYBINDINGS: source === 'global' ? '' : path.relative(cwd, target),
    AI_HARNESS_OFFLINE: '1', AI_HARNESS_THEME: 'dark', AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1', TERM: 'xterm-256color',
    EDITOR: `${process.execPath} ${JSON.stringify(editor)}`, VISUAL: '' };
  return { root, cwd, agent, sessions, target, marker, turnMarker, startMarker, probe, configure, file, env };
}
async function users(test: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  const files = (await readdir(test.sessions)).filter(file => file.endsWith('.jsonl')); expect(files).toHaveLength(1);
  const session = await new JsonlSessionStore(test.sessions).loadSession(files[0]!.slice(0, -6));
  expect(session).not.toBeNull(); return session!.messages.filter(message => message.role === 'user').map(message => message.content);
}
async function interactive(test: Awaited<ReturnType<typeof fixture>>, mode: Mode, run: (io: {
  write(value: string): void; clear(): void; visible(): string; wait(value: string): Promise<void>; reload(): Promise<void>; exit(): Promise<void>; resize(columns: number, rows: number): void;
}) => Promise<void>, approve = true) {
  const terminal = spawnPty(process.execPath, [cli, approve ? '--approve' : '--no-approve', '--no-extensions', '-e', test.probe, '--model', 'mock/mock-model', '--tui-mode', mode, '--name', 'keybinding-probe'], { cwd: test.cwd, env: test.env, cols: 140, rows: 35 });
  let output = '', original = ''; let exited: { exitCode: number; signal?: number } | undefined;
  terminal.onData(value => { output += value; original += value; }); terminal.onExit(value => { exited = value; });
  const visible = () => stripVTControlCharacters(output);
  const wait = async (value: string) => { await vi.waitFor(() => expect(visible()).toContain(value), { timeout: 10_000 }); };
  let reloads = 0;
  const reload = async () => {
    output = ''; terminal.write('/reload\r'); reloads++;
    await vi.waitFor(() => {
      // Fullscreen redraws retain earlier results. Count rows in only the latest
      // frame so an old result cannot acknowledge this reload's completion.
      const frame = stripVTControlCharacters(mode === 'fullscreen' ? output.slice(output.lastIndexOf('\x1b[2J\x1b[H')) : output);
      expect(frame.match(/Reloaded \d+ extension\(s\)\./g) ?? []).toHaveLength(mode === 'fullscreen' ? reloads : 1);
      expect(frame.slice(frame.lastIndexOf('Reloaded '))).toContain('keybinding-probe: ');
    }, { timeout: 10_000 });
  };
  const exit = async () => {
    if (original.includes('[Mock AI Response]')) await vi.waitFor(async () => expect(await readFile(test.turnMarker, 'utf8')).toBe('observed'), { timeout: 10_000 });
    terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
    expect(original).toContain('\x1b[?2004h'); expect(original).toContain('\x1b[?2004l');
    if (mode === 'fullscreen') expect(original).toContain('\x1b[?1049l');
  };
  try { await wait('keybinding-probe: '); await run({ write: value => terminal.write(value), clear: () => { output = ''; }, visible, wait, reload, exit, resize: (columns, rows) => terminal.resize(columns, rows) }); }
  finally {
    if (!exited) terminal.kill();
    if (process.env.AIH_KEYBINDING_EVIDENCE_DIR) {
      const target = path.join(process.env.AIH_KEYBINDING_EVIDENCE_DIR, path.basename(test.root) + '-' + mode);
      await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'terminal.raw.txt'), original);
      await writeFile(path.join(target, 'terminal.plain.txt'), stripVTControlCharacters(original));
      await writeFile(path.join(target, 'exit.json'), JSON.stringify(exited ?? { notYetObserved: true }));
      await writeFile(path.join(target, 'configuration.json'), await readFile(test.target));
    }
  }
}

describe('actual emitted CLI keybinding hosts', () => {
  for (const mode of ['regular', 'fullscreen'] as const) {
    for (const source of ['global', 'explicit'] as const) {
      it(`${mode}: ${source} source opens all passive actions and preserves the exact draft/caret`, async () => {
        const test = await fixture(source);
        try {
          await interactive(test, mode, async io => {
            io.write('draft\u001b[D\u001b[D'); io.clear(); io.write(source === 'global' ? sequences.f2 : sequences.f3); await io.wait('Hotkeys');
            for (const action of TERMINAL_ACTIONS) {
              io.clear(); io.write(action.id + '\r'); await io.wait(`Hotkeys ${action.id === 'editor.delete' ? 3 : 1}/${TERMINAL_ACTIONS.length}`); expect(io.visible()).toContain(action.id);
            }
            io.clear(); io.write('app.hotkeys\r'); await io.wait('KEY_MENU_V1'); expect(io.visible()).not.toContain('SHADOWED_GLOBAL_KEYS');
            io.clear(); io.write(':all\r'); await io.wait(`Hotkeys ${TERMINAL_ACTIONS.length}/${TERMINAL_ACTIONS.length}`);
            await expect(readFile(test.marker)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(test.startMarker)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(test.turnMarker)).rejects.toMatchObject({ code: 'ENOENT' });
            io.clear(); io.write(sequences.f1); await io.wait('draft');
            io.clear(); io.write('\x1a\x1bzX\r'); await io.wait('[Mock AI Response]'); await io.wait('keybinding-probe: '); await io.exit();
          });
          expect(await users(test)).toEqual(['draXft']); await expect(readFile(test.marker)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { await rm(test.root, { recursive: true, force: true }); }
      }, 30_000);
    }
    it(`${mode}: Unicode/multiline paste stays inert, grapheme edits undo and draft/history survive resize`, async () => {
      const test = await fixture();
      const content = '界 e\u0301👩🏽‍💻\nsecond';
      try {
        await interactive(test, mode, async io => {
          io.write('\x1b[20'); io.write('0~' + content + '\x1b[201~'); await io.wait('second');
          await expect(readFile(test.startMarker)).rejects.toMatchObject({ code: 'ENOENT' });
          io.write('\x1b[H\x1b[D\x7f'); await io.wait('界 e\u0301');
          io.write('\x1a'); await io.wait('👩🏽‍💻');
          io.write('\x1bz'); io.write('\x1a');
          io.resize(25, 10); io.resize(140, 35); io.write('\x1b[F\x1bj\x1a');
          io.write('\r'); await io.wait('[Mock AI Response]');
          await vi.waitFor(async () => expect(await readFile(test.turnMarker, 'utf8')).toBe('observed'), { timeout: 10_000 });
          io.write('draft\x1b[A\x1b[B'); await io.wait('draft');
          io.clear(); io.write('\x15'); await io.wait(mode === 'regular' ? 'Available Commands' : 'Commandes principales'); await io.exit();
        });
        expect(await users(test)).toEqual([content]);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
    it(`${mode}: remapped named word actions dispatch in the real editor, not as native key fall-through`, async () => {
      const test = await fixture();
      try {
        await test.file(test.target, JSON.stringify([
          { id: 'word-left', keys: ['f2'], action: 'editor.wordLeft' },
          { id: 'delete-word', keys: ['f3'], action: 'editor.deleteWordRight' },
        ]));
        await interactive(test, mode, async io => {
          io.write('\x1b[200~one two three\x1b[201~'); await io.wait('one two three');
          io.write(sequences.f2 + sequences.f3 + '!\r'); await io.wait('[Mock AI Response]'); await io.exit();
        });
        expect(await users(test)).toEqual(['one two !']);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
    it(`${mode}: settings distinguish active renderer/palette from stored unsupported preferences after reload`, async () => {
      const test = await fixture();
      try {
        await test.file(path.join(test.agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'light', fullscreenCopyOnSelect: true, terminal: { images: 'kitty' } }));
        await interactive(test, mode, async io => {
          expect(io.visible()).toContain('fullscreenCopyOnSelect is unsupported by CLI (stored only)');
          io.clear(); io.write('/settings\r'); await io.wait('fullscreenCopyOnSelect: unsupported by CLI (stored only) [global]');
          await io.wait('Active theme: dark'); await io.wait(`Active terminal: ${mode}`);
          await test.file(path.join(test.agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'auto', fullscreenCopyOnSelect: false }));
          await io.reload();
          io.clear(); io.write('/settings\r'); await io.wait('theme (saved): auto [global]');
          const latestSettingsTail = io.visible().slice(io.visible().lastIndexOf('fullscreenCopyOnSelect: unsupported'));
          expect(latestSettingsTail).not.toContain('terminal: unsupported'); await io.wait('Active theme: dark'); await io.exit();
        });
        expect(await users(test)).toEqual([]);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
    it(`${mode}: known configuration credentials are redacted before hotkey row clipping`, async () => {
      const test = await fixture();
      const secret = 'KNOWN_VIEW_SECRET_' + 'x'.repeat(200);
      (test.env as NodeJS.ProcessEnv).OPENAI_API_KEY = secret;
      try {
        await test.configure('f2', secret);
        await interactive(test, mode, async io => {
          io.clear(); io.write(sequences.f2); await io.wait('Hotkeys');
          io.write('app.hotkeys\r'); await io.wait(`Hotkeys 1/${TERMINAL_ACTIONS.length}`);
          expect(io.visible()).toContain('[REDACTED]'); expect(io.visible()).not.toContain('KNOWN_VIEW_SECRET_');
          io.write(sequences.f1); await io.wait('keybinding-probe: '); await io.exit();
        });
        expect(await users(test)).toEqual([]);
        await expect(readFile(test.startMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
    it(`${mode}: reload conserves valid data on refusal, replaces bindings and retires old keys`, async () => {
      const test = await fixture();
      try {
        await interactive(test, mode, async io => {
          await test.file(test.target, '{PRIVATE_SENTINEL'); await io.reload();
          expect(io.visible()).toContain('Failed to load custom bindings (json)'); expect(io.visible()).not.toContain('PRIVATE_SENTINEL');
          io.clear(); io.write(sequences.f2); await io.wait('Hotkeys'); io.write('app.hotkeys\r'); await io.wait('KEY_MENU_V1'); io.write(sequences.f1); await io.wait('keybinding-probe: ');
          await test.configure('f3', 'KEY_MENU_V2'); await io.reload();
          io.clear(); io.write(sequences.f3); await io.wait('Hotkeys'); io.write('app.hotkeys\r'); await io.wait('KEY_MENU_V2'); expect(io.visible()).not.toContain('F2');
          io.write(sequences.f1); await io.wait('keybinding-probe: ');
          io.clear(); io.write(sequences.f2 + 'hello\r'); await io.wait('[Mock AI Response]'); await io.wait('keybinding-probe: '); await io.exit();
        });
        expect(await users(test)).toEqual(['hello']);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
    it(`${mode}: explicit project refusal never installs its bindings`, async () => {
      const test = await fixture('project');
      try {
        await interactive(test, mode, async io => {
          expect(io.visible()).toContain('Keybinding source unavailable (project-trust)'); io.clear(); io.write(sequences.f1); await io.wait('Hotkeys');
          io.write('app.hotkeys\r'); await io.wait(`Hotkeys 1/${TERMINAL_ACTIONS.length}`); expect(io.visible()).not.toContain('KEY_MENU_V1');
          io.write(sequences.f1); await io.wait('keybinding-probe: '); await io.exit();
        }, false);
        expect(await users(test)).toEqual([]); await expect(readFile(test.marker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
    it(`${mode}: real help honors explicit native pass-through without submitting the old draft`, async () => {
      const test = await fixture();
      try {
        await interactive(test, mode, async io => {
          io.write('old-draft'); io.clear(); io.write('\u0015'); await io.wait(mode === 'regular' ? 'Available Commands' : 'Commandes principales');
          expect(io.visible()).not.toContain('[Help - use /help command]'); io.clear(); io.write('kept\r'); await io.wait('[Mock AI Response]'); await io.wait('keybinding-probe: '); await io.exit();
        });
        expect(await users(test)).toEqual(['kept']);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
    it(`${mode}: configured editor action invokes the real host and restores its result`, async () => {
      const test = await fixture();
      try {
        await interactive(test, mode, async io => {
          io.write('draft'); io.clear(); io.write('v'); await io.wait('draft-edited'); expect(await readFile(test.marker, 'utf8')).toBe('executed');
          io.clear(); io.write('\r'); await io.wait('[Mock AI Response]'); await io.wait('keybinding-probe: '); await io.exit();
        });
        expect(await users(test)).toEqual(['draft-edited']);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const mode of ['print', 'json', 'rpc'] as const) {
    it(`${mode}: never loads terminal keybindings or contaminates protocol channels`, async () => {
      const test = await fixture();
      try {
        await test.file(test.target, '{PRIVATE_SENTINEL');
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [cli, '--approve', '--no-session', '--no-extensions', '--model', 'mock/mock-model', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Hello.'])], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
          let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
          child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
          child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
          child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'keys', message: 'Hello.' }) + '\n' : '');
        });
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout + result.stderr).not.toContain('[KeyBinding]'); expect(result.stdout + result.stderr).not.toContain('PRIVATE_SENTINEL');
        if (mode === 'print') expect(result.stdout).toBe('[Mock AI Response]\n'); else for (const line of result.stdout.trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('type');
        await expect(readFile(test.marker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
});
