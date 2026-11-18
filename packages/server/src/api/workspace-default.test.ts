import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { createWorkspaceRouter } from './workspace-routes.js';
import { authenticationMiddleware, requireCapability } from '../security/request-security.js';
import type { RuntimeServices } from '../runtime/services.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(kind: 'relative' | 'missing' | 'file' | 'escape' = 'relative') {
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-default-http-'));
  roots.push(root);
  const home = path.join(root, 'home'); const cwd = path.join(home, 'project'); const outside = path.join(root, 'outside');
  await mkdir(cwd, { recursive: true }); await mkdir(outside);
  await writeFile(path.join(home, 'file'), 'file'); await symlink(outside, path.join(home, 'escape'));
  const defaultCwd = kind === 'relative' ? path.relative(process.cwd(), cwd) : path.join(home, kind);
  const workspaceManager = new WorkspaceManager({ allowedRoots: [home], defaultCwd, homeDir: home });
  await workspaceManager.initialize();
  const trustManager = new ProjectTrustManager(path.join(root, 'trust.json')); await trustManager.load();
  const app = express(); app.use(express.json()); app.use(authenticationMiddleware());
  app.use('/api/workspaces', requireCapability('workspace:read'), createWorkspaceRouter(Promise.resolve({ workspaceManager, trustManager } as RuntimeServices)));
  return { app, cwd, home, root, trustManager };
}
const get = (app: express.Express) => request(app).get('/api/workspaces/default').set('Authorization', 'Bearer user');
const validate = (app: express.Express, cwd: string) => request(app).post('/api/workspaces/validate').set('Authorization', 'Bearer user').send({ cwd });

describe('default workspace HTTP contract', () => {
  it('uses identical canonical descriptors for configured defaults, relative and home inputs; never grants trust', async () => {
    const f = await fixture();
    const initial = await get(f.app).expect(200).expect('Cache-Control', 'no-store');
    expect(initial.body).toMatchObject({ cwd: f.cwd, displayPath: '~/project', operationTrusted: false });
    expect((await validate(f.app, f.cwd).expect(200)).body).toEqual(initial.body);
    expect((await validate(f.app, '~/project').expect(200)).body).toEqual(initial.body);
    expect((await validate(f.app, '.').expect(200)).body).toEqual(initial.body);
    expect(await f.trustManager.isTrusted(f.cwd)).toBe(false);
    await request(f.app).get('/api/workspaces/default').expect(401);
  });

  it.each([
    ['missing', 404, 'not-found'], ['file', 400, 'wrong-kind'], ['escape', 403, 'outside-allowed-roots'],
  ] as const)('reports a fixed %s failure and allows explicit valid recovery', async (kind, status, code) => {
    const f = await fixture(kind);
    const result = await get(f.app).expect(status).expect('Cache-Control', 'no-store');
    expect(result.body.code).toBe(code);
    expect(JSON.stringify(result.body)).not.toContain(f.root);
    expect((await validate(f.app, path.join(f.home, kind)).expect(status)).body).toEqual(result.body);
    const recovered = await validate(f.app, f.cwd).expect(200).expect('Cache-Control', 'no-store');
    expect(recovered.body).toMatchObject({ cwd: f.cwd, displayPath: '~/project', operationTrusted: false });
  });

  it('returns current failure after a previously valid default disappears, without leaking a path or substituting home', async () => {
    const f = await fixture();
    await get(f.app).expect(200);
    await rm(f.cwd, { recursive: true });
    const missing = await get(f.app).expect(404);
    expect(missing.body).toEqual({ code: 'not-found', error: 'The workspace path was not found.' });
    expect((await validate(f.app, f.home).expect(200)).body).toMatchObject({ cwd: f.home, displayPath: '~', operationTrusted: false });
  });
});
