import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderType } from '@ai-harness/core';
import type { ModelCatalog, SkillCatalog } from '@ai-harness/core';
import {
  createSession,
  getModelCatalog,
  getProviders,
  getSkillCatalog,
  listSessions,
  updateEnabledModels,
  updateEnabledSkills,
} from '../services/api.js';
import { useSessionStore } from './session-store.js';

vi.mock('../services/api.js', () => ({
  createSession: vi.fn(),
  getModelCatalog: vi.fn(),
  getProviders: vi.fn(),
  getSkillCatalog: vi.fn(),
  listSessions: vi.fn(),
  updateEnabledModels: vi.fn(),
  updateEnabledSkills: vi.fn(),
}));

const initialProviders = useSessionStore.getState().providers.available;
const sessionCache = new Map<string, string>();

function resetStore(): void {
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    workspace: null,
    drafts: {},
    attachments: {},
    providers: {
      active: ProviderType.MOCK,
      available: Object.fromEntries(
        Object.entries(initialProviders).map(([type, config]) => [type, { ...config }]),
      ) as typeof initialProviders,
    },
    skills: {},
  });
}

describe('useSessionStore remote behavior', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionCache.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => sessionCache.get(key) ?? null,
      setItem: (key: string, value: string) => sessionCache.set(key, value),
    });
    resetStore();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('creates and updates local sessions with real store actions', () => {
    useSessionStore.getState().createSession();
    const firstId = useSessionStore.getState().activeSessionId!;
    useSessionStore.getState().createSession('Second');
    const secondId = useSessionStore.getState().activeSessionId!;

    useSessionStore.getState().addMessage(firstId, { role: 'user', content: 'A'.repeat(60) });
    useSessionStore.getState().setActiveSession(firstId);

    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe(firstId);
    expect(state.sessions.find(session => session.id === firstId)).toMatchObject({
      title: 'A'.repeat(50),
      messages: [expect.objectContaining({ role: 'user', content: 'A'.repeat(60) })],
    });
    expect(state.sessions.find(session => session.id === secondId)?.title).toBe('Second');
  });

  it('creates a remote session and handles API failures', async () => {
    vi.mocked(createSession)
      .mockResolvedValueOnce({
        success: true,
        data: {
          version: 2,
          id: 'remote-1',
          title: 'Remote',
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({ success: false, error: 'offline' });

    await expect(useSessionStore.getState().createRemoteSession('Remote')).resolves.toBe('remote-1');
    expect(useSessionStore.getState()).toMatchObject({
      activeSessionId: 'remote-1',
      sessions: [expect.objectContaining({ id: 'remote-1', title: 'Remote', messages: [] })],
    });
    await expect(useSessionStore.getState().createRemoteSession('Failure')).resolves.toBeUndefined();
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  it('hydrates sessions, converts dates, and preserves a valid active session', async () => {
    useSessionStore.setState({ activeSessionId: 'remote-2' });
    vi.mocked(listSessions).mockResolvedValue({
      success: true,
      data: [
        {
          id: 'remote-1',
          title: 'First',
          messages: [],
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-02'),
        },
        {
          id: 'remote-2',
          title: 'Second',
          messages: [{
            id: 'message-1',
            role: 'assistant',
            content: 'Hello',
            timestamp: new Date('2024-01-03'),
          }],
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-03'),
        },
      ],
    });

    await useSessionStore.getState().hydrateSessions();

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe('remote-2');
    expect(state.sessions[1].createdAt).toBeInstanceOf(Date);
    expect(state.sessions[1].messages[0].timestamp).toBeInstanceOf(Date);
  });

  it('selects the first hydrated session and ignores failed hydration', async () => {
    vi.mocked(listSessions)
      .mockResolvedValueOnce({
        success: true,
        data: [{
          id: 'first',
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
      })
      .mockResolvedValueOnce({ success: false, error: 'offline' });

    await useSessionStore.getState().hydrateSessions();
    expect(useSessionStore.getState().activeSessionId).toBe('first');
    await useSessionStore.getState().hydrateSessions();
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  it('restores a bounded local draft from the v2 workspace cache', async () => {
    const workspace = { id: 'workspace-1', cwd: '/workspace', name: 'Workspace', trusted: true };
    const cachedAt = Date.now();
    sessionCache.set('ai-harness-session-view-v2:workspace-1', JSON.stringify({
      version: 2,
      workspaceId: workspace.id,
      cachedAt,
      activeSessionId: 'draft:restored',
      sessions: [],
      localDrafts: [{
        id: 'draft:restored', title: 'Restored draft', draft: true,
        workspaceId: workspace.id, cwd: workspace.cwd, messages: [],
        providerConfig: { type: 'mock', apiKey: 'must-not-survive' },
        createdAt: new Date(cachedAt).toISOString(), updatedAt: new Date(cachedAt).toISOString(),
      }],
      drafts: { 'draft:restored': 'Unsent text' },
      providerSelection: { active: 'openai', models: { openai: 'workspace-model' } },
      attachments: { 'draft:restored': [{
        id: 'image-1', name: 'pixel.png', mediaType: 'image/png', size: 1,
        url: 'data:image/png;base64,AA==',
      }] },
    }));
    useSessionStore.setState({ workspace });
    vi.mocked(listSessions).mockResolvedValue({ success: true, data: [] });

    await useSessionStore.getState().hydrateSessions();

    expect(useSessionStore.getState()).toMatchObject({
      activeSessionId: 'draft:restored',
      drafts: { 'draft:restored': 'Unsent text' },
      attachments: { 'draft:restored': [expect.objectContaining({ name: 'pixel.png' })] },
      providers: { active: ProviderType.OPENAI },
    });
    expect(useSessionStore.getState().providers.available[ProviderType.OPENAI].model).toBe('workspace-model');
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'draft:restored', draft: true, createdAt: expect.any(Date),
    });
    expect(useSessionStore.getState().sessions[0]?.providerConfig?.apiKey).toBeUndefined();
  });

  it('migrates a valid v1 remote snapshot and falls back safely when storage throws', async () => {
    const workspace = { id: 'workspace-legacy', cwd: '/legacy', name: 'Legacy', trusted: true };
    sessionCache.set('ai-harness-session-view-v1:workspace-legacy', JSON.stringify({
      version: 1, workspaceId: workspace.id, cachedAt: Date.now(), activeSessionId: 'cached-session',
      sessions: [{
        id: 'cached-session', title: 'Cached', messages: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    }));
    useSessionStore.setState({ workspace });
    vi.mocked(listSessions).mockResolvedValue({ success: false, error: 'offline' });
    await useSessionStore.getState().hydrateSessions();
    expect(useSessionStore.getState().activeSessionId).toBe('cached-session');

    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: vi.fn() });
    useSessionStore.setState({ sessions: [], activeSessionId: null });
    vi.mocked(listSessions).mockResolvedValue({ success: true, data: [] });
    await expect(useSessionStore.getState().hydrateSessions()).resolves.toBeUndefined();
    expect(useSessionStore.getState().sessions).toEqual([]);
  });

  it('hydrates configured providers and supports provider updates', async () => {
    vi.mocked(getProviders).mockResolvedValue({
      success: true,
      data: [
        { type: ProviderType.OPENAI, configured: true },
        { type: ProviderType.ANTHROPIC, configured: false },
        { type: 'unknown', configured: true },
      ],
    });

    await useSessionStore.getState().hydrateProviders();
    useSessionStore.getState().setProvider(ProviderType.OPENAI);
    useSessionStore.getState().updateApiKey(ProviderType.ANTHROPIC, 'new-key');

    const providers = useSessionStore.getState().providers;
    expect(providers.active).toBe(ProviderType.OPENAI);
    expect(providers.available[ProviderType.OPENAI].apiKey).toBe('configured');
    expect(providers.available[ProviderType.ANTHROPIC].apiKey).toBe('new-key');
  });

  it('hydrates the workspace model catalogue and persists model activation', async () => {
    const catalog: ModelCatalog = {
      updatedAt: '2026-10-01T00:00:00.000Z', enabledScope: 'default', enabledSource: 'built-in',
      providers: [{
        provider: 'mock', configured: true,
        models: [
          {
            key: 'mock:one', provider: 'mock', id: 'one', name: 'One', available: true, enabled: true,
            source: 'published', capabilities: { reasoning: false, imageInput: false, toolCalls: true },
          },
          {
            key: 'mock:two', provider: 'mock', id: 'two', name: 'Two', available: true, enabled: true,
            source: 'published', capabilities: { reasoning: true, imageInput: false, toolCalls: true },
          },
        ],
      }],
    };
    const updated: ModelCatalog = {
      ...catalog, enabledScope: 'project', enabledSource: 'workspace-models',
      providers: catalog.providers.map(provider => ({
        ...provider, models: provider.models.map(model => ({ ...model, enabled: model.key === 'mock:two' })),
      })),
    };
    useSessionStore.setState({ workspace: { id: 'workspace-models', cwd: '/models', name: 'Models', trusted: true } });
    vi.mocked(getModelCatalog).mockResolvedValue({ success: true, data: catalog });
    vi.mocked(updateEnabledModels).mockResolvedValue({ success: true, data: updated });

    await useSessionStore.getState().hydrateModelCatalog(true);
    await useSessionStore.getState().setModelEnabled('mock:one', false);

    expect(getModelCatalog).toHaveBeenCalledWith('workspace-models', true);
    expect(updateEnabledModels).toHaveBeenCalledWith(['mock:two'], 'workspace-models');
    expect(useSessionStore.getState().providers.catalog).toEqual(updated);
    expect(useSessionStore.getState().providers.catalogLoading).toBe(false);
  });

  it('hydrates skills and controls trusted autonomous model invocation', async () => {
    const catalog: SkillCatalog = {
      updatedAt: '2026-10-01T00:00:00.000Z', projectId: 'workspace-skills', cwd: '/skills',
      projectTrusted: true, enabledScope: 'default', enabledSource: 'skill metadata', errorCount: 0,
      skills: [
        {
          key: 'project:review:one', name: 'review', description: 'Review', scope: 'project',
          source: '.agents/skills', filePath: '.agents/skills/review/SKILL.md', trusted: true,
          defaultModelInvocable: true, modelInvocable: true,
        },
        {
          key: 'project:locked:two', name: 'locked', description: 'Locked', scope: 'project',
          source: '.agents/skills', filePath: '.agents/skills/locked/SKILL.md', trusted: false,
          defaultModelInvocable: true, modelInvocable: false,
        },
      ],
    };
    const updated: SkillCatalog = {
      ...catalog, enabledScope: 'project', enabledSource: 'workspace-skills',
      skills: catalog.skills.map(skill => ({ ...skill, modelInvocable: false })),
    };
    useSessionStore.setState({ workspace: {
      id: 'workspace-skills', cwd: '/skills', name: 'Skills', trusted: true,
    } });
    vi.mocked(getSkillCatalog).mockResolvedValue({ success: true, data: catalog });
    vi.mocked(updateEnabledSkills).mockResolvedValue({ success: true, data: updated });

    await useSessionStore.getState().hydrateSkillCatalog(true);
    await useSessionStore.getState().setSkillModelInvocable('project:review:one', false);
    await useSessionStore.getState().setSkillModelInvocable('project:locked:two', true);

    expect(getSkillCatalog).toHaveBeenCalledWith('/skills', 'workspace-skills', true);
    expect(updateEnabledSkills).toHaveBeenCalledWith([], '/skills', 'workspace-skills');
    expect(updateEnabledSkills).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().skills.catalog).toEqual(updated);

    vi.mocked(updateEnabledSkills).mockResolvedValueOnce({ success: false, error: 'Write failed' });
    await useSessionStore.getState().setSkillModelInvocable('project:review:one', true);
    expect(updateEnabledSkills).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().skills.catalog).toEqual(updated);
    expect(useSessionStore.getState().skills.error).toBe('Write failed');
  });

  it('applies model activation optimistically and restores it after a server failure', async () => {
    const catalog: ModelCatalog = {
      updatedAt: '2026-10-01T00:00:00.000Z', enabledScope: 'default', enabledSource: 'built-in',
      providers: [{
        provider: 'mock', configured: true,
        models: [{
          key: 'mock:one', provider: 'mock', id: 'one', name: 'One', available: true, enabled: true,
          source: 'published', capabilities: { reasoning: false, imageInput: false, toolCalls: true },
        }],
      }],
    };
    useSessionStore.setState(state => ({ providers: { ...state.providers, catalog } }));
    let rejectUpdate!: (result: { success: false; error: string }) => void;
    vi.mocked(updateEnabledModels).mockReturnValue(new Promise(resolve => { rejectUpdate = resolve; }));

    const update = useSessionStore.getState().setModelEnabled('mock:one', false);
    expect(useSessionStore.getState().providers.catalog?.providers[0]?.models[0]?.enabled).toBe(false);
    expect(useSessionStore.getState().providers.catalogLoading).toBe(true);
    rejectUpdate({ success: false, error: 'offline' });
    await update;

    expect(useSessionStore.getState().providers.catalog?.providers[0]?.models[0]?.enabled).toBe(true);
    expect(useSessionStore.getState().providers).toMatchObject({ catalogLoading: false, catalogError: 'offline' });
  });

  it('leaves providers unchanged when hydration fails', async () => {
    vi.mocked(getProviders).mockResolvedValue({ success: false, error: 'offline' });

    await useSessionStore.getState().hydrateProviders();

    expect(useSessionStore.getState().providers.active).toBe(ProviderType.MOCK);
    expect(useSessionStore.getState().providers.available[ProviderType.OPENAI].apiKey).toBeUndefined();
  });
});
