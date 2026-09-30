import { test, expect, type Page } from '@playwright/test';

async function mockApi(page: Page): Promise<void> {
  let sessions: any[] = [];
  await page.route('**/api/providers', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify([{ type: 'mock', configured: true }]),
  }));
  await page.route('**/api/sessions', async route => {
    if (route.request().method() === 'POST') {
      const session = { id: 'e2e-session', title: 'New Conversation', messages: [], createdAt: new Date(), updatedAt: new Date() };
      sessions = [session, ...sessions];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(session) });
    } else {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(sessions) });
    }
  });
  await page.route('**/api/sessions/**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ success: true }),
  }));
}

test.beforeEach(async ({ page }) => mockApi(page));

test.describe('AiHarness Web', () => {
  test('charge l’application et sa page vide', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/AiHarness/i);
    await expect(page.getByRole('heading', { name: 'AiHarness', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();
  });

  test('navigue vers les réglages', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible();
  });

  test('crée une session et envoie un message de bout en bout', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page).toHaveURL(/\/chat\/e2e-session$/);

    await page.getByPlaceholder(/Type your message/).fill('Hello from Playwright');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.message.user')).toContainText('Hello from Playwright');
    await expect(page.locator('.message.assistant').first()).toContainText('Hello! How can I help you today?', { timeout: 10_000 });
  });

  test('reste utilisable lorsque l’API est indisponible', async ({ page }) => {
    await page.route('**/api/**', route => route.abort('failed'));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'AiHarness', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New chat' })).toBeEnabled();
  });

  for (const viewport of [{ width: 375, height: 667 }, { width: 768, height: 1024 }]) {
    test(`s’affiche dans un viewport ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await expect(page.locator('body')).toBeVisible();
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(viewport.width + 10);
    });
  }

  test('gère une route inconnue sans planter', async ({ page }) => {
    await page.goto('/route-inconnue');
    await expect(page.getByRole('heading', { name: 'AiHarness', exact: true })).toBeVisible();
  });

  test('respecte les bases d’accessibilité', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
    await expect(page.locator('main')).toBeVisible();
  });
});
