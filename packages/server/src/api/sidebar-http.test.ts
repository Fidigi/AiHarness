import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, stop } from '../index.js';

let root: string, dataDir: string, cwd: string, base: string;
const previous = { AI_HARNESS_AUTH_TOKEN: process.env.AI_HARNESS_AUTH_TOKEN, AI_HARNESS_ADMIN_TOKEN: process.env.AI_HARNESS_ADMIN_TOKEN };
const headers = () => ({ Authorization: 'Bearer sidebar-user', Origin: base, 'Content-Type': 'application/json' });
const get = () => fetch(base + '/api/sessions/ui-state', { headers: headers() });
const post = (body: unknown, origin = base) => fetch(base + '/api/sessions/ui-state', { method: 'POST', headers: { ...headers(), Origin: origin }, body: JSON.stringify(body) });
const sessionPost = (route: string, body: unknown) => fetch(base + '/api/sessions' + route, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
async function launch() {
  const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], enableMockProvider: true });
  base = `http://127.0.0.1:${server.port}`;
}
beforeAll(async () => {
  process.env.AI_HARNESS_AUTH_TOKEN = 'sidebar-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'sidebar-admin';
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-sidebar-http-')); dataDir = path.join(root, 'data'); cwd = path.join(root, 'work'); await mkdir(cwd);
  await launch();
});
afterAll(async () => {
  await stop(); await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe('real HTTP sidebar state, distinct from session journals', () => {
  it('supports user-role bulk families, two-client conflicts, undo, readback and restart without advancing a leaf', async () => {
    const created = await sessionPost('', { cwd, title: 'Root' }); expect(created.status).toBe(201); const source = await created.json();
    const forked = await sessionPost(`/${source.id}/fork`, {}); expect(forked.status).toBe(201); const fork = await forked.json();
    const cloned = await sessionPost(`/${source.id}/clone`, {}); expect(cloned.status).toBe(201); const clone = await cloned.json();
    expect(fork.branchId).toBe(source.id); expect(clone.branchId).not.toBe(source.id);
    const journalDir = path.join(dataDir, 'sessions');
    const files = await readdir(journalDir);
    const journals = await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(async file => [file, await readFile(path.join(journalDir, file), 'utf8')] as const));
    const a = await get(), b = await get(); expect(a.status).toBe(200); expect(a.headers.get('cache-control')).toBe('no-store');
    const clientA = await a.json(), clientB = await b.json(); expect(clientA.revision).toBe(clientB.revision);
    const changed = await post({ revision: clientA.revision, change: { kind: 'families', ids: [source.id, clone.id], pinned: true, archived: true } });
    expect(changed.status).toBe(200); const saved = await changed.json();
    expect(saved.state.families).toHaveLength(2);
    const conflict = await post({ revision: clientB.revision, change: { kind: 'families', ids: [source.id], pinned: false } });
    expect(conflict.status).toBe(409); expect((await conflict.json()).code).toBe('sidebar-state-conflict');
    expect(await (await get()).json()).toEqual(saved.state);
    const undo = await post({ revision: saved.state.revision, undoToken: saved.undoToken }); expect(undo.status).toBe(200);
    const undone = await undo.json(); expect(undone.state.families).toEqual([]);
    const renamed = await post({ revision: undone.state.revision, change: { kind: 'project', cwd, name: 'Across browsers' } }); expect(renamed.status).toBe(200);
    const expected = (await renamed.json()).state;
    for (const [file, bytes] of journals) expect(await readFile(path.join(journalDir, file), 'utf8')).toBe(bytes);
    await stop(); await launch(); expect(await (await get()).json()).toEqual(expected);
    for (const [file, bytes] of journals) expect(await readFile(path.join(journalDir, file), 'utf8')).toBe(bytes);
  });
  it('rejects anonymous/foreign-origin, malformed, unknown family and outside-root mutations atomically', async () => {
    expect((await fetch(base + '/api/sessions/ui-state')).status).toBe(401);
    const before = await (await get()).json();
    const body = { revision: before.revision, change: { kind: 'project', cwd, name: 'Safe' } };
    expect((await post(body, 'https://foreign.invalid')).status).toBe(403);
    expect((await post({ revision: before.revision, change: { kind: 'families', ids: ['missing'], pinned: true } })).status).toBe(404);
    expect((await post({ revision: before.revision, change: { kind: 'families', ids: ['x'], pinned: 'yes' } })).status).toBe(400);
    expect((await post({ ...body, change: { kind: 'project', cwd: root, name: 'Outside' } })).status).toBe(403);
    expect((await post({ ...body, undoToken: 'with-change' })).status).toBe(400);
    expect(await (await get()).json()).toEqual(before);
  });
});
