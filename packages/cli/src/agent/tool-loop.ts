/**
 * Backward-compatible CLI entry point. The implementation lives in Core so the
 * terminal and detached Web agent execute the exact same loop.
 */
export {
  AgentAbortError,
  runToolLoop,
} from '@ai-harness/core';
export type {
  ToolExecutionResult,
  ToolLoopOptions,
} from '@ai-harness/core';
