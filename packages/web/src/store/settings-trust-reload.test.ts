import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCatalog, SkillCatalog, WorkspaceDescriptor } from '@ai-harness/core';
import type * as Api from '../services/api.js';
import { getModelCatalog, getSkillCatalog, validateWorkspace } from '../services/api.js';
import { useSessionStore } from './session-store.js';
vi.mock('../services/api.js', async original => ({ ...await original<typeof Api>(),
  validateWorkspace: vi.fn(), getModelCatalog: vi.fn(), getSkillCatalog: vi.fn(),
  listSessions: vi.fn(async () => ({ success: true, data: [] })),
}));
const workspace: WorkspaceDescriptor = { id: 'project', cwd: '/project', name: 'project', trusted: true, operationTrusted: true };
const models: ModelCatalog = { providers: [], enabledScope: 'global', enabledSource: 'global', updatedAt: '2026-10-17T00:00:00Z' };
const skills: SkillCatalog = { skills: [], projectId: 'project', cwd: '/project', enabledScope: 'global',
  enabledSource: 'global', projectTrusted: true, errorCount: 0, updatedAt: '2026-10-17T00:00:00Z' };
function deferred<T>() { let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn() } });
  useSessionStore.setState(state => ({ workspace, recentWorkspaces: [workspace],
    providers: { ...state.providers, catalog: models, catalogLoading: false }, skills: { catalog: skills, loading: false } }));
  vi.mocked(validateWorkspace).mockResolvedValue({ success: true, data: workspace });
  vi.mocked(getModelCatalog).mockResolvedValue({ success: true, data: models });
  vi.mocked(getSkillCatalog).mockResolvedValue({ success: true, data: skills });
});
afterEach(() => vi.unstubAllGlobals());

describe('canonical workspace trust refresh and mounted catalogue ownership', () => {
  it.each(['trusted', 'operationTrusted', 'id', 'cwd'] as const)('withdraws both old catalogues atomically with changed %s, then rereads canonical data', async field => {
    const refreshed = { ...workspace, [field]: field === 'id' ? 'replacement' : field === 'cwd' ? '/replacement' : false };
    vi.mocked(validateWorkspace).mockResolvedValue({ success: true, data: refreshed });
    const model = deferred<Awaited<ReturnType<typeof getModelCatalog>>>(), skill = deferred<Awaited<ReturnType<typeof getSkillCatalog>>>();
    vi.mocked(getModelCatalog).mockReturnValue(model.promise); vi.mocked(getSkillCatalog).mockReturnValue(skill.promise);
    const observations: Array<{ trusted?: boolean; models: unknown; skills: unknown }> = [];
    const published = deferred<void>();
    const unsubscribe = useSessionStore.subscribe(state => {
      observations.push({ trusted: state.workspace?.trusted, models: state.providers.catalog, skills: state.skills.catalog });
      if (state.workspace === refreshed) published.resolve(undefined);
    });
    const pending = useSessionStore.getState().refreshWorkspace(); await published.promise;
    expect(useSessionStore.getState()).toMatchObject({ workspace: refreshed, providers: { catalogLoading: true, catalog: undefined }, skills: { loading: true, catalog: undefined } });
    expect(observations.some(state => state.models === undefined && state.skills === undefined)).toBe(true);
    expect(observations.filter(state => state.trusted === false).every(state => !state.models && !state.skills)).toBe(true);
    expect(getModelCatalog).toHaveBeenCalledWith(refreshed.id, true);
    expect(getSkillCatalog).toHaveBeenCalledWith(refreshed.cwd, refreshed.id, true);
    const freshModels = { ...models, updatedAt: 'fresh' }, freshSkills = { ...skills,
      projectId: refreshed.id, cwd: refreshed.cwd, projectTrusted: refreshed.trusted };
    model.resolve({ success: true, data: freshModels }); skill.resolve({ success: true, data: freshSkills }); await pending;
    expect(useSessionStore.getState().providers.catalog).toEqual(freshModels);
    expect(useSessionStore.getState().skills.catalog).toEqual(freshSkills); unsubscribe();
  });
  it('does not reload or replace catalogues for an equivalent descriptor or display-only change', async () => {
    vi.mocked(validateWorkspace).mockResolvedValue({ success: true, data: { ...workspace, displayPath: '~/project' } });
    await useSessionStore.getState().refreshWorkspace();
    expect(getModelCatalog).not.toHaveBeenCalled(); expect(getSkillCatalog).not.toHaveBeenCalled();
    expect(useSessionStore.getState().providers.catalog).toBe(models); expect(useSessionStore.getState().skills.catalog).toBe(skills);
  });
  it('failed refreshed reads never restore old trusted data', async () => {
    vi.mocked(validateWorkspace).mockResolvedValue({ success: true, data: { ...workspace, trusted: false } });
    vi.mocked(getModelCatalog).mockResolvedValue({ success: false, error: 'unavailable' });
    vi.mocked(getSkillCatalog).mockResolvedValue({ success: false, error: 'unavailable' });
    await useSessionStore.getState().refreshWorkspace();
    expect(useSessionStore.getState().providers).toMatchObject({ catalog: undefined, catalogLoading: false, catalogError: 'unavailable' });
    expect(useSessionStore.getState().skills).toEqual({ catalog: undefined, loading: false, error: 'unavailable' });
  });
  it('late pre-refresh reads cannot republish a prior trust generation, including allow→deny→allow', async () => {
    const oldModel = deferred<Awaited<ReturnType<typeof getModelCatalog>>>(), oldSkill = deferred<Awaited<ReturnType<typeof getSkillCatalog>>>();
    vi.mocked(getModelCatalog).mockReturnValueOnce(oldModel.promise); vi.mocked(getSkillCatalog).mockReturnValueOnce(oldSkill.promise);
    const old = Promise.all([useSessionStore.getState().hydrateModelCatalog(), useSessionStore.getState().hydrateSkillCatalog()]);
    vi.mocked(validateWorkspace).mockResolvedValueOnce({ success: true, data: { ...workspace, trusted: false, operationTrusted: false } });
    await useSessionStore.getState().refreshWorkspace(); await useSessionStore.getState().refreshWorkspace();
    oldModel.resolve({ success: true, data: { ...models, updatedAt: 'OBSOLETE' } });
    oldSkill.resolve({ success: true, data: { ...skills, updatedAt: 'OBSOLETE' } }); await old;
    expect(useSessionStore.getState().workspace).toEqual(workspace);
    expect(useSessionStore.getState().providers.catalog).toEqual(models); expect(useSessionStore.getState().skills.catalog).toEqual(skills);
  });
  it('failed validation preserves current presentation without inventing a trust change', async () => {
    vi.mocked(validateWorkspace).mockResolvedValue({ success: false }); await useSessionStore.getState().refreshWorkspace();
    expect(useSessionStore.getState().workspace).toEqual(workspace);
    expect(getModelCatalog).not.toHaveBeenCalled(); expect(getSkillCatalog).not.toHaveBeenCalled();
  });
});
