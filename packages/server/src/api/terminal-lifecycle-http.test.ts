import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../index.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function ready(response: Response) {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(); let text = '';
  while (!text.includes('\n\n')) {
    const chunk = await reader.read(); if (chunk.done) throw new Error('Missing readiness');
    text += new TextDecoder().decode(chunk.value);
  }
  return { reader, data: JSON.parse(text.split('\n\n')[0]!.split('\n').find(line => line.startsWith('data: '))!.slice(6)) };
}

describe('real PTY UTF-8 replay, expiry and physical lifecycle', () => {
  let root: string, cwd: string, base: string;
  const admin = 'web05-disposable-admin', user = 'web05-disposable-user';
  const request = (url: string, method = 'GET', body?: unknown, token = admin, origin?: string) => fetch(base + url, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  const create = async () => { const response = await request('/api/terminals', 'POST', { cwd }); expect(response.status).toBe(201); return response.json(); };
  const input = (id: string, data: string) => request(`/api/terminals/${id}/input`, 'POST', { data });
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-web05-http-')); cwd = path.join(root, 'work'); await mkdir(cwd);
    await writeFile(path.join(cwd, 'AGENTS.md'), 'Requires explicit trust.');
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', user); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', admin);
    vi.stubEnv('AI_HARNESS_AGENT_DIR', path.join(root, 'agent'));
    vi.stubEnv('OPENAI_API_KEY', 'web05-never-inherit-provider');
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), defaultCwd: cwd, allowedRoots: [cwd], enableMockProvider: true });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => { await stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it('requires admin, Origin and trust; receives a large Unicode paste once and retains authentic exit', async () => {
    expect((await request('/api/terminals', 'POST', { cwd }, user)).status).toBe(403);
    expect((await request('/api/terminals', 'POST', { cwd }, admin, 'https://foreign.invalid')).status).toBe(403);
    expect((await request('/api/terminals', 'POST', { cwd })).status).toBe(409);
    expect((await request('/api/workspaces/trust', 'POST', { cwd, confirm: true })).status).toBe(200);
    const terminal = await create(), id = terminal.id as string;
    const bytes = Buffer.from('é😀漢字'.repeat(3_000)); const resultFile = path.join(cwd, 'received.json');
    const marker = path.join(cwd, 'ready');
    const code = `const fs=require("node:fs"),crypto=require("node:crypto");process.stdin.setRawMode(true);process.stdin.resume();fs.writeFileSync(${JSON.stringify(marker)},"ready");let all=Buffer.alloc(0);process.stdin.on("data",b=>{if(b.length===1&&b[0]===4)process.exit(7);all=Buffer.concat([all,b]);if(all.length>=${bytes.length}){fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({bytes:all.length,sha:crypto.createHash("sha256").update(all).digest("hex"),leaked:!!process.env.OPENAI_API_KEY||!!process.env.AI_HARNESS_AUTH_TOKEN}));process.stdout.write("\\r\\nUNICODE_é😀漢字\\r\\n")}})`;
    expect((await input(id, `exec node -e '${code}'\r`)).status).toBe(200);
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ready'), { timeout: 5_000 });
    expect((await input(id, bytes.toString())).status).toBe(200);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(resultFile, 'utf8'))).toEqual({ bytes: bytes.length, sha: digest(bytes), leaked: false }), { timeout: 5_000 });
    expect((await input(id, 'x'.repeat(65_537))).status).toBe(400);
    expect((await request(`/api/terminals/${id}/resize`, 'POST', { cols: 121, rows: 41 })).status).toBe(200);
    const stream = await ready(await request(`/api/terminals/${id}/events?after=0`));
    expect(stream.data.snapshot).toMatchObject({ id, cols: 121, rows: 41 }); await stream.reader.cancel();
    expect((await input(id, '\x04')).status).toBe(200);
    await vi.waitFor(async () => expect(await request(`/api/terminals/${id}`).then(response => response.json())).toMatchObject({ status: 'failed', exitCode: 7 }), { timeout: 5_000 });
    expect((await input(id, 'not accepted')).status).toBe(409);
    expect((await request(`/api/terminals/${id}`, 'DELETE')).status).toBe(200);
  }, 20_000);

  it('resets real expired/future replay, closes removed stream leases and terminates shell plus foreground child', async () => {
    const terminal = await create(), id = terminal.id as string;
    const marker = path.join(cwd, 'flood-ready');
    const code = `const fs=require("node:fs");process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("Z".repeat(2_300_000),()=>fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)))`;
    expect((await input(id, `node -e '${code}'\r`)).status).toBe(200);
    let child = 0;
    await vi.waitFor(async () => { child = Number(await readFile(marker, 'utf8')); expect(child).toBeGreaterThan(0); }, { timeout: 5_000 });
    await vi.waitFor(async () => expect((await request(`/api/terminals/${id}`).then(response => response.json())).lastOffset).toBeGreaterThan(2_200_000), { timeout: 5_000 });
    for (const after of [0, 9_000_000]) {
      const stream = await ready(await request(`/api/terminals/${id}/events?after=${after}`));
      expect(stream.data.reset).toBe(true); expect(stream.data.oldestOffset).toBeGreaterThan(0);
      expect(stream.data.lastOffset - stream.data.oldestOffset).toBeLessThanOrEqual(2 * 1024 * 1024);
      await stream.reader.cancel();
    }
    const snapshot = await request(`/api/terminals/${id}`).then(response => response.json());
    const lease = await ready(await request(`/api/terminals/${id}/events?after=${snapshot.lastOffset}`));
    const removed = await request(`/api/terminals/${id}`, 'DELETE'); expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ status: 'killed' });
    while (!(await lease.reader.read()).done) { /* Drain the bounded readiness tail until removal closes SSE. */ }
    expect((await request(`/api/terminals/${id}`)).status).toBe(404);
    await vi.waitFor(async () => {
      for (const pid of [terminal.pid, child]) {
        let running = false;
        try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); running = stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        expect(running).toBe(false);
      }
    }, { timeout: 5_000 });
  }, 20_000);
});
