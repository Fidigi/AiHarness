import { expect, test } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

test.describe('Sessions', () => {
  test('hydrate la liste et ouvre une conversation existante', async ({ page }) => {
    await installMockApi(page, {
      sessions: [
        mockSession('session-one', 'Première conversation', [
          { role: 'user', content: 'Question déjà enregistrée' },
          { role: 'assistant', content: 'Réponse déjà enregistrée' },
        ]),
        mockSession('session-two', 'Deuxième conversation'),
      ],
    });
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Première conversation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deuxième conversation' })).toBeVisible();
    await page.getByRole('button', { name: 'Première conversation' }).click();
    await expect(page).toHaveURL(/\/chat\/session-one/);
    await expect(page.locator('.message.user')).toContainText('Question déjà enregistrée');
    await expect(page.locator('.message.assistant')).toContainText('Réponse déjà enregistrée');
    await expect(page.getByPlaceholder(/Type your message/)).toBeEnabled();
  });

  test('préserve puis abandonne proprement un brouillon local sans appel réseau', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'New chat' }).click();

    await expect(page).toHaveURL(/\/chat\/draft/);
    const prompt = page.getByPlaceholder(/Type your message/);
    await prompt.fill('Brouillon conservé pendant la navigation');
    await page.locator('input[type=file][accept="image/*"]').setInputFiles({
      name: 'draft.svg', mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'),
    });
    await expect(page.getByRole('img', { name: 'draft.svg' })).toBeVisible();
    await expect(page.getByLabel('Select the model')).toHaveValue('');
    await expect(page.getByLabel('Select the model')).toHaveAttribute('placeholder', /mock-model/);
    await page.getByLabel('Tool preset').selectOption('read-only');

    const draftUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(draftUrl);
    await expect(prompt).toHaveValue('Brouillon conservé pendant la navigation');
    await expect(page.getByRole('img', { name: 'draft.svg' })).toBeVisible();
    await expect(page.getByLabel('Tool preset')).toHaveValue('read-only');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Untitled' }).click();
    await expect(prompt).toHaveValue('Brouillon conservé pendant la navigation');
    await expect(page.getByRole('img', { name: 'draft.svg' })).toBeVisible();
    expect(api.requests.some(request => request.method === 'POST' && request.path === '/api/sessions')).toBe(false);

    page.once('dialog', dialog => dialog.accept());
    const draftRow = page.locator('.session-row').filter({ hasText: 'Untitled' });
    await draftRow.hover();
    await draftRow.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'Untitled' })).toHaveCount(0);
    expect(api.requests.some(request => request.method === 'DELETE' && request.path.startsWith('/api/sessions/'))).toBe(false);
  });

  test('filtre, rafraîchit et fait défiler une longue liste de sessions du workspace', async ({ page }) => {
    const sessions = Array.from({ length: 140 }, (_, index) => mockSession(`listed-${index}`, `Conversation ${String(index + 1).padStart(3, '0')}`));
    const outside = mockSession('outside', 'Other workspace');
    outside.cwd = '/another-workspace';
    const api = await installMockApi(page, { sessions: [...sessions, outside] });
    await page.goto('/');

    await expect(page.locator('.session-row')).toHaveCount(140);
    await expect(page.getByRole('button', { name: 'Other workspace' })).toHaveCount(0);
    const navigation = page.getByRole('navigation', { name: 'Conversations' });
    await expect.poll(() => navigation.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const last = page.getByRole('button', { name: 'Conversation 140' });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    const activeSession = page.locator('.sidebar-nav li.active');
    await expect(activeSession).toHaveCount(1);
    await expect(activeSession).toContainText('Conversation 140');
    await expect(activeSession.locator('small')).toContainText('0 ·');

    const before = api.requests.filter(request => request.method === 'GET' && request.path === '/api/sessions').length;
    await page.locator('.session-search').getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => api.requests.filter(request => request.method === 'GET' && request.path === '/api/sessions').length).toBeGreaterThan(before);
  });

  test('signale les agents de fond, les échecs et l’activité non lue', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('background', 'Background run'), mockSession('foreground', 'Foreground chat')],
      holdAgentRun: true,
    });
    await page.goto('/chat/background');
    await page.getByPlaceholder(/Type your message/).fill('Continue in background');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => api.requests.some(request => request.method === 'POST' && request.path === '/api/agent/runs')).toBe(true);

    await page.getByRole('button', { name: 'Foreground chat' }).click();
    const backgroundRow = page.locator('.session-row').filter({ hasText: 'Background run' });
    await expect(backgroundRow.getByLabel('Agent running')).toBeVisible();
    api.setRunPhase('background', 'failed');
    await expect(backgroundRow.getByLabel('Needs attention')).toBeVisible({ timeout: 7_000 });
    await expect(backgroundRow.getByLabel('Unread activity')).toBeVisible();

    await backgroundRow.locator('.session-main').click();
    await expect(backgroundRow.getByLabel('Needs attention')).toHaveCount(0);
    await expect(backgroundRow.getByLabel('Unread activity')).toHaveCount(0);
  });

  test('génère, renomme puis supprime une conversation avec confirmation', async ({ page }) => {
    const managed = mockSession('managed', 'Ancien titre', [{ role: 'user', content: 'Name this conversation' }]);
    const api = await installMockApi(page, { sessions: [managed] });
    await page.goto('/');
    let row = page.locator('.session-row').filter({ hasText: 'Ancien titre' });
    await row.hover();
    await row.getByRole('button', { name: 'Generate title' }).click();
    await expect(page.getByRole('button', { name: 'Generated conversation title' })).toBeVisible();
    expect(api.requests.some(request => request.method === 'POST' && request.path === '/api/sessions/managed/auto-name')).toBe(true);

    row = page.locator('.session-row').filter({ hasText: 'Generated conversation title' });
    await row.hover();
    await row.getByRole('button', { name: 'Rename conversation' }).click();
    await page.getByRole('textbox', { name: 'Rename conversation' }).fill('Nouveau titre');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: 'Nouveau titre' })).toBeVisible();
    expect(api.requests.some(request => request.method === 'PATCH' && request.path === '/api/sessions/managed')).toBe(true);

    page.once('dialog', dialog => dialog.accept());
    const renamedRow = page.locator('.session-row').filter({ hasText: 'Nouveau titre' });
    await renamedRow.hover();
    await renamedRow.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'Nouveau titre' })).toHaveCount(0);
    expect(api.requests.some(request => request.method === 'DELETE' && request.path === '/api/sessions/managed')).toBe(true);
  });

  test('exige une confirmation distincte avant de supprimer les branches', async ({ page }) => {
    const parent = mockSession('branch-parent', 'Parent conversation');
    const child = mockSession('branch-child', 'Child branch');
    child.parentId = parent.id;
    child.branchId = parent.id;
    const grandchild = mockSession('branch-grandchild', 'Nested branch');
    grandchild.parentId = child.id;
    grandchild.branchId = parent.id;
    const api = await installMockApi(page, { sessions: [parent, child, grandchild] });
    const confirmations: string[] = [];
    page.on('dialog', async dialog => {
      confirmations.push(dialog.message());
      await dialog.accept();
    });
    await page.goto('/chat/branch-parent');

    const row = page.locator('.session-row').filter({ hasText: 'Parent conversation' });
    await row.hover();
    await row.getByRole('button', { name: 'Delete conversation' }).click();
    await expect(page.getByRole('button', { name: 'Parent conversation' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Child branch' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nested branch' })).toHaveCount(0);
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toContain('2 branch(es)');
    expect(api.requests.filter(request => request.method === 'DELETE' && request.path === '/api/sessions/branch-parent')).toHaveLength(2);
  });

  test('recherche le contenu exact côté serveur et navigue vers le message', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('searchable', 'Journal de travail', [
        { role: 'user', content: 'Une aiguille très précise' },
      ])],
    });
    await page.goto('/');
    await page.getByRole('searchbox', { name: 'Search conversations' }).fill('aiguille');
    const results = page.locator('.search-results');
    await expect(results).toContainText('Une aiguille très précise');
    await expect(results).toContainText('/workspace');
    await expect(results.locator('time')).toHaveAttribute('datetime', '2025-01-01T12:00:00.000Z');
    await results.locator('button').click();
    await expect(page).toHaveURL(/\/chat\/searchable.*#searchable-message-1$/);
    expect(api.requests.some(request => request.path === '/api/sessions/search')).toBe(true);
  });

  test('charge un historique long par fenêtres, rejoint une entrée exacte et préserve l’ancre', async ({ page }) => {
    const session = mockSession('long-history', 'Long history', Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `Historical message ${index + 1}`,
    })));
    const api = await installMockApi(page, { sessions: [session] });
    await page.goto('/chat/long-history#long-history-message-21');

    await expect(page.locator('#long-history-message-21')).toContainText('Historical message 21');
    await expect(page.locator('.messages-container[data-virtualized="true"]')).toBeVisible();
    expect(await page.locator('.message').count()).toBeLessThan(45);
    expect(api.requests.some(request => request.path === '/api/sessions/long-history/messages')).toBe(true);

    await page.getByRole('button', { name: 'Conversation map' }).first().click();
    const minimap = page.getByLabel('Conversation map');
    await expect(minimap).toContainText('160 of 400 loaded');
    await expect(minimap.getByRole('link', { name: 'Download full history' }))
      .toHaveAttribute('href', '/api/sessions/long-history/export?format=json');

    await minimap.locator('.minimap-entry').filter({ hasText: 'Historical message 321' }).click();
    await expect(page.locator('#long-history-message-321')).toBeVisible();
    await expect(page.getByText('Some messages are not loaded')).toBeVisible();
    const gapButton = page.getByRole('button', { name: 'Load omitted messages' });
    const anchorBefore = await page.locator('#long-history-message-321').evaluate(element => element.getBoundingClientRect().top);
    await gapButton.click();
    await expect(minimap).toContainText('240 of 400 loaded');
    expect(await page.locator('.message').count()).toBeLessThan(45);
    await expect.poll(async () => Math.abs(
      await page.locator('#long-history-message-321').evaluate(element => element.getBoundingClientRect().top) - anchorBefore,
    )).toBeLessThan(3);
  });

  test('restaure la dernière conversation et navigue précédent/suivant sans état fantôme', async ({ page }) => {
    await installMockApi(page, {
      sessions: [
        mockSession('navigation-one', 'Navigation one'),
        mockSession('navigation-two', 'Navigation two'),
        mockSession('navigation-three', 'Navigation three'),
      ],
    });
    await page.goto('/chat/navigation-two?cwd=%2Fworkspace');
    await expect(page.locator('.chat-toolbar strong')).toHaveText('Navigation two');
    await expect.poll(() => page.evaluate(() => Object.values(sessionStorage).some(value => value.includes('navigation-two')))).toBe(true);

    await page.goto('/?cwd=%2Fworkspace');
    await expect(page).toHaveURL(/\/chat\/navigation-two\?cwd=%2Fworkspace$/);
    await page.getByRole('button', { name: 'Previous conversation' }).click();
    await expect(page).toHaveURL(/\/chat\/navigation-one/);
    await expect(page.getByRole('button', { name: 'Previous conversation' })).toBeDisabled();
    await page.getByRole('button', { name: 'Next conversation' }).click();
    await page.getByRole('button', { name: 'Next conversation' }).click();
    await expect(page).toHaveURL(/\/chat\/navigation-three/);
    await expect(page.getByRole('button', { name: 'Next conversation' })).toBeDisabled();
  });

  test('restaure la position de lecture virtualisée après navigation et rechargement', async ({ page }) => {
    const longSession = mockSession('scroll-session', 'Scroll session', Array.from({ length: 180 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Scroll marker ${index}: ${'content '.repeat(14)}`,
    })));
    await installMockApi(page, { sessions: [longSession, mockSession('scroll-other', 'Other session')] });
    await page.goto('/chat/scroll-session?cwd=%2Fworkspace#scroll-session-message-50');
    const conversation = page.getByRole('log', { name: 'Conversation messages' });
    await expect(conversation).toHaveAttribute('data-virtualized', 'true');
    await conversation.evaluate(element => element.scrollTo({ top: element.scrollHeight * 0.38 }));
    await page.waitForTimeout(350);
    const anchor = await conversation.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const item = Array.from(element.querySelectorAll<HTMLElement>('article.message[id]'))
        .find(candidate => candidate.getBoundingClientRect().bottom >= top);
      return item ? { id: item.id, offset: item.getBoundingClientRect().top - top } : undefined;
    });
    expect(anchor).toBeTruthy();
    const savedScroll = () => page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(candidate => candidate.startsWith('ai-harness:scroll:v1:'));
      return key ? JSON.parse(sessionStorage.getItem(key) ?? '{}')['scroll-session'] as { anchorId?: string; top?: number } : undefined;
    });
    await expect.poll(savedScroll).toMatchObject({ anchorId: anchor!.id });

    await page.getByRole('button', { name: 'Next conversation' }).click();
    await expect(page).toHaveURL(/\/chat\/scroll-other/);
    await expect.poll(savedScroll).toMatchObject({ anchorId: anchor!.id });
    await page.getByRole('button', { name: 'Previous conversation' }).click();
    await expect(page).toHaveURL(/\/chat\/scroll-session/);
    const anchorDrift = () => conversation.evaluate((element, saved) => {
      const item = document.getElementById(saved.id);
      return item ? Math.abs(item.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset) : 10_000;
    }, anchor!);
    await expect.poll(anchorDrift).toBeLessThan(35);

    await page.waitForTimeout(350);
    await page.reload();
    await expect(conversation).toHaveAttribute('data-virtualized', 'true');
    await expect.poll(anchorDrift).toBeLessThan(35);
    const savedEntries = await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(candidate => candidate.startsWith('ai-harness:scroll:v1:'));
      return key ? Object.keys(JSON.parse(sessionStorage.getItem(key) ?? '{}')).length : 0;
    });
    expect(savedEntries).toBeGreaterThan(0);
    expect(savedEntries).toBeLessThanOrEqual(24);
  });

  test('retire un deep link supprimé du cache et propose une conversation valide', async ({ page }) => {
    const api = await installMockApi(page, { sessions: [mockSession('available', 'Available conversation')] });
    await page.goto('/chat/deleted?cwd=%2Fworkspace');

    const unavailable = page.getByRole('alert');
    await expect(unavailable.getByRole('heading', { name: 'Conversation unavailable' })).toBeVisible();
    const stateRequests = () => api.requests.filter(request => request.path === '/api/agent/sessions/deleted/state').length;
    await page.waitForTimeout(300);
    const settledRequestCount = stateRequests();
    expect(settledRequestCount).toBeGreaterThan(0);
    await page.waitForTimeout(1_200);
    expect(stateRequests()).toBe(settledRequestCount);
    await unavailable.getByRole('button', { name: 'Open an available conversation' }).click();
    await expect(page).toHaveURL(/\/chat\/available/);
    await expect(page.locator('.chat-toolbar strong')).toHaveText('Available conversation');
  });

  test('affiche les diagnostics complets de session et l’export', async ({ page }) => {
    const session = mockSession('diagnostics', 'Diagnostics', [
      { role: 'user', content: 'Analyse' },
      { role: 'assistant', content: 'Je lance un outil' },
      { role: 'tool', content: 'Résultat' },
    ]);
    session.messages[1]!.blocks = [{ type: 'tool_call', id: 'call-1', name: 'read', input: {} }];
    session.messages[2]!.blocks = [{ type: 'tool_result', toolCallId: 'call-1', content: 'Résultat' }];
    session.gitBranch = 'feature/info';
    session.model = 'mock-model';
    session.providerConfig = { type: 'mock', contextWindowTokens: 8_000 };
    session.usage = {
      inputTokens: 1_000, outputTokens: 250, cacheReadTokens: 500,
      cacheWriteTokens: 100, totalTokens: 2_000, costUsd: 0.012345,
    };
    await installMockApi(page, { sessions: [session] });
    await page.goto('/chat/diagnostics');
    await page.getByRole('button', { name: 'Information' }).click();

    const info = page.getByLabel('Information');
    await expect(info).toContainText('diagnostics.jsonl');
    await expect(info).toContainText('/workspace');
    await expect(info).toContainText('feature/info');
    await expect(info).toContainText('mock / mock-model');
    await expect(info).toContainText('1 / 1 calls / results');
    await expect(info).toContainText('2000 / 8000 (25.0%)');
    await expect(info).toContainText('500 / 100 · 50.0%');
    await expect(info.getByRole('link', { name: 'Download full history' })).toHaveAttribute('href', '/api/sessions/diagnostics/export?format=json');
  });

  test('crée une branche et une copie indépendante depuis un message utilisateur', async ({ page }) => {
    const api = await installMockApi(page, {
      sessions: [mockSession('source', 'Conversation source', [
        { role: 'user', content: 'Point de branchement' },
        { role: 'assistant', content: 'Réponse' },
      ])],
    });
    await page.goto('/chat/source');
    const userMessage = page.locator('.message.user');
    await userMessage.getByRole('button', { name: 'Edit from here' }).click();
    await expect(page).toHaveURL(/\/chat\/e2e-session-1/);
    await expect(page.getByPlaceholder(/Type your message/)).toHaveValue('Point de branchement');
    expect(api.requests.find(request => request.method === 'POST' && request.path === '/api/sessions/source/fork')?.body)
      .toMatchObject({ messageId: 'source-message-1' });

    await page.locator('.session-main').filter({
      has: page.locator('.session-title').filter({ hasText: /^Conversation source$/ }),
    }).click();
    await page.locator('.message.user').getByRole('button', { name: 'New chat from here' }).click();
    await expect(page).toHaveURL(/\/chat\/e2e-session-2/);
    const clone = api.sessions.find(session => session.id === 'e2e-session-2');
    expect(clone?.parentId).toBeUndefined();
    expect(api.requests.find(request => request.method === 'POST' && request.path === '/api/sessions/source/clone')?.body)
      .toMatchObject({ messageId: 'source-message-1' });
  });
});
