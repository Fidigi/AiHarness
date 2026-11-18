import { describe, expect, it } from 'vitest';
import { terminalStreamRecord } from './terminal-replay';

const snapshot = { id: 'pty', cwd: '/workspace', name: 'Terminal', shell: '/bin/sh', pid: 12,
  cols: 80, rows: 24, status: 'running', startedAt: '', lastOffset: 6 };
const ready = { snapshot, reset: false, oldestOffset: 0, lastOffset: 6 };
const output = { type: 'output', terminalId: 'pty', offset: 0, endOffset: 6, data: 'é😀', timestamp: '' };
describe('native PTY byte cursor admission', () => {
  it('accepts genuine Unicode bytes, bounded readiness and zero-width exits', () => {
    expect(terminalStreamRecord('connection.ready', ready, 'pty')).toMatchObject({ type: 'connection.ready' });
    expect(terminalStreamRecord('output', output, 'pty')).toEqual({ type: 'event', event: output });
    expect(terminalStreamRecord('exit', { ...output, type: 'exit', offset: 6, exitCode: 7 }, 'pty')).toMatchObject({ event: { type: 'exit', exitCode: 7 } });
  });
  it.each([
    ['output', { ...output, endOffset: 3 }], // UTF-16 length is not an offset.
    ['output', { ...output, terminalId: 'other' }], ['output', { ...output, offset: -1 }],
    ['output', { ...output, data: 'x'.repeat(16_385), endOffset: 16_385 }],
    ['exit', { ...output, type: 'exit', exitCode: 0 }],
    ['output', { ...output, type: 'exit' }], ['unknown', output],
    ['connection.ready', { ...ready, oldestOffset: 7 }],
    ['connection.ready', { ...ready, reset: 'false' }],
    ['connection.ready', { ...ready, snapshot: { ...snapshot, id: 'other' } }],
    ['connection.ready', { ...ready, snapshot: { ...snapshot, lastOffset: 5 } }],
    ['connection.ready', { ...ready, snapshot: { ...snapshot, exitCode: '7' } }],
    ['connection.ready', { ...ready, snapshot: { ...snapshot, signal: -1 } }],
    ['connection.ready', { ...ready, snapshot: { ...snapshot, completedAt: {} } }],
  ])('refuses malformed, foreign or mixed-unit records (%s)', (type, data) => {
    expect(() => terminalStreamRecord(type as string, data, 'pty')).toThrow('Terminal stream unavailable');
  });
});
