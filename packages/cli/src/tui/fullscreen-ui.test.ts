import { describe, expect, it, vi } from 'vitest';
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

  it('detects terminal support from both streams', () => {
    const input = { isTTY: true, setRawMode: vi.fn() };
    expect(FullscreenUI.isSupported(input as never, { isTTY: true })).toBe(true);
    expect(FullscreenUI.isSupported(input as never, { isTTY: false })).toBe(false);
  });
});
