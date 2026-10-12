/**
 * Server compatibility adapter. Shell execution, cancellation, bounds, and
 * persistence are shared by the interactive CLI and Web runtime in Core.
 */
export { ShellCommandRuntime as CommandRuntime } from '@ai-harness/core';
export type {
  ShellCommandEvent as CommandEvent,
  ShellCommandSnapshot as CommandSnapshot,
} from '@ai-harness/core';
