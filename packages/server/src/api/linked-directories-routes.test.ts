import express from 'express';
import request from 'supertest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { LinkedDirectoriesService } from '../runtime/linked-directories-service.js';
import { createLinkedDirectoriesRouter } from './linked-directories-routes.js';
import { createWorkspaceRouter } from './workspace-routes.js';
import type { RuntimeServices } from '../runtime/services.js';
import { authenticationMiddleware, originMiddleware } from '../security/request-security.js';

const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(composed = true) {
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'linked-user-test');
  vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'linked-admin-test');
  const base = await mkdtemp(path.join(os.tmpdir(), 'aih-linked-http-')); temporary.push(base);
  const cwd = path.join(base, 'workspace'); const target = path.join(base, 'target'); const store = path.join(base, 'private');
  await mkdir(cwd); await mkdir(target); await mkdir(store, { mode: 0o700 });
  await writeFile(path.join(target, 'file.txt'), 'TARGET_CONTENT active-test-secret');
  await symlink('../target', path.join(cwd, 'external'));
  const workspaces = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaces.initialize();
  const trust = new ProjectTrustManager(path.join(store, 'trust.json')); await trust.load();
  const service = new LinkedDirectoriesService(workspaces, trust, { storeDirectory: store }, value => value.replaceAll('active-test-secret', '[REDACTED]'));
  const app = express(); app.use(express.json()); app.use(authenticationMiddleware()); app.use(originMiddleware());
  app.use('/api/workspaces', createWorkspaceRouter(Promise.resolve({ workspaceManager: workspaces, ...(composed ? { linkedDirectories: service } : {}) } as unknown as RuntimeServices)));
  return { app, cwd, target, trust, service };
}
const endpoint = '/api/workspaces/linked-directories';
const admin = { Authorization: 'Bearer linked-admin-test' };
const user = { Authorization: 'Bearer linked-user-test' };
function selected(inventory: { cwd: string; directory: string; revision: string; entries: Array<{ id: string }> }) {
  return { cwd: inventory.cwd, directory: inventory.directory, id: inventory.entries[0].id, revision: inventory.revision };
}

describe('linked directories HTTP adapter', () => {
  it('requires authentication; grants/revocation require workspace:write and safe Origin', async () => {
    const f = await fixture();
    await request(f.app).get(endpoint).query({ cwd: f.cwd }).expect(401);
    const listed = await request(f.app).get(endpoint).set(user).query({ cwd: f.cwd }).expect(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.text).not.toContain('TARGET_CONTENT'); expect(listed.text).not.toContain('file.txt');
    const selection = selected(listed.body);
    await request(f.app).post(`${endpoint}/consent`).set(user).send({ ...selection, allowed: true, confirm: true }).expect(403);
    await request(f.app).post(`${endpoint}/consent`).set(admin).set('Origin', 'https://evil.example').send({ ...selection, allowed: true, confirm: true }).expect(403);
    await request(f.app).get(`${endpoint}/browse`).set(user).query({ ...selection, path: '.' }).expect(409);
    const granted = await request(f.app).post(`${endpoint}/consent`).set(admin).send({ ...selection, allowed: true, confirm: true }).expect(200);
    expect(granted.body.entries[0].allowed).toBe(true);
    await f.trust.trust(f.cwd);
    const file = await request(f.app).get(`${endpoint}/content`).set(user).query({ ...selected(granted.body), path: 'file.txt' }).expect(200);
    expect(file.body.content).toBe('TARGET_CONTENT [REDACTED]'); expect(file.text).not.toContain('active-test-secret');
    const revoked = await request(f.app).post(`${endpoint}/consent`).set(admin).send({ ...selected(granted.body), allowed: false, confirm: true }).expect(200);
    await request(f.app).get(`${endpoint}/content`).set(user).query({ ...selected(revoked.body), path: 'file.txt' }).expect(409);
  });

  it('is disabled before service composition and never expands configured roots', async () => {
    const f = await fixture(false);
    const response = await request(f.app).get(endpoint).set(admin).query({ cwd: f.cwd }).expect(503);
    expect(response.body.code).toBe('store-unavailable');
    await request(f.app).post(`${endpoint}/consent`).set(admin).send({ cwd: f.cwd, directory: '.', id: 'a'.repeat(64), revision: 'b'.repeat(64), confirm: true, allowed: true }).expect(503);
    const roots = await request(f.app).get('/api/workspaces/roots').set(admin).expect(200);
    expect(roots.body.roots).toEqual([f.cwd]);
  });

  it('rejects smuggled raw targets, trust, transcript, system, MCP and codemode authority', async () => {
    const f = await fixture(); const listed = await request(f.app).get(endpoint).set(admin).query({ cwd: f.cwd }).expect(200);
    const selection = selected(listed.body);
    for (const extra of [{ target: f.target }, { trust: true }, { transcript: 'allow' }, { system: 'allow' }, { mcp: 'allow' }, { codemode: 'allow' }]) {
      await request(f.app).post(`${endpoint}/consent`).set(admin).send({ ...selection, allowed: true, confirm: true, ...extra }).expect(400);
    }
    for (const confirm of [false, 'true', 1, null]) {
      await request(f.app).post(`${endpoint}/consent`).set(admin).send({ ...selection, allowed: true, confirm }).expect(400);
    }
    await request(f.app).get(endpoint).set(admin).query({ cwd: f.cwd, body: 'read' }).expect(400);
    await request(f.app).post(`${endpoint}/consent`).set(admin).send({ ...selection, revision: 'c'.repeat(64), allowed: true, confirm: true }).expect(409);
  });

  it('keeps source trust independent and refuses traversal and nested links after approval', async () => {
    const f = await fixture();
    const inventory = await f.service.list(f.cwd);
    const granted = await f.service.setConsent(selected(inventory), true, true);
    const selection = selected(granted);
    expect(await f.trust.isTrusted(f.target)).toBe(false);
    const untrusted = await request(f.app).get(`${endpoint}/browse`).set(user).query({ ...selection, path: '.' }).expect(409);
    expect(untrusted.body.code).toBe('source-trust-required');
    await f.trust.trust(f.cwd);
    await request(f.app).get(`${endpoint}/browse`).set(user).query({ ...selection, path: '.' }).expect(200);
    await request(f.app).get(`${endpoint}/content`).set(user).query({ ...selection, path: '../target/file.txt' }).expect(400);
    await symlink('/etc/passwd', path.join(f.target, 'nested-link'));
    await request(f.app).get(`${endpoint}/content`).set(user).query({ ...selection, path: 'nested-link' }).expect(403);
    await f.trust.refuse(f.cwd);
    await request(f.app).get(`${endpoint}/content`).set(user).query({ ...selection, path: 'file.txt' }).expect(409);
  });

  it('does not leak arbitrary backend errors or accept query arrays', async () => {
    const app = express(); app.use(authenticationMiddleware());
    app.use(endpoint, createLinkedDirectoriesRouter(async () => { throw new Error('PRIVATE_BACKEND_SECRET'); }));
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'linked-admin-test'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'linked-admin-test');
    const failed = await request(app).get(endpoint).set(admin).query({ cwd: '/bounded' }).expect(503);
    expect(failed.text).not.toContain('PRIVATE_BACKEND_SECRET');
    await request(app).get(`${endpoint}?cwd=a&cwd=b`).set(admin).expect(400);
  });
});
