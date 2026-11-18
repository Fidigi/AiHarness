import type { ExtensionToolResult } from './extension-registry.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { ownToolResult } from '../agent/tool-result.js';

/** A custom trigger is model-visible context, not a synthetic user message. */
export interface ExtensionCustomTrigger {
  type: string;
  content: string;
}
export type AgentRunTrigger = { kind: 'user' } | { kind: 'custom'; type: string };

export function copyAgentRunTrigger(value: unknown): AgentRunTrigger {
  if (value === undefined) return { kind: 'user' };
  const copy = copySessionCustomValue(value, 1024) as AgentRunTrigger;
  if (copy?.kind === 'user' && Object.keys(copy).length === 1) return { kind: 'user' };
  if (copy?.kind === 'custom' && Object.keys(copy).length === 2 && validType(copy.type)) return { kind: 'custom', type: copy.type };
  throw new Error('Agent trigger is invalid.');
}

function validType(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9:_.-]{0,127}$/u.test(value);
}

export function copyExtensionContinuation(value: unknown): ExtensionCustomTrigger | null {
  if (value === null) return null;
  const copy = copySessionCustomValue(value, 64 * 1024) as ExtensionCustomTrigger;
  if (!copy || Object.keys(copy).length !== 2 || !validType(copy.type)
    || typeof copy.content !== 'string' || !copy.content.trim() || copy.content.includes('\0')) {
    throw new Error('Extension continuation is invalid.');
  }
  return { type: copy.type, content: copy.content };
}

/** Exclude details: authenticated store, activation and usage stay with the host. */
export function copyExtensionResult(value: ExtensionToolResult): ExtensionToolResult {
  const fields: Record<string, unknown> = {};
  for (const key of ['content', 'blocks', 'structuredContent', 'isError']) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property && !('value' in property)) throw new Error('Extension result is invalid.');
    if (property?.value !== undefined) fields[key] = property.value;
  }
  const copy = copySessionCustomValue(fields, 5 * 1024 * 1024) as unknown as ExtensionToolResult;
  ownToolResult(copy);
  return copy;
}

export const EXECUTION_HOOK_NAMES = ['before:message', 'before:tool:result', 'before:turn:end', 'before:agent:settle'] as const;
export type ExecutionHookName = typeof EXECUTION_HOOK_NAMES[number];
export function isExecutionHook(event: string): event is ExecutionHookName {
  return (EXECUTION_HOOK_NAMES as readonly string[]).includes(event);
}

/** Own data only, one output field per hook; unknown authority fields fail closed. */
export function copyExecutionHookPatch(event: ExecutionHookName, value: unknown): Record<string, unknown> {
  const fail = (): never => { throw new Error('Extension execution hook result is invalid.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const keys = Reflect.ownKeys(value);
  const allowed = event === 'before:message' ? 'content' : event === 'before:tool:result' ? 'result' : 'continuation';
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (key !== allowed || !property || !('value' in property)) return fail();
    if (key === 'content') {
      if (typeof property.value !== 'string' || Buffer.byteLength(property.value) > 4 * 1024 * 1024) return fail();
      output.content = property.value;
    } else if (key === 'result') {
      if (!property.value || typeof property.value !== 'object'
        || Reflect.ownKeys(property.value).some(field => !['content', 'blocks', 'structuredContent', 'isError'].includes(String(field)))) return fail();
      output.result = copyExtensionResult(property.value as ExtensionToolResult);
    } else output.continuation = copyExtensionContinuation(property.value);
  }
  return output;
}
