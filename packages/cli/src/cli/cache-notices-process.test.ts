import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'node-pty';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';
import { expect, it, vi } from 'vitest';

for (const mode of ['regular', 'fullscreen']) for (const enabled of [true, false]) {
  it(`${mode}: replays historical cache notices only when enabled without making provider requests (${enabled})`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cache-terminal-'));
    const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    await mkdir(cwd); await mkdir(agent);
    const store = new JsonlSessionStore(sessions), manager = new SessionManager({ store });
    const session = await manager.create({ cwd, title: 'cache-history' });
    await manager.addMessage(session.id, { role: 'assistant', content: 'cached reply', provider: 'anthropic', model: 'claude-sonnet-4-6',
      usage: { cacheReadTokens: 100_000, outputTokens: 1 } });
    await manager.recordProviderUsage(session.id, { provider: 'anthropic', model: 'claude-sonnet-4-6',
      usage: { cacheReadTokens: 100_000, outputTokens: 1, costUsd: 0.03 } }, session.activeLeafId!);
    await manager.addMessage(session.id, { role: 'assistant', content: 'uncached reply', provider: 'anthropic', model: 'claude-sonnet-4-6',
      usage: { inputTokens: 100_000, outputTokens: 1 } });
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ showCacheMissNotices: enabled, cacheWarming: 'off', quietStartup: true }));
    await writeFile(path.join(agent, 'keybindings.json'), JSON.stringify([{ id: 'history', keys: ['f4'], action: 'transcript.up' }]));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), '--approve', '--no-extensions',
      '--offline', '--model', 'mock/mock-model', '--tui-mode', mode, '--session-dir', sessions, '--session', session.id], {
      cwd, cols: 140, rows: 40, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
        AI_HARNESS_KEYBINDINGS: '', AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1', TERM: 'xterm-256color' },
    });
    let output = '', exit: { exitCode: number; signal?: number } | undefined;
    child.onData(text => { output += text; }); child.onExit(value => { exit = value; });
    const visible = () => stripVTControlCharacters(output);
    try {
      await vi.waitFor(() => expect(visible()).toContain('cache-history'), { timeout: 10_000 });
      if (mode === 'regular') child.write('\u001bOS');
      await vi.waitFor(() => expect(visible()).toContain('uncached reply'), { timeout: 10_000 });
      expect(visible().includes('Cache warmed')).toBe(enabled);
      expect(visible().includes('Cache miss')).toBe(enabled);
      if (enabled) { expect(visible()).toContain('$0.03000'); expect(visible()).toContain('100000 tokens'); }
      expect(visible()).not.toContain('stored-only: showCacheMissNotices');
      child.write('/quit\r');
      await vi.waitFor(() => expect(exit).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
      const entries = (await readFile(path.join(sessions, `${session.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(entries.filter(entry => entry.type === 'message')).toHaveLength(2);
      expect(entries.filter(entry => entry.customType === 'provider.cache_warm')).toHaveLength(1);
    } finally { if (!exit) child.kill(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
}
