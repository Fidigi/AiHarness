import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const literal = 'ordinary-prompt-literal-arity';
const secret = 'genuine-credential-arity: +/字';
const marker = 'CREDENTIAL-ARITY-END';
function variants(value: string): string[] {
  return [...new Set([value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), Buffer.from(value).toString('hex'), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])];
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-startup-credential-'));
  const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), capture = path.join(root, 'capture'), extension = path.join(root, 'owner.mjs');
  await mkdir(cwd); await mkdir(agent);
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, enabledModels: ['mock/*'] }));
  await writeFile(extension, `import{appendFileSync}from'node:fs';export default api=>{api.registerOption('owned-boolean',{type:'boolean',description:'Actual boolean arity'});api.registerOption('owned-string',{type:'string',description:'Actual string arity'});api.before('before:provider',data=>{appendFileSync(${JSON.stringify(capture)},JSON.stringify(data.messages.filter(message=>message.role==='user').map(message=>message.content))+'\\n');});api.on('agent:end',()=>{if(process.stdout.isTTY)process.stdout.write('\\n${marker}\\n');});};`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1', TERM: 'xterm-256color' };
  const args = [cli, '--offline', '--no-approve', '--no-extensions', '-e', extension, '--no-context-files', '--no-session', '--model', 'mock/mock-model'];
  const records = async (): Promise<string[]> => (await readFile(capture, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as string[]).at(-1)!);
  return { root, cwd, env, args, records, capture };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Mode = 'print' | 'json' | 'rpc';
function run(test: Fixture, mode: Mode, tail: string[], input = '') {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...test.args, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...tail], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}
const cases = ['ambiguous', 'separator', 'inline-boolean', 'string-option', 'actual-before', 'actual-after', 'actual-and-false', 'environment'] as const;
function scenario(kind: typeof cases[number]) {
  const ordinary = ['hello', '--api-key', ...variants(literal)];
  if (kind === 'ambiguous') return { tail: ['--owned-boolean', ...ordinary], expected: ordinary };
  if (kind === 'separator') return { tail: ['--owned-boolean', '--', ...ordinary], expected: ordinary };
  if (kind === 'inline-boolean') return { tail: ['--owned-boolean=false', ...ordinary], expected: ordinary };
  if (kind === 'string-option') return { tail: ['--owned-string', 'choice', ...ordinary], expected: ordinary };
  if (kind === 'actual-before') return { tail: ['--api-key', secret, '--owned-boolean', '--', 'hello', ...variants(secret)], expected: ['hello', ...variants(secret).map(() => '[REDACTED]')] };
  if (kind === 'actual-after') return { tail: ['--owned-boolean', '--api-key', secret, '--', 'hello', ...variants(secret)], expected: ['hello', ...variants(secret).map(() => '[REDACTED]')] };
  if (kind === 'actual-and-false') return { tail: ['--api-key', secret, '--owned-boolean', ...ordinary, ...variants(secret)], expected: [...ordinary, ...variants(secret).map(() => '[REDACTED]')] };
  return { tail: ['--owned-boolean', '--', 'hello', ...variants(secret)], expected: ['hello', ...variants(secret).map(() => '[REDACTED]')] };
}

describe('definitive CLI credential authority after contributed-option arity', () => {
  for (const mode of ['print', 'json'] as const) for (const kind of cases) {
    it(`${mode}/${kind}: preserves actual prompt bytes and still removes genuine credential variants`, async () => {
      const test = await fixture(), { tail, expected } = scenario(kind);
      if (kind === 'environment') test.env.OPENAI_API_KEY = secret;
      try {
        const result = await run(test, mode, tail);
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
        expect(await test.records()).toEqual(expected);
        if (mode === 'print') expect(result.stdout).toBe('[Mock AI Response]\n');
        else {
          const records = result.stdout.trim().split('\n').map(line => JSON.parse(line)) as Array<{ type: string; message?: { role: string; content: string } }>;
          expect(records.filter(record => record.type === 'message_end' && record.message?.role === 'user').map(record => record.message!.content)).toEqual(expected);
        }
        if (kind.startsWith('actual') || kind === 'environment') for (const value of variants(secret)) expect(result.stdout + result.stderr + await readFile(test.capture, 'utf8')).not.toContain(value);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const mode of ['print', 'json', 'rpc'] as const) {
    it(`${mode}: retains conservative genuine-key masking in definitive-parse diagnostics`, async () => {
      const test = await fixture();
      try {
        const result = await run(test, mode, ['--api-key=--owned-boolean', '--owned-boolean=bad']);
        expect(result).toEqual({ code: 2, signal: null, stdout: '', stderr: 'Error: [REDACTED] accepts only true or false.\n' });
        expect(await test.records()).toEqual([]);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const position of ['before', 'after'] as const) {
    it(`rpc/key-${position}: definitive real key protects stdin turns without changing framing`, async () => {
      const test = await fixture();
      try {
        const tail = position === 'before' ? ['--api-key', secret, '--owned-boolean'] : ['--owned-boolean', '--api-key', secret];
        const result = await run(test, 'rpc', tail, JSON.stringify({ type: 'prompt', id: 'credential', message: variants(secret).join(' | ') }) + '\n');
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
        expect(await test.records()).toEqual([variants(secret).map(() => '[REDACTED]').join(' | ')]);
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line)) as Array<{ type: string; id?: string; success?: boolean }>;
        expect(records).toContainEqual(expect.objectContaining({ type: 'response', id: 'credential', success: true }));
        for (const value of variants(secret)) expect(result.stdout + result.stderr).not.toContain(value);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const mode of ['regular', 'fullscreen'] as const) for (const genuine of [false, true]) {
    it(`${mode}/genuine=${genuine}: actual initial turns and post-reload input keep the definitive authority`, async () => {
      const test = await fixture(); let terminal: ReturnType<typeof spawnPty> | undefined, exited: { exitCode: number; signal?: number } | undefined;
      try {
        const tail = genuine ? ['--api-key', literal, '--owned-boolean', '--', 'hello', literal] : ['--owned-boolean', 'hello', '--api-key', literal];
        const expected = genuine ? ['hello', '[REDACTED]'] : ['hello', '--api-key', literal];
        terminal = spawnPty(process.execPath, [...test.args, '--tui-mode', mode, '--theme', 'dark', '--name', 'credential-arity', ...tail], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
        let output = ''; terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
        const visible = () => stripVTControlCharacters(output);
        await vi.waitFor(async () => expect(await test.records()).toEqual(expected), { timeout: 10_000 });
        await vi.waitFor(() => { expect(visible().split(marker)).toHaveLength(expected.length + 1); expect(visible().split(marker).at(-1)).toContain('editor ready · Enter send'); expect(visible()).toContain('credential-arity: '); }, { timeout: 10_000 });
        output = ''; terminal.write('/reload\r');
        await vi.waitFor(() => { expect(visible()).toContain('Reloaded '); expect(visible()).toContain('editor ready · Enter send'); expect(visible()).toContain('credential-arity: '); }, { timeout: 10_000 });
        output = ''; terminal.write(literal + '\r');
        await vi.waitFor(async () => expect(await test.records()).toEqual([...expected, genuine ? '[REDACTED]' : literal]), { timeout: 10_000 });
        await vi.waitFor(() => { expect(visible()).toContain(marker); expect(visible().split(marker).at(-1)).toContain('editor ready · Enter send'); }, { timeout: 10_000 });
        terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
      } finally { if (terminal && !exited) terminal.kill(); await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
});
