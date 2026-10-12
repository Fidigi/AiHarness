import express from 'express';
import request from 'supertest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceManager } from '@ai-harness/core';
import { createWorkspaceRouter } from './workspace-routes.js';
import { authenticationMiddleware } from '../security/request-security.js';
import type { RuntimeServices } from '../runtime/services.js';

it('keeps existing workspace routes operational and link grants disabled before public export/service integration', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aih-linked-disabled-'));
  try {
    const cwd = path.join(base, 'workspace'); const outside = path.join(base, 'outside');
    await mkdir(cwd); await mkdir(outside); await symlink(outside, path.join(cwd, 'escape'));
    const workspaceManager = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaceManager.initialize();
    const app = express(); app.use(express.json()); app.use(authenticationMiddleware());
    app.use('/api/workspaces', createWorkspaceRouter(Promise.resolve({ workspaceManager } as unknown as RuntimeServices)));
    await request(app).get('/api/workspaces/roots').expect(200, { roots: [cwd] });
    const listed = await request(app).get('/api/workspaces/browse').query({ path: cwd }).expect(200);
    expect(listed.body.entries[0]).toMatchObject({ isSymbolicLink: true, isDirectory: false });
    const disabled = await request(app).get('/api/workspaces/linked-directories').query({ cwd }).expect(503);
    expect(disabled.body.code).toBe('store-unavailable');
    await request(app).post('/api/workspaces/linked-directories/consent').send({ cwd, target: outside, allowed: true, confirm: true }).expect(503);
    await expect(workspaceManager.resolve('escape')).rejects.toMatchObject({ code: 'OUTSIDE_ALLOWED_ROOTS' });
  } finally { await rm(base, { recursive: true, force: true }); }
});
