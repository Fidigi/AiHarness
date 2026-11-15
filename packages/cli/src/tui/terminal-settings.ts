import type { AgentSettings } from '@ai-harness/core';

/** Accepted storage fields without a CLI consumer. Never present them as effective behavior. */
export const UNSUPPORTED_CLI_SETTINGS = [
  'lastChangelogVersion', 'hideThinkingBlock',
  'doubleEscapeAction', 'treeFilterMode', 'fullscreenExitOutput', 'fullscreenScrollbar',
  'fullscreenCopyOnSelect', 'fullscreenWheelScrollLines', 'editorPaddingX', 'outputPad',
  'autocompleteMaxVisible', 'showHardwareCursor', 'terminal', 'markdown',
  'collapseChangelog', 'enableInstallTelemetry', 'enableAnalytics', 'trackingId', 'deviceId', 'warnings',
] as const satisfies readonly (keyof AgentSettings)[];

export function unsupportedCliSettings(settings: AgentSettings): string[] {
  return UNSUPPORTED_CLI_SETTINGS.filter(field => settings[field] !== undefined);
}
