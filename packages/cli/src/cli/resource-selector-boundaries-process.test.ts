import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
type Kind = 'prompt' | 'skill';
async function fixture(kind: Kind, refused: boolean, settings: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-resource-process-'));
  const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), trace = path.join(root, 'reads');
  await mkdir(cwd); await mkdir(agent);
  const relative = kind === 'skill' ? 'review/SKILL.md' : 'review.md';
  const target = path.join(refused ? path.join(cwd, '..private') : path.join(root, 'resources/[literal]'), relative);
  const file = async (target: string, text: string) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); };
  await file(target, '---\nname: review\ndescription: Boundary resource\n---\nEXACT BODY');
  if (!refused) await file(path.join(root, 'resources/l', relative), '---\nname: review\ndescription: Unrequested match\n---\nBAIT BODY');
  const selector = refused ? target : '+' + target;
  await file(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, ...(settings ? { [kind === 'prompt' ? 'prompts' : 'skills']: [selector] } : {}) }));
  const observer = path.join(root, 'observe.mjs');
  await file(observer, `import fs from 'node:fs/promises';import{appendFileSync,readlinkSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';
    const original=fs.open;fs.open=async(...args)=>{const handle=await original(...args);const read=handle.read.bind(handle);handle.read=(...values)=>{const name=readlinkSync('/proc/self/fd/'+handle.fd);if(name.startsWith(${JSON.stringify(root + path.sep)})&&name.endsWith('.md'))appendFileSync(${JSON.stringify(trace)},JSON.stringify(name)+'\\n');return read(...values);};return handle;};syncBuiltinESMExports();`);
  const args = ['--import', observer, cli, '--no-approve', '--no-extensions', '--no-session', '--model', 'mock/mock-model', ...(settings ? [] : [kind === 'prompt' ? '--prompt-template' : '--skill', selector])];
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', AI_HARNESS_THEME: '', NO_COLOR: '1', TERM: 'xterm-256color' };
  const reads = async (): Promise<string[]> => (await readFile(trace, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, cwd, target, args, env, reads };
}
function run(test: Awaited<ReturnType<typeof fixture>>, mode: 'print' | 'json' | 'rpc') {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...test.args, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Hello.'])], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'boundary', message: 'Hello.' }) + '\n' : '');
  });
}

describe('emitted Markdown selector boundaries', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) {
    for (const kind of ['prompt', 'skill'] as const) {
      for (const settings of [false, true]) {
        for (const refused of [false, true]) {
          it(`${mode}/${kind}/${settings ? 'settings' : 'explicit'}: ${refused ? 'refuses two-dot project children before reads' : 'reads only the exact literal addition'}`, async () => {
            const test = await fixture(kind, refused, settings);
            try {
              const result = await run(test, mode);
              expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
              expect(await test.reads()).toEqual(refused ? [] : [test.target]);
              if (mode === 'print') expect(result.stdout).toBe('[Mock AI Response]\n');
              else { expect(result.stdout.trim()).not.toBe(''); for (const line of result.stdout.trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('type'); }
            } finally { await rm(test.root, { recursive: true, force: true }); }
          }, 30_000);
        }
      }
    }
  }
  for (const mode of ['print', 'json', 'rpc'] as const) {
    for (const kind of ['prompt', 'skill'] as const) {
      for (const glob of [false, true]) {
        it(`${mode}/${kind}: applies a ${glob ? 'glob' : 'subtree'} exclusion before body reads without project trust`, async () => {
          const test = await fixture(kind, false, true);
          try {
            await writeFile(path.join(test.root, 'agent/settings.json'), JSON.stringify({ quietStartup: true,
              [kind === 'prompt' ? 'prompts' : 'skills']: ['+' + test.target, glob ? '!' + path.join(test.root, '**/*.md') : '-' + test.root] }));
            const result = await run(test, mode);
            expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
            expect(await test.reads()).toEqual([]);
            if (mode === 'print') expect(result.stdout).toBe('[Mock AI Response]\n');
            else { expect(result.stdout.trim()).not.toBe(''); for (const line of result.stdout.trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('type'); }
          } finally { await rm(test.root, { recursive: true, force: true }); }
        }, 30_000);
      }
    }
  }
  for (const mode of ['regular', 'fullscreen'] as const) {
    for (const kind of ['prompt', 'skill'] as const) {
      for (const refused of [false, true]) {
        it(`${mode}/${kind}: ${refused ? 'omits refused private metadata' : 'reports the admitted literal resource'}`, async () => {
          const test = await fixture(kind, refused, false);
          const terminal = spawnPty(process.execPath, [...test.args, '--tui-mode', mode, '--theme', 'dark', '--name', 'resource-boundary'], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
          let output = ''; let exited: { exitCode: number; signal?: number } | undefined;
          terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
          const visible = () => stripVTControlCharacters(output);
          try {
            await vi.waitFor(() => expect(visible()).toContain('resource-boundary: '), { timeout: 10_000 });
            output = ''; terminal.write('/resources\r');
            await vi.waitFor(() => expect(visible()).toContain(refused ? 'Aucune ressource découverte.' : `● ${kind}:review [temporary/cli]`), { timeout: 10_000 });
            await vi.waitFor(() => expect(visible()).toContain('resource-boundary: '), { timeout: 10_000 });
            if (refused) expect(visible()).not.toContain(`${kind}:review`);
            expect(await test.reads()).toEqual(refused ? [] : [test.target]);
            terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
          } finally { if (!exited) terminal.kill(); await rm(test.root, { recursive: true, force: true }); }
        }, 30_000);
      }
    }
  }
});
