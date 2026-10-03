import { expect, test } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

function providerSection(page: import('@playwright/test').Page) {
  return page.getByRole('heading', { name: 'AI Provider' }).locator('..');
}

test.describe('Conversation detached agent', () => {
  test('crée la session au premier envoi, suit le flux SSE et restaure l’état final', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'New chat' }).click();

    const input = page.getByPlaceholder(/Type your message/);
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await input.fill('Hello from Playwright');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page).toHaveURL(/\/chat\/e2e-session-1/);
    await expect(page.locator('.message.user')).toContainText('Hello from Playwright');
    await expect(page.locator('.message.assistant')).toContainText('Mock response');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('');

    const start = api.requests.find(request => request.method === 'POST' && request.path === '/api/agent/runs');
    expect(start?.body).toMatchObject({
      cwd: '/workspace', provider: 'mock', input: 'Hello from Playwright',
      blocks: [{ type: 'text', text: 'Hello from Playwright' }],
      thinking: 'off', toolPreset: 'default',
    });
    expect(api.requests.some(request => request.path === '/api/agent/sessions/e2e-session-1/events')).toBe(true);
    expect(api.requests.some(request => request.path === '/api/chat/stream')).toBe(false);
  });

  test('utilise le fournisseur et les réglages choisis sans renvoyer tout l’historique', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('streamed-session', 'Conversation SSE', [
        { role: 'user', content: 'Message précédent' },
        { role: 'assistant', content: 'Contexte précédent' },
      ])],
      providers: [{ type: 'mock', configured: true }, { type: 'openai', configured: true }],
      stream: [
        { type: 'message_start' },
        { type: 'text_delta', content: 'Bon' },
        { type: 'text_delta', content: 'jour' },
        { type: 'message_end', content: 'Bonjour' },
      ],
    });
    await page.goto('/settings');
    await providerSection(page).locator('select').selectOption('openai');
    await page.getByRole('button', { name: 'Conversation SSE' }).click();
    const modelSaved = page.waitForResponse(response => response.request().method() === 'PATCH'
      && response.url().endsWith('/api/sessions/streamed-session'));
    await page.locator('input[list="model-suggestions"]').fill('gpt-4o');
    await modelSaved;
    await expect(page.locator('input[list="model-suggestions"]')).toHaveValue('gpt-4o');

    await page.getByPlaceholder(/Type your message/).fill('Nouveau message');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.message.assistant').last()).toContainText('Bonjour');

    const start = api.requests.find(request => request.method === 'POST' && request.path === '/api/agent/runs');
    expect(start?.body).toMatchObject({
      sessionId: 'streamed-session', provider: 'openai', input: 'Nouveau message', model: 'gpt-4o',
    });
    expect(start?.body).not.toHaveProperty('messages');
  });

  test('rend l’héritage explicite, persiste les surcharges puis restaure la portée projet', async ({ page }) => {
    const session = mockSession('scoped-session', 'Scoped settings');
    delete session.model;
    delete session.thinking;
    delete session.toolPreset;
    delete session.autoCompaction;
    const api = await installMockApi(page, {
      sessions: [session],
      effectiveConfiguration: {
        values: { model: 'project-model', thinking: 'high', toolPreset: 'read-only', autoCompaction: false },
        provenance: {
          model: { value: 'project-model', scope: 'project', source: 'workspace-e2e' },
          thinking: { value: 'high', scope: 'project', source: 'workspace-e2e' },
          toolPreset: { value: 'read-only', scope: 'project', source: 'workspace-e2e' },
          autoCompaction: { value: false, scope: 'project', source: 'workspace-e2e' },
        },
      },
    });
    await page.goto('/chat/scoped-session');

    const model = page.locator('input[list="model-suggestions"]');
    const thinking = page.getByLabel('Thinking level');
    const tools = page.getByLabel('Tool preset');
    const autoCompaction = page.getByLabel('Auto-compaction');
    const scopes = page.getByLabel('Effective conversation setting scopes');
    await expect(model).toHaveValue('');
    await expect(model).toHaveAttribute('placeholder', /project-model/);
    await expect(thinking).toHaveValue('auto');
    await expect(tools).toHaveValue('auto');
    await expect(autoCompaction).toHaveValue('auto');
    await expect(scopes).toContainText('Model: workspace');
    await expect(scopes).toContainText('Auto-compaction: workspace');

    await model.fill('session-model');
    await thinking.selectOption('max');
    await tools.selectOption('full');
    await autoCompaction.selectOption('true');
    await expect.poll(() => api.sessions[0]?.model).toBe('session-model');
    await expect.poll(() => api.sessions[0]?.thinking).toBe('max');
    await expect.poll(() => api.sessions[0]?.toolPreset).toBe('full');
    await expect.poll(() => api.sessions[0]?.autoCompaction).toBe(true);
    await page.reload();
    await expect(model).toHaveValue('session-model');
    await expect(thinking).toHaveValue('max');
    await expect(tools).toHaveValue('full');
    await expect(autoCompaction).toHaveValue('true');
    await expect(scopes).toContainText('Model: this conversation');

    await model.fill('');
    await thinking.selectOption('auto');
    await tools.selectOption('auto');
    await autoCompaction.selectOption('auto');
    await expect.poll(() => api.sessions[0]?.model).toBeUndefined();
    await expect.poll(() => api.sessions[0]?.thinking).toBeUndefined();
    await expect.poll(() => api.sessions[0]?.toolPreset).toBeUndefined();
    await expect.poll(() => api.sessions[0]?.autoCompaction).toBeUndefined();

    await page.getByPlaceholder(/Type your message/).fill('Use inherited settings');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toContainText('Mock response');
    const start = api.requests.find(request => request.method === 'POST' && request.path === '/api/agent/runs');
    expect(start?.body).toMatchObject({
      model: 'project-model', thinking: 'high', toolPreset: 'read-only', autoCompaction: false,
      settingOverrides: [],
    });
    const patches = api.requests.filter(request => request.method === 'PATCH' && request.path.endsWith('/scoped-session'));
    expect(patches.map(request => request.body)).toEqual(expect.arrayContaining([
      { model: null }, { thinking: null }, { toolPreset: null }, { autoCompaction: null },
    ]));
  });

  test('verrouille et signale les réglages imposés par l’environnement serveur', async ({ page }) => {
    const session = mockSession('locked-session', 'Locked settings');
    delete session.model;
    delete session.thinking;
    const api = await installMockApi(page, {
      sessions: [session],
      effectiveConfiguration: {
        values: { model: 'server-model', thinking: 'xhigh' },
        provenance: {
          model: { value: 'server-model', scope: 'environment', source: 'AI_HARNESS_MODEL' },
          thinking: { value: 'xhigh', scope: 'environment', source: 'AI_HARNESS_THINKING' },
        },
      },
    });
    await page.goto('/chat/locked-session');
    await expect(page.locator('input[list="model-suggestions"]')).toBeDisabled();
    await expect(page.getByLabel('Thinking level')).toBeDisabled();
    await expect(page.getByLabel('Effective conversation setting scopes'))
      .toContainText('server environment (locked)');
    expect(api.requests.filter(request => request.method === 'PATCH')).toHaveLength(0);
  });

  test('configure la compaction automatique par commande et restaure l’héritage', async ({ page }) => {
    const session = mockSession('auto-command-session', 'Auto compact command');
    delete session.autoCompaction;
    const api = await installMockApi(page, {
      sessions: [session],
      effectiveConfiguration: {
        values: { autoCompaction: false },
        provenance: { autoCompaction: { value: false, scope: 'project', source: 'workspace-e2e' } },
      },
    });
    await page.goto('/chat/auto-command-session');
    const input = page.getByPlaceholder(/Type your message/);
    await input.fill('/auto-compact');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Automatic compaction is Off.' })).toBeVisible();

    await input.fill('/auto-compact on');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByLabel('Auto-compaction')).toHaveValue('true');
    await expect.poll(() => api.sessions[0]?.autoCompaction).toBe(true);

    await input.fill('/auto-compact auto');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByLabel('Auto-compaction')).toHaveValue('auto');
    await expect.poll(() => api.sessions[0]?.autoCompaction).toBeUndefined();
    expect(api.requests.filter(request => request.method === 'PATCH' && request.path.endsWith('/auto-command-session'))
      .map(request => request.body)).toEqual([{ autoCompaction: true }, { autoCompaction: null }]);
  });

  test('resynchronise l’historique et les statistiques après une compaction automatique', async ({ page }) => {
    const session = mockSession('automatic-session', 'Automatic compaction', [
      { role: 'user', content: 'Old context that must disappear' },
      { role: 'assistant', content: 'Old answer one' },
      { role: 'user', content: 'Old question two' },
      { role: 'assistant', content: 'Recent answer to preserve' },
    ]);
    session.autoCompaction = true;
    await installMockApi(page, { sessions: [session], automaticCompaction: true });
    await page.goto('/chat/automatic-session');
    await expect(page.getByText('Old context that must disappear')).toBeVisible();
    await page.getByPlaceholder(/Type your message/).fill('Trigger automatic compaction');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByRole('status').filter({ hasText: '120 → 40 tokens (80 saved)' })).toBeVisible();
    await expect(page.getByText('Old context that must disappear')).toBeHidden();
    await expect(page.locator('.message.user')).toContainText('Trigger automatic compaction');
    await expect(page.locator('.message.assistant')).toContainText('Mock response');
  });

  test('affiche une erreur d’agent', async ({ page }) => {
    await installMockApi(page, {
      sessions: [mockSession('error-session', 'Conversation en erreur')],
      stream: [{ type: 'error', content: 'Provider unavailable' }],
    });
    await page.goto('/chat/error-session');
    await page.getByPlaceholder(/Type your message/).fill('Déclencher une erreur');
    await page.getByRole('button', { name: 'Send' }).click();
    const notice = page.getByRole('alert').filter({ hasText: 'Provider unavailable' });
    await expect(notice).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(notice).toBeVisible();
    await notice.hover();
    await notice.getByRole('button', { name: 'Close' }).click();
    await expect(notice).toBeHidden();
  });

  test('affiche retry et outil actifs puis adapte le bouton d’arrêt à la phase', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('phase-session', 'Agent phases')],
      holdAgentRun: true,
    });
    await page.goto('/chat/phase-session');
    await page.getByPlaceholder(/Type your message/).fill('Run a long task');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    api.setRunPhase('phase-session', 'streaming', {
      retry: {
        attempt: 1, max: 3, delayMs: 500, message: 'temporary provider outage',
        scheduledAt: '2026-10-01T12:00:00.000Z',
      },
    });
    const retry = page.locator('.retry-status');
    await expect(retry).toContainText('Retry 1 of 3');
    await expect(retry).toContainText('temporary provider outage');
    await expect(page.getByRole('button', { name: 'Stop model' })).toBeVisible();

    api.setRunPhase('phase-session', 'tool', {
      activeTool: {
        id: 'tool-1', name: 'write', input: { path: 'src/generated.ts' },
        startedAt: '2026-10-01T12:00:01.000Z',
      },
    });
    await expect(retry).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Running tool: write' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop tool' }).click();
    await expect.poll(() => api.requests.some(request => request.method === 'POST' && request.path.endsWith('/stop'))).toBe(true);
    await expect(page.getByRole('button', { name: 'Stop tool' })).toBeHidden();
  });

  test('annule une compaction en cours avec un libellé de phase explicite', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('compact-session', 'Compaction phase')], holdCompaction: true,
    });
    await page.goto('/chat/compact-session');
    await page.getByPlaceholder(/Type your message/).fill('/compact Preserve pending decisions');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const cancel = page.getByRole('button', { name: 'Cancel compaction' });
    await expect(cancel).toBeVisible();
    expect(api.requests.find(request => request.path.endsWith('/compact'))?.body)
      .toMatchObject({ instruction: 'Preserve pending decisions' });
    await cancel.click();
    api.releaseCompaction();
    await expect(page.getByRole('status').filter({ hasText: /compaction cancelled/i })).toBeVisible();
    await expect(cancel).toBeHidden();
  });

  test('resynchronise aussi l’historique après une compaction manuelle réussie', async ({ page }) => {
    const session = mockSession('manual-compact-session', 'Manual compaction', [
      { role: 'user', content: 'Ancient context removed by manual compaction' },
      { role: 'assistant', content: 'Ancient response' },
      { role: 'user', content: 'Recent question' },
      { role: 'assistant', content: 'Recent response' },
    ]);
    await installMockApi(page, { sessions: [session] });
    await page.goto('/chat/manual-compact-session');
    await page.getByPlaceholder(/Type your message/).fill('/compact Keep the latest decision');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '120 → 40 tokens (80 saved)' })).toBeVisible();
    await expect(page.getByText('Ancient context removed by manual compaction')).toBeHidden();
    await expect(page.getByText('Recent response')).toBeVisible();
  });

  test('conserve le brouillon en cas d’échec au démarrage', async ({ page }) => {
    const api = await installMockApi(page, { createSessionError: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'New chat' }).click();
    const draft = page.getByPlaceholder(/Type your message/);
    await draft.fill('Brouillon préservé');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(draft).toHaveValue('Brouillon préservé');
    await expect.poll(() => api.requests.some(request => request.path === '/api/agent/runs')).toBe(true);
  });

  test('affiche le prompt et les outils exacts puis les actualise avec le preset', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('capabilities-session', 'Capabilities')],
      capabilities: {
        systemPrompt: 'Respect the workspace instructions.',
        tools: [
          { name: 'read', description: 'Read a file', parameters: { type: 'object', required: ['path'] }, extensionId: 'builtin:workspace-tools' },
          { name: 'write', description: 'Write a file', parameters: { type: 'object', required: ['path', 'content'] }, extensionId: 'builtin:workspace-tools' },
        ],
      },
    });
    await page.goto('/chat/capabilities-session');
    await page.getByRole('button', { name: 'Context', exact: true }).click();
    const panel = page.locator('.capabilities-panel');
    await expect(panel).toContainText('Respect the workspace instructions.');
    await expect(panel).toContainText('2 active tools');
    await panel.getByText('read', { exact: true }).click();
    await expect(panel.getByText('Read a file')).toBeVisible();
    await expect(panel.locator('pre').last()).toContainText('required');

    await page.getByLabel('Tool preset').selectOption('chat-only');
    await expect(panel).toContainText('0 active tools');
    await page.getByLabel('Tool preset').selectOption('full');
    await expect(panel).toContainText('2 active tools');
    await expect.poll(() => api.requests.filter(request => request.path.endsWith('/capabilities')).length).toBeGreaterThanOrEqual(3);
  });

  test('exécute ! et !! hors du modèle avec sortie, code et politique de contexte', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('command-session', 'Commands')],
      commandOutput: 'command output',
    });
    await page.goto('/chat/command-session');
    const input = page.getByPlaceholder(/Type your message/);
    await input.fill('!!printf secret');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const command = page.locator('.command-run');
    await expect(command).toContainText('$ printf secret');
    await expect(command).toContainText('command output');
    await expect(command).toContainText('exit 0');
    await expect(command).toContainText('excluded from model context');

    await input.fill('!printf public');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(command).toContainText('$ printf public');
    await expect(command).toContainText('included in model context');
    const commandRequests = api.requests.filter(request => request.path === '/api/agent/commands');
    expect(commandRequests.map(request => request.body)).toEqual([
      expect.objectContaining({ command: 'printf secret', excludedFromContext: true }),
      expect.objectContaining({ command: 'printf public', excludedFromContext: false }),
    ]);
    expect(api.requests.filter(request => request.path === '/api/agent/runs')).toHaveLength(0);
  });

  test('annule une commande shell encore active', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('cancel-command-session', 'Cancel command')],
      holdCommands: true,
    });
    await page.goto('/chat/cancel-command-session');
    await page.getByPlaceholder(/Type your message/).fill('!sleep 30');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const command = page.locator('.command-run');
    await expect(command).toContainText('running');
    await command.getByRole('button', { name: 'Stop command' }).click();
    await expect(command).toContainText('cancelled');
    await expect.poll(() => api.requests.some(request => request.method === 'DELETE' && request.path.startsWith('/api/agent/commands/'))).toBe(true);
  });

  test('pilote un run actif avec les deux files, rappel et vidage', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('queue-session', 'Queues')],
      holdAgentRun: true,
    });
    await page.goto('/chat/queue-session');
    const input = page.getByPlaceholder(/Type your message/);
    await input.fill('Start a long task');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeVisible();

    await input.fill('Steer instruction');
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect.poll(() => api.requests.filter(request => request.method === 'POST' && request.path.endsWith('/queue')).length).toBe(1);
    const queues = page.getByRole('region', { name: 'Pending agent messages' });
    await expect(queues).toContainText('Steering: 1');

    await page.getByLabel('Queue mode').selectOption('follow-up');
    await input.fill('Follow-up instruction');
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(queues).toContainText('Follow-ups: 1');
    await page.reload();
    await expect(queues).toContainText('Steering: 1');
    await expect(queues).toContainText('Follow-ups: 1');
    await queues.getByRole('button', { name: 'Steer instruction' }).click();
    await expect(input).toHaveValue('Steer instruction');
    await queues.getByRole('button', { name: 'Clear queues' }).click();
    await expect(queues).toBeHidden();
    expect(api.requests.filter(request => request.method === 'POST' && request.path.endsWith('/queue')).map(request => request.body))
      .toEqual([
        expect.objectContaining({ kind: 'steer', content: 'Steer instruction' }),
        expect.objectContaining({ kind: 'follow-up', content: 'Follow-up instruction' }),
      ]);
  });

  test('joint une image, l’aperçoit, puis l’envoie comme bloc multimodal', async ({ page }) => {
    const api = await installMockApi(page, { sessions: [mockSession('image-session', 'Images')] });
    await page.goto('/chat/image-session');
    await page.locator('input[type=file][accept="image/*"]').setInputFiles({
      name: 'pixel.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
    });
    await expect(page.getByRole('img', { name: 'pixel.svg' })).toBeVisible();
    await expect(page.getByText('The selected mock model may not support images.')).toBeVisible();
    await page.getByPlaceholder(/Type your message/).fill('Analyse cette image');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.message.assistant')).toContainText('Mock response');

    const start = api.requests.find(request => request.method === 'POST' && request.path === '/api/agent/runs');
    expect(start?.body).toMatchObject({
      input: 'Analyse cette image',
      blocks: [
        { type: 'text', text: 'Analyse cette image' },
        { type: 'image', name: 'pixel.svg', mediaType: 'image/svg+xml', url: expect.stringMatching(/^data:image\/svg\+xml;base64,/) },
      ],
    });
  });

  test('accepte collage et glisser-déposer d’images, permet leur retrait et borne leur nombre', async ({ page }) => {
    await installMockApi(page, { sessions: [mockSession('image-input-session', 'Image inputs')] });
    await page.goto('/chat/image-input-session');
    const input = page.getByPlaceholder(/Type your message/);
    const form = page.locator('form.input-container');

    await input.evaluate(element => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect(page.getByRole('img', { name: 'pasted.png' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove pasted.png' }).click();
    await expect(page.getByRole('img', { name: 'pasted.png' })).toHaveCount(0);

    await form.evaluate(element => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'dropped.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.getByRole('img', { name: 'dropped.png' })).toBeVisible();

    await page.locator('input[type=file][accept="image/*"]').setInputFiles(Array.from({ length: 8 }, (_, index) => ({
      name: `extra-${index}.png`, mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]),
    })));
    await expect(page.getByText('You can attach up to 8 images.')).toBeVisible();
    await expect(page.locator('.attachment-previews figure')).toHaveCount(1);
  });

  test('préremplit la session courante ou un nouveau chat depuis le texte sélectionné', async ({ page }) => {
    await installMockApi(page, {
      sessions: [mockSession('selection-session', 'Selection actions', [
        { role: 'assistant', content: 'Important selected answer' },
      ])],
    });
    await page.goto('/chat/selection-session');
    const selectAnswer = async () => page.locator('.message.assistant .message-content').evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.closest('.messages-container')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    await selectAnswer();
    const actions = page.getByRole('toolbar', { name: 'Selected text actions' });
    await expect(actions).toBeVisible();
    await actions.getByRole('button', { name: 'Ask here' }).click();
    const input = page.getByPlaceholder(/Type your message/);
    await expect(input).toHaveValue('> Important selected answer\n\n');
    await input.fill('');

    await selectAnswer();
    await actions.getByRole('button', { name: 'New chat' }).click();
    await expect(page).toHaveURL(/\/chat\/draft/);
    await expect(input).toHaveValue('> Important selected answer\n\n');
  });

  test('propose les fichiers et dossiers avec @, navigation clavier et chemins cités', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('mention-session', 'Mentions')],
      indexedFiles: ['src/index.ts', 'docs/user guide.md'],
      indexedDirectories: ['src/', 'docs/'],
      fileIndexTruncated: true,
    });
    await page.goto('/chat/mention-session');
    const input = page.getByPlaceholder(/Type your message/);

    await input.fill('Consulte @guide');
    const palette = page.getByRole('listbox', { name: 'Workspace files and directories' });
    await expect(palette).toContainText('docs/user guide.md');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/files/index').length).toBeGreaterThanOrEqual(2);
    await input.press('Enter');
    await expect(input).toHaveValue('Consulte @"docs/user guide.md" ');

    await input.fill('@src');
    await palette.getByRole('option').first().click();
    await expect(input).toHaveValue('@src/ ');
  });

  test('regroupe raisonnement et outils avec métriques, ANSI et sortie complète', async ({ page }) => {
    const session = mockSession('process-session', 'Process details');
    session.messages.push({
      id: 'assistant-process', role: 'assistant', content: 'Deployment checked.', timestamp: '2025-01-01T12:00:01.000Z',
      provider: 'mock', model: 'tool-model', durationMs: 1250,
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125, costUsd: 0.00125 },
      blocks: [
        { type: 'reasoning', text: 'I will inspect the deployment.' },
        { type: 'tool_call', id: 'call-1', name: 'inspect', input: { target: 'staging' } },
        {
          type: 'tool_result', toolCallId: 'call-1', name: 'inspect', content: 'bounded output',
          fullContent: `\u001b[32m${'complete output '.repeat(700)}\u001b[0m`, truncated: true, isError: false,
        },
        { type: 'text', text: 'Deployment checked.' },
      ],
    });
    await installMockApi(page, { sessions: [session] });
    await page.goto('/chat/process-session');

    const process = page.getByLabel('Agent process');
    await expect(process).toContainText('3 process blocks');
    await expect(process).toContainText('mock/tool-model');
    await expect(process).toContainText('1.25s');
    await expect(process).toContainText('125 tokens');
    await expect(process).toContainText('$0.001250');
    const result = process.locator('details').filter({ hasText: 'Tool result: inspect' });
    await result.locator('summary').click();
    await expect(result.getByText('truncated')).toBeVisible();
    await expect(result.getByRole('button', { name: 'Show complete output' })).toBeVisible();
    await expect(result.getByRole('button', { name: 'Download' })).toBeVisible();
    await result.getByRole('button', { name: 'Show complete output' }).click();
    await expect(result).toContainText('complete output');
  });

  test('charge palette et widgets d’extension puis résout une interaction déclarative', async ({ page }) => {
    const session = mockSession('extension-session', 'Extension interaction');
    const api = await installMockApi(page, {
      sessions: [session], holdAgentRun: true,
      extensionWidgets: [{ name: 'Build status', placement: 'status', content: '<b>plain text only</b>', extensionId: 'e2e-extension' }],
      extensionInteraction: {
        id: 'interaction-e2e', kind: 'custom', title: 'Approve deployment', message: 'Choose a safe target.',
        output: '\u001b[31mValidation required\u001b[0m', ansi: true, createdAt: '2025-01-01T12:00:00.000Z',
        fields: [
          { name: 'target', label: 'Target', type: 'select', required: true, options: [{ value: 'staging', label: 'Staging' }] },
          { name: 'remember', label: 'Remember', type: 'checkbox' },
        ],
      },
    });
    await page.goto('/chat/extension-session');

    const panels = page.getByLabel('Extension panels');
    await expect(panels).toContainText('Build status');
    await expect(panels).toContainText('<b>plain text only</b>');
    await expect(panels.locator('b')).toHaveCount(0);

    const input = page.getByPlaceholder(/Type your message/);
    await input.fill('/');
    const palette = page.getByRole('listbox', { name: 'Commands, prompts, and skills' });
    await expect(palette).toContainText('review');
    await expect(palette).toContainText('release-notes');
    await expect(palette).toContainText('approve');

    await input.fill('Run deployment approval');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve deployment' });
    await expect(dialog).toContainText('Validation required');
    await dialog.getByLabel('Target').selectOption('staging');
    await dialog.getByLabel('Remember').check();
    await dialog.getByRole('button', { name: 'Submit' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => api.requests.filter(request => request.path.endsWith('/interactions/interaction-e2e')).at(-1)?.body)
      .toEqual({ cancelled: false, value: { target: 'staging', remember: true } });
  });

  test('préserve le scroll de lecture et permet de revenir en bas', async ({ page }) => {
    const messages = Array.from({ length: 70 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `Message ${index + 1} — ${'contenu '.repeat(12)}`,
    }));
    await installMockApi(page, { sessions: [mockSession('long-session', 'Long historique', messages)] });
    await page.goto('/chat/long-session');
    const container = page.locator('.messages-container');
    await expect.poll(() => container.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await container.evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    const backToBottom = page.getByRole('button', { name: /Back to bottom/ });
    await expect(backToBottom).toBeVisible();
    await page.getByPlaceholder(/Type your message/).fill('Nouveau message hors écran');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.locator('.message').count()).toBeGreaterThan(70);
    await expect(backToBottom).toContainText(/\([1-9]\d*\)/);
    await expect.poll(() => container.evaluate(element => element.scrollTop)).toBeLessThan(100);
    await backToBottom.click();
    await expect.poll(() => container.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 96)).toBe(true);
  });

  test('suit les agents enfants, signale leur attention et navigue parent/enfant', async ({ page }) => {
    const parent = mockSession('subagent-parent', 'Coordination');
    const child = mockSession('subagent-child', 'Explore: inspect sources', [
      { role: 'assistant', content: 'Inspection complete.' },
    ]);
    child.parentId = parent.id;
    child.metadata = { subagent: true, subagentRunId: 'child-run-complete', subagentProfileId: 'explore' };
    const api = await installMockApi(page, {
      sessions: [parent, child],
      subagentRuns: [
        {
          id: 'child-run-complete', parentSessionId: parent.id, childSessionId: child.id,
          workspaceId: 'workspace-e2e', profileId: 'explore', profileName: 'Explore', task: 'Inspect sources',
          provider: 'mock', model: 'mock-model', status: 'completed', phase: 'completed', background: true,
          attention: true, turn: 2, maxTurns: 8, startedAt: '2025-01-01T12:00:00.000Z',
          completedAt: '2025-01-01T12:00:03.000Z', output: 'Inspection complete.',
        },
        {
          id: 'child-run-active', parentSessionId: parent.id, childSessionId: 'subagent-running-child',
          workspaceId: 'workspace-e2e', profileId: 'general', profileName: 'General purpose', task: 'Run checks',
          provider: 'mock', model: 'mock-model', status: 'running', phase: 'tool', background: true,
          attention: false, turn: 3, maxTurns: 12, startedAt: '2025-01-01T12:00:04.000Z',
        },
      ],
    });
    await page.goto('/settings');
    await expect(page.getByText('Explore child agent completed.')).toBeVisible();
    await page.goto(`/chat/${parent.id}`);

    const toggle = page.getByRole('button', { name: 'Open child agents (2)' });
    await expect(toggle.locator('.subagent-toggle-count')).toHaveText('2');
    await expect(toggle.locator('b')).toHaveText('1');
    await toggle.click();
    const panel = page.getByRole('complementary', { name: 'Child agents' });
    await expect(panel).toContainText('Inspect sources');
    await expect(panel).toContainText('Turn 3/12 · tool');
    const active = panel.locator('.subagent-run').filter({ hasText: 'General purpose' });
    await active.getByRole('button', { name: 'Stop child agent' }).click();
    await expect(active).toHaveClass(/stopped/);
    await expect.poll(() => api.requests.filter(request => request.path === '/api/subagents/runs/child-run-active/stop').length).toBe(1);

    const complete = panel.locator('.subagent-run').filter({ hasText: 'Explore' });
    await complete.getByRole('button', { name: 'Open details' }).click();
    await expect(page).toHaveURL(/\/chat\/subagent-child/);
    await expect(page.getByRole('button', { name: 'Back to parent agent' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to parent agent' }).click();
    await expect(page).toHaveURL(/\/chat\/subagent-parent/);
  });

  test('rend Markdown, tableau, raisonnement, outils et HTML comme texte sûr', async ({ page }) => {
    const session = mockSession('formatted-session', 'Réponse formatée', [{
      role: 'assistant',
      content: '# Titre\n\nUtilisez `npm test` et $x^2$.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst safe = "<script>";\n```\n\n```mermaid\nflowchart TD\nA[Start] --> B[Done]\n```\n<script>alert(1)</script>',
    }]);
    session.messages[0]!.model = 'mock-rich-model';
    session.messages[0]!.usage = {
      inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 250, totalTokens: 1_500, costUsd: 0.0123,
    };
    session.messages[0]!.blocks = [
      { type: 'reasoning', text: 'Résumé du raisonnement' },
      { type: 'text', text: session.messages[0]!.content },
      { type: 'tool_call', id: 'tool-1', name: 'write', input: { path: 'src/generated.ts', content: 'export {};' } },
    ];
    await installMockApi(page, {
      sessions: [session],
      workspaceFiles: [{ path: 'src/generated.ts', content: 'export {};', language: 'typescript' }],
    });
    await page.goto('/chat/formatted-session');

    await expect(page.locator('.message-content h1')).toHaveText('Titre');
    await expect(page.locator('code.inline-code')).toHaveText('npm test');
    await expect(page.locator('table')).toContainText('2');
    await expect(page.locator('pre.code-block code')).toContainText('const safe = "<script>";');
    await expect(page.locator('pre.code-block .syntax-keyword').filter({ hasText: /^const$/ })).toHaveCount(1);
    await expect(page.locator('.katex')).toBeVisible();
    await expect(page.getByLabel('Mermaid diagram').locator('svg')).toBeVisible();
    await expect(page.getByLabel('Mermaid diagram')).toContainText('Start');
    const mermaid = page.locator('.mermaid-block');
    const zoom = mermaid.getByRole('button', { name: 'Zoom' });
    await zoom.click();
    await expect(page.getByRole('dialog', { name: 'Mermaid diagram' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(zoom).toBeFocused();
    const download = page.waitForEvent('download');
    await mermaid.getByRole('button', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe('diagram.svg');
    await expect(page.locator('.message-content script')).toHaveCount(0);
    await expect(page.locator('.message-content')).not.toContainText('alert(1)');
    await expect(page.locator('details.reasoning-block')).toContainText('Résumé du raisonnement');
    await expect(page.locator('details.tool-block')).toContainText('write');

    const message = page.locator('.message.assistant');
    await expect(message.locator('time')).toHaveAttribute('datetime', '2025-01-01T12:00:00.000Z');
    await expect(message.locator('.message-meta')).toContainText('mock-rich-model');
    await expect(message.locator('.message-meta')).toContainText(/1[,.\s]500 tokens · \$0\.0123/);
    await expect(message.locator('.message-meta span[title]')).toHaveAttribute('title', /1[,.\s]000 input.*500 output.*250 cache read/);
    await message.locator('.message-meta').getByRole('button', { name: 'Copy' }).click();
    await expect(message.locator('.message-meta').getByRole('button', { name: 'Assistant response copied.' })).toBeVisible();

    await message.getByRole('button', { name: 'src/generated.ts' }).click();
    await expect(page.getByRole('complementary', { name: 'Workspace explorer' })).toContainText('generated.ts');
  });
});
