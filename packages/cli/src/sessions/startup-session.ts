import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionManager } from '@ai-harness/core';
import {
  JsonlSessionStore,
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

interface StartupForkSource { id: string; store?: JsonlSessionStore }

async function externalForkSource(
  manager: SessionManager,
  selector: string,
  cwd: string,
  homeDir?: string,
): Promise<StartupForkSource | undefined> {
  if (!isPathSelector(selector)) {
    const source = sessionForId(manager, selector);
    return source ? { id: source.id } : undefined;
  }
  const filePath = selectorPath(selector, cwd, homeDir);
  await assertRegularSessionFile(filePath);
  return { id: path.basename(filePath).replace(/\.jsonl$/i, ''), store: new JsonlSessionStore(path.dirname(filePath)) };
}

function currentWorkspaceSession(session: Session, cwd: string): boolean {
  if (!session.cwd) return true;
  return path.resolve(session.cwd) === path.resolve(cwd);
}

async function forkSession(
  manager: SessionManager,
  source: StartupForkSource,
  options: Pick<ResolveStartupSessionOptions, 'cwd' | 'workspaceId'> & Pick<StartupSessionArguments, 'sessionId' | 'name'>,
): Promise<Session> {
  if (options.sessionId && manager.get(options.sessionId)) {
    throw new Error(`Session already exists with ID: ${options.sessionId}`);
  }
  const fork = await manager.forkSession(source.id, undefined, options.name, {
    sourceStore: source.store, id: options.sessionId, cwd: options.cwd, workspaceId: options.workspaceId,
  });
  if (!fork) throw new Error(`Session could not be forked: ${source.id}`);
  return fork;
}

/** Apply CLI startup selectors to AiHarness's shared session manager. */
export async function resolveStartupSession(options: ResolveStartupSessionOptions): Promise<Session> {
  const { sessionManager: manager, args, cwd, workspaceId } = options;
  const startupName = args.name;
  let selected: Session | undefined;

  if (args.noSession) {
    selected = await manager.create({
      ...(args.sessionId ? { id: args.sessionId } : {}),
      title: startupName ?? 'Nouvelle conversation',
      cwd,
      workspaceId,
    });
  } else if (args.fork) {
    const selector = args.fork;
    const destination = { sessionId: args.sessionId, name: startupName, cwd, workspaceId };
    const source = await externalForkSource(manager, selector, cwd, options.homeDir);
    if (!source) throw new Error(`No session found matching: ${selector}`);
    selected = await forkSession(manager, source, destination);
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
    selected ??= await manager.create({ title: startupName ?? 'Nouvelle conversation', cwd, workspaceId });
  } else if (args.sessionId) {
    selected = manager.get(args.sessionId);
    selected ??= await manager.create({ id: args.sessionId, title: startupName ?? 'Nouvelle conversation', cwd, workspaceId });
  } else {
    selected = await manager.create({ title: startupName ?? 'Nouvelle conversation', cwd, workspaceId });
  }

  if (startupName && selected.title !== startupName) {
    selected = await manager.update(selected.id, { title: startupName }) ?? selected;
  }
  return selected;
}
