import { expect, test, type Page } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';
import {
  MCP_FILE_PROBLEM_MESSAGES,
  MCP_FILE_PROBLEM_REASONS,
  mcpFileProblemInventory,
  mcpFreshProjectInventory,
  mcpFreshProjectPreviewFixture,
  mcpImportPreviewFixture,
  mcpStateInventory,
} from './fixtures/mcp';

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

  test('présente un inventaire MCP expurgé et garde le fichier projet fermé avant confiance', async ({ page }) => {
    const api = await installMockApi(page, {
      workspaceTrusted: false,
      mcpConfig: {
        files: [
          { scope: 'global', path: '/agent/mcp.json', exists: true, contentRead: true, problems: [] },
          {
            scope: 'project', path: '/workspace/.ai-harness/mcp.json', exists: true, contentRead: false,
            problems: [{ reason: 'trust-required', message: 'Project trust required.' }],
          },
        ],
        project: {
          cwd: '/workspace', contentTrusted: false, requiresTrust: true, decision: null,
          inherited: false, trustError: false,
        },
        servers: [{
          name: 'documentation', scope: 'global', sourcePath: '/agent/mcp.json', valid: true,
          enabled: true, exposure: 'deferred', transport: 'http', url: 'https://docs.example.test/•••?•••',
          envNames: [], headerNames: ['Authorization'], commandFields: [],
          variableReferences: [{ field: 'headers.X-Token', names: ['DOCS_TOKEN'] }], masked: true,
          shadowedByProject: false, replacesGlobal: false, problems: [],
        }],
      },
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');

    await expect(section.getByRole('heading', { name: 'MCP servers' })).toBeVisible();
    await expect(section).toContainText('documentation');
    await expect(section).toContainText('https://docs.example.test/•••?•••');
    await expect(section).toContainText('Header names: Authorization');
    await expect(section).toContainText('headers.X-Token reads host variables: DOCS_TOKEN');
    await expect(section).toContainText('Project server names and values are not read before trust.');
    await section.getByText('Configuration file diagnostics').click();
    await expect(section).toContainText('Project trust is required before reading this file.');
    await section.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/mcp').length).toBeGreaterThanOrEqual(2);
  });

  test('présente tous les états de ligne MCP sans les confondre avec une connexion', async ({ page }) => {
    await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');

    await expect(section.getByRole('article', { name: 'remote-docs: Configured', exact: true })).toBeVisible();
    await expect(section.getByRole('article', { name: 'local-tools: Disabled', exact: true })).toBeVisible();
    await expect(section.getByRole('article', { name: 'shared: Replaced by project', exact: true })).toBeVisible();
    await expect(section.getByRole('article', { name: 'bad\\u202ename: Invalid', exact: true })).toBeVisible();
    const projectReplacement = section.locator('fieldset[data-scope="project"]')
      .getByRole('article', { name: 'shared: Configured', exact: true });
    await expect(projectReplacement).toContainText('replaces the global entry');
    await expect(section.getByText('Connected', { exact: true })).toHaveCount(0);
    await expect(section).toContainText('Command-backed fields: headers.X-Command');
    await expect(section).toContainText('env.CACHE_DIR reads host variables: CACHE_DIR');
    await section.getByText('Configuration file diagnostics').click();
    await expect(section).toContainText(MCP_FILE_PROBLEM_MESSAGES['invalid-shape']);
  });

  test('teste une entrée MCP sans envoyer sa configuration et détaille capacités, cwd et outils', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const card = section.getByRole('article', { name: 'remote-docs: Configured', exact: true });

    await card.getByRole('button', { name: 'Test remote-docs', exact: true }).click();
    const report = card.getByRole('region', { name: 'Last connection test for remote-docs' });
    await expect(report).toContainText('Connected');
    await expect(report).toContainText('Server: docs-fixture 1.2.3');
    await expect(report).toContainText('Working directory:');
    await expect(report).toContainText('/workspace');
    await expect(report).toContainText('2 tools · 3 resources · 1 templates · 2 prompts');
    await expect(report).toContainText('search_docs');
    await expect(report).toContainText('Search documentation');
    await expect(report).toContainText('read-only hint · deferred tools');
    await expect(report).toContainText('publish_note');
    await expect(report).toContainText('may write · deferred tools');

    const request = api.requests.find(item => item.path === '/api/mcp/test');
    expect(request?.body).toEqual({ scope: 'global', name: 'remote-docs', cwd: '/workspace' });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
  });

  test('reparcourt le texte MCP côté serveur et affiche seulement un aperçu expurgé', async ({ page }) => {
    const api = await installMockApi(page, {
      mcpConfig: mcpStateInventory(),
      mcpImportPreview: mcpImportPreviewFixture(),
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.getByText('Paste and preview a server').click();
    const paste = '{"mcpServers":{"docs-import":{"url":"https://docs.example.test/private?token=SOURCE-SECRET","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}}}';
    await section.getByLabel('MCP server text').fill(paste);
    await section.getByLabel('Treat resolved values as AiHarness syntax').check();
    await section.getByRole('button', { name: 'Preview', exact: true }).click();

    await expect(section.getByRole('heading', { name: 'Redacted import preview' })).toBeVisible();
    const preview = section.getByRole('article', { name: 'docs-import' });
    await expect(preview).toContainText('https://docs.example.test/•••?•••');
    await expect(preview).toContainText('Header names: Authorization, X-Tenant');
    await expect(preview).toContainText('headers.X-Tenant');
    await expect(preview).toContainText('DOCS_TOKEN');
    await expect(preview).toContainText('explicit confirmation required');
    await expect(preview).toContainText('Confirmation is required before sending available host values remotely');
    await expect(preview).toContainText('Confirmation is required before storing literal secrets globally');
    await expect(preview).toContainText('Project configuration');
    await expect(preview).toContainText('cannot contain literal secrets');
    // The textarea intentionally retains the user's own paste; the rendered
    // server response must not echo any literal from it.
    await expect(preview).not.toContainText('SOURCE-SECRET');

    const request = api.requests.find(item => item.path === '/api/mcp/preview');
    expect(request?.body).toEqual({ text: paste, syntax: 'aiharness', cwd: '/workspace' });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
    expect(api.requests.filter(item => item.path === '/api/mcp/actions')).toHaveLength(0);

    await section.getByLabel('MCP server text').fill('https://other.example.test');
    await expect(section.getByRole('heading', { name: 'Redacted import preview' })).toHaveCount(0);
  });

  test('complète, confirme et persiste un import MCP depuis le texte original', async ({ page }) => {
    const api = await installMockApi(page, {
      mcpConfig: mcpStateInventory(),
      mcpImportPreview: mcpImportPreviewFixture(),
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.getByText('Paste and preview a server').click();
    const paste = '{"mcpServers":{"docs-import":{"url":"https://docs.example.test/private?token=SOURCE-SECRET","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}}}';
    await section.getByLabel('MCP server text').fill(paste);
    await section.getByLabel('Treat resolved values as AiHarness syntax').check();
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    const configure = section.getByRole('button', { name: 'Configure global import' });
    await configure.click();

    const dialog = page.getByRole('dialog', { name: 'Configure MCP import' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(configure).toBeFocused();
    await configure.click();
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    const tenant = dialog.getByRole('group', { name: 'headers.X-Tenant' });
    await tenant.getByLabel('Use a host-variable reference').check();
    await tenant.getByLabel('Host variable name').fill('TENANT_TOKEN');
    await dialog.getByLabel('I confirm storing the remaining literal secret values in global configuration.').check();
    await dialog.getByLabel(/I confirm that these host variables may be sent/u).check();
    await dialog.getByRole('button', { name: 'Save atomically' }).click();

    await expect(section).toContainText('The MCP server was imported.');
    await expect(section.getByRole('article', { name: 'docs-import: Configured', exact: true })).toBeVisible();
    await expect(section).not.toContainText('SOURCE-SECRET');
    const request = api.requests.find(item => item.path === '/api/mcp/actions'
      && (item.body as { action?: string } | undefined)?.action === 'import');
    expect(request?.body).toEqual({
      action: 'import', scope: 'global', revision: expect.any(String), text: paste,
      syntax: 'aiharness', entryIndex: 0, name: 'docs-import',
      values: { 'headers.X-Tenant': { reference: 'TENANT_TOKEN' } },
      secretReferences: {},
      confirmations: {
        literalSecret: true,
        remoteHostVariables: ['DOCS_TOKEN', 'TENANT_TOKEN'],
      },
      cwd: '/workspace',
    });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
  });

  test('confirme confiance et première écriture MCP dans un dossier projet neuf', async ({ page }) => {
    const api = await installMockApi(page, {
      workspaceTrusted: true,
      workspaceOperationTrusted: false,
      mcpConfig: mcpFreshProjectInventory(),
      mcpImportPreview: mcpFreshProjectPreviewFixture(),
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.getByText('Paste and preview a server').click();
    const paste = 'npx -y fresh-mcp-tools';
    await section.getByLabel('MCP server text').fill(paste);
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(section).toContainText('Explicit confirmation is required to trust this fresh folder');
    await section.getByRole('button', { name: 'Configure project import' }).click();

    const dialog = page.getByRole('dialog', { name: 'Configure MCP import' });
    await expect(section.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    const trust = dialog.getByLabel(/I trust this fresh project folder/u);
    await expect(dialog.getByRole('button', { name: 'Save atomically' })).toBeDisabled();
    await trust.check();
    await expect(dialog.getByRole('button', { name: 'Save atomically' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Save atomically' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(section.getByRole('article', { name: 'fresh-tools: Configured', exact: true })).toBeVisible();
    const request = api.requests.find(item => item.path === '/api/mcp/actions'
      && (item.body as { action?: string } | undefined)?.action === 'import');
    expect(request?.body).toMatchObject({
      action: 'import', scope: 'project', cwd: '/workspace', revision: null,
      trustProject: true, text: paste, entryIndex: 0,
    });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
    await expect.poll(() => api.requests.some(item => item.path === '/api/workspaces/validate')).toBe(true);
    expect(api.requests.some(item => item.path === '/api/workspaces/trust')).toBe(false);
  });

  test('recharge inventaire et confiance après un échec de transaction MCP projet', async ({ page }) => {
    const api = await installMockApi(page, {
      workspaceTrusted: true,
      workspaceOperationTrusted: false,
      mcpConfig: mcpFreshProjectInventory(),
      mcpImportPreview: mcpFreshProjectPreviewFixture(),
    });
    await page.route('**/api/mcp/actions', async route => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Internal rollback detail must not render.',
          code: 'write-failed',
          uncertain: false,
          trustKept: true,
        }),
      });
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.getByText('Paste and preview a server').click();
    await section.getByLabel('MCP server text').fill('npx -y fresh-mcp-tools');
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await section.getByRole('button', { name: 'Configure project import' }).click();
    const dialog = page.getByRole('dialog', { name: 'Configure MCP import' });
    await dialog.getByLabel(/I trust this fresh project folder/u).check();
    const readsBefore = api.requests.filter(request => request.path === '/api/mcp').length;
    await dialog.getByRole('button', { name: 'Save atomically' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(section).toContainText('The MCP import failed. The canonical inventory was reloaded.');
    await expect(section).not.toContainText('Internal rollback detail must not render.');
    await expect(section.getByRole('article', { name: /fresh-tools: Configured/u })).toHaveCount(0);
    await expect.poll(() => api.requests.filter(request => request.path === '/api/mcp').length)
      .toBeGreaterThan(readsBefore);
    await expect.poll(() => api.requests.some(request => request.path === '/api/workspaces/validate'))
      .toBe(true);
  });

  test('remplace une entrée MCP depuis le texte original et restaure le focus après renommage', async ({ page }) => {
    const api = await installMockApi(page, {
      mcpConfig: mcpStateInventory(),
      mcpImportPreview: mcpImportPreviewFixture(),
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const edit = section.getByRole('button', { name: 'Edit remote-docs', exact: true });

    await edit.click();
    await expect(section.getByText('Replace remote-docs', { exact: true })).toBeVisible();
    await expect(section.getByLabel('Replacement MCP server text')).toBeFocused();
    await section.getByRole('button', { name: 'Cancel editing' }).click();
    await expect(edit).toBeFocused();

    await edit.click();
    const paste = '{"mcpServers":{"docs-import":{"url":"https://docs.example.test/private?token=SOURCE-EDIT-SECRET","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}}}';
    await section.getByLabel('Replacement MCP server text').fill(paste);
    await section.getByLabel('Treat resolved values as AiHarness syntax').check();
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(section.getByRole('heading', { name: 'Redacted replacement preview' })).toBeVisible();
    await section.getByRole('button', { name: 'Configure replacement' }).click();

    const dialog = page.getByRole('dialog', { name: 'Configure MCP replacement' });
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    await dialog.getByLabel('Server name').fill('remote-docs-v2');
    await dialog.getByRole('group', { name: 'headers.X-Tenant' }).getByLabel('Value').fill('tenant-value');
    await dialog.getByLabel('I confirm storing the remaining literal secret values in global configuration.').check();
    await dialog.getByLabel(/I confirm that these host variables may be sent/u).check();
    await dialog.getByRole('button', { name: 'Replace atomically' }).click();

    await expect(section).toContainText('MCP configuration updated.');
    await expect(section.getByRole('article', { name: 'remote-docs-v2: Configured', exact: true })).toBeVisible();
    await expect(section.getByRole('article', { name: /remote-docs:/u })).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Edit remote-docs-v2', exact: true })).toBeFocused();
    await expect(section).not.toContainText('SOURCE-EDIT-SECRET');

    const previewRequest = api.requests.find(item => item.path === '/api/mcp/preview'
      && Boolean((item.body as { replacement?: unknown } | undefined)?.replacement));
    expect(previewRequest?.body).toEqual({
      text: paste,
      syntax: 'aiharness',
      cwd: '/workspace',
      replacement: {
        scope: 'global', name: 'remote-docs', revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    const request = api.requests.find(item => item.path === '/api/mcp/actions'
      && (item.body as { action?: string } | undefined)?.action === 'replace');
    expect(request?.body).toEqual({
      action: 'replace', scope: 'global', revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      targetName: 'remote-docs', text: paste, syntax: 'aiharness', entryIndex: 0,
      name: 'remote-docs-v2', values: { 'headers.X-Tenant': 'tenant-value' },
      secretReferences: {},
      confirmations: { literalSecret: true, remoteHostVariables: ['DOCS_TOKEN'] },
      cwd: '/workspace',
    });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
  });

  test('invalide l’éditeur MCP et recharge après un résultat de remplacement incertain', async ({ page }) => {
    const api = await installMockApi(page, {
      mcpConfig: mcpStateInventory(),
      mcpImportPreview: mcpImportPreviewFixture(),
    });
    await page.route('**/api/mcp/actions', async route => {
      const body = route.request().postDataJSON() as { action?: string };
      if (body.action !== 'replace') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'uncertain', code: 'write-failed', uncertain: true }),
      });
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const edit = section.getByRole('button', { name: 'Edit remote-docs', exact: true });
    const readsBefore = api.requests.filter(request => request.path === '/api/mcp').length;

    await edit.click();
    await section.getByLabel('Replacement MCP server text').fill('npx replacement-server');
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await section.getByRole('button', { name: 'Configure replacement' }).click();
    const dialog = page.getByRole('dialog', { name: 'Configure MCP replacement' });
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    await dialog.getByRole('group', { name: 'headers.X-Tenant' }).getByLabel('Value').fill('tenant-value');
    await dialog.getByLabel('I confirm storing the remaining literal secret values in global configuration.').check();
    await dialog.getByLabel(/I confirm that these host variables may be sent/u).check();
    await dialog.getByRole('button', { name: 'Replace atomically' }).click();

    await expect(section).toContainText('The action result is uncertain and may have been committed. The inventory was reloaded.');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/mcp').length)
      .toBeGreaterThan(readsBefore);
    await expect(section.getByText('Replace remote-docs', { exact: true })).toHaveCount(0);
    await expect(edit).toBeFocused();
    await expect(section.getByRole('article', { name: 'remote-docs: Configured', exact: true })).toBeVisible();
  });

  test('active et désactive les serveurs MCP par ligne ou groupe en une requête', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const global = section.locator('fieldset[data-scope="global"]');

    await global.getByRole('button', { name: 'Disable all', exact: true }).click();
    await expect(global.getByRole('article', { name: 'remote-docs: Disabled', exact: true })).toBeVisible();
    await expect(global.getByRole('article', { name: 'shared: Replaced by project', exact: true })).toBeVisible();
    await expect(section).toContainText('MCP configuration updated.');
    const groupRequest = api.requests.find(request => request.path === '/api/mcp/actions');
    expect(groupRequest?.body).toMatchObject({
      action: 'set-enabled', scope: 'global', names: ['remote-docs', 'shared'], enabled: false,
    });

    await global.getByRole('button', { name: 'Enable local-tools', exact: true }).click();
    await expect(global.getByRole('article', { name: 'local-tools: Configured', exact: true })).toBeVisible();
    const mutationRequests = api.requests.filter(request => request.path === '/api/mcp/actions');
    expect(mutationRequests).toHaveLength(2);
    expect(mutationRequests[1]?.body).toMatchObject({
      action: 'set-enabled', scope: 'global', names: ['local-tools'], enabled: true,
    });
  });

  test('modifie l’exposition MCP atomiquement et restaure le focus du sélecteur', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const card = section.getByRole('article', { name: 'remote-docs: Configured', exact: true });
    const exposure = card.getByRole('combobox', { name: 'Tool exposure for remote-docs' });

    await expect(exposure).toHaveValue('deferred');
    await exposure.selectOption('direct');
    await expect(exposure).toHaveValue('direct');
    await expect(exposure).toBeFocused();
    await expect(section).toContainText('MCP configuration updated.');

    const request = api.requests.find(item => item.path === '/api/mcp/actions'
      && (item.body as { action?: string } | undefined)?.action === 'set-exposure');
    expect(request?.body).toEqual({
      action: 'set-exposure', scope: 'global', name: 'remote-docs', exposure: 'direct',
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u), cwd: '/workspace',
    });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
  });

  test('confirme une suppression MCP, restaure le focus et utilise un undo opaque', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const remove = section.getByRole('button', { name: 'Remove remote-docs', exact: true });

    await remove.click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove MCP server?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(remove).toBeFocused();

    await remove.click();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(section.getByRole('article', { name: /remote-docs:/u })).toHaveCount(0);
    const undo = section.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeFocused();
    const removalRequest = api.requests.find(request => request.path === '/api/mcp/actions'
      && (request.body as { action?: string } | undefined)?.action === 'remove');
    expect(removalRequest?.body).toMatchObject({ action: 'remove', scope: 'global', name: 'remote-docs' });

    await undo.click();
    await expect(section.getByRole('article', { name: 'remote-docs: Configured', exact: true })).toBeVisible();
    const restoreRequest = api.requests.find(request => request.path === '/api/mcp/actions'
      && (request.body as { action?: string } | undefined)?.action === 'restore');
    expect(restoreRequest?.body).toMatchObject({ action: 'restore', undoToken: expect.any(String) });
    expect(Object.keys(restoreRequest?.body as object)).not.toContain('entry');
  });

  test('recharge l’inventaire après un échec MCP au résultat incertain', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.route('**/api/mcp/actions', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'uncertain', code: 'write-failed', uncertain: true }),
      });
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const readsBefore = api.requests.filter(request => request.path === '/api/mcp').length;

    await section.getByRole('button', { name: 'Disable remote-docs', exact: true }).click();
    await expect(section).toContainText('The action result is uncertain and may have been committed. The inventory was reloaded.');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/mcp').length)
      .toBeGreaterThan(readsBefore);
    await expect(section.getByRole('article', { name: 'remote-docs: Configured', exact: true })).toBeVisible();
  });

  for (const reason of MCP_FILE_PROBLEM_REASONS) {
    test(`localise le diagnostic MCP ${reason} sans afficher le message source`, async ({ page }) => {
      const trustProblem = reason === 'trust-required' || reason === 'trust-unavailable';
      await installMockApi(page, {
        workspaceTrusted: !trustProblem,
        mcpConfig: mcpFileProblemInventory(reason),
      });
      await page.goto('/settings#mcp');
      const section = page.locator('#mcp');

      await section.getByText('Configuration file diagnostics').click();
      await expect(section).toContainText(MCP_FILE_PROBLEM_MESSAGES[reason]);
      await expect(section).not.toContainText('SOURCE-DIAGNOSTIC-MUST-NOT-RENDER');
    });
  }

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

    const globalGroup = section.locator('fieldset[data-scope="global"]');
    const disableRequestPromise = page.waitForRequest(request => request.url().endsWith('/api/plugins/enabled'));
    await globalGroup.getByRole('button', { name: 'Disable all (1)' }).click();
    const disableRequest = await disableRequestPromise;
    expect(disableRequest.method()).toBe('PATCH');
    expect(disableRequest.postDataJSON().changes).toEqual([{
      key: 'global:global:11111111111111111111', scope: 'global', enabled: false,
    }]);
    await expect(globalCard.getByRole('checkbox')).not.toBeChecked();
    await expect(section.getByText('Executable extension changes are pending.', { exact: false })).toBeVisible();
    await globalGroup.getByRole('button', { name: 'Enable all (1)' }).click();
    await expect(globalCard.getByRole('checkbox')).toBeChecked();

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

  test('refuse indépendamment une activation groupée projet sans confiance', async ({ page }) => {
    await installMockApi(page, { workspaceTrusted: false });
    await page.goto('/settings#plugins');
    const section = page.locator('#plugins');
    const projectGroup = section.locator('fieldset[data-scope="project"]');
    const projectCard = projectGroup.locator('.plugin-card').filter({ hasText: 'workspace-kit' });

    await projectGroup.getByRole('button', { name: 'Disable all (1)' }).click();
    await expect(projectCard.getByRole('checkbox')).not.toBeChecked();
    await expect(section.getByText('Executable extension changes are pending.', { exact: false })).toBeVisible();
    const requestPromise = page.waitForRequest(request => request.url().endsWith('/api/plugins/enabled'));
    await projectGroup.getByRole('button', { name: 'Enable all (1)' }).click();
    const request = await requestPromise;
    expect(request.method()).toBe('PATCH');
    expect(request.postDataJSON().changes).toEqual([{
      key: 'project:workspace-e2e:22222222222222222222', scope: 'project', enabled: true,
    }]);
    await expect(section.getByRole('alert')).toContainText('Changed: 0 · unchanged: 0 · refused: 1.');
    await expect(section).toContainText('workspace-kit: Project trust is required.');
    await expect(projectCard.getByRole('checkbox')).not.toBeChecked();
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
