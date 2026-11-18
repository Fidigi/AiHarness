import type { ActiveToolSnapshot, CodemodeCall, CodemodeDetails } from '@ai-harness/core';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validCall(value: unknown, parentId: string): value is CodemodeCall {
  return record(value) && typeof value.id === 'string' && value.id.startsWith(`${parentId}:`)
    && value.id.length <= 600 && /^(?:[1-9]|[1-5][0-9]|6[0-4])$/u.test(value.id.slice(parentId.length + 1)) && value.parentId === parentId && typeof value.name === 'string' && value.name.length <= 256
    && ['tool', 'classifier', 'image'].includes(String(value.kind))
    && ['running', 'completed', 'failed', 'cancelled'].includes(String(value.state)) && typeof value.isError === 'boolean'
    && (value.durationMs === undefined || (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0));
}
/** Fail closed to the historical generic block for old, foreign or malformed metadata. */
export function codemodeDetails(value: unknown, parentId: string): CodemodeDetails | undefined {
  if (!record(value) || value.engine !== 'QuickJS' || value.parentId !== parentId
    || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0
    || typeof value.costComplete !== 'boolean' || !Array.isArray(value.nestedCalls) || value.nestedCalls.length > 64
    || !value.nestedCalls.every(call => validCall(call, parentId))
    || new Set(value.nestedCalls.map(call => call.id)).size !== value.nestedCalls.length) return undefined;
  return value as unknown as CodemodeDetails;
}
/** Replay cannot create top-level activity, resurrect terminal calls or cross parent invocations. */
export function applyCodemodeProgress(tool: ActiveToolSnapshot | undefined, value: unknown): ActiveToolSnapshot | undefined {
  if (!tool || tool.name !== 'codemode' || !record(value) || value.kind !== 'codemode'
    || value.parentId !== tool.id || !validCall(value.call, tool.id)) return tool;
  const calls = tool.nestedCalls ?? [];
  const nextCall = value.call;
  const index = calls.findIndex(call => call.id === nextCall.id);
  if (index >= 0 && calls[index]!.state !== 'running') return tool;
  if (index < 0 && calls.length >= 64) return tool;
  return { ...tool, nestedCalls: index < 0 ? [...calls, nextCall]
    : calls.map((call, position) => position === index ? nextCall : call) };
}
