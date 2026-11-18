import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore, SessionManager, type Session } from '@ai-harness/core';
import { ConfigurationStore } from '../config/config-store.js';
import { ProviderAdministration, assertProviderReferenceOwners } from './provider-administration.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-admission-')); roots.push(root);
  const store = new ConfigurationStore(path.join(root, 'config.json')); await store.load();
  const references = vi.fn(async (_id: string) => undefined);
  const admission = new ProviderAdministration(store, references);
  const owners = { oldId: 'acme', running: [], sessions: [] as Session[], sessionsDir: path.join(root, 'sessions'),
    subagentsFile: path.join(root, 'subagents.json'), agentSettingsFile: path.join(root, 'settings.json'), projectDirectories: [] as string[], projectRoots: [] as string[], extensionIds: [] as string[] };
  return { root, store, references, admission, owners };
}

describe('provider administration operation leases', () => {
  it('never enables rename implicitly, takes the exclusive lease synchronously, and rejects rather than queues', async () => {
    const { admission, references } = await fixture();
    await expect(admission.rename('acme', async () => undefined)).rejects.toMatchObject({ code: 'PROVIDER_ADMISSION_UNAVAILABLE' });
    admission.activateForExclusiveHost();
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    references.mockImplementationOnce(async () => pending);
    const rename = admission.rename('acme', async () => undefined);
    await expect(admission.withOperation(async () => undefined)).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
    await expect(admission.rename('acme', async () => undefined)).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
    release(); await rename;
    expect(await admission.withOperation(async () => 'ok')).toBe('ok');
  });
  it('keeps an operation leased through actual rejection and safely releases afterwards', async () => {
    const { admission } = await fixture(); admission.activateForExclusiveHost();
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const operation = expect(admission.withOperation(async () => { await pending; throw new Error('operation failed'); })).rejects.toThrow('operation failed');
    await expect(admission.rename('acme', async () => undefined)).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
    release(); await operation;
    await admission.rename('acme', async () => undefined);
  });
  it('fresh durable intent check refuses admissions from a stale loaded store', async () => {
    const { admission, root } = await fixture();
    await writeFile(path.join(root, 'config.json.provider-intent.json'), '{"version":1,"state":"pending"}');
    const operation = vi.fn(async () => undefined);
    await expect(admission.withOperation(operation)).rejects.toMatchObject({ code: 'PROVIDER_TRANSACTION_QUARANTINED' });
    expect(operation).not.toHaveBeenCalled();
  });
});

describe('actual reference owners fail closed', () => {
  it('checks independent durable v2 sessions even when no session is loaded in memory', async () => {
    const { owners } = await fixture();
    const manager = new SessionManager(); manager.setStore(new JsonlSessionStore(owners.sessionsDir));
    const session = await manager.create({ model: 'acme:org:model' });
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_IN_USE' });
    await manager.update(session.id, { model: 'bare-model', providerConfig: { type: 'acme' } });
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_IN_USE' });
    await manager.update(session.id, { providerConfig: { type: 'other' } });
    await assertProviderReferenceOwners(owners);
  });
  it('refuses malformed/legacy/linked/over-budget durable stores instead of the forgiving Core inventory', async () => {
    const { owners, root } = await fixture(); await mkdir(owners.sessionsDir);
    const file = path.join(owners.sessionsDir, 'unsafe.jsonl');
    for (const source of ['{bad', '{"type":"message","role":"user"}\n', ' '.repeat(1024 * 1024 + 1)]) {
      await writeFile(file, source);
      await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_STORE_UNAVAILABLE' });
    }
    await rm(file); await writeFile(path.join(root, 'outside'), 'private'); await symlink(path.join(root, 'outside'), file);
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_STORE_UNAVAILABLE' });
  });
  it('refuses referenced disabled global/project profiles without rewriting instructions or bare models', async () => {
    const { owners } = await fixture();
    for (const key of ['global', 'projects']) {
      await writeFile(owners.subagentsFile, JSON.stringify({ version: 1, projects: {},
        [key]: key === 'global' ? { profiles: [{ model: 'acme/model', enabled: false }] } : { p: { profiles: [{ model: 'acme:model', enabled: false }] } },
      }));
      await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED_REFERENCES' });
    }
    await writeFile(owners.subagentsFile, JSON.stringify({ version: 1, projects: { p: { profiles: [{ model: 'bare', instructions: 'acme:model' }] } } }));
    await assertProviderReferenceOwners(owners);
  });
  it('refuses executable extension generations instead of trusting retained runtime handles', async () => {
    const { owners } = await fixture(); owners.extensionIds.push('user:extension');
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED_REFERENCES' });
  });
  it('does not open operator/project agent settings or grant trust during rename', async () => {
    const { owners, root } = await fixture();
    await writeFile(owners.agentSettingsFile, 'not even valid JSON');
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED_REFERENCES' });
    await rm(owners.agentSettingsFile);
    const project = path.join(root, 'project'); await mkdir(path.join(project, '.ai-harness'), { recursive: true });
    await writeFile(path.join(project, '.ai-harness', 'settings.json'), 'untrusted resource');
    owners.projectDirectories.push(project);
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED_REFERENCES' });
  });
  it('finds future-cwd settings below allowed roots without any loaded project/session', async () => {
    const { owners, root } = await fixture();
    const workspace = path.join(root, 'workspace'); const nested = path.join(workspace, 'future', 'cwd');
    await mkdir(path.join(nested, '.ai-harness'), { recursive: true });
    await writeFile(path.join(nested, '.ai-harness', 'settings.json'), 'private untrusted body');
    owners.projectRoots.push(workspace);
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED_REFERENCES' });
    await rm(path.join(nested, '.ai-harness', 'settings.json'));
    await assertProviderReferenceOwners(owners);
    await symlink(nested, path.join(workspace, 'linked'));
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_STORE_UNAVAILABLE' });
  });
  it('normalizes current provider/environment references and recognizes environment-qualified defaults', async () => {
    const { owners } = await fixture();
    owners.sessions.push({ providerConfig: { type: ' ACME ' } } as Session);
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_IN_USE' }); owners.sessions.length = 0;
    vi.stubEnv('AI_HARNESS_PROVIDER', ' AcMe ');
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_ENVIRONMENT_LOCKED' });
    vi.stubEnv('AI_HARNESS_PROVIDER', 'other'); vi.stubEnv('AI_HARNESS_DEFAULT_MODEL', 'ACME:org:model');
    await expect(assertProviderReferenceOwners(owners)).rejects.toMatchObject({ code: 'PROVIDER_ENVIRONMENT_LOCKED' });
  });
});

// The exclusive administration cap must not restrict ordinary default-OFF hosts.
it('retains unrestricted ordinary operation admission while bounding only an activated exclusive host', async () => {
  const { admission } = await fixture();
  let release!: () => void;
  let hold = new Promise<void>(resolve => { release = resolve; });
  const ordinary = Array.from({ length: 1_025 }, () => admission.withOperation(async () => hold));
  release(); await expect(Promise.all(ordinary)).resolves.toHaveLength(1_025);
  admission.activateForExclusiveHost();
  hold = new Promise<void>(resolve => { release = resolve; });
  const restricted = Array.from({ length: 1_024 }, () => admission.withOperation(async () => hold));
  try { await expect(admission.withOperation(async () => undefined)).rejects.toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' }); }
  finally { release(); await Promise.all(restricted); }
});
