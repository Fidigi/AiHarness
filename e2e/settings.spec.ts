import { expect, test, type Page } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

function settingsSection(page: Page, heading: string) {
  return page.getByRole('heading', { name: heading, exact: true }).locator('..');
}

test.describe('Réglages', () => {
  test('présente les fournisseurs hydratés et le nombre de sessions', async ({ page }) => {
    await installMockApi(page, {
      sessions: [
        mockSession('first-session', 'Première'),
        mockSession('second-session', 'Deuxième'),
      ],
      providers: [
        { type: 'mock', configured: true },
        { type: 'openai', configured: true },
      ],
    });

    await page.goto('/settings');

    const provider = settingsSection(page, 'AI Provider');
    await expect(provider.locator('select')).toHaveValue('mock');
    await provider.locator('select').selectOption('openai');
    await expect(provider.getByText('✅ OpenAI configured')).toBeVisible();
    await expect(settingsSection(page, 'Model').locator('select')).toBeEnabled();
    await expect(settingsSection(page, 'Model').locator('option')).toContainText([
      'GPT-4o (Recommended)',
      'GPT-4 Turbo',
      'GPT-3.5 Turbo',
    ]);
    await expect(settingsSection(page, 'Sessions')).toContainText('Total sessions: 2');
  });

  test('enregistre une clé fournisseur côté serveur puis masque sa valeur', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings');

    const openAiRow = page.locator('.api-key-row').filter({
      has: page.getByText('OpenAI', { exact: true }),
    });
    const keyInput = openAiRow.locator('input');
    await keyInput.fill('sk-e2e-secret');
    await openAiRow.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('OpenAI configured on the server.')).toBeVisible();
    await expect(keyInput).toHaveValue('••••••••');
    await expect.poll(() => api.requests.filter((request) => (
      request.method === 'POST' && request.path === '/api/config'
    )).map((request) => request.body)).toEqual([
      { type: 'openai', apiKey: 'sk-e2e-secret' },
    ]);
  });

  test('signale un échec de configuration fournisseur', async ({ page }) => {
    await installMockApi(page, { configureProviderError: true });
    await page.goto('/settings');

    const anthropicRow = page.locator('.api-key-row').filter({
      has: page.getByText('Anthropic', { exact: true }),
    });
    await anthropicRow.locator('input').fill('invalid-key');
    await anthropicRow.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('HTTP 500')).toBeVisible();
    await expect(anthropicRow.locator('input')).toHaveValue('invalid-key');
  });

  test('applique le Bearer token aux requêtes suivantes sans le persister durablement', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings');

    const authentication = settingsSection(page, 'Server authentication');
    await authentication.getByPlaceholder('Bearer token').fill('  e2e-token  ');
    await authentication.getByRole('button', { name: 'Apply' }).click();
    await expect(authentication.getByText('Token applied to this tab.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('ai-harness-auth-token')))
      .toBe('e2e-token');
    expect(await page.evaluate(() => localStorage.getItem('ai-harness-auth-token'))).toBeNull();

    await page.getByRole('button', { name: 'New chat' }).click();

    await expect.poll(() => api.requests.find((request) => (
      request.method === 'POST' && request.path === '/api/sessions'
    ))?.headers.authorization).toBe('Bearer e2e-token');
  });

  test('mémorise le transport choisi', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/settings');

    const transport = settingsSection(page, 'Real-time transport').locator('select');
    await transport.selectOption('websocket');

    await expect.poll(() => page.evaluate(() => localStorage.getItem('ai-harness-transport')))
      .toBe('websocket');
    await page.reload();
    await expect(settingsSection(page, 'Real-time transport').locator('select'))
      .toHaveValue('websocket');
  });

  test('bascule entre les thèmes sombre et clair', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/settings');

    const appearance = settingsSection(page, 'Appearance');
    await appearance.getByRole('button', { name: /Dark Mode/ }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await appearance.getByRole('button', { name: /Light Mode/ }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });
});
