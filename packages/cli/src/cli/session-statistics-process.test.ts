import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const measured = (costUsd: number) => ({ inputTokens: 1, outputTokens: 1,
  cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd });

describe('actual terminal session statistics and management', () => {
  for (const mode of ['regular', 'fullscreen'] as const) for (const durable of [false, true]) {
    it(`${mode}/durable=${durable}: reports real accounting and safely names/searches/resumes/deletes`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-session-stats-pty-'));
      let terminal: ReturnType<typeof spawnPty> | undefined;
      let exited: { exitCode: number; signal?: number } | undefined;
      try {
        const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), directory = path.join(root, 'sessions');
        await mkdir(cwd); await mkdir(agent);
        await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, enabledModels: ['mock/*'] }));
        const id = 'session-statistics-primary';
        let secondaryId: string | undefined;
        if (durable) {
          const manager = new SessionManager({ store: new JsonlSessionStore(directory) });
          const session = await manager.create({ id, title: 'StatisticsPrimary', cwd });
          await manager.addMessage(id, { role: 'assistant', content: 'Root', usage: measured(0.125) });
          const rootId = session.activeLeafId;
          await manager.addMessage(id, { role: 'assistant', content: 'Abandoned', usage: measured(1) });
          await manager.update(id, { activeLeafId: rootId });
          await manager.addBranchSummary(id, 'Summary', 'Selected', { provider: 'mock', model: 'mock-model', usage: measured(0.25) });
          await manager.addMessage(id, { role: 'tool', name: 'codemode', content: 'Nested', usage: measured(0.5),
            metadata: { codemode: { costComplete: false, nestedCalls: [{ usage: measured(999) }] } } });
          secondaryId = (await manager.create({ title: 'LookupNeedle', cwd })).id;
        }
        const args = [cli, '--offline', '--no-approve', '--no-extensions', '--no-context-files', '--model', 'mock/mock-model',
          '--session-dir', directory, '--session-id', id, '--verbose', '--tui-mode', mode, '--theme', 'dark',
          ...(!durable ? ['--no-session', '--name', 'StatisticsPrimary'] : [])];
        terminal = spawnPty(process.execPath, args, { cwd, cols: 240, rows: 45,
          env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1', TERM: 'xterm-256color' } });
        let output = '';
        terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
        const visible = () => stripVTControlCharacters(output);
        const ready = async () => vi.waitFor(() => expect(visible()).toContain('editor ready · Enter send'), { timeout: 10_000 });
        await ready();
        if (!durable) {
          output = ''; terminal.write('Actual in-memory turn\r');
          await vi.waitFor(() => { expect(visible()).toContain('[Mock AI Response]'); expect(visible()).toContain('editor ready · Enter send'); }, { timeout: 10_000 });
        }
        output = ''; terminal.write('/session\r');
        await vi.waitFor(() => {
          expect(visible()).toContain(`ID: ${id}`);
          expect(visible()).toContain(durable ? path.join(directory, `${id}.jsonl`) : 'File: memory (not saved)');
          expect(visible()).toContain('Active path:');
          expect(visible()).toContain('Full history (all branches):');
          expect(visible()).toContain('Context (est.):');
          if (durable) {
            expect(visible()).toContain('tokens 6'); expect(visible()).toContain('tokens 8');
            expect(visible()).toContain('$0.875000 known subtotal; total unknown');
            expect(visible()).toContain('$1.875000 known subtotal; total unknown');
          } else {
            expect(visible()).toContain('1 (you) + 1 (AI)'); expect(visible()).toContain('cost unknown');
          }
        }, { timeout: 10_000 });
        await ready();
        output = ''; terminal.write('/name StatisticsRenamed\r');
        await vi.waitFor(() => expect(visible()).toContain('Session title updated to: "StatisticsRenamed"'), { timeout: 10_000 });
        await ready();
        output = ''; terminal.write(`/delete ${id}\r`);
        await vi.waitFor(() => expect(visible()).toContain('Cannot delete the active session.'), { timeout: 10_000 });
        await ready();
        if (durable) {
          output = ''; terminal.write('/list LookupNeedle\r');
          await vi.waitFor(() => expect(visible()).toContain('LookupNeedle'), { timeout: 10_000 });
          await ready();
          output = ''; terminal.write(`/switch ${secondaryId!}\r`);
          await vi.waitFor(() => expect(visible()).toContain(`Switched to session: ${secondaryId!}`), { timeout: 10_000 });
          await ready();
          output = ''; terminal.write(`/delete ${id}\r`);
          await vi.waitFor(() => expect(visible()).toContain(`Deleted session ${id}`), { timeout: 10_000 });
          await ready();
          await expect(readFile(path.join(directory, `${id}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
          const manager = new SessionManager({ store: new JsonlSessionStore(directory) });
          await manager.loadAllSessions();
          expect(manager.get(secondaryId!)).toBeDefined();
        } else expect(await readdir(directory).catch(() => [])).toEqual([]);
        terminal.write('/quit\r');
        await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
      } finally { if (terminal && !exited) terminal.kill(); await rm(root, { recursive: true, force: true }); }
    }, 30_000);
  }
});
