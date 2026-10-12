export type TerminalMode = 'regular' | 'fullscreen';

/** Resolve CLI mode from flags, environment, then terminal capabilities. */
export function resolveTerminalMode(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  fullscreenSupported = false,
  configuredMode?: TerminalMode,
): TerminalMode {
  let requested: TerminalMode | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') break;
    if (argument === '--tui-mode') {
      const value = args[++index];
      if (value === 'regular' || value === 'fullscreen') requested = value;
    } else if (argument.startsWith('--tui-mode=')) {
      const value = argument.slice('--tui-mode='.length);
      if (value === 'regular' || value === 'fullscreen') requested = value;
    } else if (argument === '--regular' || argument === '--no-fullscreen') {
      requested = 'regular';
    } else if (argument === '--fullscreen') {
      requested = 'fullscreen';
    }
  }
  if (requested === 'regular') return 'regular';
  if (requested === 'fullscreen') return fullscreenSupported ? 'fullscreen' : 'regular';

  const configured = env.AI_HARNESS_TUI_MODE?.trim().toLowerCase();
  if (configured === 'regular') return 'regular';
  if (configured === 'fullscreen') return fullscreenSupported ? 'fullscreen' : 'regular';
  if (configuredMode === 'regular') return 'regular';
  if (configuredMode === 'fullscreen') return fullscreenSupported ? 'fullscreen' : 'regular';

  return fullscreenSupported ? 'fullscreen' : 'regular';
}
