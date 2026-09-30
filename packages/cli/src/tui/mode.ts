export type TerminalMode = 'regular' | 'fullscreen';

/** Resolve CLI mode from flags, environment, then terminal capabilities. */
export function resolveTerminalMode(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  fullscreenSupported = false,
): TerminalMode {
  if (args.includes('--regular') || args.includes('--no-fullscreen')) return 'regular';
  if (args.includes('--fullscreen')) return fullscreenSupported ? 'fullscreen' : 'regular';

  const configured = env.AI_HARNESS_TUI_MODE?.trim().toLowerCase();
  if (configured === 'regular') return 'regular';
  if (configured === 'fullscreen') return fullscreenSupported ? 'fullscreen' : 'regular';

  return fullscreenSupported ? 'fullscreen' : 'regular';
}
