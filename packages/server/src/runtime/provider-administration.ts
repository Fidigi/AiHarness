import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedResourceText, readStableDirectoryEntries, type Session } from '@ai-harness/core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ConfigurationStore } from '../config/config-store.js';

function refusal(code: string, uncertain = false): never {
  throw Object.assign(new Error('Provider administration is unavailable or referenced.'), { status: 409, code, uncertain });
}

export type ProviderOperationHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;
export interface ProviderAdministrationHost { providerAdministration?: ProviderAdministration; }

/** Non-waiting process-local read/exclusive leases. Ownership is the awaited
 * operation, NEVER the HTTP socket/finish event. A stuck operation keeps rename
 * disabled, rather than letting a timeout/disconnect publish over live work.
 * Not a lock for arbitrary CLI/external session writers. Activation explicitly
 * requires exclusive host ownership of reference stores and all entry points.
 */
export class ProviderAdministration {
  private operations = 0;
  private exclusive = false;
  private activated = false;
  constructor(
    private readonly store: Pick<ConfigurationStore, 'assertProviderTransactionSafe' | 'finishProviderRebind'>,
    private readonly assertReferencesSafe: (oldId: string) => Promise<void>,
  ) {}

  /** Call only after ALL host admission/reference owners have been wired.
   * The coordinator must not enable this on a shared CLI/session deployment.
   */
  activateForExclusiveHost(): void { this.activated = true; }

  /** Passive actual composition status; never activates or relaxes admission. */
  get isActivatedForExclusiveHost(): boolean { return this.activated; }

  async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.exclusive || this.activated && this.operations >= 1_024) refusal('PROVIDER_ADMINISTRATION_BUSY');
    ++this.operations; // Synchronous acquisition before the first await.
    try {
      await this.store.assertProviderTransactionSafe();
      return await operation();
    } finally { --this.operations; }
  }

  async rename<T>(oldId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.activated) refusal('PROVIDER_ADMISSION_UNAVAILABLE');
    if (this.exclusive || this.operations !== 0) refusal('PROVIDER_ADMINISTRATION_BUSY');
    this.exclusive = true;
    try {
      await this.store.assertProviderTransactionSafe();
      await this.assertReferencesSafe(oldId);
      const result = await operation();
      // Registry rollback/reconciliation is now outside its callback and fully
      // settled. Only this success boundary may clear the durable intent.
      await this.store.finishProviderRebind();
      return result;
    } finally { this.exclusive = false; }
  }

  /** Recheck fresh unsupported owners immediately around registry publication. */
  async assertRenameReferencesSafe(oldId: string): Promise<void> {
    if (!this.exclusive) refusal('PROVIDER_ADMISSION_UNAVAILABLE');
    await this.assertReferencesSafe(oldId);
  }
}

export function providerAdministration(host: object): ProviderAdministration | undefined {
  return (host as ProviderAdministrationHost).providerAdministration;
}

/** Public Express handler wrapper; no Router internals or prototype mutation.
 * Missing host integration allows ordinary operations but NEVER rename.
 */
export function providerOperation(services: Promise<object>, handler: ProviderOperationHandler): RequestHandler {
  return (request, response, next): void => {
    void services.then(async host => {
      const administration = providerAdministration(host);
      const operation = () => handler(request, response, next);
      if (administration) await administration.withOperation(operation);
      else await operation();
    }).catch(next);
  };
}

/** Restricted hosting requires reference stores outside every editable root.
 * Reject links even when their current target is independent; do not trust a
 * lexical path or a comment asserting administrator ownership. Missing private
 * directories are checked via their nearest existing ancestor before creation.
 * This is a deployment boundary, not an OS sandbox for arbitrary shell/Node.
 */
export async function assertProviderAdministrationRoots(roots: readonly string[], stores: readonly string[]): Promise<void> {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return !relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  };
  try {
    for (const store of stores) {
      const absolute = path.resolve(store);
      let current = path.parse(absolute).root;
      for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked administrative path.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      // Existing path components were all nonlinked. Canonicalize its existing
      // ancestor as well (e.g. platform-specific realpath spelling).
      let ancestor = absolute; const suffix: string[] = [];
      for (;;) {
        try { ancestor = await realpath(ancestor); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
        }
      }
      const canonical = path.join(ancestor, ...suffix);
      if (roots.some(root => contains(root, canonical) || contains(canonical, root))) throw new Error('Overlapping administrative path.');
    }
  } catch {
    refusal('PROVIDER_ADMINISTRATION_UNSAFE_ROOTS');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function qualified(value: unknown, oldId: string): boolean {
  return typeof value === 'string' && [':', '/'].some(separator => value.trim().toLowerCase().startsWith(`${oldId}${separator}`));
}
function sessionReference(session: Pick<Session, 'providerConfig' | 'model'>, oldId: string): boolean {
  return String(session.providerConfig?.type ?? '').trim().toLowerCase() === oldId
    || qualified(session.model, oldId) || qualified(session.providerConfig?.model, oldId);
}

/** Metadata-only administration of unsupported reference owners: never grant
 * trust, never read project resource bodies, never rewrite sessions/profiles.
 * Durable sessions are scanned independently: SessionStore.list/load swallow
 * unsafe/malformed inventory errors and cannot prove absence of references.
 * Strict caps intentionally refuse larger/legacy/unrecognized stores.
 */
export async function assertProviderReferenceOwners(input: {
  oldId: string;
  sessions: readonly Session[];
  running: readonly unknown[];
  sessionsDir: string;
  subagentsFile: string;
  agentSettingsFile: string;
  projectDirectories: readonly string[];
  /** Complete canonical WorkspaceManager roots, not just loaded session cwds. */
  projectRoots: readonly string[];
  /** Non-builtin executable generations can retain arbitrary provider/session handles. */
  extensionIds: readonly string[];
}): Promise<void> {
  const oldId = input.oldId.trim().toLowerCase();
  if (input.extensionIds.some(id => !id.startsWith('builtin:'))) refusal('PROVIDER_UNSUPPORTED_REFERENCES');
  if (input.running.length || input.sessions.some(session => sessionReference(session, oldId))) refusal('PROVIDER_IN_USE');
  if ([process.env.AI_HARNESS_DEFAULT_PROVIDER, process.env.AI_HARNESS_PROVIDER].some(value => value?.trim().toLowerCase() === oldId)
    || [process.env.AI_HARNESS_DEFAULT_MODEL, process.env.AI_HARNESS_MODEL].some(value => qualified(value, oldId))) refusal('PROVIDER_ENVIRONMENT_LOCKED');

  const exists = async (file: string): Promise<boolean> => {
    try { await lstat(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  try {
    // Other configuration schemas have different qualification/inheritance rules.
    // Without a trusted transactional inventory, even a disabled profile can be
    // enabled later and must not be silently orphaned.
    if (await exists(input.subagentsFile)) {
      const value: unknown = JSON.parse(await readBoundedResourceText(input.subagentsFile, 1024 * 1024));
      if (!record(value) || value.version !== 1 || !record(value.projects)
        || Object.keys(value).some(key => !['version', 'global', 'projects'].includes(key))
        || Object.keys(value.projects).length > 1_000) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
      for (const layer of [value.global, ...Object.values(value.projects)].filter(item => item !== undefined)) {
        if (!record(layer) || Object.keys(layer).some(key => !['engineEnabled', 'maxConcurrency', 'profiles', 'updatedAt'].includes(key))
          || !Array.isArray(layer.profiles) || layer.profiles.length > 50) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
        for (const profile of layer.profiles) {
          if (!record(profile) || profile.model !== undefined && typeof profile.model !== 'string'
            || profile.provider !== undefined || profile.providerConfig !== undefined) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
          if (qualified(profile.model, oldId)) refusal('PROVIDER_UNSUPPORTED_REFERENCES');
        }
      }
    }
    // Operator/global agent settings are outside ConfigurationStore ownership.
    if (await exists(input.agentSettingsFile)) refusal('PROVIDER_UNSUPPORTED_REFERENCES');
    const projects = new Set(input.projectDirectories);
    if (projects.size > 1_000) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
    for (const cwd of projects) {
      if (await exists(path.join(cwd, '.ai-harness', 'settings.json'))) refusal('PROVIDER_UNSUPPORTED_REFERENCES');
    }
    // A future cwd can be any descendant of an allowed root, even without a
    // loaded session. Prove absence using bounded METADATA ONLY traversal;
    // truncated, linked or too-deep trees are unsupported, never silently skipped.
    if (input.projectRoots.length > 1_000) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
    const pending = [...new Set(input.projectRoots)].map(cwd => ({ cwd, depth: 0 }));
    const inspected = new Map<string, Awaited<ReturnType<typeof lstat>>>();
    let entries = 0;
    for (let index = 0; index < pending.length; ++index) {
      const { cwd, depth } = pending[index]!;
      if (inspected.has(cwd)) continue;
      if (inspected.size >= 2_000 || depth > 32) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
      if (await exists(path.join(cwd, '.ai-harness', 'settings.json'))) refusal('PROVIDER_UNSUPPORTED_REFERENCES');
      const listing = await readStableDirectoryEntries(cwd, Math.max(1, 20_000 - entries));
      entries += listing.entries.length;
      if (listing.truncated || entries > 20_000) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
      inspected.set(cwd, listing.stats);
      for (const entry of listing.entries) {
        if (entry.isSymbolicLink()) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
        if (entry.isDirectory()) {
          if (pending.length >= 2_000) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
          pending.push({ cwd: path.join(cwd, entry.name), depth: depth + 1 });
        }
      }
    }
    for (const [cwd, before] of inspected) {
      const after = await lstat(cwd);
      if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || after.isSymbolicLink()) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
    }
    if (!await exists(input.sessionsDir)) return;
    const listing = await readStableDirectoryEntries(input.sessionsDir, 10_000);
    if (listing.truncated) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
    let bytes = 0;
    for (const entry of listing.entries) {
      if (!entry.name.endsWith('.jsonl')) continue;
      if (!entry.isFile()) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
      const source = await readBoundedResourceText(path.join(input.sessionsDir, entry.name), 1024 * 1024);
      bytes += Buffer.byteLength(source);
      if (bytes > 16 * 1024 * 1024) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
      let metadata = false;
      for (const line of source.split('\n').filter(line => line.trim())) {
        const value: unknown = JSON.parse(line);
        if (!record(value) || value.version !== 2 || !['metadata', 'message', 'command', 'compaction', 'branch_summary'].includes(String(value.type))) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
        if (value.type === 'metadata') {
          metadata = true;
          if (value.providerConfig !== undefined && (!record(value.providerConfig) || typeof value.providerConfig.type !== 'string')
            || value.model !== undefined && typeof value.model !== 'string'
            || value.cwd !== undefined && typeof value.cwd !== 'string') refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
          if (sessionReference(value as Pick<Session, 'providerConfig' | 'model'>, oldId)) refusal('PROVIDER_IN_USE');
          if (typeof value.cwd === 'string' && await exists(path.join(value.cwd, '.ai-harness', 'settings.json'))) refusal('PROVIDER_UNSUPPORTED_REFERENCES');
        }
        if (String(value.provider ?? '').trim().toLowerCase() === oldId || qualified(value.model, oldId)) refusal('PROVIDER_IN_USE');
      }
      if (!metadata) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
    }
    // Recheck inventory identity after all file reads; external replacements fail
    // closed. Host exclusive ownership is still required for future admissions.
    const after = await readStableDirectoryEntries(input.sessionsDir, 10_000);
    if (after.truncated || after.stats.ino !== listing.stats.ino || after.stats.dev !== listing.stats.dev
      || after.stats.mtimeMs !== listing.stats.mtimeMs || after.stats.ctimeMs !== listing.stats.ctimeMs) refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('PROVIDER_')) throw error;
    refusal('PROVIDER_REFERENCE_STORE_UNAVAILABLE');
  }
}
