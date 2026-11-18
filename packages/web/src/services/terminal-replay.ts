import { apiFetch, boundedSseRecords } from './api-transport';
import type { TerminalSnapshot, TerminalStreamRecord } from './api';

export class TerminalStreamError extends Error {
  constructor(readonly status?: number) { super('Terminal stream unavailable'); }
}
export async function* readTerminalEvents(terminalId: string, after = 0, signal?: AbortSignal): AsyncGenerator<TerminalStreamRecord, void> {
  const response = await apiFetch(`/api/terminals/${encodeURIComponent(terminalId)}/events?after=${after}`,
    { headers: { Accept: 'text/event-stream' }, signal });
  if (!response.ok) throw new TerminalStreamError(response.status);
  for await (const record of boundedSseRecords(response)) {
    yield terminalStreamRecord(record.event, JSON.parse(record.data), terminalId);
  }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const offset = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;

export function terminalStreamRecord(event: string, data: unknown, id: string): TerminalStreamRecord {
  if (!object(data)) throw new TerminalStreamError();
  if (event === 'connection.ready' && object(data.snapshot)) {
    const snapshot = data.snapshot;
    if (snapshot.id !== id || !text(snapshot.cwd, 4096) || !text(snapshot.name, 200) || !text(snapshot.shell, 4096)
      || !offset(snapshot.pid) || !text(snapshot.startedAt, 100) || !offset(snapshot.lastOffset)
      || !Number.isSafeInteger(snapshot.cols) || Number(snapshot.cols) < 20 || Number(snapshot.cols) > 500
      || !Number.isSafeInteger(snapshot.rows) || Number(snapshot.rows) < 5 || Number(snapshot.rows) > 200
      || !['running', 'exited', 'killed', 'failed'].includes(String(snapshot.status))
      || (snapshot.exitCode !== undefined && !Number.isSafeInteger(snapshot.exitCode))
      || (snapshot.signal !== undefined && !offset(snapshot.signal))
      || (snapshot.completedAt !== undefined && !text(snapshot.completedAt, 100))
      || typeof data.reset !== 'boolean' || !offset(data.oldestOffset) || !offset(data.lastOffset)
      || data.oldestOffset > data.lastOffset || snapshot.lastOffset !== data.lastOffset) throw new TerminalStreamError();
    return { type: 'connection.ready', snapshot: snapshot as unknown as TerminalSnapshot,
      reset: data.reset, oldestOffset: data.oldestOffset, lastOffset: data.lastOffset };
  }
  if (data.terminalId !== id || data.type !== event || !offset(data.offset) || !offset(data.endOffset)
    || !text(data.timestamp, 100)) throw new TerminalStreamError();
  if (event === 'output' && typeof data.data === 'string' && data.data.length <= 16_384
    && data.endOffset - data.offset === new TextEncoder().encode(data.data).byteLength) {
    return { type: 'event', event: { type: 'output', terminalId: id, offset: data.offset,
      endOffset: data.endOffset, data: data.data, timestamp: data.timestamp } };
  }
  if (event === 'exit' && data.offset === data.endOffset && Number.isSafeInteger(data.exitCode)
    && (data.signal === undefined || offset(data.signal))) {
    return { type: 'event', event: { type: 'exit', terminalId: id, offset: data.offset,
      endOffset: data.endOffset, exitCode: Number(data.exitCode), signal: data.signal as number | undefined, timestamp: data.timestamp } };
  }
  throw new TerminalStreamError();
}
