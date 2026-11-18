import { crc32 } from 'node:zlib';

/** AWS EventStream wire fixture, independently framed from the provider decoder. */
export function bedrockFrame(type: string, body: unknown, messageType = 'event'): Buffer {
  const headers = Buffer.concat(Object.entries({ ':message-type': messageType, ':event-type': type, ':content-type': 'application/json' }).map(([name, value]) => {
    const key = Buffer.from(name), text = Buffer.from(value), length = Buffer.alloc(2);
    length.writeUInt16BE(text.length);
    return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([7]), length, text]);
  }));
  const payload = Buffer.from(JSON.stringify(body));
  const frame = Buffer.alloc(16 + headers.length + payload.length);
  frame.writeUInt32BE(frame.length); frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12); payload.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

export function bedrockText(text = 'fragment', stopReason = 'end_turn', usage?: unknown): Buffer {
  return Buffer.concat([
    bedrockFrame('messageStart', { role: 'assistant' }),
    bedrockFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text } }),
    bedrockFrame('contentBlockStop', { contentBlockIndex: 0 }),
    bedrockFrame('messageStop', { stopReason }),
    ...(usage ? [bedrockFrame('metadata', { usage })] : []),
  ]);
}
