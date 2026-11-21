import { expect, test, type Locator } from './fixtures/test-budget';
import { expectContrast, expectThemeRoles } from './fixtures/contrast';

// Relative conversation ages must not move every day in visual baselines.
// Freeze Date only: browser timers, animations and network ordering stay real.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00.000Z'));
});
import { installMockApi, mockSession } from './fixtures/mock-api';
import { mcpImportPreviewFixture, mcpStateInventory } from './fixtures/mcp';
import { selectMcpServer } from './fixtures/mcp-navigation';
import { selectCatalogueModel, selectCustomModel, selectModelSettings, selectProviderConnection, selectRegistryEntry } from './fixtures/settings-navigation';

const scenarios = [
  { name: 'desktop-dark', width: 1440, height: 900, theme: 'dark' },
  { name: 'desktop-light', width: 1440, height: 900, theme: 'light' },
  { name: 'tablet-dark', width: 820, height: 1180, theme: 'dark' },
  { name: 'tablet-light', width: 820, height: 1180, theme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, theme: 'light' },
] as const;

const mcpScenarios = scenarios.filter(scenario => scenario.name.startsWith('desktop') || scenario.name.startsWith('mobile'));

async function alignSettingsSection(section: Locator): Promise<void> {
  // Native section position inside the modal, clamped to its actual scroll extent.
  const targetScroll = await section.evaluate(element => {
    const root = element.closest('.settings-view')!;
    const top = root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top;
    const target = Math.min(top, root.scrollHeight - root.clientHeight);
    element.scrollIntoView({ block: 'start', behavior: 'instant' });
    return target;
  });
  await expect.poll(() => section.evaluate((element, top) => Math.abs(element.closest('.settings-view')!.scrollTop - top), targetScroll)).toBeLessThan(1);
}

for (const theme of ['light', 'dark', 'mist', 'rose', 'pine', 'system-light', 'system-dark']) {
  test(`shared semantic surfaces: ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme.endsWith('dark') ? 'dark' : 'light' });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme: theme.startsWith('system-') ? 'system' : theme, filesOpen: false,
    })), theme);
    const session = mockSession('theme-shell', 'Theme shell', [
      { role: 'user', content: 'Inspect the workspace.' },
      { role: 'assistant', content: 'Readable content\n\n```ts\nconst label = "hello"; // readable comment\nconst count = 42;\n```' },
    ]);
    session.cacheNotices = [{ id: 'theme-cache-warm', afterEntryId: session.messages[1]!.id, kind: 'cache_warm', costUsd: 0.001 }];
    session.messages[1]!.blocks = [
      { type: 'text', text: session.messages[1]!.content },
      { type: 'tool_call', id: 'theme-output', name: 'bash', input: { command: 'printf synthetic-output' } },
      { type: 'tool_result', toolCallId: 'theme-output', name: 'bash', isError: false,
        content: [...Array.from({ length: 8 }, (_, index) => 30 + index), ...Array.from({ length: 8 }, (_, index) => 90 + index)]
          .map(code => `\u001b[${code}mColor ${code}\u001b[0m`).join(' ') },
    ];
    await installMockApi(page, { sessions: [session], workspaceFiles: [{ path: 'README.md', content: '# Workspace', language: 'markdown' }] });
    const expectRoles = (selector: string, surface: string | null, text = '--text-primary') =>
      expectThemeRoles(page.locator(selector), surface, text);
    await page.goto('/chat/theme-shell');
    await expect(page.locator('.message.assistant')).toContainText('Readable content');
    // Chat syntax must be themed before the lazy explorer has ever opened.
    await expect(page.locator('.workspace-panel')).toHaveCount(0);
    await expectRoles('body, .main-content', '--surface-canvas');
    await expectRoles('.sidebar, .chat-toolbar, .input-container', '--surface-panel');
    await expectRoles('.input-container textarea, .composer-controls select', '--surface-input');
    await expectRoles('.message.assistant .message-content', '--surface-panel');
    await expect(page.locator('.cache-notice')).toHaveCount(1);
    await expect(page.locator('.cache-notice')).toBeInViewport({ ratio: 1 });
    await expectContrast(page.locator('.cache-notice'));
    await expectRoles('.cache-notice', '--surface-danger');
    await expectRoles('.code-container', '--surface-input');
    const output = page.locator('.tool-block').last();
    if (await output.getAttribute('open') === null) await output.locator('summary').click();
    await expect(output.locator('[class^="ansi-"]')).toHaveCount(16);
    await expectContrast(output.locator('[class^="ansi-"]'));
    await expectContrast(page.locator('.message-role, .message-meta, .chat-toolbar small, .composer-setting-scopes'));
    await expectContrast(page.locator('.code-container .syntax-string, .code-container .syntax-comment, .code-container .syntax-number, .code-container .syntax-keyword'));
    for (const token of ['string', 'comment', 'number', 'keyword']) {
      await expectRoles(`.code-container .syntax-${token}`, null, `--syntax-${token}`);
    }
    await expect(page).toHaveScreenshot(`theme-shell-${theme}.png`, { maxDiffPixelRatio: 0.02 });
    await page.keyboard.press('Control+k');
    const activeCommand = page.locator('.global-command-palette-results button.active');
    await expect(activeCommand).toHaveCSS('box-shadow', /inset/);
    await expectContrast(activeCommand);
    await expectContrast(activeCommand, 'boxShadow', 3);
    await page.keyboard.press('Escape');
    await expect(page.locator('.global-command-palette')).toHaveCount(0);
    await page.goto('/settings#appearance');
    await expect(page.locator('#appearance')).toBeVisible();
    await expectRoles('#appearance', '--surface-panel');
    await expectRoles('#appearance select', '--surface-input');
    await expectContrast(page.locator('#appearance label, #appearance legend, #appearance .settings-help'));
    await expectContrast(page.locator('#appearance select'), 'borderTopColor', 3);
    await expectContrast(page.locator('#appearance input[type=range]'), 'accentColor', 3);
    await expect(page).toHaveScreenshot(`theme-settings-${theme}.png`, { maxDiffPixelRatio: 0.02 });
  });
}

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

test.describe('Régression visuelle du sélecteur de workspace', () => {
  for (const scenario of mcpScenarios) {
    test(`${scenario.name} garde la création bornée et le gestionnaire hôte lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
          version: 4, theme, sendMode: 'enter', contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'appearance', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, {
        fileManagerAvailable: true,
        workspaceBrowse: {
          '/workspace': {
            cwd: '/workspace',
            truncated: true,
            entries: [
              { name: 'docs', path: '/workspace/docs', isDirectory: true, isSymbolicLink: false },
              { name: 'packages', path: '/workspace/packages', isDirectory: true, isSymbolicLink: false },
              { name: 'README.md', path: '/workspace/README.md', isDirectory: false, isSymbolicLink: false },
            ],
          },
        },
      });

      await page.goto('/');
      if (scenario.width <= 959) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.locator('.workspace-button').click();
      const picker = page.getByRole('dialog', { name: 'Choose a workspace' });
      await picker.getByRole('button', { name: 'New folder' }).click();
      const createDialog = page.getByRole('dialog', { name: 'Create a folder' });
      await createDialog.getByLabel('Folder name').fill('release-notes');
      await expect(createDialog.getByRole('button', { name: 'Create folder' })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`workspace-picker-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
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
      await expect(page.getByRole('link', { name: 'Nested branch' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Nested branch' })).toHaveAttribute('href', '/chat/visual-lifecycle-child?cwd=%2Fworkspace');
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
      await expect(appearance.getByLabel(/^Theme/u)).toHaveValue(scenario.theme);
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
      await expect(page.locator('#providers')).toBeHidden();
      await expect(page.locator('#custom-models')).toBeHidden();
      const section = page.getByRole('heading', { name: 'Model', exact: true }).locator('..');
      await expect(page.locator('#defaults')).toBeHidden();
      await section.getByText('Manage model catalogue').click();
      await section.getByLabel('Filter models or providers').fill('openai');
      await selectCatalogueModel(page, 'OpenAI', 'gpt-4o');
      const detail = section.locator('[data-settings-selection="openai:gpt-4o"]');
      await expect(detail).toBeVisible();
      await expect(detail).toContainText('GPT-4o (Recommended)');
      await expect(detail.getByRole('checkbox')).toBeChecked();
      await section.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await alignSettingsSection(section);
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
      const api = await installMockApi(page, {
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
      await expect(page.locator('#providers')).toBeHidden();
      await expect(page.locator('#custom-models')).toBeHidden();
      // Retain the original usage/actions evidence when details are no longer simultaneous.
      await selectProviderConnection(page, 'builtin', 'openai');
      const builtin = page.locator('.provider-context-detail').getByRole('article');
      await expect(builtin).toContainText('24 requests · 14500 tokens · $0.1432');
      for (const name of ['Reconnect', 'Test connection', 'Disconnect']) await expect(builtin.getByRole('button', { name, exact: true })).toBeVisible();
      const builtinCapture = test.info().outputPath(`provider-connection-builtin-${scenario.name}.png`);
      await page.screenshot({ path: builtinCapture, animations: 'disabled', caret: 'hide' });
      await test.info().attach('provider-connection-builtin', { path: builtinCapture, contentType: 'image/png' });
      await selectProviderConnection(page, 'custom', 'acme');
      await page.getByText('Create or edit a compatible provider').click();
      await expect(page.locator('.provider-context-detail').getByText('Acme Gateway', { exact: true })).toBeVisible();
      const fields = page.locator('#provider-lifecycle .custom-resource-editor input, #provider-lifecycle .custom-resource-editor textarea');
      expect(await fields.count()).toBeGreaterThan(0);
      for (const field of await fields.all()) {
        await expect(field).toHaveCSS('border-top-style', 'solid');
        await expect(field).toHaveCSS('border-top-width', '1px');
      }
      await expectContrast(fields);
      await expectContrast(fields, 'borderTopColor', 3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      expect(api.requests.filter(request => request.method !== 'GET'
        && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`provider-model-lifecycle-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
      await selectCustomModel(page, 'acme:reasoner');
      await expect(page.locator('#provider-lifecycle')).toBeHidden();
      await expect(page.locator('.custom-model-context-detail').getByText('Acme Reasoner', { exact: true })).toBeVisible();
      expect(api.requests.filter(request => request.method !== 'GET'
        && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
      await expect(page).toHaveScreenshot(`custom-models-${scenario.name}.png`, {
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
      const api = await installMockApi(page);

      await page.goto('/settings#skills');
      await page.addStyleTag({ content: '#plugins { display: none !important; }' });
      const section = page.getByRole('heading', { name: 'Skills', exact: true }).locator('..');
      const navigation = section.getByRole('navigation', { name: 'Skills', exact: true });
      await expect(navigation.locator('[data-scope="project"]').getByRole('button', { name: 'review-project', exact: true })).toBeVisible();
      await expect(navigation.locator('[data-scope="global"]').getByRole('button', { name: 'release-notes', exact: true })).toBeVisible();
      await selectRegistryEntry(page, 'security-review');
      await expect(section.locator('.skill-registry-context-detail').getByText('security-review', { exact: true })).toBeVisible();
      expect(api.requests.filter(request => request.method !== 'GET'
        && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
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

test.describe('Régression visuelle de l’inventaire MCP', () => {
  for (const scenario of mcpScenarios) {
    test(`${scenario.name} garde états, expurgation et diagnostics lisibles`, async ({ page }) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'mcp', keybindings: {},
        }));
      }, { theme: scenario.theme });
      await installMockApi(page, {
        mcpConfig: mcpStateInventory(),
        mcpImportPreview: mcpImportPreviewFixture(),
      });

      await page.goto('/settings#mcp');
      // Expanded inventory artifact, not native viewport geometry (owned by Settings navigation).
      await page.addStyleTag({ content: `
        html, body, .settings-backdrop, .settings-dialog, .settings-layout, .settings-view {
          height: auto !important;
          max-height: none !important;
          overflow: visible !important;
        }
        .settings-backdrop { position: static !important; }
        .app { display: none !important; }
      ` });
      const section = page.locator('#mcp');
      await section.getByText('Paste and preview a server').click();
      await section.getByLabel('MCP server text').fill('https://docs.example.test/mcp');
      await section.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(section.getByRole('article', { name: 'docs-import' })).toBeVisible();
      await selectMcpServer(page, 'global', 'remote-docs');
      const testedServer = section.getByRole('article', { name: 'remote-docs: Configured', exact: true });
      await expect(testedServer).toBeVisible();
      await testedServer.getByRole('button', { name: 'Test remote-docs', exact: true }).click();
      await expect(testedServer.getByRole('region', { name: 'Last connection test for remote-docs' })).toContainText('Connected');
      await selectMcpServer(page, 'global', 'local-tools');
      await expect(section.getByRole('article', { name: 'local-tools: Disabled', exact: true })).toBeVisible();
      await selectMcpServer(page, 'global', 'shared');
      await expect(section.getByRole('article', { name: 'shared: Replaced by project', exact: true })).toBeVisible();
      await selectMcpServer(page, 'global', 'bad\\u202ename');
      await expect(section.getByRole('article', { name: 'bad\\u202ename: Invalid', exact: true })).toBeVisible();
      await selectMcpServer(page, 'global', 'remote-docs');
      await expect(testedServer.getByRole('region', { name: 'Last connection test for remote-docs' })).toContainText('Connected');
      if (scenario.width < 960) await section.getByRole('button', { name: 'Back to MCP servers', exact: true }).click();
      await section.getByText('Configuration file diagnostics').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`mcp-inventory-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', fullPage: true, maxDiffPixelRatio: 0.02,
      });
    });
  }
});

test.describe('Régression visuelle du catalogue de plugins', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde sources, ressources et actions explicites lisibles`, async ({ page }) => {
      const locale = scenario.theme === 'dark' ? 'fr' : 'en';
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme, locale }) => {
        localStorage.setItem('ai-harness-locale', locale);
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'plugins', keybindings: {},
        }));
      }, { theme: scenario.theme, locale });
      const api = await installMockApi(page);

      await page.goto('/settings#plugins');
      const section = page.locator('#plugins');
      await expect(section.locator('fieldset[data-scope="project"]')).toContainText('workspace-kit');
      await expect(section.locator('fieldset[data-scope="global"]')).toContainText('@aiharness/review-kit');
      await expect(section.locator('fieldset[data-scope="standalone"]')).toContainText('global-status');
      const navigation = section.getByRole('navigation', {
        name: locale === 'fr' ? 'Plugins et packages' : 'Plugins and packages', exact: true, includeHidden: true,
      });
      await expect(navigation).toBeVisible();
      const global = navigation.getByRole('group', { name: locale === 'fr' ? 'Globale' : 'Global', exact: true, includeHidden: true });
      const choice = global.getByRole('button', { name: '@aiharness/review-kit', exact: true, includeHidden: true });
      expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await choice.focus();
      await expect(choice).toHaveCSS('outline-style', 'solid');
      await expectContrast(choice, 'outlineColor', 3);
      await choice.press('Enter');
      const detail = section.getByRole('article', { name: '@aiharness/review-kit', exact: true });
      await expect(detail).toBeVisible();
      await expect(detail).toHaveAttribute('id', (await choice.getAttribute('aria-controls'))!);
      await expect(choice).toHaveAttribute('aria-current', 'true');
      await expect(choice).toHaveAttribute('aria-expanded', 'true');
      const back = section.getByRole('button', { name: locale === 'fr' ? 'Retour aux plugins' : 'Back to plugins', exact: true });
      expect(await choice.evaluate(element => parseFloat(getComputedStyle(element).borderLeftWidth))).toBeGreaterThanOrEqual(3);
      if (scenario.width >= 960) {
        await expect(choice).toBeFocused();
        await expectThemeRoles(choice, '--surface-selected');
        await expectContrast(choice, 'borderLeftColor', 3);
        const listBounds = (await navigation.boundingBox())!, detailBounds = (await detail.boundingBox())!;
        expect(detailBounds.x).toBeGreaterThanOrEqual(listBounds.x + listBounds.width);
        expect(Math.min(listBounds.y + listBounds.height, detailBounds.y + detailBounds.height)
          - Math.max(listBounds.y, detailBounds.y)).toBeGreaterThan(0);
        await choice.press('Enter');
        const filter = section.getByRole('searchbox');
        await filter.click();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(back).toBeVisible();
        await expect(filter).toBeFocused();
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        await expect(navigation).toBeVisible();
      } else {
        await expect(back).toBeFocused();
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await expect(navigation).toBeHidden();
        for (const control of [detail.getByRole('button', { name: locale === 'fr'
          ? 'Vérifier les mises à jour de @aiharness/review-kit' : 'Check updates for @aiharness/review-kit', exact: true }),
          detail.getByRole('checkbox'), detail.getByRole('button', { name: locale === 'fr' ? 'Supprimer' : 'Remove', exact: true })]) {
          await page.keyboard.press('Tab');
          await expect(control).toBeFocused();
          await expect(control).toBeInViewport({ ratio: 1 });
          const clearance = await control.evaluate(element => {
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            const view = element.closest('.settings-view')!.getBoundingClientRect();
            const outline = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
            return Math.min(rect.top - outline - view.top, view.bottom - rect.bottom - outline,
              rect.left - outline - view.left, view.right - rect.right - outline);
          });
          expect(clearance).toBeGreaterThanOrEqual(-0.1);
        }
        await test.info().attach(`plugin-detail-${scenario.name}`, {
          body: await page.locator('.settings-dialog').screenshot({ path: test.info().outputPath(`plugin-detail-${scenario.name}.png`),
            animations: 'disabled', caret: 'hide' }), contentType: 'image/png',
        });
        await back.focus();
        await back.press('Enter');
        await expect(choice).toBeFocused();
        await expect(choice).toBeInViewport({ ratio: 1 });
        await expect(choice).toHaveAttribute('aria-expanded', 'false');
        await expect(choice).toHaveAttribute('aria-current', 'true');
        await expect(detail).toBeHidden();
        await expectThemeRoles(choice, '--surface-selected');
        await expectContrast(choice, 'borderLeftColor', 3);
        await choice.press('Enter');
        await expect(back).toBeFocused();
      }
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ai-harness-settings-navigation-v1')!).entries
        .find((entry: { cwd: string }) => entry.cwd === '/workspace')?.positions.plugins))
        .toEqual({ group: 'global', selection: 'global:global:11111111111111111111' });
      expect(api.requests.filter(request => request.method !== 'GET' && (
        request.path.startsWith('/api/plugins') || request.path === '/api/agent/runs'))).toEqual([]);
      await page.reload();
      await expect(detail).toBeVisible();
      await expect(choice).toHaveAttribute('aria-current', 'true');
      if (scenario.width < 960) await back.click();
      await section.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await alignSettingsSection(section);
      await expect(page).toHaveScreenshot(`plugin-catalog-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
      await test.info().attach('plugin-catalog-state', {
        body: await page.screenshot({ path: test.info().outputPath(`plugin-catalog-state-${scenario.name}.png`),
          animations: 'disabled', caret: 'hide' }), contentType: 'image/png',
      });
    });
  }
});

test.describe('Régression visuelle des profils de sous-agents', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} garde moteur, portées et permissions lisibles`, async ({ page }) => {
      const locale = scenario.theme === 'dark' ? 'fr' : 'en';
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.addInitScript(({ theme, locale }) => {
        localStorage.setItem('ai-harness-locale', locale);
        localStorage.setItem('ai-harness-preferences-v2', JSON.stringify({
          version: 2, theme, contentWidth: 1000, fontSize: 16,
          reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
          filesOpen: true, sidebarVisible: true, lastSettingsSection: 'subagents', keybindings: {},
        }));
      }, { theme: scenario.theme, locale });
      const api = await installMockApi(page);

      await page.goto('/settings#subagents');
      const section = page.locator('#subagents');
      await expect(section.locator('.subagent-profile-card')).toHaveCount(3);
      const navigation = section.getByRole('navigation', { name: locale === 'fr' ? 'Sous-agents' : 'Sub-agents', exact: true, includeHidden: true });
      await expect(navigation).toBeVisible();
      const choice = navigation.getByRole('button', { name: 'Plan (plan)', exact: true, includeHidden: true });
      expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await choice.focus();
      await expect(choice).toHaveCSS('outline-style', 'solid');
      await expectContrast(choice, 'outlineColor', 3);
      await choice.press('Enter');
      const detail = section.getByRole('article', { name: 'Plan', exact: true });
      await expect(detail).toBeVisible();
      await expect(detail).toHaveAttribute('id', (await choice.getAttribute('aria-controls'))!);
      await expect(choice).toHaveAttribute('aria-current', 'true');
      await expect(choice).toHaveAttribute('aria-expanded', 'true');
      const back = section.getByRole('button', { name: locale === 'fr' ? 'Retour aux profils' : 'Back to profiles', exact: true });
      if (scenario.width >= 960) {
        await expect(choice).toBeFocused();
        await expectThemeRoles(choice, '--surface-selected');
        await expectContrast(choice, 'borderLeftColor', 3);
        const listBounds = (await navigation.boundingBox())!, detailBounds = (await detail.boundingBox())!;
        expect(detailBounds.x).toBeGreaterThanOrEqual(listBounds.x + listBounds.width);
        expect(Math.min(listBounds.y + listBounds.height, detailBounds.y + detailBounds.height)
          - Math.max(listBounds.y, detailBounds.y)).toBeGreaterThan(0);
        await choice.press('Enter');
        const filter = section.getByRole('searchbox');
        await filter.click();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(back).toBeVisible();
        await expect(filter).toBeFocused();
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        await expect(navigation).toBeVisible();
      } else {
        await expect(back).toBeFocused();
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await expect(navigation).toBeHidden();
        for (const control of [detail.getByRole('checkbox'),
          detail.getByRole('button', { name: locale === 'fr' ? 'Modifier' : 'Edit', exact: true }),
          detail.getByRole('button', { name: locale === 'fr' ? 'Dupliquer' : 'Duplicate', exact: true })]) {
          await page.keyboard.press('Tab');
          await expect(control).toBeFocused();
          await expect(control).toBeInViewport({ ratio: 1 });
          const clearance = await control.evaluate(element => {
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            const view = element.closest('.settings-view')!.getBoundingClientRect();
            const outline = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
            return Math.min(rect.top - outline - view.top, view.bottom - rect.bottom - outline,
              rect.left - outline - view.left, view.right - rect.right - outline);
          });
          expect(clearance).toBeGreaterThanOrEqual(-0.1);
        }
        await test.info().attach(`profile-detail-${scenario.name}`, {
          body: await page.locator('.settings-dialog').screenshot({ path: test.info().outputPath(`profile-detail-${scenario.name}.png`),
            animations: 'disabled', caret: 'hide' }), contentType: 'image/png',
        });
        await back.focus();
        await back.press('Enter');
        await expect(choice).toBeFocused();
        await expect(choice).toHaveAttribute('aria-expanded', 'false');
        await expect(choice).toHaveAttribute('aria-current', 'true');
        await expect(detail).toBeHidden();
        await expectThemeRoles(choice, '--surface-selected');
        await expectContrast(choice, 'borderLeftColor', 3);
        await choice.press('Enter');
        await expect(back).toBeFocused();
      }
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ai-harness-settings-navigation-v1')!).entries
        .find((entry: { cwd: string }) => entry.cwd === '/workspace')?.positions.subagents))
        .toEqual({ group: 'project', selection: 'plan' });
      expect(api.requests.filter(request => request.method !== 'GET' && (
        request.path.startsWith('/api/subagents/') || request.path === '/api/agent/runs'))).toEqual([]);
      await detail.getByRole('button', { name: locale === 'fr' ? 'Modifier' : 'Edit', exact: true }).click();
      const editor = section.locator('.subagent-profile-editor'), options = editor.locator('.subagent-editor-options');
      await options.scrollIntoViewIfNeeded();
      await test.info().attach(`profile-options-${scenario.name}`, {
        body: await page.screenshot({ path: test.info().outputPath(`profile-options-${scenario.name}.png`),
          animations: 'disabled', caret: 'hide' }), contentType: 'image/png',
      });
      const toggles = options.getByRole('checkbox'); await expect(toggles).toHaveCount(3);
      for (const toggle of await toggles.all()) {
        const bounds = await toggle.boundingBox(), target = await toggle.locator('..').boundingBox();
        expect(bounds!.width).toBeLessThanOrEqual(bounds!.height);
        expect(target!.height).toBeGreaterThanOrEqual(44);
        const checked = await toggle.isChecked(); await toggle.locator('..').click();
        await expect(toggle).toBeChecked({ checked: !checked }); await expect(toggle).toBeFocused();
        await toggle.press('Space'); await expect(toggle).toBeChecked({ checked });
        await expect(toggle).toHaveCSS('outline-style', 'solid'); await expectContrast(toggle, 'outlineColor', 3);
      }
      await editor.getByRole('button', { name: locale === 'fr' ? 'Annuler' : 'Cancel', exact: true }).click();
      await expect(editor).toBeHidden();
      expect(api.requests.filter(request => request.method !== 'GET' && (
        request.path.startsWith('/api/subagents/') || request.path === '/api/agent/runs'))).toEqual([]);
      await page.reload();
      await expect(detail).toBeVisible();
      await expect(choice).toHaveAttribute('aria-current', 'true');
      if (scenario.width < 960) await back.click();
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
      const loadEarlier = page.getByRole('button', { name: 'Load earlier messages' });
      // Measure at the actual pagination click, after native reveal and any
      // in-flight initial scrolling, but before React admits the older page.
      const [priorAnchor] = await Promise.all([
        loadEarlier.evaluate(element => new Promise<number>(resolve => {
          element.addEventListener('click', () => resolve(
            document.getElementById('visual-history-message-101')!.getBoundingClientRect().top,
          ), { capture: true, once: true });
        })),
        loadEarlier.click(),
      ]);
      await expect(page.locator('.messages-container[data-virtualized="true"]')).toBeVisible();
      expect(await page.locator('.message').count()).toBeLessThan(45);
      const actions = scenario.width <= 959
        ? page.getByRole('navigation', { name: 'Conversation actions' })
        : page.locator('.chat-toolbar-actions');
      await actions.getByRole('button', { name: 'Conversation map' }).click();
      await expect(page.getByLabel('Conversation map')).toContainText('160 of 180 loaded');
      await expect(page.getByRole('button', { name: /Back to bottom \(\d+\)/ })).toHaveCount(0);
      // Role prefixes remain accessible, not extra grid cells that displace previews.
      expect(await page.locator('.minimap-entry').evaluateAll(entries => entries.every(entry => {
        const preview = entry.querySelector('small');
        const prefix = entry.querySelector('.sr-only');
        return preview && prefix && getComputedStyle(prefix).position === 'absolute'
          && preview.getBoundingClientRect().width > entry.getBoundingClientRect().width / 2;
      }))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(async () => Math.abs(
        await page.locator('#visual-history-message-101').evaluate(element => element.getBoundingClientRect().top) - priorAnchor,
      )).toBeLessThan(3);
      // The real pagination assertion above retains its measured user anchor.
      // Retire pagination's settling lease with real input before framing the capture.
      await page.locator('.messages-container').click({ position: { x: 8, y: 8 } });
      // Normalize only the capture: native initial reveal can differ by 16–32px.
      const captureAnchor = page.locator('#visual-history-message-101');
      await captureAnchor.evaluate(element => {
        const viewport = element.closest('.messages-container')!;
        viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16;
      });
      await expect.poll(() => captureAnchor.evaluate(element => Math.abs(element.getBoundingClientRect().top
        - element.closest('.messages-container')!.getBoundingClientRect().top - 16))).toBeLessThan(1);
      await expect.poll(async () => {
        const map = await page.locator('.conversation-minimap').boundingBox();
        const form = await page.locator('.input-container').boundingBox();
        return map!.y + map!.height - form!.y;
      }).toBeLessThanOrEqual(0);
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
        { type: 'tool_call', id: 'visual-write', name: 'write', input: { path: 'src/generated.ts', content: 'export {};' } },
      ];
      await installMockApi(page, { sessions: [session], providers: [{ type: 'openai', configured: true }] });

      await page.goto('/chat/visual-message-meta');
      await page.locator('input[type=file][accept="image/*"]').setInputFiles({
        name: 'visual-attachment.svg', mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><rect width="80" height="50" fill="#6aa6ff"/></svg>'),
      });
      const imageWarning = page.getByRole('alert').filter({ hasText: 'may not support images' });
      await imageWarning.getByRole('button', { name: 'Close' }).click();
      await expect(imageWarning).toBeHidden();
      const attachment = page.getByRole('img', { name: 'visual-attachment.svg' });
      await expect(attachment).toBeVisible();
      await attachment.evaluate(element => (element as HTMLImageElement).decode());
      const metadata = page.locator('.message.assistant .message-meta');
      await expect(metadata).toContainText('mock-rich-model');
      await expect(metadata).toContainText('$0.0123');
      await expect(page.getByRole('button', { name: 'src/generated.ts' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      // Selection coordinates must be measured after image/font/composer layout,
      // not before an attachment-triggered scroll moves the selected paragraph.
      const paragraph = page.locator('.message.assistant .message-content p').first();
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        element.closest('.messages-container')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      const selectionToolbar = page.getByRole('toolbar', { name: 'Selected text actions' });
      await expect(selectionToolbar).toBeVisible();
      const selectedTop = await page.evaluate(() => window.getSelection()!.getRangeAt(0).getBoundingClientRect().top);
      const toolbarBox = (await selectionToolbar.boundingBox())!;
      expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(selectedTop);
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
      const longPath = 'docs/nested/a-long-directory-name-that-keeps-the-complete-file-path-visible/README.md';
      await installMockApi(page, {
        sessions: [mockSession('visual-files', 'Workspace files', [{ role: 'assistant', content: `[Open readme](file:${longPath})` }])],
        workspaceFiles: [...Array.from({ length: 40 }, (_, index) => ({ path: `file-${index}.ts`, content: 'fixture' })), {
          path: longPath, language: 'markdown', gitStatus: 'modified', additions: 3, deletions: 1,
          content: '---\ntitle: Visual fixture\n---\n# Workspace viewer\n\nSafe **Markdown** preview.',
          diff: '@@ -1 +1 @@\n-old\n+new',
        }],
      });

      await page.goto('/chat/visual-files');
      await page.getByRole('link', { name: 'Open readme', exact: true }).click();
      const panel = page.getByRole('complementary', { name: 'File reader' });
      await expect(panel.locator('.viewer-path')).toHaveText(longPath);
      await panel.getByRole('button', { name: 'Preview' }).click();
      await expect(panel.locator('.markdown-preview h1')).toHaveText('Workspace viewer');
      await expect(page.getByRole('region', { name: 'Workspace explorer' }).locator('.file-name[aria-current="true"]')).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`workspace-files-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
      await test.info().attach('design-workspace', {
        body: await page.screenshot({ path: test.info().outputPath(`design-workspace-${scenario.name}.png`),
          animations: 'disabled', caret: 'hide' }), contentType: 'image/png',
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
      await page.addStyleTag({ content: '#plugins, #mcp { display: none !important; }' });
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
