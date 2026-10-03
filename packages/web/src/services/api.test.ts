import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendSessionMessage,
  autoNameSession,
  checkPluginUpdates,
  cloneSession,
  compactSession,
  createSubagentProfile,
  createSession,
  deleteSession,
  forkSession,
  getAgentRun,
  getAppUpdateStatus,
  getChatTransport,
  getEffectiveConfiguration,
  getModelCatalog,
  getPluginCatalog,
  getProviders,
  getSession,
  getSessionMessages,
  getSessionTree,
  getSkillCatalog,
  getSubagentConfiguration,
  healthCheck,
  listSubagentRuns,
  listRunningAgentRuns,
  listSessions,
  mutatePlugin,
  reloadPluginResources,
  searchSessions,
  sendChat,
  setAuthToken,
  setChatTransport,
  setProviderApiKey,
  stopSubagentRun,
  streamAgentEvents,
  updateEnabledModels,
  updateEnabledSkills,
  updateSubagentSettings,
  streamChat,
  uploadFiles,
} from './api';

function sseResponse(chunks: string[], ok = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: ok ? 200 : 500 });
}

describe('Web API service', () => {
  afterEach(() => {
    setAuthToken('');
    vi.unstubAllGlobals();
  });

  it('parses sequenced detached-agent snapshots and replay events across fragmented SSE chunks', async () => {
    const event = {
      protocolVersion: 1,
      id: 'session-1:43',
      sequence: 43,
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'message.delta',
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { messageId: 'stream:run-1', content: 'hello' },
    };
    const response = sseResponse([
      'event: connection.ready\ndata: {"snapshot":{"sessionId":"session-1","lastSequence":42},',
      '"reset":true}\n\nid: session-1:43\nevent: message.delta\ndata: ',
      `${JSON.stringify(event)}\n\n`,
    ]);
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const records = [];
    for await (const record of streamAgentEvents('session-1', 42)) records.push(record);
    expect(records).toEqual([
      { type: 'connection.ready', snapshot: { sessionId: 'session-1', lastSequence: 42 }, reset: true },
      { type: 'event', event },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions/session-1/events?after=42', {
      headers: { Accept: 'text/event-stream' }, signal: undefined, credentials: 'same-origin',
    });
  });

  it('associates SSE event names with their data payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: message_start\ndata: {"provider":"mock"}\n\n',
      'event: text_delta\ndata: {"content":"Bon"}\n\n',
      'event: text_delta\ndata: {"content":"jour"}\n\n',
      'event: message_end\ndata: {"content":"Bonjour"}\n\n',
    ])));

    const events = [];
    for await (const event of streamChat('mock', [{ role: 'user', content: 'Salut' }])) {
      events.push(event);
    }

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'text_delta',
      'text_delta',
      'message_end',
    ]);
    expect(events[3].content).toBe('Bonjour');
  });

  it('handles SSE records split across network chunks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: text_',
      'delta\ndata: {"content":"chunk"}\n\n',
    ])));

    const events = [];
    for await (const event of streamChat('mock', [])) events.push(event);

    expect(events).toEqual([{ type: 'text_delta', content: 'chunk' }]);
  });

  it('parses the final SSE record even when the stream has no trailing newline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: message_end\r\ndata: {"content":"Terminé"}',
    ])));

    const events = [];
    for await (const event of streamChat('mock', [])) events.push(event);

    expect(events).toEqual([{ type: 'message_end', content: 'Terminé' }]);
  });

  it('yields an error event for HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Provider unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )));

    const events = [];
    for await (const event of streamChat('openai', [])) events.push(event);

    expect(events).toEqual([{ type: 'error', content: 'Provider unavailable' }]);
  });

  it('propagates cancellation to a manual compaction request', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = compactSession({ sessionId: 'session-1', provider: 'mock' }, controller.signal);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ success: false, error: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions/session-1/compact', expect.objectContaining({
      method: 'POST', signal: controller.signal,
    }));
  });

  it('loads application versions and explicitly requests a refreshed update check', async () => {
    const status = {
      webVersion: '0.1.0', agentVersion: '0.1.0', checkedAt: '2026-10-01T00:00:00.000Z',
      available: true, release: { version: '0.2.0', name: 'Release', url: 'https://example.test/release' },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAppUpdateStatus(true)).resolves.toEqual({ success: true, data: status });
    expect(fetchMock).toHaveBeenCalledWith('/api/app-update?refresh=true', { headers: {}, credentials: 'same-origin' });
  });

  it('loads effective scoped settings with project and session context', async () => {
    const configuration = {
      values: { thinking: 'high', toolPreset: 'read-only', autoCompaction: false },
      provenance: { thinking: { value: 'high', scope: 'project', source: 'workspace-1' } },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(configuration), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getEffectiveConfiguration('workspace-1', 'session-1')).resolves.toEqual({
      success: true, data: configuration,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/configuration/effective?projectId=workspace-1&sessionId=session-1',
      { headers: {}, credentials: 'same-origin' },
    );
  });

  it('loads, refreshes and updates the scoped model catalogue', async () => {
    const catalog = {
      updatedAt: '2026-10-01T00:00:00.000Z', enabledScope: 'project', enabledSource: 'workspace-1',
      providers: [{
        provider: 'mock', configured: true,
        models: [{
          key: 'mock:mock-model', provider: 'mock', id: 'mock-model', name: 'Mock model',
          available: true, enabled: true, source: 'published',
          capabilities: { reasoning: false, imageInput: false, toolCalls: true },
        }],
      }],
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelCatalog('workspace-1', true)).resolves.toEqual({ success: true, data: catalog });
    await expect(updateEnabledModels(['mock:mock-model'], 'workspace-1')).resolves.toEqual({ success: true, data: catalog });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/models?projectId=workspace-1&refresh=true', {
      headers: {}, credentials: 'same-origin',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/models/enabled', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ enabledModels: ['mock:mock-model'], projectId: 'workspace-1' }),
    }));
  });

  it('loads and updates workspace skill invocation settings without instruction bodies', async () => {
    const catalog = {
      updatedAt: '2026-10-01T00:00:00.000Z', projectId: 'workspace-1', cwd: '/workspace',
      projectTrusted: true, enabledScope: 'project', enabledSource: 'workspace-1', errorCount: 0,
      skills: [{
        key: 'project:review:key', name: 'review', description: 'Review code', scope: 'project',
        source: '.agents/skills', filePath: '.agents/skills/review/SKILL.md', trusted: true,
        defaultModelInvocable: true, modelInvocable: true,
      }],
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSkillCatalog('/workspace', 'workspace-1', true)).resolves.toEqual({ success: true, data: catalog });
    await expect(updateEnabledSkills(['project:review:key'], '/workspace', 'workspace-1'))
      .resolves.toEqual({ success: true, data: catalog });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1, '/api/skills?cwd=%2Fworkspace&projectId=workspace-1&refresh=true',
      { headers: {}, credentials: 'same-origin' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/skills/enabled', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ enabledSkills: ['project:review:key'], cwd: '/workspace', projectId: 'workspace-1' }),
    }));
    expect(JSON.stringify(catalog)).not.toContain('instructions');
  });

  it('loads and explicitly mutates, checks, and reloads the plugin catalogue', async () => {
    const catalog = {
      updatedAt: '2026-10-01T00:00:00.000Z', generation: 2, cwd: '/workspace', projectId: 'workspace-1',
      projectTrusted: true, projectResourcesLoaded: true, packages: [], standaloneExtensions: [],
      totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 }, diagnostics: [],
    };
    const update = {
      key: 'global:global:01234567890123456789', source: 'npm:demo', scope: 'global', displayName: 'demo',
      type: 'npm', state: 'update-available', installedVersion: '1.0.0', availableVersion: '2.0.0',
    };
    const reload = {
      reloadedAt: '2026-10-01T00:00:00.000Z', generation: 3,
      resourceCounts: catalog.totals, restartRequired: false, message: 'Reloaded.',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ updates: [update] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalog, reload }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPluginCatalog('/workspace', 'workspace-1', true)).resolves.toEqual({ success: true, data: catalog });
    await expect(mutatePlugin({
      action: 'install', source: 'npm:demo', scope: 'project', cwd: '/workspace', projectId: 'workspace-1',
    })).resolves.toEqual({ success: true, data: catalog });
    await expect(checkPluginUpdates({ cwd: '/workspace', projectId: 'workspace-1' }))
      .resolves.toEqual({ success: true, data: [update] });
    await expect(reloadPluginResources({ cwd: '/workspace', projectId: 'workspace-1' }))
      .resolves.toEqual({ success: true, data: { catalog, reload } });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1, '/api/plugins?cwd=%2Fworkspace&projectId=workspace-1&refresh=true',
      { headers: {}, credentials: 'same-origin' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/plugins', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        action: 'install', source: 'npm:demo', scope: 'project', cwd: '/workspace', projectId: 'workspace-1',
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/plugins/check', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/plugins/reload', expect.objectContaining({ method: 'POST' }));
  });

  it('loads sub-agent settings, creates profiles and controls child runs', async () => {
    const configuration = {
      updatedAt: '2026-10-01T00:00:00.000Z', cwd: '/workspace', projectId: 'workspace-1',
      scope: 'project', source: 'workspace-1', engineEnabled: true, maxConcurrency: 3, profiles: [],
    };
    const run = {
      id: 'subagent-1', parentSessionId: 'parent-1', childSessionId: 'child-1', workspaceId: 'workspace-1',
      profileId: 'explore', profileName: 'Explore', task: 'Inspect', provider: 'mock', status: 'running',
      phase: 'streaming', background: true, attention: false, turn: 1, maxTurns: 8,
      startedAt: '2026-10-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(configuration), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(configuration), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(configuration), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([run]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...run, status: 'stopped' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSubagentConfiguration('/workspace', 'workspace-1', 'project')).resolves.toEqual({ success: true, data: configuration });
    await expect(updateSubagentSettings({ maxConcurrency: 3 }, '/workspace', 'workspace-1'))
      .resolves.toEqual({ success: true, data: configuration });
    await expect(createSubagentProfile({
      name: 'Review', description: 'Review', instructions: 'Review.', kind: 'custom', enabled: true,
      tools: [], skills: [], extensions: [], maxTurns: 8, inheritContext: true, background: true,
    }, '/workspace', 'workspace-1')).resolves.toEqual({ success: true, data: configuration });
    await expect(listSubagentRuns('parent-1')).resolves.toEqual({ success: true, data: [run] });
    await expect(stopSubagentRun('subagent-1')).resolves.toEqual({
      success: true, data: { ...run, status: 'stopped' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/subagents/settings?cwd=%2Fworkspace&projectId=workspace-1&scope=project', {
      headers: {}, credentials: 'same-origin',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/subagents/runs?parentSessionId=parent-1', {
      headers: {}, credentials: 'same-origin',
    });
  });

  it('checks the public server health route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(healthCheck()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/health', { headers: {}, credentials: 'same-origin' });
  });

  it('lists and refreshes detached run snapshots and forwards search cancellation', async () => {
    const run = {
      id: 'run-1', sessionId: 'session-1', cwd: '/workspace', provider: 'mock', phase: 'streaming',
      steerQueue: [], followUpQueue: [], lastSequence: 3,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([run]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(run), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ query: 'needle', count: 0, results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(listRunningAgentRuns(controller.signal)).resolves.toMatchObject({ success: true, data: [run] });
    await expect(getAgentRun('run/1', controller.signal)).resolves.toMatchObject({ success: true, data: run });
    await expect(searchSessions('needle', '/workspace', controller.signal)).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/agent/running', expect.objectContaining({ signal: controller.signal }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/agent/runs/run%2F1', expect.objectContaining({ signal: controller.signal }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/sessions/search?q=needle&cwd=%2Fworkspace', expect.objectContaining({ signal: controller.signal }));
  });

  it('covers successful JSON API operations and authentication headers', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      id: 'session-1',
      content: 'response',
      success: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    setAuthToken(' secret-token ');

    const results = await Promise.all([
      sendChat('openai', [{ role: 'user', content: 'Hello' }]),
      listSessions(),
      createSession('New'),
      getSession('session-1'),
      getSessionMessages('session-1', { before: 'message/20', limit: 40 }),
      appendSessionMessage('session-1', { role: 'assistant', content: 'Done' }),
      autoNameSession('session-1', 'mock', 'mock-model'),
      deleteSession('session-1'),
      forkSession('session-1', { messageIndex: 0, title: 'Fork' }),
      cloneSession('session-1', 'Clone'),
      getSessionTree('branch/with spaces'),
      getProviders(),
      setProviderApiKey('openai', 'key', 'https://example.test/v1'),
    ]);

    expect(results.every(result => result.success)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/tree?branchId=branch%2Fwith%20spaces',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-token' } }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/session-1/messages?limit=40&before=message%2F20',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-token' } }),
    );
    expect(fetchMock.mock.calls.every(([, init]) => (
      (init as RequestInit | undefined)?.headers as Record<string, string> | undefined
    )?.Authorization === 'Bearer secret-token')).toBe(true);
  });

  it('normalizes failures from JSON API operations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const results = await Promise.all([
      sendChat('openai', []),
      listSessions(),
      createSession(),
      getSession('missing'),
      getSessionMessages('missing'),
      appendSessionMessage('missing', { role: 'user', content: 'test' }),
      autoNameSession('missing', 'mock'),
      deleteSession('missing'),
      forkSession('missing'),
      cloneSession('missing'),
      getSessionTree(),
      getProviders(),
      setProviderApiKey('openai', 'key'),
    ]);

    expect(results.every(result => !result.success && result.error === 'network down')).toBe(true);
    await expect(healthCheck()).resolves.toBe(false);
  });

  it('posts model title generation and surfaces branch cascade requirements', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'session/1', title: 'Generated title', updatedAt: '2024-01-01T00:00:00.000Z',
      }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Cascade confirmation required', code: 'CASCADE_CONFIRMATION_REQUIRED',
        descendants: [{ id: 'branch-1', title: 'Branch' }],
      }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(autoNameSession('session/1', 'mock', 'mock-model')).resolves.toMatchObject({
      success: true, data: { title: 'Generated title' },
    });
    await expect(deleteSession('session/1')).resolves.toMatchObject({
      success: false,
      data: { requiresCascade: true, descendants: [{ id: 'branch-1', title: 'Branch' }] },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/sessions/session%2F1/auto-name', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ provider: 'mock', model: 'mock-model' }),
    }));
  });

  it('reports preparation and real transport progress for file uploads', async () => {
    const requests: Array<{ body: string; headers: Record<string, string> }> = [];
    class MockXMLHttpRequest {
      status = 201;
      responseText = JSON.stringify({ files: ['progress.txt'], collision: 'reject' });
      readonly headers: Record<string, string> = {};
      private listeners = new Map<string, () => void>();
      readonly upload = {
        addEventListener: (type: string, listener: (event: ProgressEvent) => void) => {
          if (type === 'progress') this.uploadProgress = listener;
        },
      };
      private uploadProgress?: (event: ProgressEvent) => void;
      open(): void { /* Captured by send. */ }
      setRequestHeader(name: string, value: string): void { this.headers[name] = value; }
      addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
      send(body: string): void {
        requests.push({ body, headers: this.headers });
        this.uploadProgress?.({ loaded: body.length, total: body.length, lengthComputable: true } as ProgressEvent);
        this.listeners.get('load')?.();
      }
      abort(): void { this.listeners.get('abort')?.(); }
      withCredentials = false;
    }
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);
    setAuthToken('upload-token');
    const progress: string[] = [];
    const file = {
      name: 'progress.txt', size: 8,
      arrayBuffer: async () => new TextEncoder().encode('progress').buffer,
    } as File;

    const result = await uploadFiles('/workspace', '.', [file], {
      onProgress: value => progress.push(value.phase),
    });

    expect(result).toMatchObject({ success: true, data: { files: ['progress.txt'] } });
    expect(progress).toEqual(['preparing', 'preparing', 'uploading', 'complete']);
    expect(requests[0]?.headers.Authorization).toBe('Bearer upload-token');
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ cwd: '/workspace', path: '.', collision: 'reject' });
  });

  it('streams chat over WebSocket and persists the selected transport', async () => {
    const storage = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('location', { protocol: 'https:', host: 'chat.example.test' });

    class MockWebSocket {
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      onclose?: () => void;
      readonly sent: string[] = [];

      constructor(readonly url: string) {
        queueMicrotask(() => {
          this.onopen?.();
          this.onmessage?.({ data: 'event: text_delta\ndata: {"content":"Salut"}\n' });
          this.onmessage?.({ data: 'event: message_end\ndata: {"content":"Salut"}\n' });
          this.onclose?.();
        });
      }

      send(payload: string): void {
        this.sent.push(payload);
      }
    }
    vi.stubGlobal('WebSocket', MockWebSocket);
    setChatTransport('websocket');

    const events = [];
    for await (const event of streamChat('openai', [{ role: 'user', content: 'Bonjour' }])) {
      events.push(event);
    }

    expect(getChatTransport()).toBe('websocket');
    expect(storage.setItem).toHaveBeenCalledWith('ai-harness-transport', 'websocket');
    expect(events).toEqual([
      { type: 'text_delta', content: 'Salut' },
      { type: 'message_end', content: 'Salut' },
    ]);
    setChatTransport('sse');
  });
});
