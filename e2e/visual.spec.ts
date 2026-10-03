import { expect, test } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

const scenarios = [
  { name: 'desktop-dark', width: 1440, height: 900, theme: 'dark' },
  { name: 'desktop-light', width: 1440, height: 900, theme: 'light' },
  { name: 'tablet-dark', width: 820, height: 1180, theme: 'dark' },
  { name: 'tablet-light', width: 820, height: 1180, theme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, theme: 'light' },
] as const;

test.describe('Régression visuelle confiance et PWA', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} reste dans la baseline AiHarness`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1,
          theme,
          contentWidth: 1000,
          fontSize: 16,
          reasoningOpen: false,
          sound: false,
          notifications: false,
          selectionActions: true,
        }));
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      }, { theme: scenario.theme });
      await installMockApi(page, { workspaceTrusted: false });

      await page.goto('/');
      if (scenario.width <= 959) {
        await page.getByRole('button', { name: 'Toggle navigation' }).click();
      }
      await page.getByRole('button', { name: /Project not trusted/i }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Trust this project?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Trust project' })).toBeFocused();
      await expect(page.getByText(/Offline.*server actions/i)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);

      await page.addStyleTag({ content: `
        *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
      ` });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`trust-pwa-${scenario.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle de l’authentification Web', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde la connexion lisible et centrée`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'authentication', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, { authRequired: true });

      await page.goto('/');
      await expect(page.getByRole('main').getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByLabel('Access token')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`authentication-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle des informations de session', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} affiche les métriques sans débordement`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
        }));
      }, { theme: scenario.theme });
      const session = mockSession('visual-info', 'Session diagnostics', [
        { role: 'user', content: 'Inspect the current workspace.' },
        { role: 'assistant', content: 'The workspace diagnostics are ready.' },
      ]);
      session.messages[1]!.blocks = [
        { type: 'text', text: session.messages[1]!.content },
        { type: 'tool_call', id: 'visual-tool', name: 'read', input: { path: 'README.md' } },
        { type: 'tool_result', toolCallId: 'visual-tool', content: 'done' },
      ];
      session.gitBranch = 'feature/visual';
      session.model = 'mock-model';
      session.providerConfig = { type: 'mock', contextWindowTokens: 8_000 };
      session.usage = {
        inputTokens: 1_000, outputTokens: 250, cacheReadTokens: 500,
        cacheWriteTokens: 100, totalTokens: 2_000, costUsd: 0.012345,
      };
      await installMockApi(page, { sessions: [session] });

      await page.goto('/chat/visual-info');
      const actions = scenario.width <= 959
        ? page.getByRole('navigation', { name: 'Conversation actions' })
        : page.locator('.chat-toolbar-actions');
      await actions.getByRole('button', { name: 'Information' }).click();
      await expect(page.getByLabel('Information')).toContainText('25.0%');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`session-info-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du cycle de vie des sessions', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde le titre automatique et les actions lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'appearance', keybindings: {},
        }));
      }, { theme: scenario.theme });
      const parent = mockSession('visual-lifecycle', 'Lifecycle parent', [{ role: 'user', content: 'Name this session.' }]);
      const child = mockSession('visual-lifecycle-child', 'Nested branch');
      child.parentId = parent.id;
      child.branchId = parent.id;
      await installMockApi(page, { sessions: [parent, child] });

      await page.goto('/chat/visual-lifecycle');
      if (scenario.width <= 959) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      let row = page.locator('.session-row').filter({ hasText: 'Lifecycle parent' });
      await row.hover();
      await row.getByRole('button', { name: 'Generate title' }).click();
      row = page.locator('.session-row').filter({ hasText: 'Generated conversation title' });
      await row.hover();
      await expect(row.getByRole('button', { name: 'Generate title' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Nested branch' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`session-lifecycle-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle des préférences d’apparence', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} conserve les contrôles et contrastes`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1, theme, contentWidth: 1200, fontSize: 18,
          reasoningOpen: true, sound: false, notifications: false, selectionActions: true,
        }));
      }, { theme: scenario.theme });
      await installMockApi(page);

      await page.goto('/settings');
      await page.addStyleTag({ content: '#plugins { display: none !important; }' });
      const appearance = page.getByRole('heading', { name: 'Appearance', exact: true }).locator('..');
      await appearance.scrollIntoViewIfNeeded();
      await expect(appearance.locator('select')).toHaveValue(scenario.theme);
      await expect(appearance.locator('input[type=range]').nth(0)).toHaveValue('1200');
      await expect(appearance.locator('input[type=range]').nth(1)).toHaveValue('18');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`preferences-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du catalogue de modèles', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde filtres, capacités et activation lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'model', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, {
        providers: [
          { type: 'mock', configured: true },
          { type: 'openai', configured: true },
          { type: 'anthropic', configured: false },
        ],
      });

      await page.goto('/settings#model');
      await page.addStyleTag({ content: '#skills, #plugins { display: none !important; }' });
      const section = page.getByRole('heading', { name: 'Model', exact: true }).locator('..');
      await section.getByText('Manage model catalogue').click();
      await section.getByLabel('Filter models or providers').fill('openai');
      await expect(section.locator('fieldset[data-provider="openai"]')).toContainText('GPT-4o (Recommended)');
      await section.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`model-catalog-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle des providers et modèles personnalisés', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde statuts, secrets masqués et métadonnées lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v3', JSON.stringify({
          version: 3, theme, contentWidth: 1000, fontSize: 16, reasoningOpen: false,
          sound: false, soundVolume: .25, soundEvents: { completion: true, attention: true },
          notifications: false, pushNotifications: false,
          notificationEvents: { completion: true, attention: true }, pushEvents: { completion: true, attention: true },
          selectionActions: true, filesOpen: true, sidebarVisible: true,
          lastSettingsSection: 'provider-lifecycle', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, {
        providers: [{ type: 'mock', configured: true }, { type: 'openai', configured: true }],
        providerAuthStatuses: [{
          type: 'openai', name: 'OpenAI', configured: true, connected: true, method: 'oauth',
          reconnectSupported: true, disconnectSupported: true,
          usage: { requests: 24, inputTokens: 12000, outputTokens: 2500, costUsd: 0.1432 },
        }],
        customProviders: [{
          id: 'acme', name: 'Acme Gateway', baseUrl: 'https://models.acme.test/v1', dialect: 'openai-completions',
          configured: true, headerNames: ['X-Tenant'], modelCount: 1, createdAt: '2025-01-01T12:00:00.000Z', updatedAt: '2025-01-01T12:00:00.000Z',
        }],
        customModels: [{
          key: 'acme:reasoner', provider: 'acme', id: 'reasoner', name: 'Acme Reasoner',
          capabilities: { reasoning: true, imageInput: true, toolCalls: true }, contextWindow: 128000, maxOutputTokens: 8192,
          pricing: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: .5 },
          compatibility: { supportsDeveloperRole: true }, createdAt: '2025-01-01T12:00:00.000Z', updatedAt: '2025-01-01T12:00:00.000Z',
        }],
      });

      await page.goto('/settings#provider-lifecycle');
      await page.addStyleTag({ content: '.settings-section:not(#provider-lifecycle):not(#custom-models) { display: none !important; }' });
      await page.getByText('Create or edit a compatible provider').click();
      await expect(page.getByText('Acme Gateway')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`provider-model-lifecycle-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du catalogue de skills', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde portées, sources et confiance lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'skills', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page);

      await page.goto('/settings#skills');
      await page.addStyleTag({ content: '#plugins { display: none !important; }' });
      const section = page.getByRole('heading', { name: 'Skills', exact: true }).locator('..');
      await expect(section.locator('fieldset[data-scope="project"]')).toContainText('review-project');
      await expect(section.locator('fieldset[data-scope="global"]')).toContainText('release-notes');
      await section.getByText('Browse Agent Skills registry').click();
      await expect(section.getByText('security-review')).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`skill-catalog-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du catalogue de plugins', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde sources, ressources et actions explicites lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'plugins', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page);

      await page.goto('/settings#plugins');
      const section = page.locator('#plugins');
      await expect(section.locator('fieldset[data-scope="project"]')).toContainText('workspace-kit');
      await expect(section.locator('fieldset[data-scope="global"]')).toContainText('@aiharness/review-kit');
      await expect(section.locator('fieldset[data-scope="standalone"]')).toContainText('global-status');
      await section.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`plugin-catalog-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle des profils de sous-agents', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde moteur, portées et permissions lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'subagents', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page);

      await page.goto('/settings#subagents');
      const section = page.getByRole('heading', { name: 'Sub-agents', exact: true }).locator('..');
      await expect(section.locator('.subagent-profile-card')).toHaveCount(3);
      await section.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`subagent-settings-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du suivi des agents enfants', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde progression et actions lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: false, sidebarVisible: false, lastSettingsSection: 'subagents', keybindings: {},
        }));
      }, { theme: scenario.theme });
      const parent = mockSession('visual-subagent-parent', 'Parallel review', [
        { role: 'user', content: 'Review the implementation in parallel.' },
        { role: 'assistant', content: 'I delegated exploration and test planning.' },
      ]);
      await installMockApi(page, {
        sessions: [parent],
        subagentRuns: [
          {
            id: 'visual-running', parentSessionId: parent.id, childSessionId: 'visual-running-child',
            workspaceId: 'workspace-e2e', profileId: 'general', profileName: 'General purpose', task: 'Run focused checks',
            provider: 'mock', model: 'mock-model', status: 'running', phase: 'tool', background: true,
            attention: false, turn: 3, maxTurns: 12, startedAt: '2025-01-01T12:00:02.000Z',
          },
          {
            id: 'visual-complete', parentSessionId: parent.id, childSessionId: 'visual-complete-child',
            workspaceId: 'workspace-e2e', profileId: 'explore', profileName: 'Explore', task: 'Map relevant source files',
            provider: 'mock', model: 'mock-model', status: 'completed', phase: 'completed', background: true,
            attention: false, turn: 2, maxTurns: 8, startedAt: '2025-01-01T12:00:00.000Z',
            completedAt: '2025-01-01T12:00:01.000Z', output: 'Mapped the relevant files.',
          },
        ],
      });

      await page.goto(`/chat/${parent.id}`);
      await page.getByRole('button', { name: 'Open child agents (2)' }).click();
      await expect(page.getByRole('complementary', { name: 'Child agents' })).toContainText('Run focused checks');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`subagent-panel-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle des historiques paginés', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde la mini-carte et les fenêtres lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
        }));
      }, { theme: scenario.theme });
      const session = mockSession('visual-history', 'Long paged conversation', Array.from({ length: 180 }, (_, index) => ({
        role: index % 2 ? 'assistant' as const : 'user' as const,
        content: `${index % 2 ? 'Response' : 'Question'} ${index + 1}: stable visual history entry`,
      })));
      await installMockApi(page, { sessions: [session] });

      await page.goto('/chat/visual-history');
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }' });
      await page.getByRole('button', { name: 'Load earlier messages' }).click();
      await expect(page.locator('.messages-container[data-virtualized="true"]')).toBeVisible();
      expect(await page.locator('.message').count()).toBeLessThan(45);
      const actions = scenario.width <= 959
        ? page.getByRole('navigation', { name: 'Conversation actions' })
        : page.locator('.chat-toolbar-actions');
      await actions.getByRole('button', { name: 'Conversation map' }).click();
      await expect(page.getByLabel('Conversation map')).toContainText('160 of 180 loaded');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`history-minimap-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle des métadonnées de message', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde modèle, usage et fichiers écrits lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
        }));
      }, { theme: scenario.theme });
      const session = mockSession('visual-message-meta', 'Message metadata', [
        { role: 'user', content: 'Create the generated module.' },
        { role: 'assistant', content: 'The generated module is ready.' },
      ]);
      session.providerConfig = { type: 'openai', model: 'mock-rich-model' };
      session.messages[1]!.model = 'mock-rich-model';
      session.messages[1]!.usage = {
        inputTokens: 1_000, outputTokens: 250, cacheReadTokens: 500,
        totalTokens: 1_250, costUsd: 0.0123,
      };
      session.messages[1]!.blocks = [
        { type: 'text', text: session.messages[1]!.content },
        { type: 'tool_call', id: 'visual-write', name: 'write_file', input: { path: 'src/generated.ts', content: 'export {};' } },
      ];
      await installMockApi(page, { sessions: [session], providers: [{ type: 'openai', configured: true }] });

      await page.goto('/chat/visual-message-meta');
      await page.locator('input[type=file][accept="image/*"]').setInputFiles({
        name: 'visual-attachment.svg', mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><rect width="80" height="50" fill="#6aa6ff"/></svg>'),
      });
      const imageWarning = page.getByRole('alert').filter({ hasText: 'may not support images' });
      await imageWarning.getByRole('button', { name: 'Close' }).click();
      await page.locator('.message.assistant .message-content p').first().evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        element.closest('.messages-container')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      await expect(page.getByRole('toolbar', { name: 'Selected text actions' })).toBeVisible();
      await expect(page.getByRole('img', { name: 'visual-attachment.svg' })).toBeVisible();
      const metadata = page.locator('.message.assistant .message-meta');
      await expect(metadata).toContainText('mock-rich-model');
      await expect(metadata).toContainText('$0.0123');
      await expect(page.getByRole('button', { name: 'src/generated.ts' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`message-metadata-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du processus et des interactions d’extension', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde processus, ANSI et formulaire déclaratif lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v3', JSON.stringify({
          version: 3, theme, contentWidth: 1000, fontSize: 16, reasoningOpen: true,
          sound: false, soundVolume: .25, soundEvents: { completion: true, attention: true },
          notifications: false, pushNotifications: false,
          notificationEvents: { completion: true, attention: true }, pushEvents: { completion: true, attention: true },
          selectionActions: true, filesOpen: true, sidebarVisible: true, lastSettingsSection: 'appearance', keybindings: {},
        }));
      }, { theme: scenario.theme });
      const session = mockSession('visual-extension', 'Extension approval');
      session.messages.push({
        id: 'visual-process', role: 'assistant', content: 'The checks are ready.', timestamp: '2025-01-01T12:00:00.000Z',
        provider: 'mock', model: 'tool-model', durationMs: 980,
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, costUsd: .001 },
        blocks: [
          { type: 'reasoning', text: 'Check the deployment constraints.' },
          { type: 'tool_call', id: 'visual-call', name: 'inspect', input: { target: 'staging' } },
          { type: 'tool_result', toolCallId: 'visual-call', name: 'inspect', content: '\u001b[32mAll checks passed\u001b[0m', isError: false },
          { type: 'text', text: 'The checks are ready.' },
        ],
      });
      await installMockApi(page, {
        sessions: [session], holdAgentRun: true,
        extensionWidgets: [{ name: 'Deployment status', placement: 'status', content: 'Waiting for approval', extensionId: 'visual-extension' }],
        extensionInteraction: {
          id: 'visual-interaction', kind: 'custom', title: 'Approve deployment', message: 'Review the validated target.',
          output: '\u001b[33mHuman approval required\u001b[0m', ansi: true, createdAt: '2025-01-01T12:00:00.000Z',
          fields: [
            { name: 'target', label: 'Target', type: 'select', required: true, options: [{ value: 'staging', label: 'Staging' }] },
            { name: 'note', label: 'Approval note', type: 'textarea', placeholder: 'Optional note' },
          ],
        },
      });

      await page.goto('/chat/visual-extension');
      await page.getByPlaceholder(/Type your message/).fill('Request deployment approval');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Approve deployment' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`extension-interaction-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle de l’explorer et du viewer', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde fichiers, Git et aperçu lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, {
        sessions: [mockSession('visual-files', 'Workspace files')],
        workspaceFiles: [{
          path: 'README.md', language: 'markdown', gitStatus: 'modified', additions: 3, deletions: 1,
          content: '---\ntitle: Visual fixture\n---\n# Workspace viewer\n\nSafe **Markdown** preview.',
          diff: '@@ -1 +1 @@\n-old\n+new',
        }],
      });

      await page.goto('/chat/visual-files');
      if (scenario.width <= 959) await page.getByRole('button', { name: 'Workspace explorer' }).click();
      const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
      await panel.locator('.file-name').filter({ hasText: 'README.md' }).click();
      await panel.getByRole('button', { name: 'Preview' }).click();
      await expect(panel.locator('.markdown-preview h1')).toHaveText('Workspace viewer');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`workspace-files-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du terminal PTY', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde les onglets xterm utilisables`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, { sessions: [mockSession('visual-terminal', 'Workspace terminal')] });

      await page.goto('/chat/visual-terminal');
      await page.getByRole('button', { name: 'Open workspace terminal' }).click();
      const terminal = page.getByRole('region', { name: 'Terminal' });
      await expect(terminal.locator('.xterm-screen')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`terminal-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle des versions et mises à jour', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde versions et notes de release lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'about', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, {
        appUpdate: {
          webVersion: '0.1.0', agentVersion: '0.1.0', available: true,
          release: {
            version: '0.2.0', name: 'AiHarness 0.2.0',
            url: 'https://github.com/Fidigi/AiHarness/releases/tag/v0.2.0',
            notes: 'Detached agents, safer workspaces, and interface refinements.',
          },
        },
      });

      await page.goto('/settings#about');
      await page.addStyleTag({ content: '#plugins { display: none !important; }' });
      const about = page.getByRole('heading', { name: 'About', exact: true }).locator('..');
      await about.scrollIntoViewIfNeeded();
      await about.getByText('Release notes').click();
      await expect(about).toContainText('Detached agents, safer workspaces');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`app-update-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle de la palette globale', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde recherche et focus lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, {
        sessions: [mockSession('visual-palette', 'Palette target')],
        workspaceFiles: [{ path: 'src/palette.ts', content: 'export {};', language: 'typescript' }],
      });

      await page.goto('/chat/visual-palette');
      await expect(page.getByPlaceholder(/Type your message/)).toBeVisible();
      await page.keyboard.press('Control+K');
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await expect(palette).toBeVisible();
      await expect(palette.locator('input')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`command-palette-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du pilotage et des commandes', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde les files et la commande lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v1', JSON.stringify({
          version: 1, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
        }));
      }, { theme: scenario.theme });
      const controlsSession = mockSession('visual-controls', 'Agent controls');
      delete controlsSession.model;
      delete controlsSession.thinking;
      delete controlsSession.toolPreset;
      delete controlsSession.autoCompaction;
      const api = await installMockApi(page, {
        sessions: [controlsSession],
        effectiveConfiguration: {
          values: { model: 'workspace-model', thinking: 'high', toolPreset: 'read-only', autoCompaction: false },
          provenance: {
            model: { value: 'workspace-model', scope: 'project', source: 'workspace-e2e' },
            thinking: { value: 'high', scope: 'project', source: 'workspace-e2e' },
            toolPreset: { value: 'read-only', scope: 'project', source: 'workspace-e2e' },
            autoCompaction: { value: false, scope: 'project', source: 'workspace-e2e' },
          },
        },
        holdAgentRun: true,
        holdCommands: true,
      });

      await page.goto('/chat/visual-controls');
      const input = page.getByPlaceholder(/Type your message/);
      await input.fill('Start the background task');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeVisible();
      await input.fill('Keep the response concise');
      await page.getByRole('button', { name: 'Queue', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Pending agent messages' })).toBeVisible();
      await input.fill('!!printf visual-command');
      await page.getByRole('button', { name: 'Queue', exact: true }).click();
      await expect(page.locator('.command-run')).toContainText('visual-command');
      api.setRunPhase('visual-controls', 'streaming', {
        retry: {
          attempt: 2, max: 3, delayMs: 1_000, message: 'Temporary provider overload',
          scheduledAt: '2026-10-01T12:00:00.000Z',
        },
      });
      await expect(page.locator('.retry-status')).toContainText('Temporary provider overload');
      await page.locator('input[type=file][accept="image/*"]').setInputFiles({
        name: 'warning.svg', mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'),
      });
      await expect(page.getByRole('alert').filter({ hasText: 'may not support images' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`agent-controls-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
    });
  }
});
