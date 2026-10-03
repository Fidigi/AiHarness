import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  JsonlSessionStore,
  SessionManager,
  type Session,
} from '@ai-harness/core';
import type { CliArguments } from '../cli/args.js';

export type StartupSessionArguments = Pick<CliArguments,
  | 'continueSession'
  | 'resume'
  | 'session'
  | 'sessionId'
  | 'fork'
  | 'sessionDir'
  | 'name'
  | 'noSession'
>;

export class StartupSessionSelectionCancelledError extends Error {
  constructor() {
    super('No session selected.');
    this.name = 'StartupSessionSelectionCancelledError';
  }
}

export interface ResolveStartupSessionOptions {
  sessionManager: SessionManager;
  args: StartupSessionArguments;
  cwd: string;
  workspaceId?: string;
  interactive: boolean;
  chooseSession?(sessions: Session[]): Promise<Session | undefined>;
  homeDir?: string;
}

function expandHome(value: string, homeDir = os.homedir()): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  return value;
}

function isPathSelector(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.endsWith('.jsonl') || value.startsWith('~');
}

function selectorPath(value: string, cwd: string, homeDir?: string): string {
  return path.resolve(cwd, expandHome(value, homeDir));
}

/** Resolve persistence before constructing JsonlSessionStore. Explicit session files keep their own directory. */
export function resolveStartupSessionDirectory(
  args: Pick<StartupSessionArguments, 'session' | 'sessionDir'>,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  settingsDirectory?: string,
): string | undefined {
  if (args.session && isPathSelector(args.session)) {
    return path.dirname(selectorPath(args.session, cwd, homeDir));
  }
  const configured = args.sessionDir
    ?? environment.PI_CODING_AGENT_SESSION_DIR
    ?? environment.AI_HARNESS_SESSIONS_DIR
    ?? settingsDirectory;
  return configured ? path.resolve(cwd, expandHome(configured, homeDir)) : undefined;
}

function sessionForId(manager: SessionManager, selector: string): Session | undefined {
  return manager.get(selector) ?? manager.list().find(session => session.id.startsWith(selector));
}

async function assertRegularSessionFile(filePath: string): Promise<void> {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    throw new Error(`Session file not found: ${filePath}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Session path must be a regular file: ${filePath}`);
}

async function sessionFromSelector(
  manager: SessionManager,
  selector: string,
  cwd: string,
  homeDir?: string,
): Promise<Session | undefined> {
  if (!isPathSelector(selector)) return sessionForId(manager, selector);
  const filePath = selectorPath(selector, cwd, homeDir);
  await assertRegularSessionFile(filePath);
  const id = path.basename(filePath).replace(/\.jsonl$/i, '');
  return manager.get(id);
}

async function externalForkSource(
  manager: SessionManager,
  selector: string,
  cwd: string,
  homeDir?: string,
): Promise<Session | undefined> {
  if (!isPathSelector(selector)) return sessionForId(manager, selector);
  const filePath = selectorPath(selector, cwd, homeDir);
  await assertRegularSessionFile(filePath);
  const id = path.basename(filePath).replace(/\.jsonl$/i, '');
  const sourceStore = new JsonlSessionStore(path.dirname(filePath));
  return await sourceStore.loadSession(id) ?? undefined;
}

function currentWorkspaceSession(session: Session, cwd: string): boolean {
  if (!session.cwd) return true;
  return path.resolve(session.cwd) === path.resolve(cwd);
}

async function forkSession(
  manager: SessionManager,
  source: Session,
  options: Pick<ResolveStartupSessionOptions, 'args' | 'cwd' | 'workspaceId'>,
): Promise<Session> {
  if (options.args.sessionId && manager.get(options.args.sessionId)) {
    throw new Error(`Session already exists with ID: ${options.args.sessionId}`);
  }
  const messages = structuredClone(source.messages).map(message => ({
    ...message,
    timestamp: new Date(message.timestamp),
  }));
  return manager.create({
    ...(options.args.sessionId ? { id: options.args.sessionId } : {}),
    title: options.args.name ?? `${source.title || 'Fork'} (fork)`,
    messages,
    commands: source.commands ? structuredClone(source.commands).map(command => ({
      ...command,
      timestamp: new Date(command.timestamp),
    })) : undefined,
    parentId: source.id,
    branchId: source.branchId || source.id,
    activeLeafId: messages.at(-1)?.id,
    cwd: options.cwd,
    workspaceId: options.workspaceId,
    gitBranch: source.gitBranch,
    model: source.model,
    thinking: source.thinking,
    toolPreset: source.toolPreset,
    autoCompaction: source.autoCompaction,
    usage: source.usage ? { ...source.usage } : undefined,
    providerConfig: source.providerConfig,
    metadata: source.metadata ? structuredClone(source.metadata) : undefined,
  });
}

/** Apply Pi-style startup selectors to AiHarness's shared session manager. */
export async function resolveStartupSession(options: ResolveStartupSessionOptions): Promise<Session> {
  const { sessionManager: manager, args, cwd, workspaceId } = options;
  let selected: Session | undefined;

  if (args.noSession) {
    selected = await manager.create({
      ...(args.sessionId ? { id: args.sessionId } : {}),
      title: args.name ?? 'Nouvelle conversation',
      cwd,
      workspaceId,
    });
  } else if (args.fork) {
    const source = await externalForkSource(manager, args.fork, cwd, options.homeDir);
    if (!source) throw new Error(`No session found matching: ${args.fork}`);
    selected = await forkSession(manager, source, options);
  } else if (args.session) {
    selected = await sessionFromSelector(manager, args.session, cwd, options.homeDir);
    if (!selected) throw new Error(`No session found matching: ${args.session}`);
  } else if (args.resume) {
    if (!options.interactive || !options.chooseSession) {
      throw new Error('--resume requires an interactive terminal; use --session in headless mode.');
    }
    selected = await options.chooseSession(manager.list());
    if (!selected) throw new StartupSessionSelectionCancelledError();
  } else if (args.continueSession) {
    selected = manager.list().find(session => currentWorkspaceSession(session, cwd));
    selected ??= await manager.create({ title: args.name ?? 'Nouvelle conversation', cwd, workspaceId });
  } else if (args.sessionId) {
    selected = manager.get(args.sessionId);
    selected ??= await manager.create({ id: args.sessionId, title: args.name ?? 'Nouvelle conversation', cwd, workspaceId });
  } else {
    selected = await manager.create({ title: args.name ?? 'Nouvelle conversation', cwd, workspaceId });
  }

  if (args.name && selected.title !== args.name) {
    selected = await manager.update(selected.id, { title: args.name }) ?? selected;
  }
  return selected;
}
