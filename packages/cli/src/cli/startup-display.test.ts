import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, ExtensionRegistry } from '@ai-harness/core';
import { parseCliArguments, cliVersion, formatCliHelp, completeCliOptions } from './args.js';
import { resolveStartupDisplay } from './startup-display.js';
import { TerminalUI } from '../tui/terminal-ui.js';
import { FullscreenUI } from '../tui/fullscreen-ui.js';
import { createTerminalStatus } from '../tui/status.js';
import { ThemeManager } from '../tui/theme-manager.js';
import { plainTerminalText } from '../tui/terminal-text.js';

afterEach(() => vi.restoreAllMocks());

describe('startup display policy and renderers', () => {
  for (const quiet of [undefined, false, 'header', true] as const) {
    for (const verbose of [false, true]) {
      it(`quiet ${String(quiet)} with verbose ${verbose}`, () => {
        expect(resolveStartupDisplay(quiet, verbose)).toEqual({
          header: verbose || quiet !== true,
          details: verbose || quiet === undefined || quiet === false,
        });
      });
    }
  }

  it('keeps verbose strict, reserved, idempotent and distinct from version or prompt text', async () => {
    expect(parseCliArguments(['--verbose', '--verbose']).verbose).toBe(true);
    expect(parseCliArguments([]).verbose).toBe(false);
    expect(parseCliArguments(['-v'])).toMatchObject({ version: true, verbose: false });
    for (const bootstrap of [false, true]) {
      expect(() => parseCliArguments(['--verbose=false'], [], bootstrap))
        .toThrow('--verbose does not accept a value.');
    }
    expect(parseCliArguments(['--', '--verbose'])).toMatchObject({ verbose: false, messages: ['--verbose'] });
    expect(parseCliArguments(['prompt', '--verbose'])).toMatchObject({ verbose: false, messages: ['prompt', '--verbose'] });
    await expect(new ExtensionRegistry().load('shadow', api => {
      api.registerOption('verbose', { type: 'boolean', description: 'Shadow' });
    })).rejects.toThrow('Invalid extension startup option metadata.');
    expect(formatCliHelp()).toContain('--verbose');
    expect(completeCliOptions('--verb', [])).toEqual(['--verbose']);
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  for (const mode of ['regular', 'fullscreen'] as const) {
    for (const details of [false, true]) {
      it(`${mode}: initial details ${details}, safe configured title and later live status`, async () => {
        const chunks: string[] = [];
        vi.spyOn(console, 'clear').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { chunks.push(values.join(' ')); });
        const output = { columns: 180, rows: 32, write: (value: string) => { chunks.push(value); } };
        const options = { title: 'Configured v9.8.7\u001b]52;c;unsafe\u0007', startupDetails: details };
        const ui = mode === 'regular' ? new TerminalUI(options) : new FullscreenUI({ ...options, output });
        const manager = new SessionManager();
        const session = await manager.create({ title: 'display session', cwd: '/actual' });
        const status = await createTerminalStatus({
          sessionManager: manager, sessionId: session.id, cwd: '/actual', model: 'mock-model', provider: 'mock',
          resources: { skills: 2, prompts: 3, extensions: 4, instructions: 5, diagnostics: 0 },
        });
        ui.setStatus(status);
        ui.welcome();
        expect(plainTerminalText(chunks.join('\n'))).toContain('Configured v9.8.7');
        expect(chunks.join('\n')).not.toContain('unsafe');
        expect(plainTerminalText(chunks.join('\n')).includes('resources 2 skills')).toBe(details);
        chunks.length = 0;
        ui.setStatus(status);
        ui.setTheme(ThemeManager.builtins()[0]!);
        ui.displayStatus();
        expect(plainTerminalText(chunks.join('\n')).includes('resources 2 skills')).toBe(details);
        chunks.length = 0;
        ui.finishStartup();
        ui.finishStartup();
        ui.displayStatus();
        expect(plainTerminalText(chunks.join('\n'))).toContain('resources 2 skills');
        expect(plainTerminalText(chunks.join('\n'))).toContain('full history (all branches)');
        if (ui instanceof FullscreenUI) ui.leave();
      });
    }
  }
});
