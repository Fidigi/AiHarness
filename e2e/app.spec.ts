import { expect, test } from '@playwright/test';
import { installMockApi } from './fixtures/mock-api';

test.describe('Application shell', () => {
  test('affiche l’état vide et permet d’ouvrir les réglages', async ({ page }) => {
    await installMockApi(page);

    await page.goto('/');

    await expect(page).toHaveTitle(/AiHarness/i);
    await expect(page.getByRole('heading', { name: 'AiHarness', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();
    await expect(page.getByText('Select a conversation or create a new one.')).toBeVisible();

    await page.getByRole('button', { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('reste navigable lorsque l’API est indisponible', async ({ page }) => {
    const api = await installMockApi(page, { unavailable: true });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New chat' })).toBeEnabled();

    await page.getByRole('button', { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings$/);
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

  for (const viewport of [
    { name: 'mobile', width: 375, height: 667 },
    { name: 'tablette', width: 768, height: 1024 },
  ]) {
    test(`s’adapte au viewport ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installMockApi(page);

      await page.goto('/');

      await expect(page.locator('body')).toBeVisible();
      await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
      await expect(page.getByRole('button', { name: /settings/i })).toBeVisible();
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth).toBeLessThanOrEqual(viewport.width);
    });
  }
});
