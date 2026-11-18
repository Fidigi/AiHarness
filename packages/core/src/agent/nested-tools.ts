import { randomUUID } from 'node:crypto';
import { bindHostToolAdmission, type ExtensionRuntimeContext, type ExtensionToolResult } from '../extensions/extension-registry.js';
import { ownToolResult, type OwnedToolResult } from './tool-result.js';
import { ToolProgressChannel, type ToolProgressSnapshot } from './tool-progress.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';

export interface NestedToolRecord extends OwnedToolResult {
  id: string;
  parentId: string;
  name: string;
  durationMs: number;
  progress?: ToolProgressSnapshot;
}

/** Siblings are serialized depth-first. Already admitted children are joined, never abandoned. */
export function nestedToolScope(
  context: ExtensionRuntimeContext,
  root: { id: string; name: string },
  execute: (name: string, input: unknown, context: ExtensionRuntimeContext) => Promise<ExtensionToolResult>,
  allowed: (name: string) => boolean,
  signal?: AbortSignal,
  redact: (text: string) => string = text => text,
): { context: ExtensionRuntimeContext; finish(): Promise<void>; records: NestedToolRecord[] } {
  const records: NestedToolRecord[] = [];
  let count = 0, bytes = 0, reservedBytes = 0;
  const scope = (base: ExtensionRuntimeContext, parentId: string, ancestors: string[]) => {
    let accepting = true;
    let tail: Promise<void> = Promise.resolve();
    const current = (): void => { if (!accepting || signal?.aborted) throw new Error('Nested tool execution is no longer active.'); };
    const childContext: ExtensionRuntimeContext = { ...base, executeTool: (name, input) => {
      let ownedInput: unknown;
      let identity: Pick<NestedToolRecord, 'id' | 'parentId' | 'name'>;
      let reservation: number;
      try {
        current();
        if (typeof name !== 'string' || !name || name.length > 256 || ancestors.length > 4 || count >= 64) throw new Error('Nested tool execution limit exceeded.');
        ownedInput = copySessionCustomValue(input, 64 * 1024);
        identity = { id: randomUUID(), parentId: redact(parentId), name: redact(name) };
        reservation = Buffer.byteLength(JSON.stringify(identity)) + 512;
        if (bytes + reservedBytes + reservation > 512 * 1024) throw new Error('Nested tool metadata limit exceeded.');
        reservedBytes += reservation; count++;
      } catch (error) {
        const refusal = Promise.reject<ExtensionToolResult>(error); void refusal.catch(() => undefined); return refusal;
      }
      const { id } = identity;
      const pending = tail.then(async () => {
        const started = performance.now();
        let result: OwnedToolResult;
        const channel = new ToolProgressChannel({ id, name, input: {} }, progress => context.onProgress?.({ version: 1,
          content: progress.content, details: { id, parentId: redact(parentId), name: redact(name), state: 'running',
            progress: { sequence: progress.sequence, content: progress.content ?? '', details: progress.details ?? null } } }), signal, redact);
        const nested = scope({ ...base, toolCallId: id, onProgress: channel.report, onProcessOutput: undefined, processOutputPath: undefined },
          id, [...ancestors, name.toLowerCase()]);
        try {
          if (signal?.aborted || !allowed(name) || ancestors.includes(name.toLowerCase())
            || ['codemode', 'tool_search', 'spawn_subagent'].includes(name.toLowerCase())) throw new Error('Nested tool is not enabled or is recursive.');
          await context.onProgress?.({ version: 1, content: `[Nested tool] ${name}`, details: { id, parentId: redact(parentId), name: redact(name), state: 'running' } });
          result = ownToolResult(await execute(name, ownedInput, nested.context), redact);
        } catch (error) {
          result = { content: redact(error instanceof Error ? error.message : String(error)).slice(0, 1000), blocks: [], isError: true };
        } finally { await nested.finish(); }
        if (signal?.aborted) result = { content: 'Nested tool execution interrupted.', blocks: [], isError: true };
        const progress = await channel.finish(signal?.aborted ? 'cancelled' : result.isError ? 'failed' : 'completed');
        if (channel.failure) result = { content: 'Nested tool progress sink failed.', blocks: [], isError: true };
        reservedBytes -= reservation;
        const header = { ...identity, durationMs: Math.max(0, Math.round(performance.now() - started)) };
        let record: NestedToolRecord = { ...result, ...header, ...(progress ? { progress } : {}) };
        const size = Buffer.byteLength(JSON.stringify(record));
        if (bytes + size > 384 * 1024 || bytes + reservedBytes + size > 512 * 1024) {
          result = { content: 'Nested tool result exceeded the aggregate limit.', blocks: [], isError: true };
          record = { ...result, ...header };
        }
        bytes += Buffer.byteLength(JSON.stringify(record));
        records.push(record);
        if (!signal?.aborted) await context.onProgress?.({ version: 1, content: `[Nested tool] ${name}: ${result.isError ? 'failed' : 'completed'}`,
          details: { id, parentId: redact(parentId), name: redact(name), state: result.isError ? 'failed' : 'completed' } });
        return { ...result, blocks: structuredClone(result.blocks.filter(block => block.type === 'image')),
          ...(result.structuredContent !== undefined ? { structuredContent: structuredClone(result.structuredContent) } : {}) };
      });
      // Observe failures even if privileged extension code deliberately ignores its promise.
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    } };
    bindHostToolAdmission(childContext, () => { current(); if (!allowed(ancestors.at(-1)!)) throw new Error('Tool is no longer enabled.'); });
    return { context: childContext, finish: async () => { accepting = false; await tail; } };
  };
  return { ...scope(context, root.id, [root.name.toLowerCase()]), records };
}
