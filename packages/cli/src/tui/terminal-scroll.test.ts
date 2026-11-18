import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalUI } from './terminal-ui.js';
import { terminalWidth } from './terminal-text.js';

function fixture(ui = new TerminalUI()) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const visible = () => stripVTControlCharacters(log.mock.calls.map(args => args.join(' ')).join('\n'));
  const seed = (count: number, first = 0) => {
    for (let index = first; index < first + count; index++) ui.addTranscriptEntry({ type: 'user', content: `history-${String(index).padStart(2, '0')}` });
  };
  return { ui, log, visible, seed };
}
afterEach(() => vi.restoreAllMocks());

describe('real bounded regular transcript page actions', () => {
  it('renders older and newer entry contents rather than an indicative counter', () => {
    const { ui, seed, log, visible } = fixture(); seed(40); ui.scrollUp(20);
    expect(visible()).toContain('Transcript entries 1-20/40'); expect(visible()).toContain('You: history-00');
    expect(visible()).toContain('You: history-19'); expect(visible()).not.toContain('history-20');
    log.mockClear(); ui.scrollDown(20); expect(visible()).toContain('Transcript entries 21-40/40');
    expect(visible()).toContain('history-39'); expect(visible()).not.toContain('history-19');
    expect(ui.getTranscriptStats()).toEqual({ totalMessages: 40, userCount: 40, assistantCount: 0 });
  });
  it('clamps both boundaries and never creates a negative or zero-tail slice', () => {
    const { ui, seed, log, visible } = fixture(); seed(40); ui.scrollUp(500); ui.scrollUp(500);
    expect(visible()).toContain('Transcript entries 1-20/40'); expect(visible()).not.toContain('history-39');
    log.mockClear(); ui.scrollDown(500); ui.scrollDown(500); expect(visible()).toContain('Transcript entries 21-40/40');
    expect(visible()).not.toContain('history-00');
  });
  it('renders a short buffer once without losing entries', () => {
    const { ui, seed, log, visible } = fixture(); seed(3); ui.scrollUp(500);
    expect(log).toHaveBeenCalledTimes(4); expect(visible()).toContain('Transcript entries 1-3/3');
    for (let index = 0; index < 3; index++) expect(visible()).toContain(`history-0${index}`);
    log.mockClear(); ui.scrollDown(500); expect(log).toHaveBeenCalledTimes(4);
  });
  it('keeps an empty buffer empty without printing a counterfeit scroll report', () => {
    const { ui, log } = fixture(); ui.scrollUp(); ui.scrollDown(); expect(log).not.toHaveBeenCalled();
    expect(ui.getTranscriptStats().totalMessages).toBe(0);
  });
  it('bounds invalid movement values without coercion or unbounded traversal', () => {
    const { ui, seed, log, visible } = fixture(); seed(40); ui.scrollUp(-20);
    expect(visible()).toContain('Transcript entries 21-40/40');
    log.mockClear(); ui.scrollUp(Number.NaN); expect(visible()).toContain('Transcript entries 20-39/40');
    log.mockClear(); ui.scrollUp(Infinity); expect(visible()).toContain('Transcript entries 19-38/40');
    log.mockClear(); ui.scrollDown(0.5); expect(visible()).toContain('Transcript entries 20-39/40');
  });
  it('anchors a historical page when new completed entries arrive', () => {
    const { ui, seed, log, visible } = fixture(); seed(60); ui.scrollUp(20); log.mockClear(); seed(1, 60); ui.scrollUp(0);
    expect(visible()).toContain('Transcript entries 21-40/61'); expect(visible()).toContain('history-20');
    expect(visible()).toContain('history-39'); expect(visible()).not.toContain('history-40');
  });
  it('conserves the existing 500-entry retention boundary while anchoring at the oldest retained entry', () => {
    const { ui, seed, log, visible } = fixture(); seed(500); ui.scrollUp(500); log.mockClear(); seed(1, 500); ui.scrollUp(0);
    expect(ui.getTranscriptStats().totalMessages).toBe(500); expect(visible()).toContain('history-01');
    expect(visible()).not.toContain('history-00'); expect(visible()).not.toContain('history-500'); expect(log).toHaveBeenCalledTimes(21);
  });
  it('uses bounded single-cell rows with all entry roles and control-safe text', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 18 });
    try {
      const { ui, log, visible } = fixture();
      for (const type of ['user', 'assistant', 'system', 'command'] as const) ui.addTranscriptEntry({ type, content: '界'.repeat(3000) + '\n\u001b[2J\ttrailing' });
      ui.scrollUp(20); expect(log).toHaveBeenCalledTimes(5);
      expect(visible()).toContain('You:'); expect(visible()).toContain('AI:'); expect(visible()).toContain('System:'); expect(visible()).toContain('Command:');
      for (const row of log.mock.calls.map(args => stripVTControlCharacters(args.join(' ')))) expect(terminalWidth(row)).toBeLessThanOrEqual(18);
      expect(log.mock.calls.flat().join('')).not.toContain('\u001b[2J');
    } finally { if (descriptor) Object.defineProperty(process.stdout, 'columns', descriptor); else Reflect.deleteProperty(process.stdout, 'columns'); }
  });
  it('reapplies current credential redaction before slicing preview text', () => {
    let learned = false;
    const { ui, visible } = fixture(new TerminalUI({ redactText: value => learned ? value.replaceAll('PRIVATE-CREDENTIAL', '[REDACTED]') : value }));
    ui.addTranscriptEntry({ type: 'user', content: 'PRIVATE-CREDENTIAL' }); learned = true; ui.scrollUp();
    expect(visible()).toContain('[REDACTED]'); expect(visible()).not.toContain('PRIVATE-CREDENTIAL');
  });
  it('does not finish, cancel or swallow an in-progress response', () => {
    const { ui, seed } = fixture(); seed(40);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stream = ui.startStreaming(); stream.write('before-page'); ui.scrollUp(20);
    expect(ui.isCurrentlyStreaming()).toBe(true); stream.write('after-page'); stream.finish();
    expect(write.mock.calls.map(args => args[0]).join('')).toContain('before-pageafter-page'); expect(ui.isCurrentlyStreaming()).toBe(false);
    expect(ui.getTranscriptStats().totalMessages).toBe(40);
  });
});
