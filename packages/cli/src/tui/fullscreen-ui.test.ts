import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@ai-harness/core';
import chalk from 'chalk';
import { createTerminalStatus } from './status.js';
import { plainTerminalText, terminalWidth } from './terminal-text.js';
import { FullscreenUI } from './fullscreen-ui';

function createScreen(columns = 40, rows = 12) {
  const chunks: string[] = [];
  return {
    screen: {
      columns,
      rows,
      isTTY: true,
      write: (chunk: string) => chunks.push(chunk),
    },
    chunks,
  };
}

describe('FullscreenUI', () => {
  it('enters and leaves the ANSI alternate screen', () => {
    const { screen, chunks } = createScreen();
    const ui = new FullscreenUI({ output: screen });

    ui.enter();
    ui.leave();

    expect(chunks.join('')).toContain('\u001b[?1049h');
    expect(chunks.join('')).toContain('\u001b[?1049l');
    expect(ui.isActive()).toBe(false);
  });

  it('renders transcript and input in separate regions', () => {
    const { screen, chunks } = createScreen();
    const ui = new FullscreenUI({ output: screen });
    ui.enter();
    chunks.length = 0;

    ui.addTranscriptEntry({ type: 'user', content: 'Bonjour' });
    ui.setPrompt('Session: ');
    ui.setInput('question');

    const frame = chunks.at(-1)!;
    expect(frame).toContain('Vous: Bonjour');
    expect(frame).toContain('Session: question');
    expect(frame).toContain('─'.repeat(40));
  });

  it('updates one ephemeral streaming region', () => {
    const { screen, chunks } = createScreen();
    const ui = new FullscreenUI({ output: screen });
    ui.enter();

    const stream = ui.startStreaming();
    stream.write('Bon');
    stream.write('jour');
    expect(chunks.at(-1)).toContain('Assistant: Bonjour');

    stream.finish();
    expect(ui.isCurrentlyStreaming()).toBe(false);
    expect(chunks.at(-1)).not.toContain('Assistant: Bonjour');
  });

  it('routes command output into the viewport', () => {
    const { screen, chunks } = createScreen();
    const ui = new FullscreenUI({ output: screen });
    ui.enter();

    ui.writeOutput('\u001b[31mCommande terminée\u001b[39m');

    expect(chunks.at(-1)).toContain('Commande: Commande terminée');
    expect(chunks.at(-1)).not.toContain('\u001b[31m');
  });

  it('updates one shell command entry while output streams', () => {
    const { screen, chunks } = createScreen(80, 16);
    const ui = new FullscreenUI({ output: screen });
    ui.enter();

    const command = ui.startShellCommand('printf test', false);
    command.write('te');
    command.write('st');
    expect(chunks.at(-1)).toContain('Commande: $ printf test');
    expect(chunks.at(-1)).toContain('test');

    command.finish({ status: 'completed', exitCode: 0, truncated: false });
    expect(chunks.at(-1)).toContain('[code 0]');
  });

  it('renders actual status, keeps narrow/short resize frames bounded, and preserves panels/scroll/cleanup', async () => {
    const { screen, chunks } = createScreen(180, 30);
    const manager = new SessionManager();
    const session = await manager.create({ title: 'status session', cwd: '/actual' });
    await manager.addMessage(session.id, { role: 'assistant', content: 'reply', usage: { inputTokens: 5 } });
    const ui = new FullscreenUI({ output: screen });
    ui.setStatus(await createTerminalStatus({ sessionManager: manager, sessionId: session.id,
      cwd: '/actual', provider: 'mock', model: 'mock', resources: { skills: 1, prompts: 2, extensions: 3, instructions: 4, diagnostics: 0 } }));
    ui.enter();
    screen.columns = 80;
    screen.rows = 24;
    ui.render();
    const standard = chunks.at(-1)!;
    expect(standard).toContain('cwd /actual');
    expect(standard).toContain('session status session');
    expect(standard).toContain('model mock/mock');
    expect(standard).toContain('resources 1 skills');
    expect(standard).toContain('context ~');
    expect(standard).toContain('active path');
    expect(standard).toContain('full history (all branches)');
    expect(standard).toContain('editor ready');
    screen.columns = 180;
    screen.rows = 30;
    ui.setPanelProvider(() => ['extension panel']);
    for (let i = 0; i < 20; i++) ui.addTranscriptEntry({ type: 'user', content: `line ${i}` });
    ui.setInput('界🙂 editor text', 4);
    let frame = chunks.at(-1)!;
    expect(frame).toContain('cwd /actual');
    expect(frame).toContain('status session');
    expect(frame).toContain('1 skills');
    expect(frame).toContain('full history (all branches)');
    expect(frame).toContain('cost unknown');
    expect(frame).toContain('extension panel');
    ui.scrollUp(8);
    expect(chunks.at(-1)).not.toContain('Vous: line 19');
    ui.scrollDown(8);
    expect(chunks.at(-1)).toContain('Vous: line 19');
    for (const [width, height] of [[20, 12], [8, 6], [1, 2], [40, 14], [180, 30]]) {
      screen.columns = width;
      screen.rows = height;
      ui.render();
      frame = chunks.at(-1)!;
      const plain = plainTerminalText(frame.replace(/^\x1b\[2J\x1b\[H/, '').replace(/\x1b\[\d+D$/, ''));
      expect(plain.split('\n').length).toBeLessThanOrEqual(height);
      expect(plain.split('\n').every(line => terminalWidth(line) <= width)).toBe(true);
    }
    ui.leave();
    const count = chunks.length;
    ui.render();
    expect(chunks).toHaveLength(count);
    expect(chunks.at(-1)).toBe('\x1b[?25h\x1b[?1049l');
  });

  it('sanitizes panels/prompts/editor/transcript and split model/shell control strings while retaining theme SGR', () => {
    const { screen, chunks } = createScreen(80, 20);
    const previous = chalk.level;
    chalk.level = 3;
    try {
      const ui = new FullscreenUI({ output: screen });
      ui.enter();
      ui.setPanelProvider(() => ['panel\x1b]52;c;FORGED\x07']);
      ui.setPrompt('prompt\x1b[2J: ');
      ui.setInput('editor\u009d0;FORGED\u009c');
      ui.addTranscriptEntry({ type: 'user', content: 'user\x1b[?1049l\x1b]0;FORGED\x1b\\' });
      const stream = ui.startStreaming();
      stream.write('model\x1b]52;c;');
      stream.write('FORGED\x1b');
      stream.write('\\ safe');
      expect(chunks.at(-1)).toContain('model safe');
      stream.finish();
      const shell = ui.startShellCommand('echo safe', false);
      shell.write('shell\x1b[');
      shell.write('2J safe');
      shell.finish({ status: 'completed', exitCode: 0, truncated: false });
      const frame = chunks.at(-1)!;
      expect(frame).not.toContain('FORGED');
      expect(frame.match(/\x1b\[2J/g)).toHaveLength(1); // renderer clear only
      expect(frame).not.toContain('\x1b[?1049l');
      expect(frame).toContain('\x1b[38;2;');
      expect(frame).toContain('shell safe');
    } finally { chalk.level = previous; }
  });

  it('detects terminal support from both streams', () => {
    const input = { isTTY: true, setRawMode: vi.fn() };
    expect(FullscreenUI.isSupported(input as never, { isTTY: true })).toBe(true);
    expect(FullscreenUI.isSupported(input as never, { isTTY: false })).toBe(false);
  });
});
