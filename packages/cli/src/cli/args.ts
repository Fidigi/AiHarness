import { createRequire } from 'node:module';

export type CliOutputMode = 'text' | 'json' | 'rpc';
export type CliThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CliTerminalMode = 'regular' | 'fullscreen';
export type CliApplicationMode = 'interactive' | 'print' | 'json' | 'rpc';

export interface CliArguments {
  help: boolean;
  version: boolean;
  print: boolean;
  mode?: CliOutputMode;
  continueSession: boolean;
  resume: boolean;
  session?: string;
  sessionId?: string;
  fork?: string;
  sessionDir?: string;
  name?: string;
  noSession: boolean;
  theme?: string;
  tuiMode?: CliTerminalMode;
  extensions: string[];
  tools?: string[];
  excludeTools?: string[];
  noTools: boolean;
  noBuiltinTools: boolean;
  provider?: string;
  model?: string;
  models?: string[];
  listModels?: true | string;
  apiKey?: string;
  thinking?: CliThinkingLevel;
  systemPrompt?: string;
  appendSystemPrompts?: string[];
  noContextFiles: boolean;
  messages: string[];
  fileArgs: string[];
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

const THINKING_LEVELS = new Set<CliThinkingLevel>([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

function commaList(value: string, option: string): string[] {
  const values = [...new Set(value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
  if (!values.length) throw new CliArgumentError(`${option} requires at least one tool name.`);
  return values;
}

function modelPatternList(value: string): string[] {
  const values = [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
  if (!values.length) throw new CliArgumentError('--models requires at least one model pattern.');
  return values;
}

/** Strict parser for the implemented AiHarness startup surface. */
export function parseCliArguments(args: readonly string[]): CliArguments {
  const result: CliArguments = {
    help: false,
    version: false,
    print: false,
    continueSession: false,
    resume: false,
    noSession: false,
    extensions: [],
    noTools: false,
    noBuiltinTools: false,
    noContextFiles: false,
    messages: [],
    fileArgs: [],
  };
  let optionsEnded = false;

  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    if (!optionsEnded && raw === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !raw.startsWith('-') || raw === '-') {
      if (raw.startsWith('@') && raw.length > 1) result.fileArgs.push(raw.slice(1));
      else result.messages.push(raw);
      continue;
    }
    if (raw.startsWith('@')) {
      result.fileArgs.push(raw.slice(1));
      continue;
    }

    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const option = equals > 0 ? raw.slice(0, equals) : raw;
    const inlineValue = equals > 0 ? raw.slice(equals + 1) : undefined;
    const value = (): string => {
      const candidate = inlineValue ?? args[++index];
      if (candidate === undefined || (!inlineValue && candidate.startsWith('-'))) {
        throw new CliArgumentError(`${option} requires a value.`);
      }
      if (!candidate) throw new CliArgumentError(`${option} requires a non-empty value.`);
      return candidate;
    };
    const booleanOption = (): void => {
      if (inlineValue !== undefined) throw new CliArgumentError(`${option} does not accept a value.`);
    };

    switch (option) {
      case '--help': case '-h': booleanOption(); result.help = true; break;
      case '--version': case '-v': booleanOption(); result.version = true; break;
      case '--print': case '-p': booleanOption(); result.print = true; break;
      case '--rpc': booleanOption(); result.mode = 'rpc'; break;
      case '--mode': {
        const mode = value();
        if (!['text', 'json', 'rpc'].includes(mode)) {
          throw new CliArgumentError(`Invalid mode "${mode}". Valid values: text, json, rpc.`);
        }
        result.mode = mode as CliOutputMode;
        break;
      }
      case '--continue': case '-c': booleanOption(); result.continueSession = true; break;
      case '--resume': case '-r': booleanOption(); result.resume = true; break;
      case '--session': result.session = value(); break;
      case '--session-id': result.sessionId = value(); break;
      case '--fork': result.fork = value(); break;
      case '--session-dir': result.sessionDir = value(); break;
      case '--name': case '-n': result.name = value().trim(); break;
      case '--no-session': booleanOption(); result.noSession = true; break;
      case '--theme': result.theme = value(); break;
      case '--extension': case '-e': result.extensions.push(value()); break;
      case '--tui-mode': {
        const mode = value();
        if (mode !== 'regular' && mode !== 'fullscreen') {
          throw new CliArgumentError(`Invalid TUI mode "${mode}". Valid values: regular, fullscreen.`);
        }
        result.tuiMode = mode;
        break;
      }
      case '--regular': case '--no-fullscreen': booleanOption(); result.tuiMode = 'regular'; break;
      case '--fullscreen': booleanOption(); result.tuiMode = 'fullscreen'; break;
      case '--tools': case '-t': result.tools = commaList(value(), option); break;
      case '--exclude-tools': case '-xt': result.excludeTools = commaList(value(), option); break;
      case '--no-tools': case '-nt': booleanOption(); result.noTools = true; break;
      case '--no-builtin-tools': case '-nbt': booleanOption(); result.noBuiltinTools = true; break;
      case '--provider': result.provider = value().trim().toLowerCase(); break;
      case '--model': result.model = value().trim(); break;
      case '--models': result.models = modelPatternList(value()); break;
      case '--list-models': {
        if (inlineValue !== undefined) {
          const search = inlineValue.trim();
          if (!search) throw new CliArgumentError('--list-models requires a non-empty search after =.');
          result.listModels = search;
        } else {
          const search = args[index + 1];
          if (search !== undefined && !search.startsWith('-')) {
            index++;
            result.listModels = search;
          } else result.listModels = true;
        }
        break;
      }
      case '--api-key': result.apiKey = value(); break;
      case '--system-prompt': result.systemPrompt = value(); break;
      case '--append-system-prompt': {
        result.appendSystemPrompts ??= [];
        result.appendSystemPrompts.push(value());
        break;
      }
      case '--no-context-files': case '-nc': booleanOption(); result.noContextFiles = true; break;
      case '--thinking': {
        const level = value().trim().toLowerCase() as CliThinkingLevel;
        if (!THINKING_LEVELS.has(level)) {
          throw new CliArgumentError(`Invalid thinking level "${level}". Valid values: ${[...THINKING_LEVELS].join(', ')}.`);
        }
        result.thinking = level;
        break;
      }
      default:
        throw new CliArgumentError(`Unknown option: ${option}. Use --help for available options.`);
    }
  }

  const sessionSelectors = [
    result.continueSession ? '--continue' : undefined,
    result.resume ? '--resume' : undefined,
    result.session ? '--session' : undefined,
  ].filter((option): option is string => Boolean(option));
  if (sessionSelectors.length > 1) {
    throw new CliArgumentError(`${sessionSelectors.join(', ')} cannot be combined.`);
  }
  if (result.fork) {
    const conflicts = [
      ...sessionSelectors,
      result.noSession ? '--no-session' : undefined,
    ].filter((option): option is string => Boolean(option));
    if (conflicts.length) throw new CliArgumentError(`--fork cannot be combined with ${conflicts.join(', ')}.`);
  }
  if (result.sessionId && sessionSelectors.length) {
    throw new CliArgumentError(`--session-id cannot be combined with ${sessionSelectors.join(', ')}.`);
  }
  if (result.noSession && sessionSelectors.length) {
    throw new CliArgumentError(`--no-session cannot be combined with ${sessionSelectors.join(', ')}.`);
  }
  if (result.sessionId && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(result.sessionId)) {
    throw new CliArgumentError("Session ID must contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character.");
  }
  if (result.name !== undefined && !result.name) throw new CliArgumentError('--name requires a non-empty value.');

  if (result.mode === 'rpc') {
    if (result.print) throw new CliArgumentError('--print cannot be combined with RPC mode.');
    if (result.messages.length || result.fileArgs.length) {
      throw new CliArgumentError('RPC mode does not accept initial messages or @file arguments.');
    }
    if (result.resume) {
      throw new CliArgumentError('--resume requires an interactive terminal; use --session in RPC mode.');
    }
  }
  if (result.provider && !result.model && !result.models?.length) {
    throw new CliArgumentError('--provider requires --model or --models.');
  }
  if (result.apiKey && !result.model && !result.models?.length) {
    throw new CliArgumentError('--api-key requires --model or --models.');
  }
  if (result.listModels && (result.print || result.mode || result.messages.length || result.fileArgs.length)) {
    throw new CliArgumentError('--list-models cannot be combined with execution modes or prompt input.');
  }
  return result;
}

export function resolveCliApplicationMode(
  parsed: Pick<CliArguments, 'mode' | 'print'>,
  streams: { stdinIsTTY?: boolean; stdoutIsTTY?: boolean },
): CliApplicationMode {
  if (parsed.mode === 'rpc') return 'rpc';
  if (parsed.mode === 'json') return 'json';
  if (parsed.print || streams.stdinIsTTY !== true || streams.stdoutIsTTY !== true) return 'print';
  return 'interactive';
}

export function cliVersion(): string {
  const packageJson = createRequire(import.meta.url)('../../package.json') as { version?: unknown };
  return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
}

export function formatCliHelp(): string {
  return `AiHarness - unified AI coding agent\n\nUsage:\n  ai-harness [options] [--] [@files...] [messages...]\n\nOptions:\n  -p, --print                    Run supplied prompts, print only the final response, then exit\n  --mode <text|json|rpc>         Select text, JSONL event, or RPC output\n  --rpc                          Backward-compatible alias for --mode rpc\n  --provider <name>              Select a provider (requires --model or --models)\n  --model <[provider/]model>     Select an exact/fuzzy model, optionally suffixed with :thinking\n  --models <patterns>            Scope startup and cycling with IDs, fuzzy matches, globs, and :thinking\n  --list-models [search]         List configured-provider models, optionally fuzzy-filtered, then exit\n  --api-key <key>                Non-persistent credential override (requires --model or --models)\n  --thinking <level>             off|minimal|low|medium|high|xhigh|max\n  --system-prompt <text|path>    Replace the default system prompt for this run\n  --append-system-prompt <value> Append text or an existing file (repeatable)\n  -nc, --no-context-files        Disable AGENTS.md and CLAUDE.md discovery\n  -t, --tools <names>            Replace active tools with a comma-separated allowlist\n  -xt, --exclude-tools <names>   Disable comma-separated tool names after selection\n  -nbt, --no-builtin-tools       Disable default built-ins but retain extension tools\n  -nt, --no-tools                Disable all tools by default\n  -c, --continue                 Continue the newest session for this workspace\n  -r, --resume                   Select a stored session interactively\n  --session <path|id>            Open a session file or ID prefix\n  --session-id <id>              Open or create an exact session ID\n  --fork <path|id>               Fork a stored session before startup\n  --session-dir <dir>            Override the session storage directory\n  -n, --name <name>              Name or rename the startup session\n  --no-session                   Keep the session in memory only\n  --tui-mode <mode>              fullscreen or regular\n  --fullscreen                   Legacy fullscreen alias\n  --regular, --no-fullscreen     Legacy regular-mode aliases\n  --theme <name|file>            Select dark, light, or a custom theme file\n  -e, --extension <path>         Load an extension file or directory (repeatable)\n  -h, --help                     Show this help and exit\n  -v, --version                  Show the version and exit\n  --                             Stop option parsing\n\nInput:\n  Positional messages are sent in order. @path prepends a bounded UTF-8 text file\n  or supported image to the first message. Piped stdin is prepended in print mode.\n\nConfiguration:\n  User settings load from <AI_HARNESS_AGENT_DIR>/settings.json or ~/.ai-harness/settings.json.\n  Trusted project settings load from .ai-harness/settings.json; CLI options take precedence.\n  AI_HARNESS_SESSIONS_DIR overrides settings sessionDir. Use /settings for effective\n  sources and /reload after changing settings or project trust.\n\nInstructions:\n  User files load from the same agent directory. Project context and .ai-harness\n  system files require trust; use /reload after changing trust interactively.\n`;
}

/** Read redirected stdin without allowing an unbounded automation payload. */
export async function readPipedStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  maxBytes = 2 * 1024 * 1024,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`Piped input exceeds the ${maxBytes} byte limit.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString('utf8').trim() || undefined;
}
