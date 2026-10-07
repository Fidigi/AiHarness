import { describe, expect, it, vi } from 'vitest';
import { CredentialRedactor } from '@ai-harness/core';
import type { Response } from 'express';
import { SseChannel } from './sse-channel.js';

function responseMock(writeResult = true): {
  response: Response;
  writes: string[];
  end: ReturnType<typeof vi.fn>;
} {
  const writes: string[] = [];
  const end = vi.fn();
  const response = {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    write: vi.fn((value: string | Uint8Array) => {
      writes.push(Buffer.from(value).toString('utf8'));
      return writeResult;
    }),
    end,
  } as unknown as Response;
  return { response, writes, end };
}

describe('SseChannel', () => {
  it('redacts known credentials at the final event boundary and closes idempotently', () => {
    const secret = 'sse-private-credential';
    const target = responseMock();
    const channel = new SseChannel(target.response, new CredentialRedactor([secret]).createStream());

    expect(channel.send('run.delta', { content: `before ${secret} after` }, 12)).toBe(true);
    channel.close();
    channel.close();

    const output = target.writes.join('');
    expect(output).toContain('event: run.delta');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(secret);
    expect(target.end).toHaveBeenCalledTimes(1);
  });

  it('fails closed on invalid tokens, oversized events, cycles, and backpressure', () => {
    for (const send of [
      (channel: SseChannel) => channel.send('invalid\nevent', { ok: true }),
      (channel: SseChannel) => channel.send('event', { content: 'x'.repeat(1024 * 1024) }),
      (channel: SseChannel) => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        return channel.send('event', cyclic);
      },
    ]) {
      const target = responseMock();
      const channel = new SseChannel(target.response, new CredentialRedactor().createStream());
      expect(send(channel)).toBe(false);
      expect(target.end).toHaveBeenCalledTimes(1);
    }

    const pressured = responseMock(false);
    const channel = new SseChannel(pressured.response, new CredentialRedactor().createStream());
    expect(channel.heartbeat()).toBe(false);
    expect(pressured.end).toHaveBeenCalledTimes(1);
    expect(channel.send('event', { ignored: true })).toBe(false);
  });
});
