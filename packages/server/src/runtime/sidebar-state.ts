import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteStableFile, readBoundedResourceText } from '@ai-harness/core';
import type { SidebarChange, SidebarMutationResult, SidebarState } from '@ai-harness/core';

const MAX_BYTES = 4 * 1024 * 1024;
const EMPTY: SidebarState = { version: 1, revision: 'initial', families: [], projects: [] };
export function sidebarError(status: number, code: string): Error {
  return Object.assign(new Error(code), { status, code });
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= max
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
export function parseSidebarChange(value: unknown): SidebarChange {
  const invalid = (): never => { throw sidebarError(400, 'invalid-sidebar-change'); };
  if (!record(value)) return invalid();
  if (value.kind === 'families') {
    if (Object.keys(value).some(key => !['kind', 'ids', 'pinned', 'archived'].includes(key))
      || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 100
      || !value.ids.every(id => text(id, 256) && !id.startsWith('draft:'))
      || new Set(value.ids).size !== value.ids.length
      || (value.pinned === undefined && value.archived === undefined)
      || (value.pinned !== undefined && typeof value.pinned !== 'boolean')
      || (value.archived !== undefined && typeof value.archived !== 'boolean')) return invalid();
  } else if (value.kind === 'project') {
    if (Object.keys(value).some(key => !['kind', 'cwd', 'name'].includes(key))
      || !text(value.cwd, 4096) || (value.name !== null && !text(value.name, 120))) return invalid();
  } else if (value.kind === 'move-project') {
    if (Object.keys(value).some(key => !['kind', 'cwd', 'before'].includes(key))
      || !text(value.cwd, 4096) || (value.before !== null && !text(value.before, 4096))) return invalid();
  } else return invalid();
  return structuredClone(value) as unknown as SidebarChange;
}
function validateState(value: unknown): SidebarState {
  if (!record(value) || value.version !== 1 || !text(value.revision, 64)
    || Object.keys(value).some(key => !['version', 'revision', 'families', 'projects'].includes(key))
    || !Array.isArray(value.families) || value.families.length > 10_000
    || !Array.isArray(value.projects) || value.projects.length > 256) throw sidebarError(503, 'invalid-sidebar-state');
  for (const item of value.families) {
    if (!record(item) || !text(item.id, 256) || typeof item.pinned !== 'boolean' || typeof item.archived !== 'boolean'
      || Object.keys(item).some(key => !['id', 'pinned', 'archived'].includes(key))) throw sidebarError(503, 'invalid-sidebar-state');
  }
  for (const item of value.projects) {
    if (!record(item) || !text(item.cwd, 4096) || !path.isAbsolute(item.cwd)
      || (item.name !== undefined && !text(item.name, 120))
      || Object.keys(item).some(key => !['cwd', 'name'].includes(key))) throw sidebarError(503, 'invalid-sidebar-state');
  }
  if (new Set(value.families.map(item => item.id)).size !== value.families.length
    || new Set(value.projects.map(item => item.cwd)).size !== value.projects.length) throw sidebarError(503, 'invalid-sidebar-state');
  return value as unknown as SidebarState;
}

/** Fresh reads, atomic private writes, exclusive cooperating-process lock. No journal writes. */
export class SidebarStateStore {
  private undo = new Map<string, { revision: string; before: SidebarState; expires: number }>();
  constructor(private readonly file: string) {}
  async read(): Promise<SidebarState> {
    let source: string;
    try { source = await readBoundedResourceText(this.file, MAX_BYTES); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
      throw sidebarError(503, 'sidebar-state-unavailable');
    }
    try { return validateState(JSON.parse(source)); }
    catch { throw sidebarError(503, 'invalid-sidebar-state'); }
  }
  async mutate(revision: unknown, change?: SidebarChange, undoToken?: string): Promise<SidebarMutationResult> {
    if (!text(revision, 64)) throw sidebarError(400, 'invalid-sidebar-revision');
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // A crash leaves a fail-closed lock for offline operator removal, never unsafe takeover.
    const lock = await open(`${this.file}.lock`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      .catch(() => { throw sidebarError(409, 'sidebar-state-busy'); });
    try {
      const before = await this.read();
      if (before.revision !== revision) throw sidebarError(409, 'sidebar-state-conflict');
      for (const [token, entry] of this.undo) if (entry.expires <= Date.now()) this.undo.delete(token);
      let state = structuredClone(before);
      if (undoToken) {
        const entry = this.undo.get(undoToken);
        if (!entry || entry.revision !== revision) throw sidebarError(409, 'sidebar-undo-expired');
        state = structuredClone(entry.before);
      } else if (change?.kind === 'families') {
        for (const id of change.ids) {
          const row = state.families.find(item => item.id === id) ?? { id, pinned: false, archived: false };
          if (change.pinned !== undefined) row.pinned = change.pinned;
          if (change.archived !== undefined) row.archived = change.archived;
          state.families = state.families.filter(item => item.id !== id);
          if (row.pinned || row.archived) state.families.push(row);
        }
      } else if (change) {
        const project = state.projects.find(item => item.cwd === change.cwd) ?? { cwd: change.cwd };
        if (change.kind === 'project') {
          if (change.name === null) delete project.name;
          else project.name = change.name.trim();
          if (!state.projects.some(item => item.cwd === change.cwd)) state.projects.push(project);
        } else if (change.cwd !== change.before) {
          state.projects = state.projects.filter(item => item.cwd !== change.cwd);
          if (change.before && !state.projects.some(item => item.cwd === change.before)) state.projects.push({ cwd: change.before });
          const index = change.before ? state.projects.findIndex(item => item.cwd === change.before) : state.projects.length;
          state.projects.splice(index, 0, project);
        }
      } else throw sidebarError(400, 'invalid-sidebar-change');
      state.revision = randomUUID();
      try { validateState(state); }
      catch { throw sidebarError(400, 'sidebar-state-limit'); }
      await atomicWriteStableFile(this.file, JSON.stringify(state) + '\n', { overwrite: true, mode: 0o600, maxBytes: MAX_BYTES });
      if (undoToken) { this.undo.delete(undoToken); return { state }; }
      while (this.undo.size >= 100) this.undo.delete(this.undo.keys().next().value!);
      const token = randomUUID();
      this.undo.set(token, { before, revision: state.revision, expires: Date.now() + 60_000 });
      return { state, undoToken: token };
    } finally { await lock.close(); await unlink(`${this.file}.lock`); }
  }
}
