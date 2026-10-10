import path from 'node:path';
import {
  CredentialRedactor, deserializeSession, isValidSessionId, JsonlSessionStore,
  loadAgentSettings, openStableDirectoryHandle, ProjectTrustManager,
  resolveAgentSettingsPath, resolvePreTrustAgentDirectory, serializeSession, SessionManager, WorkspaceManager,
  type Session,
} from '@ai-harness/core';
import { CommandHandler } from '../commands/handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';
import { resolveStartupSessionDirectory } from '../sessions/startup-session.js';
import { loadTopLevelCredentialService } from './provider-auth-command.js';

export const EXPORT_HELP = `Usage: ai-harness export --session <path|id-prefix> --format <html|jsonl|json|markdown> --output <path> [options]
  --session-dir <dir>                Select the existing session storage root
  --approve | --no-approve           Process-only workspace trust decision (conflicting flags refused)
  -h, --help                        Show help without startup
Selection is mandatory and never creates a session. ID prefixes must be unambiguous.
Paths must be ordinary files in the selected store or current workspace, with no links.
Output must be an explicit trusted current-workspace file, ending in .html/.jsonl/.json/.md.
Existing ordinary output files are atomically replaced, mode 0600; source files cannot be replaced.
JSONL is the existing message projection, not the v2 session journal. No transcript is printed.
Exits: 0 success/help, 2 usage, 1 selection/trust/publication failure.
`;

class ExportUsageError extends Error {}
function parse(args: readonly string[]): { session?: string; format?: string; output?: string; sessionDir?: string; trust?: boolean; help: boolean } {
  if (args.length > 24 || args.some(arg => Buffer.byteLength(arg) > 4096 || /[\x00-\x1f\x7f-\x9f]/u.test(arg))) throw new ExportUsageError();
  const result: ReturnTypeShape = { help: args.length === 0 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    if (raw === 'help' && args.length === 1) { result.help = true; continue; }
    const equal = raw.indexOf('=');
    const key = equal < 0 ? raw : raw.slice(0, equal);
    if (seen.has(key)) throw new ExportUsageError();
    seen.add(key);
    if (['--help', '-h', '--approve', '--no-approve'].includes(key)) {
      if (equal >= 0) throw new ExportUsageError();
      if (key === '--help' || key === '-h') {
        if (result.help) throw new ExportUsageError();
        result.help = true;
      } else {
        if (result.trust !== undefined) throw new ExportUsageError();
        result.trust = key === '--approve';
      }
    } else if (['--session', '--format', '--output', '--session-dir'].includes(key)) {
      const value = equal < 0 ? args[++i] : raw.slice(equal + 1);
      if (!value || value.startsWith('-')) throw new ExportUsageError();
      if (key === '--session') result.session = value;
      else if (key === '--format') result.format = value;
      else if (key === '--output') result.output = value;
      else result.sessionDir = value;
    } else throw new ExportUsageError();
  }
  if (result.format && !['html', 'jsonl', 'json', 'markdown'].includes(result.format)) throw new ExportUsageError();
  if (!result.help) {
    if (!result.session || !result.format || !result.output) throw new ExportUsageError();
    const ext = result.format === 'markdown' ? 'md' : result.format;
    if (!result.output.endsWith(`.${ext}`)) throw new ExportUsageError();
  }
  return result;
}
type ReturnTypeShape = { session?: string; format?: string; output?: string; sessionDir?: string; trust?: boolean; help: boolean };

/** A single copied projection. Manager normalization is memory-only, never a source rewrite. */
class ExportProjectionStore extends JsonlSessionStore {
  constructor(private readonly projection: Session) { super(undefined, false); }
  override async listSessionIds(): Promise<string[]> { return [this.projection.id]; }
  override async loadSession(): Promise<Session> { return structuredClone(this.projection); }
  override async saveSession(): Promise<void> { /* Deliberately borrowed read-only source. */ }
}

/** Reuse the accepted slash exporter, serialization, redaction and atomic writer. */
export async function runExportCommand(args: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(args); }
  catch { process.stderr.write('Export usage error. Run "ai-harness export --help".\n'); return 2; }
  if (parsed.help) { process.stdout.write(EXPORT_HELP); return 0; }
  try {
    const workspace = new WorkspaceManager({ allowedRoots: [process.cwd()], defaultCwd: process.cwd() });
    await workspace.initialize();
    const cwd = await workspace.getDefaultCwd();
    const trust = new ProjectTrustManager(path.join(resolvePreTrustAgentDirectory(cwd), 'trust.json'));
    const trusted = async (): Promise<boolean> => parsed.trust ?? await trust.isTrusted(cwd);
    if (!await trusted()) { process.stderr.write('Export refused: explicit or saved workspace trust is required.\n'); return 1; }
    const settings = await loadAgentSettings({ cwd, projectTrusted: true });
    const storageDir = resolveStartupSessionDirectory({ sessionDir: parsed.sessionDir }, cwd,
      process.env, undefined, settings.settings.sessionDir)
      ?? path.join(process.env.HOME || '.', '.ai-harness', 'sessions');
    const selector = parsed.session!;
    const pathSelected = selector.includes('/') || selector.includes('\\') || selector.endsWith('.jsonl') || selector.startsWith('~');
    const relative = path.relative(cwd, resolveAgentSettingsPath(selector, cwd));
    const workspacePath = pathSelected && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    // Selecting a storage root grants input authority only, never output authority.
    // A workspace path does not require a default store to exist. Other selections
    // hold/check the store's no-follow directory policy before inventory/body reads.
    if (!workspacePath) {
      const directory = await openStableDirectoryHandle(storageDir);
      await directory.close();
    }
    const inputs = new WorkspaceManager({ allowedRoots: workspacePath ? [cwd] : [cwd, storageDir], defaultCwd: cwd });
    await inputs.initialize();
    const redactor = new CredentialRedactor();
    redactor.addEnvironment(process.env);
    await loadTopLevelCredentialService(cwd, redactor); // register stored secrets, never resolve/refresh
    let source: string;
    let id: string;
    let store: JsonlSessionStore;
    if (pathSelected) {
      source = await inputs.resolveStableFile(selector, { base: cwd });
      if (!source.endsWith('.jsonl')) throw new Error();
      id = path.basename(source, '.jsonl');
      if (!isValidSessionId(id)) throw new Error();
      store = new JsonlSessionStore(path.dirname(source));
    } else {
      if (!isValidSessionId(selector)) throw new Error();
      store = new JsonlSessionStore(storageDir);
      const ids = await store.listSessionIds(); // metadata only: do not load unrelated sessions
      const matches = ids.includes(selector) ? [selector] : ids.filter(item => item.startsWith(selector));
      if (matches.length !== 1) { process.stderr.write('Export selection failed: no unique session.\n'); return 1; }
      id = matches[0]!;
      source = await inputs.resolveStableFile(path.join(storageDir, `${id}.jsonl`));
    }
    const destination = await workspace.resolveDestination(parsed.output!, { base: cwd, kind: 'file' });
    if (source === destination || redactor.redact(destination) !== destination) throw new Error();
    const loaded = await store.loadSession(id);
    if (!loaded) throw new Error();
    // Shared serialization removes provider-config secret fields; shared redactor
    // copies/scrubs metadata and message blocks, including stored/environment values.
    const projection = redactor.redactJson(deserializeSession(serializeSession(structuredClone(loaded))));
    const ephemeral = new ExportProjectionStore(projection);
    const manager = new SessionManager({ store: ephemeral, redactText: value => redactor.redact(value),
      redactJson: value => redactor.redactJson(value) });
    await manager.loadAllSessions();
    let failed = false, published = false;
    const terminal = { showError: () => { failed = true; },
      writeOutput: (value: string) => { published = value.startsWith('✅ Exported session '); },
    } as unknown as TerminalUI;
    const handler = new CommandHandler(manager, ephemeral, terminal, undefined, undefined, {
      cwd, workspaceManager: workspace, providers: new Map(), isProjectTrusted: () => true,
      redactText: value => redactor.redact(value), redactJson: value => redactor.redactJson(value),
    });
    handler.getContext().currentSessionId = projection.id;
    if (!await trusted()) throw new Error();
    await handler.execute(`/export ${parsed.format} ${JSON.stringify(destination)}`);
    if (failed || !published) throw new Error();
    process.stdout.write('Session export published.\n');
    return 0;
  } catch {
    // A failed publication may already have changed disk; never promise rollback.
    process.stderr.write('Export failed; no success confirmed. Check the selected output file.\n');
    return 1;
  }
}
