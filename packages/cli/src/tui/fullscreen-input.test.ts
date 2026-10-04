import { describe, expect, it, vi } from 'vitest';
import { FullscreenInput } from './fullscreen-input';
import type { FullscreenUI } from './fullscreen-ui';

function createUI() {
  return {
    setInput: vi.fn(),
    setPrompt: vi.fn(),
    render: vi.fn(),
    scrollUp: vi.fn(),
    scrollDown: vi.fn(),
    leave: vi.fn(),
  } as unknown as FullscreenUI;
}

function createInput(ui = createUI()) {
  const handlers = {
    onLine: vi.fn(),
    onInterrupt: vi.fn(),
    onExit: vi.fn(),
    onError: vi.fn(),
  };
  const stream = {
    resume: vi.fn(),
    pause: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { controller: new FullscreenInput(ui, handlers, stream), ui, handlers };
}

describe('FullscreenInput', () => {
  it('edits text at the cursor', () => {
    const { controller, ui } = createInput();

    controller.handleKeypress('a', { name: 'a' });
    controller.handleKeypress('c', { name: 'c' });
    controller.handleKeypress('', { name: 'left' });
    controller.handleKeypress('b', { name: 'b' });

    expect(controller.getValue()).toBe('abc');
    expect(ui.setInput).toHaveBeenLastCalledWith('abc', 2);
  });

  it('supports backspace, delete and ctrl+u', () => {
    const { controller } = createInput();
    for (const character of 'abc') controller.handleKeypress(character, { name: character });

    controller.handleKeypress('', { name: 'left' });
    controller.handleKeypress('', { name: 'backspace' });
    expect(controller.getValue()).toBe('ac');
    controller.handleKeypress('', { name: 'delete' });
    expect(controller.getValue()).toBe('a');
    controller.handleKeypress('', { name: 'u', ctrl: true });
    expect(controller.getValue()).toBe('');
  });

  it('submits Enter as steering without blocking later input and stores history', async () => {
    const { controller, handlers } = createInput();
    for (const character of 'test') controller.handleKeypress(character, { name: character });
    controller.handleKeypress('\r', { name: 'return' });

    await vi.waitFor(() => expect(handlers.onLine).toHaveBeenCalledWith('test', 'steer'));
    controller.handleKeypress('', { name: 'up' });
    expect(controller.getValue()).toBe('test');
  });

  it('completes slash commands with tab', () => {
    const ui = createUI();
    const controller = new FullscreenInput(ui, {
      onLine: vi.fn(),
      onInterrupt: vi.fn(),
      onExit: vi.fn(),
      complete: input => ['/prompts', '/provider'].filter(candidate => candidate.startsWith(input)),
    }, { resume: vi.fn(), pause: vi.fn(), on: vi.fn(), off: vi.fn() });
    for (const character of '/promp') controller.handleKeypress(character, { name: character });

    controller.handleKeypress('', { name: 'tab' });

    expect(controller.getValue()).toBe('/prompts ');
  });

  it('distinguishes follow-ups and restores queued text before transcript navigation', async () => {
    const ui = createUI();
    const onDequeue = vi.fn((current: string) => `queued\n${current}`);
    const handlers = {
      onLine: vi.fn(),
      onInterrupt: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
      onDequeue,
    };
    const controller = new FullscreenInput(ui, handlers, {
      resume: vi.fn(), pause: vi.fn(), on: vi.fn(), off: vi.fn(),
    });
    for (const character of 'later') controller.handleKeypress(character, { name: character });
    controller.handleKeypress('\r', { name: 'return', meta: true });
    await vi.waitFor(() => expect(handlers.onLine).toHaveBeenCalledWith('later', 'follow-up'));

    controller.replaceValue('draft');
    controller.handleKeypress('', { name: 'up', meta: true });
    expect(onDequeue).toHaveBeenCalledWith('draft');
    expect(controller.getValue()).toBe('queued\ndraft');
    expect(ui.scrollUp).not.toHaveBeenCalled();
  });

  it('dispatches interrupt, exit and transcript navigation when no queue is restored', () => {
    const { controller, handlers, ui } = createInput();

    controller.handleKeypress('', { name: 'c', ctrl: true });
    controller.handleKeypress('', { name: 'd', ctrl: true });
    controller.handleKeypress('', { name: 'up', meta: true });
    controller.handleKeypress('', { name: 'down', meta: true });

    expect(handlers.onInterrupt).toHaveBeenCalledOnce();
    expect(handlers.onExit).toHaveBeenCalledOnce();
    expect(ui.scrollUp).toHaveBeenCalledOnce();
    expect(ui.scrollDown).toHaveBeenCalledOnce();
  });

  it('recognizes terminals that report Alt+Enter as Escape then Enter', async () => {
    const { controller, handlers } = createInput();
    controller.handleKeypress('x', { name: 'x' });
    controller.handleKeypress('', { name: 'escape' });
    controller.handleKeypress('\r', { name: 'return' });

    await vi.waitFor(() => expect(handlers.onLine).toHaveBeenCalledWith('x', 'follow-up'));
  });

  it('uses Ctrl+Q as a terminal-compatible follow-up shortcut', async () => {
    const { controller, handlers } = createInput();
    controller.handleKeypress('x', { name: 'x' });
    controller.handleKeypress('', { name: 'q', ctrl: true });

    await vi.waitFor(() => expect(handlers.onLine).toHaveBeenCalledWith('x', 'follow-up'));
  });
});
