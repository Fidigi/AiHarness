import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
async function fixture(kind: 'skill' | 'prompt', scope: 'global' | 'project') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-absolute-process-'));
  const cwd = path.join(root, 'work[literal]'), agentDir = path.join(root, 'agent[literal]');
  const trace = path.join(root, 'reads'), skill = kind === 'skill', field = skill ? 'skills' : 'prompts';
  await mkdir(cwd); await mkdir(agentDir);
  const base = scope === 'global' ? agentDir : path.join(cwd, '.ai-harness');
  const relative = skill ? 'review/SKILL.md' : 'review.md', pattern = skill ? '**/SKILL.md' : '*.md';
  const file = async (target: string, text: string) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); };
  const body = (text: string) => `---\nname: review\ndescription: Absolute fixture\n---\n${text}`;
  const target = path.join(base, 'configured', relative);
  await file(target, body('ABSOLUTE LITERAL BODY'));
  await file(target.replaceAll('[literal]', 'l'), body('UNREQUESTED ABSOLUTE BODY'));
  await file(path.join(agentDir, 'settings.json'), JSON.stringify({ quietStartup: true,
    ...(scope === 'global' ? { [field]: [path.join(base, 'configured', pattern)] } : {}) }));
  if (scope === 'project') await file(path.join(base, 'settings.json'), JSON.stringify({ [field]: [path.join(base, 'configured', pattern)] }));
  const observer = path.join(root, 'observe.mjs');
  await file(observer, `import fs from 'node:fs/promises';import{appendFileSync,readlinkSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';const open=fs.open;fs.open=async(...args)=>{const handle=await open(...args),read=handle.read.bind(handle);handle.read=(...values)=>{const name=readlinkSync('/proc/self/fd/'+handle.fd);if(name.startsWith(${JSON.stringify(root + path.sep)})&&name.endsWith('.md'))appendFileSync(${JSON.stringify(trace)},JSON.stringify(name)+'\\n');return read(...values);};return handle;};syncBuiltinESMExports();`);
  const args = ['--import', observer, cli, '--approve', '--no-extensions', '--no-session', '--model', 'mock/mock-model'];
  const env = { ...process.env, HOME: path.join(root, 'home[literal]'), AI_HARNESS_AGENT_DIR: agentDir,
    AI_HARNESS_EXTENSIONS: '', AI_HARNESS_THEME: '', TERM: 'xterm-256color', NO_COLOR: '1' };
  const reads = async (): Promise<string[]> => (await readFile(trace, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, cwd, base, field, relative, pattern, target, trace, args, env, reads, file, body };
}
function run(test: Awaited<ReturnType<typeof fixture>>, mode: 'print' | 'json' | 'rpc', refused = false) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...test.args.map(value => refused && value === '--approve' ? '--no-approve' : value),
      ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Hello.'])], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'absolute', message: 'Hello.' }) + '\n' : '');
  });
}

describe('real emitted CLI absolute resource selectors', () => {
  for (const kind of ['skill', 'prompt'] as const) for (const scope of ['global', 'project'] as const) for (const mode of ['print', 'json', 'rpc'] as const) {
    it(`${mode}/${scope}/${kind}: reads exactly the literal absolute settings target`, async () => {
      const test = await fixture(kind, scope);
      try {
        const result = await run(test, mode);
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
        expect(await test.reads()).toEqual([test.target]);
        if (mode === 'print') expect(result.stdout).toBe('[Mock AI Response]\n');
        else { expect(result.stdout.trim()).not.toBe(''); for (const line of result.stdout.trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('type'); }
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const kind of ['skill', 'prompt'] as const) {
    it(`${kind}: refusal still permits zero project body reads`, async () => {
      const test = await fixture(kind, 'project');
      try {
        expect(await run(test, 'print', true)).toMatchObject({ code: 0, signal: null, stderr: '', stdout: '[Mock AI Response]\n' });
        expect(await test.reads()).toEqual([]);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
    for (const mode of ['regular', 'fullscreen'] as const) {
      it(`${mode}/${kind}: reload rereads absolute settings without reviving the sibling`, async () => {
        const test = await fixture(kind, 'global');
        const terminal = spawnPty(process.execPath, [...test.args, '--tui-mode', mode, '--theme', 'dark', '--name', 'absolute-resource'], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
        let output = ''; let exited: { exitCode: number; signal?: number } | undefined;
        terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
        const visible = () => stripVTControlCharacters(output);
        try {
          await vi.waitFor(() => expect(visible()).toContain('absolute-resource: '), { timeout: 10_000 });
          expect(await test.reads()).toEqual([test.target]);
          const fresh = path.join(test.base, 'fresh', test.relative);
          await test.file(fresh, test.body('FRESH ABSOLUTE BODY'));
          await test.file(fresh.replaceAll('[literal]', 'l'), test.body('FRESH BAIT'));
          await test.file(path.join(test.base, 'settings.json'), JSON.stringify({ quietStartup: true, [test.field]: [path.join(test.base, 'fresh', test.pattern)] }));
          await rm(test.trace, { force: true }); output = ''; terminal.write('/reload\r');
          await vi.waitFor(() => expect(visible()).toContain('Reloaded '), { timeout: 10_000 });
          await vi.waitFor(() => expect(visible()).toContain('absolute-resource: '), { timeout: 10_000 });
          expect(await test.reads()).toEqual([fresh]);
          output = ''; terminal.write('/resources\r');
          await vi.waitFor(() => expect(visible()).toContain(`● ${kind}:review [user/settings]`), { timeout: 10_000 });
          await vi.waitFor(() => expect(visible()).toContain('absolute-resource: '), { timeout: 10_000 });
          terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
        } finally { if (!exited) terminal.kill(); await rm(test.root, { recursive: true, force: true }); }
      }, 30_000);
    }
  }
});
