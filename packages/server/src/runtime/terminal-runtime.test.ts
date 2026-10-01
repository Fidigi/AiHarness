import { describe, expect, it, vi } from 'vitest';
import {
  TerminalRuntime,
  type PseudoTerminal,
  type SpawnPseudoTerminal,
} from './terminal-runtime.js';

class FakePty implements PseudoTerminal {
  readonly pid = 42;
  readonly process = '/bin/test-shell';
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  private dataListener?: (data: string) => void;
  private exitListener?: (event: { exitCode: number; signal?: number }) => void;

  write(data: string): void { this.writes.push(data); }
  resize(columns: number, rows: number): void { this.resizes.push([columns, rows]); }
  kill(): void { this.killed = true; }
  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListener = listener;
    return { dispose: () => { this.dataListener = undefined; } };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListener = listener;
    return { dispose: () => { this.exitListener = undefined; } };
  }
  emitData(data: string): void { this.dataListener?.(data); }
  emitExit(exitCode: number, signal?: number): void { this.exitListener?.({ exitCode, signal }); }
}

function fixture(options: { maxReplayBytes?: number } = {}) {
  const terminals: FakePty[] = [];
  const spawn: SpawnPseudoTerminal = vi.fn(() => {
    const terminal = new FakePty();
    terminals.push(terminal);
    return terminal;
  });
  return {
    runtime: new TerminalRuntime({ spawn, maxReplayBytes: options.maxReplayBytes }),
    spawn,
    terminals,
  };
}

describe('TerminalRuntime', () => {
  it('owns PTYs independently from requests and supports input and resize', () => {
    const { runtime, spawn, terminals } = fixture();
    const created = runtime.create({ cwd: '/workspace', cols: 90, rows: 24, name: 'Shell' });
    expect(created).toMatchObject({ cwd: '/workspace', cols: 90, rows: 24, status: 'running', pid: 42 });
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cwd: '/workspace' }));

    runtime.write(created.id, 'echo hello\r');
    runtime.resize(created.id, 120, 40);
    expect(terminals[0]!.writes).toEqual(['echo hello\r']);
    expect(terminals[0]!.resizes).toEqual([[120, 40]]);
    expect(runtime.get(created.id)).toMatchObject({ cols: 120, rows: 40 });
  });

  it('does not inherit server and provider credentials', () => {
    const previousProviderKey = process.env.OPENAI_API_KEY;
    const previousAuthToken = process.env.AI_HARNESS_AUTH_TOKEN;
    process.env.OPENAI_API_KEY = 'provider-secret';
    process.env.AI_HARNESS_AUTH_TOKEN = 'server-secret';
    try {
      const { runtime, spawn } = fixture();
      runtime.create({ cwd: '/workspace' });
      const options = vi.mocked(spawn).mock.calls[0]![2];
      expect(options.env).toMatchObject({ PWD: '/workspace', TERM: expect.any(String) });
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(options.env).not.toHaveProperty('AI_HARNESS_AUTH_TOKEN');
    } finally {
      if (previousProviderKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousProviderKey;
      if (previousAuthToken === undefined) delete process.env.AI_HARNESS_AUTH_TOKEN;
      else process.env.AI_HARNESS_AUTH_TOKEN = previousAuthToken;
    }
  });

  it('replays bounded ANSI output by UTF-8 byte offset and signals reset', () => {
    const { runtime, terminals } = fixture({ maxReplayBytes: 8 });
    const created = runtime.create({ cwd: '/workspace' });
    terminals[0]!.emitData('\u001b[31mred');
    const firstOffset = runtime.get(created.id)!.lastOffset;
    terminals[0]!.emitData('éééé');

    const tail = runtime.replay(created.id, firstOffset);
    expect(tail.events).toEqual([expect.objectContaining({ type: 'output', data: 'éééé', offset: firstOffset })]);
    expect(tail.lastOffset).toBe(firstOffset + 8);
    expect(runtime.replay(created.id, 1).reset).toBe(true);
  });

  it('evicts a single output chunk larger than the replay budget', () => {
    const { runtime, terminals } = fixture({ maxReplayBytes: 8 });
    const created = runtime.create({ cwd: '/workspace' });
    terminals[0]!.emitData('oversized');

    expect(runtime.replay(created.id, 0)).toMatchObject({ events: [], oldestOffset: 9, lastOffset: 9 });
    expect(runtime.replay(created.id, 1).reset).toBe(true);
  });

  it('publishes exit state and kills every active PTY on shutdown', () => {
    const { runtime, terminals } = fixture();
    const first = runtime.create({ cwd: '/workspace' });
    const second = runtime.create({ cwd: '/workspace' });
    const listener = vi.fn();
    runtime.subscribe(first.id, listener);
    terminals[0]!.emitExit(7, 15);
    expect(runtime.get(first.id)).toMatchObject({ status: 'failed', exitCode: 7, signal: 15 });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'exit', exitCode: 7 }));

    runtime.shutdown();
    expect(terminals[0]!.killed).toBe(false);
    expect(terminals[1]!.killed).toBe(true);
    expect(runtime.get(second.id)).toBeUndefined();
  });

  it('validates input, dimensions, active count and lifecycle', () => {
    const { runtime, terminals } = fixture();
    const created = runtime.create({ cwd: '/workspace' });
    expect(() => runtime.resize(created.id, 1, 1)).toThrow(/dimensions/i);
    expect(() => runtime.write(created.id, '')).toThrow(/saisie/i);
    terminals[0]!.emitExit(0);
    expect(() => runtime.write(created.id, 'pwd\r')).toThrow(/terminé/i);
    expect(() => runtime.kill('missing')).toThrow(/introuvable/i);
  });
});
