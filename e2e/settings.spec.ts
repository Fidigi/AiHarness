import { expect, test, type Page } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

function settingsSection(page: Page, heading: string) {
  return page.getByRole('heading', { name: heading, exact: true }).locator('..');
}

test.describe('Settings and authentication', () => {
  test('présente les fournisseurs hydratés et le nombre de sessions', async ({ page }) => {
    await installMockApi(page, {
      sessions: [mockSession('first-session', 'Première'), mockSession('second-session', 'Deuxième')],
      providers: [{ type: 'mock', configured: true }, { type: 'openai', configured: true }],
    });
    await page.goto('/settings');

    const provider = settingsSection(page, 'AI Provider');
    await expect(provider.locator('select')).toHaveValue('mock');
    await provider.locator('select').selectOption('openai');
    await expect(provider.getByText('✅ OpenAI configured')).toBeVisible();
    await expect(settingsSection(page, 'Model').locator('select')).toBeEnabled();
    await expect(settingsSection(page, 'Model').locator('option')).toContainText([
      'GPT-4o (Recommended)', 'GPT-4 Turbo', 'GPT-3.5 Turbo',
    ]);
    await expect(settingsSection(page, 'Sessions')).toContainText('Total sessions: 2');
  });

  test('filtre le catalogue serveur, active les modèles par workspace et alimente le chat', async ({ page }) => {
    const api = await installMockApi(page, {
      providers: [
        { type: 'mock', configured: true },
        { type: 'openai', configured: true },
        { type: 'anthropic', configured: false },
      ],
    });
    await page.goto('/settings#model');
    await settingsSection(page, 'AI Provider').locator('select').selectOption('openai');

    const section = settingsSection(page, 'Model');
    await section.getByText('Manage model catalogue').click();
    await expect(section.locator('fieldset[data-provider="openai"]')).toContainText('GPT-4o (Recommended)');
    await expect(section.locator('fieldset[data-provider="openai"]')).toContainText('images');
    await expect(section.locator('fieldset[data-provider="anthropic"]')).toContainText('unavailable');

    await section.getByLabel('Filter models or providers').fill('o3');
    await expect(section.locator('.model-catalog-row')).toHaveCount(1);
    await expect(section.locator('.model-catalog-row')).toContainText('reasoning');
    await section.getByLabel('Filter models or providers').fill('');

    const o3 = section.getByRole('checkbox', { name: 'Enable o3 for OpenAI' });
    await o3.uncheck();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/models/enabled').at(-1)?.body)
      .toMatchObject({ projectId: 'workspace-e2e' });
    expect((api.requests.filter(request => request.path === '/api/models/enabled').at(-1)?.body as { enabledModels: string[] }).enabledModels)
      .not.toContain('openai:o3');

    await section.getByRole('button', { name: 'Disable all' }).click();
    await expect.poll(() => (api.requests.filter(request => request.path === '/api/models/enabled').at(-1)?.body as { enabledModels: string[] })?.enabledModels)
      .toEqual([]);
    await section.getByRole('button', { name: 'Enable all' }).click();
    await expect.poll(() => (api.requests.filter(request => request.path === '/api/models/enabled').at(-1)?.body as { enabledModels: string[] })?.enabledModels.length)
      .toBeGreaterThan(1);

    const catalogueRequests = api.requests.filter(request => request.path === '/api/models').length;
    await section.getByRole('button', { name: 'Refresh catalogue' }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/models').length).toBe(catalogueRequests + 1);

    await o3.uncheck();
    await page.getByRole('button', { name: 'New chat' }).click();
    const suggestions = page.locator('#model-suggestions option');
    await expect.poll(() => suggestions.evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
      .toEqual(['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo']);
    await expect(page.locator('#model-suggestions option[value="o3"]')).toHaveCount(0);
  });

  test('gère OAuth et un provider compatible sans réexposer ses secrets', async ({ page }) => {
    const api = await installMockApi(page, {
      providers: [{ type: 'mock', configured: true }, { type: 'openai', configured: false }],
      providerAuthStatuses: [
        {
          type: 'mock', name: 'Mock', configured: true, connected: true, method: 'none',
          reconnectSupported: false, disconnectSupported: false,
        },
        {
          type: 'openai', name: 'OpenAI', configured: false, connected: false, method: 'oauth',
          reconnectSupported: true, disconnectSupported: false,
        },
      ],
    });
    await page.goto('/settings#provider-lifecycle');
    const section = settingsSection(page, 'Provider connections and custom providers');
    const openai = section.locator('.settings-resource-card').filter({ hasText: 'OpenAI' });
    await openai.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(section.getByText('E2E-CODE')).toBeVisible();
    await expect(section.getByRole('link', { name: 'Open the provider authorization page' }))
      .toHaveAttribute('href', 'https://oauth.example.test/activate');
    await section.getByRole('button', { name: 'Cancel' }).click();

    await section.getByText('Create or edit a compatible provider').click();
    const editor = section.locator('.custom-resource-editor');
    await editor.getByLabel('ID').fill('acme');
    await editor.getByLabel('Name').fill('Acme Gateway');
    await editor.getByLabel('Base URL').fill('https://models.acme.test/v1');
    await editor.getByLabel('API dialect').selectOption('openai-completions');
    await editor.getByLabel('API key').fill('e2e-provider-secret');
    await editor.getByLabel('Custom headers (encrypted JSON values)').fill('{"X-Tenant":"private-tenant"}');
    await editor.getByRole('button', { name: 'Save' }).click();

    const card = section.locator('.settings-resource-card').filter({ hasText: 'Acme Gateway' });
    await expect(card).toContainText('connected');
    await expect(section).not.toContainText('e2e-provider-secret');
    await expect(section).not.toContainText('private-tenant');
    await card.getByRole('button', { name: 'Import models' }).click();
    await expect.poll(() => api.requests.filter(request => request.path.endsWith('/import-models')).length).toBe(1);
  });

  test('administre modèles personnalisés, valeurs par défaut, outils et registre de skills', async ({ page }) => {
    const api = await installMockApi(page, {
      providers: [{ type: 'mock', configured: true }, { type: 'openai', configured: true }],
    });
    await page.goto('/settings#custom-models');

    const models = settingsSection(page, 'Custom models');
    await models.getByText('Create a custom model').click();
    await models.getByLabel('Provider').fill('openai');
    await models.getByLabel('ID', { exact: true }).fill('gpt-e2e');
    await models.getByLabel('Name').fill('GPT E2E');
    await models.getByText('reasoning', { exact: true }).locator('input').check();
    await models.getByLabel('Context window').fill('64000');
    await models.getByLabel('Maximum output tokens').fill('4096');
    await models.getByLabel('Input price / million tokens').fill('2.5');
    await models.getByLabel('Output price / million tokens').fill('10');
    await models.getByLabel('Advanced compatibility (JSON)').fill('{"supportsDeveloperRole":true}');
    await models.getByRole('button', { name: 'Save' }).click();
    await expect(models.getByText('GPT E2E')).toBeVisible();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/provider-registry/models' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ provider: 'openai', id: 'gpt-e2e', contextWindow: 64000, maxOutputTokens: 4096 });

    const defaults = settingsSection(page, 'Provider and model defaults');
    await defaults.getByLabel('Provider').fill('openai');
    await defaults.getByLabel('Model').fill('gpt-e2e');
    await defaults.getByLabel('Default tool preset').selectOption('read-only');
    await defaults.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ scope: 'project', scopeId: 'workspace-e2e', values: { provider: 'openai', model: 'gpt-e2e', toolPreset: 'read-only' } });

    const tools = settingsSection(page, 'Tools and presets');
    await tools.getByLabel('Default tool preset').selectOption('read-only');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/tools' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ projectId: 'workspace-e2e', toolPreset: 'read-only' });
    await expect(tools.getByText('powershell', { exact: true }).locator('../..').locator('input')).toBeDisabled();

    const skills = settingsSection(page, 'Skills');
    await skills.getByText('Browse Agent Skills registry').click();
    await expect(skills.getByText('security-review')).toBeVisible();
    await skills.getByRole('button', { name: 'Install', exact: true }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/skills/registry/install').at(-1)?.body)
      .toMatchObject({ id: 'security-review', scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' });
  });

  test('liste les skills par portée et persiste l’invocation autonome par workspace', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings#skills');
    const section = settingsSection(page, 'Skills');

    await expect(section.locator('fieldset[data-scope="project"]')).toContainText('review-project');
    await expect(section.locator('fieldset[data-scope="global"]')).toContainText('release-notes');
    await expect(section.locator('fieldset[data-scope="path"]')).toContainText('documentation');
    await expect(section.locator('fieldset[data-scope="package"]')).toContainText('test-plan');
    await expect(section).toContainText('~/.ai-harness/skills/release-notes/SKILL.md');

    await section.getByLabel('Filter skills or sources').fill('release');
    await expect(section.locator('.skill-catalog-row')).toHaveCount(1);
    await section.getByLabel('Filter skills or sources').fill('');

    const release = section.getByRole('checkbox', { name: 'Allow release-notes for autonomous model invocation' });
    await release.uncheck();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/skills/enabled').at(-1)?.body)
      .toMatchObject({ cwd: '/workspace', projectId: 'workspace-e2e' });
    expect((api.requests.filter(request => request.path === '/api/skills/enabled').at(-1)?.body as { enabledSkills: string[] }).enabledSkills)
      .not.toContain('global:release-notes:e2e');

    const documentation = section.getByRole('checkbox', { name: 'Allow documentation for autonomous model invocation' });
    await documentation.check();
    await expect.poll(() => (api.requests.filter(request => request.path === '/api/skills/enabled').at(-1)?.body as { enabledSkills: string[] })?.enabledSkills)
      .toContain('path:documentation:e2e');
    await page.reload();
    await expect(section.getByRole('checkbox', { name: 'Allow release-notes for autonomous model invocation' })).not.toBeChecked();
    await expect(section.getByRole('checkbox', { name: 'Allow documentation for autonomous model invocation' })).toBeChecked();
  });

  test('verrouille les skills projet tant que le workspace n’est pas approuvé', async ({ page }) => {
    await installMockApi(page, { workspaceTrusted: false });
    await page.goto('/settings#skills');
    const section = settingsSection(page, 'Skills');
    await expect(section.getByText('Project skills are locked until this workspace is trusted.')).toBeVisible();
    await expect(section.getByRole('checkbox', { name: 'Allow review-project for autonomous model invocation' })).toBeDisabled();
    await expect(section.locator('fieldset[data-scope="project"]')).toContainText('untrusted');
    await expect(section.getByRole('checkbox', { name: 'Allow release-notes for autonomous model invocation' })).toBeEnabled();
  });

  test('gère les plugins npm/git/path, leur inventaire et les mises à jour explicites', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings#plugins');
    const section = page.locator('#plugins');

    await expect(section.locator('fieldset[data-scope="project"]')).toContainText('workspace-kit');
    await expect(section.locator('fieldset[data-scope="global"]')).toContainText('@aiharness/review-kit');
    await expect(section.locator('fieldset[data-scope="standalone"]')).toContainText('workspace-banner');
    await expect(section).toContainText('1 extension · 1 skill · 1 prompt · 1 theme');
    const globalCard = section.locator('.plugin-card').filter({ hasText: '@aiharness/review-kit' });
    await globalCard.getByText('Resources and diagnostics').click();
    await expect(globalCard).toContainText('extensions/review-tools.js');
    await expect(globalCard).toContainText('skills/release-review');

    await section.getByLabel('Filter packages').fill('workspace');
    await expect(section.locator('.plugin-card')).toHaveCount(1);
    await section.getByLabel('Filter packages').fill('');

    await section.getByRole('button', { name: 'Check all' }).click();
    await expect(section.getByRole('button', { name: 'Update all (1)' })).toBeVisible();
    await expect(globalCard).toContainText('Version 1.5.0 is available.');
    await section.getByRole('button', { name: 'Update all (1)' }).click();
    await expect(globalCard).toContainText('Version 1.5.0');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/plugins' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ action: 'update', cwd: '/workspace', projectId: 'workspace-e2e' });

    await section.getByRole('button', { name: 'Reload resources' }).click();
    await expect(section).toContainText('generation 5');
    await expect(section).toContainText('Restart the server for executable extensions.');

    await section.getByLabel('Package source').fill('npm:@example/new-plugin');
    await section.getByLabel('Install scope').selectOption('global');
    await section.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(section).toContainText('@example/new-plugin');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/plugins' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ action: 'install', source: 'npm:@example/new-plugin', scope: 'global' });

    const installed = section.locator('.plugin-card').filter({ hasText: '@example/new-plugin' });
    await installed.getByRole('checkbox', { name: 'Enable or disable @example/new-plugin' }).uncheck();
    await expect(installed).toContainText('Disabled');
    page.once('dialog', dialog => dialog.accept());
    await installed.getByRole('button', { name: 'Remove' }).click();
    await expect(installed).toHaveCount(0);
  });

  test('verrouille les packages projet non approuvés sans bloquer l’administration globale', async ({ page }) => {
    await installMockApi(page, { workspaceTrusted: false });
    await page.goto('/settings#plugins');
    const section = page.locator('#plugins');
    await expect(section.getByText('Project packages and standalone extensions stay locked until this workspace is trusted.')).toBeVisible();
    await expect(section.getByLabel('Install scope').locator('option[value="project"]')).toHaveAttribute('disabled', '');
    const projectCard = section.locator('.plugin-card').filter({ hasText: 'workspace-kit' });
    await expect(projectCard).toContainText('Installed');
    await expect(projectCard).toContainText('No resolved resources');
    await expect(section.locator('fieldset[data-scope="standalone"]')).toContainText('global-status');
    await expect(section.locator('fieldset[data-scope="standalone"]')).not.toContainText('workspace-banner');
    await expect(section.locator('fieldset[data-scope="global"]')).toContainText('@aiharness/review-kit');
  });

  test('configure les profils de sous-agents avec portée, duplication et permissions', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings#subagents');
    const section = settingsSection(page, 'Sub-agents');

    await expect(section.getByLabel('Enable the integrated sub-agent engine')).toBeChecked();
    const scopeControl = section.getByLabel('Configuration scope');
    const concurrency = section.getByLabel('Maximum concurrent child agents');
    await expect(scopeControl).toHaveValue('project');
    await expect(section.locator('.subagent-profile-card')).toHaveCount(3);
    await scopeControl.selectOption('global');
    await concurrency.fill('3');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/subagents/settings' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ cwd: '/workspace', scope: 'global', maxConcurrency: 3 });
    await scopeControl.selectOption('project');
    await concurrency.fill('2');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/subagents/settings' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ cwd: '/workspace', projectId: 'workspace-e2e', scope: 'project', maxConcurrency: 2 });

    await section.getByLabel('Filter profiles').fill('Plan');
    await expect(section.locator('.subagent-profile-card')).toHaveCount(1);
    const planToggle = section.getByRole('checkbox', { name: 'Enable sub-agent profile Plan' });
    await planToggle.click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/subagents/profiles/plan').at(-1)?.body)
      .toMatchObject({ profile: { enabled: false } });
    await expect(planToggle).not.toBeChecked();
    await section.getByLabel('Filter profiles').fill('');

    await section.getByRole('button', { name: 'Create profile' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create profile' });
    await dialog.getByLabel('Profile ID').fill('security-review');
    await dialog.getByLabel('Name').fill('Security review');
    await dialog.getByLabel('Description').fill('Review trust boundaries');
    await dialog.getByLabel('Instructions').fill('Inspect the selected trust boundaries.');
    await dialog.getByLabel('Tools').fill('read, grep');
    await dialog.getByLabel('Skills').fill('review-project');
    await dialog.getByLabel('Maximum turns').fill('6');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText('Security review', { exact: true })).toBeVisible();
    const custom = section.locator('.subagent-profile-card').filter({ hasText: 'Security review' });
    await expect(custom).toContainText('read, grep');
    await custom.getByRole('button', { name: 'Duplicate' }).click();
    await expect(section.getByText('Security review copy', { exact: true })).toBeVisible();
  });

  test('enregistre une clé fournisseur côté serveur puis masque sa valeur', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings');
    const openAiRow = page.locator('.api-key-row').filter({ has: page.getByText('OpenAI', { exact: true }) });
    const keyInput = openAiRow.locator('input');
    await keyInput.fill('sk-e2e-secret');
    await openAiRow.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('OpenAI configured on the server.')).toBeVisible();
    await expect(keyInput).toHaveValue('••••••••');
    await expect.poll(() => api.requests.filter(request => request.method === 'POST' && request.path === '/api/config').map(request => request.body))
      .toEqual([{ type: 'openai', apiKey: 'sk-e2e-secret' }]);
  });

  test('signale un échec de configuration fournisseur', async ({ page }) => {
    await installMockApi(page, { configureProviderError: true });
    await page.goto('/settings');
    const anthropicRow = page.locator('.api-key-row').filter({ has: page.getByText('Anthropic', { exact: true }) });
    await anthropicRow.locator('input').fill('invalid-key');
    await anthropicRow.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('HTTP 500')).toBeVisible();
    await expect(anthropicRow.locator('input')).toHaveValue('invalid-key');
  });

  test('applique le Bearer token à l’agent sans le persister durablement', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings');
    const authentication = settingsSection(page, 'Server authentication');
    await authentication.getByPlaceholder('Bearer token').fill('  e2e-token  ');
    await authentication.getByRole('button', { name: 'Apply' }).click();
    await expect(authentication.getByText('Token applied to this tab.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('ai-harness-auth-token'))).toBe('e2e-token');
    expect(await page.evaluate(() => localStorage.getItem('ai-harness-auth-token'))).toBeNull();

    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByPlaceholder(/Type your message/).fill('Authentifié');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => api.requests.find(request => request.method === 'POST' && request.path === '/api/agent/runs')?.headers.authorization)
      .toBe('Bearer e2e-token');
  });

  test('persiste thème, largeur, police et options dans des préférences versionnées', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/settings');
    const appearance = settingsSection(page, 'Appearance');
    await appearance.locator('select').selectOption('pine');
    await appearance.locator('input[type=range]').nth(0).fill('1200');
    await appearance.locator('input[type=range]').nth(1).fill('18');
    await appearance.locator('input[type=checkbox]').nth(0).check();
    await appearance.locator('input[type=checkbox]').nth(1).check();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pine');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ai-harness-preferences-v3') || '{}')))
      .toMatchObject({
        version: 3, theme: 'pine', contentWidth: 1200, fontSize: 18, reasoningOpen: true, sound: true,
        soundEvents: { completion: true, attention: true },
        notificationEvents: { completion: true, attention: true },
        pushEvents: { completion: true, attention: true },
      });
    await page.reload();
    const theme = settingsSection(page, 'Appearance').locator('select');
    await expect(theme).toHaveValue('pine');
    await expect(theme.locator('option')).toHaveText(['System', 'Light', 'Dark', 'Mist', 'Rose', 'Pine']);
    await theme.selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('demande explicitement la permission Push et garde ses catégories séparées', async ({ page }) => {
    await page.addInitScript(() => {
      let subscription: any = null;
      Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: class Notification {
          static permission = 'default';
          static async requestPermission() {
            (window as any).__permissionRequests = ((window as any).__permissionRequests || 0) + 1;
            this.permission = 'granted';
            return 'granted';
          }
        },
      });
      const registration = {
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async (options: any) => {
            subscription = {
              endpoint: 'https://push.example.test/e2e', expirationTime: null, options,
              toJSON: () => ({ endpoint: 'https://push.example.test/e2e', keys: { p256dh: 'client', auth: 'auth' } }),
              unsubscribe: async () => { subscription = null; return true; },
            };
            return subscription;
          },
        },
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          getRegistration: async () => registration,
          register: async () => registration,
        },
      });
    });
    const api = await installMockApi(page);
    await page.goto('/settings#appearance');
    await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
    await expect(page.locator('#appearance .preference-grid')).toBeVisible();
    const localEvents = page.locator('.notification-event-settings input[type=checkbox]');
    await expect(localEvents.nth(1)).toBeChecked();

    const push = page.locator('.push-notification-toggle');
    await expect(push).toBeEnabled();
    await push.click();
    await expect.poll(() => page.evaluate(() => (window as any).__permissionRequests || 0)).toBe(1);
    await expect.poll(() => api.requests.filter(request => request.path === '/api/push/subscribe' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ categories: ['completion', 'attention'] });

    const pushEvents = page.locator('.push-event-settings input[type=checkbox]');
    await pushEvents.nth(0).uncheck();
    await expect(localEvents.nth(0)).toBeChecked();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/push/subscribe' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ categories: ['attention'] });
    await push.click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/push/subscribe' && request.method === 'DELETE').length).toBe(1);
  });

  test('affiche les versions, une release et ses notes sans mise à jour automatique', async ({ page }) => {
    const api = await installMockApi(page, {
      appUpdate: {
        webVersion: '0.1.0', agentVersion: '0.1.1', available: true,
        release: {
          version: '0.2.0', name: 'AiHarness 0.2.0',
          url: 'https://github.com/Fidigi/AiHarness/releases/tag/v0.2.0',
          notes: 'Safer agents and a faster interface.',
        },
      },
    });
    await page.goto('/settings#about');
    const about = settingsSection(page, 'About');
    await expect(about.locator('.version-status dt')).toHaveText(['Web version', 'Agent version']);
    await expect(about.locator('.version-status dd')).toHaveText(['0.1.0', '0.1.1']);
    const release = about.getByRole('link', { name: 'Version 0.2.0 is available' });
    await expect(release).toHaveAttribute('href', 'https://github.com/Fidigi/AiHarness/releases/tag/v0.2.0');
    await about.getByText('Release notes').click();
    await expect(about).toContainText('Safer agents and a faster interface.');
    expect(api.requests.filter(request => request.path === '/api/app-update')).toHaveLength(1);
    await about.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/app-update').length).toBe(2);
    expect(api.requests.filter(request => request.path === '/api/app-update')[1]?.path).toBe('/api/app-update');
  });

  test('affiche une connexion dédiée puis restaure le deep link avec une session cookie', async ({ page }) => {
    const api = await installMockApi(page, {
      authRequired: true,
      authToken: 'correct-token',
      sessions: [mockSession('protected-session', 'Protected deep link')],
    });
    await page.goto('/chat/protected-session?cwd=%2Fworkspace');
    await expect(page.getByText('Sign in to access this AiHarness server.')).toBeVisible();
    await page.getByLabel('Access token').fill('incorrect');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid credentials');
    await page.getByLabel('Access token').fill('correct-token');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/chat\/protected-session\?cwd=%2Fworkspace/);
    await expect(page.getByText('Protected deep link', { exact: true }).first()).toBeVisible();
    expect(api.requests.filter(request => request.path === '/api/auth/login')).toHaveLength(2);
  });
});
