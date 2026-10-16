import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore, SessionManager } from '@ai-harness/core';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

describe('real terminal optional branch navigation', () => {
  for (const mode of ['regular', 'fullscreen'] as const) for (const scenario of ['choice', 'summary', 'abort'] as const) {
    it(`${mode}/${scenario}: preserves foreground ownership and the durable branch`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-navigation-pty-'));
      const sockets = new Set<Socket>();
      const requests: unknown[] = [];
      let heldClosed = 0;
      let terminal: ReturnType<typeof spawnPty> | undefined;
      let exited: { exitCode: number; signal?: number } | undefined;
      const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        requests.push(JSON.parse(body));
        if (scenario === 'abort') {
          response.on('close', () => { if (!response.writableEnded) heldClosed++; });
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'pty-summary', object: 'chat.completion', model: 'fixture-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Terminal branch outcome.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }));
      });
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      try {
        await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
        const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
        await mkdir(cwd); await mkdir(agent);
        await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, enabledModels: ['local/*'] }));
        const manager = new SessionManager({ store: new JsonlSessionStore(sessions) });
        const session = await manager.create({ title: 'PTY navigation', cwd });
        await manager.addMessage(session.id, { role: 'user', content: 'Common root' });
        await manager.appendCustomMessage(session.id, 'notice', 'Useful custom context', { display: false });
        const target = session.activeLeafId!;
        await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned result' });
        const source = session.activeLeafId!;
        terminal = spawnPty(process.execPath, [cli, '--offline', '--no-approve', '--no-extensions', '--no-context-files',
          '--model', 'local/fixture-model', '--session-dir', sessions, '--session-id', session.id,
          '--verbose', '--tui-mode', mode, '--theme', 'dark'], { cwd, cols: 200, rows: 40,
          env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
            LOCAL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, LOCAL_MODEL: 'fixture-model',
            TERM: 'xterm-256color', NO_COLOR: '1' } });
        let output = '';
        terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
        const visible = () => stripVTControlCharacters(output);
        const ready = () => vi.waitFor(() => expect(visible()).toContain('editor ready · Enter send'), { timeout: 2_000 });
        await ready();
        output = '';
        terminal.write(`/navigate ${target}${scenario === 'choice' ? '' : ' --summarize'}\r`);
        if (scenario === 'abort') {
          await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 2_000 });
          terminal.write('/new MustNotRun\r');
          await vi.waitFor(() => expect(visible()).toContain('Une commande ou saisie est déjà en cours.'), { timeout: 1_000 });
          terminal.write('\u0003');
          await vi.waitFor(() => expect(visible()).toContain('Navigation cancelled.'), { timeout: 2_000 });
        } else {
          await vi.waitFor(() => expect(visible()).toContain(scenario === 'choice'
            ? 'Repeat with --summarize or --no-summary' : 'Branch summary saved.'), { timeout: 2_000 });
        }
        await ready();
        // Rejected concurrent input remains a draft. Readline Ctrl-U erases to
        // the caret, unlike fullscreen's clear-all: move to its end first.
        if (scenario === 'abort') terminal.write(mode === 'regular' ? '\u0005\u0015' : '\u0015');
        terminal.write('/quit\r');
        await vi.waitFor(() => expect(exited, visible()).toMatchObject({ exitCode: 0 }), { timeout: 2_000 });
        const reloaded = new SessionManager({ store: new JsonlSessionStore(sessions) });
        await reloaded.loadAllSessions();
        expect(reloaded.list()).toHaveLength(1);
        expect(requests).toHaveLength(scenario === 'choice' ? 0 : 1);
        expect((await reloaded.getRawEntries(session.id)).some(entry => entry.id === source)).toBe(true);
        if (scenario === 'summary') {
          expect(await reloaded.getBranchSummaries(session.id)).toMatchObject([
            { parentEntryId: target, fromEntryId: source, usage: { inputTokens: 12 } },
          ]);
          expect(reloaded.getEffectiveContext(session.id).flatMap(entry => entry.type === 'message' ? [entry.content] : []))
            .toEqual(['Common root', '[Custom Message: notice]\nUseful custom context',
              '[Branch Summary: PTY navigation]\nTerminal branch outcome.']);
        } else {
          expect(reloaded.get(session.id)?.activeLeafId).toBe(source);
          expect(await reloaded.getBranchSummaries(session.id)).toEqual([]);
          if (scenario === 'abort') expect(heldClosed).toBe(1);
        }
      } finally {
        if (terminal && !exited) terminal.kill();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => { server.close(() => resolve()); });
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
