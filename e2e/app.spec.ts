import { expect, test } from '@playwright/test';
import { installMockApi } from './fixtures/mock-api';

test.describe('Application shell', () => {
  test('expose le manifeste et le fallback hors ligne de la PWA', async ({ request }) => {
    const manifestResponse = await request.get('/manifest.webmanifest');
    expect(manifestResponse.ok()).toBe(true);
    expect(await manifestResponse.json()).toMatchObject({
      name: 'AiHarness',
      start_url: '/',
      display: 'standalone',
    });
    await expect.poll(async () => (await request.get('/sw.js')).status()).toBe(200);
    await expect.poll(async () => (await request.get('/offline.html')).status()).toBe(200);
  });

  test('conserve un shell utile hors ligne via le service worker', async ({ page, context }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();
      await expect(page.getByText(/Offline.*server actions/i)).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('affiche l’état vide et permet d’ouvrir les réglages', async ({ page }) => {
    await installMockApi(page);

    await page.goto('/');

    await expect(page).toHaveTitle(/AiHarness/i);
    await expect(page.getByRole('heading', { name: 'AiHarness', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();
    await expect(page.getByText('Select a conversation or create a new one.')).toBeVisible();

    await page.getByRole('button', { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings(?:\?|$)/);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('reste navigable lorsque l’API est indisponible', async ({ page }) => {
    const api = await installMockApi(page, { unavailable: true });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New chat' })).toBeEnabled();

    await page.getByRole('button', { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings(?:\?|$)/);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect.poll(() => api.requests.length).toBeGreaterThanOrEqual(2);
  });

  test('gère une route inconnue sans faire disparaître la navigation', async ({ page }) => {
    await installMockApi(page);

    await page.goto('/route-inconnue');

    await expect(page.getByRole('heading', { name: 'AiHarness', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
    await expect(page.locator('main')).toBeVisible();
  });

  test('demande une approbation explicite avant de faire confiance au projet', async ({ page }) => {
    const api = await installMockApi(page, { workspaceTrusted: false });

    await page.goto('/');

    await page.getByRole('button', { name: /Project not trusted/i }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Trust this project?' });
    await expect(dialog).toContainText('/workspace');
    await expect(dialog).toContainText(/execute code and modify files/i);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: /Project not trusted/i }).click();
    await dialog.getByRole('button', { name: 'Trust project' }).click();

    await expect(page.getByRole('button', { name: /Project not trusted/i })).toHaveCount(0);
    expect(api.requests.some(request => request.method === 'POST'
      && request.path === '/api/workspaces/trust'
      && (request.body as { confirm?: boolean })?.confirm === true)).toBe(true);
  });

  for (const viewport of [
    { name: 'mobile', width: 375, height: 667 },
    { name: 'tablette', width: 768, height: 1024 },
  ]) {
    test(`s’adapte au viewport ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installMockApi(page);

      await page.goto('/');

      await expect(page.locator('body')).toBeVisible();
      await expect(page.getByRole('button', { name: 'New chat' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await expect(page.getByRole('dialog', { name: 'Main navigation' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
      await expect(page.getByRole('button', { name: /settings/i })).toBeVisible();
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth).toBeLessThanOrEqual(viewport.width);
    });
  }
});
