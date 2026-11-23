import type { AgentSettings } from '@ai-harness/core';

/** Startup presentation only: never suppress trust prompts, warnings or execution. */
export function resolveStartupDisplay(
  quiet: AgentSettings['quietStartup'],
  verbose = false,
): { readonly header: boolean; readonly details: boolean } {
  return {
    header: verbose || quiet !== true,
    details: verbose || quiet === undefined || quiet === false,
  };
}
