import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { JsonlSessionStore, SessionManager, type Message } from '@ai-harness/core';
import { expect, it, vi } from 'vitest';

it('regular configured scroll actions replay real bounded history and preserve the exact native draft/caret', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-keybindings-scroll-'));
  const cwd = path.join(root, 'workspace'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  await mkdir(cwd); await mkdir(agent);
  const messages: Message[] = Array.from({ length: 40 }, (_, index) => ({ id: `seed-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant', content: `history-${String(index).padStart(2, '0')}`,
    timestamp: new Date(1_720_000_000_000 + index) }));
  const store = new JsonlSessionStore(sessions), manager = new SessionManager({ store });
  const session = await manager.create({ cwd, title: 'scroll-proof', messages });
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark' }));
  await writeFile(path.join(agent, 'keybindings.json'), JSON.stringify([
    { id: 'older', keys: ['f4'], action: 'transcript.up' }, { id: 'newer', keys: ['f5'], action: 'transcript.down' },
  ]));
  const ended = path.join(root, 'ended'), probe = path.join(root, 'probe.mjs');
  await writeFile(probe, `import{writeFileSync}from'node:fs';export default api=>api.on('agent:end',()=>{setImmediate(()=>writeFileSync(${JSON.stringify(ended)},'observed'));});`);
  const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
  const terminal = spawnPty(process.execPath, [cli, '--approve', '--no-extensions', '-e', probe, '--offline', '--model', 'mock/mock-model', '--tui-mode', 'regular', '--session-id', session.id, '--name', 'scroll-proof'], {
    cwd, cols: 140, rows: 35, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
      AI_HARNESS_SESSIONS_DIR: sessions, AI_HARNESS_KEYBINDINGS: '', AI_HARNESS_EXTENSIONS: '', AI_HARNESS_THEME: 'dark', NO_COLOR: '1', TERM: 'xterm-256color' },
  });
  let output = '', original = ''; let exited: { exitCode: number; signal?: number } | undefined;
  terminal.onData(value => { output += value; original += value; }); terminal.onExit(value => { exited = value; });
  const visible = () => stripVTControlCharacters(output);
  const wait = (value: string) => vi.waitFor(() => expect(visible()).toContain(value), { timeout: 10_000 });
  try {
    await wait('scroll-proof: '); terminal.write('draft\u001b[D\u001b[D'); output = ''; terminal.write('\u001bOS');
    await wait('Transcript entries 1-20/40'); expect(visible()).toContain('history-00'); expect(visible()).toContain('history-19');
    expect(visible()).not.toContain('history-20'); expect(visible()).not.toContain('[Scroll: showing last');
    output = ''; terminal.write('\u001b[15~'); await wait('Transcript entries 21-40/40');
    expect(visible()).toContain('history-20'); expect(visible()).toContain('history-39'); expect(visible()).not.toContain('history-00');
    output = ''; terminal.write('\u001bOS'); await wait('Transcript entries 1-20/40');
    output = ''; terminal.write('X\r'); await wait('[Mock AI Response]');
    await vi.waitFor(async () => expect(await readFile(ended, 'utf8')).toBe('observed'), { timeout: 10_000 });
    terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
    const saved = await store.loadSession(session.id); expect(saved?.messages).toHaveLength(42);
    expect(saved?.messages.filter(message => message.role === 'user').at(-1)?.content).toBe('draXft');
    expect(saved?.messages.filter(message => message.role === 'user').slice(0, 20).map(message => message.content)).toEqual(messages.filter(message => message.role === 'user').map(message => message.content));
  } finally {
    try { if (!exited) { terminal.kill(); await vi.waitFor(() => expect(exited).toBeDefined(), { timeout: 5000 }); } }
    finally {
      if (process.env.AIH_KEYBINDING_EVIDENCE_DIR) {
        const evidence = path.join(process.env.AIH_KEYBINDING_EVIDENCE_DIR, path.basename(root)); await mkdir(evidence, { recursive: true });
        await writeFile(path.join(evidence, 'terminal.raw.txt'), original); await writeFile(path.join(evidence, 'terminal.plain.txt'), stripVTControlCharacters(original));
        await writeFile(path.join(evidence, 'exit.json'), JSON.stringify(exited ?? { notYetObserved: true }));
        await writeFile(path.join(evidence, 'seed.json'), JSON.stringify(messages));
        await writeFile(path.join(evidence, 'configuration.json'), await readFile(path.join(agent, 'keybindings.json')));
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);
