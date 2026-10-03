import { expect, test } from '@playwright/test';
import { installMockApi } from './fixtures/mock-api';

test.describe('Internationalisation', () => {
  test('détecte le français puis mémorise un choix explicite', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, 'languages', {
        configurable: true,
        get: () => ['fr-FR', 'en-US'],
      });
      Object.defineProperty(window.navigator, 'language', {
        configurable: true,
        get: () => 'fr-FR',
      });
    });
    await installMockApi(page);

    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page).toHaveTitle('AiHarness - Plateforme unifiée d’agents IA');
    await expect(page.getByRole('heading', { name: 'Bienvenue dans AiHarness' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nouvelle conversation' })).toBeVisible();

    const localeSelector = page.getByLabel('Langue');
    await expect(localeSelector).toHaveValue('fr');
    await expect(localeSelector.locator('option')).toHaveText(['English', 'Français']);
    await localeSelector.selectOption('en');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('ai-harness-locale')))
      .toBe('en');

    await page.reload();
    await expect(page.getByLabel('Language')).toHaveValue('en');
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
  });

  test('traduit les réglages et les valeurs interpolées', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'fr'));
    await installMockApi(page);

    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: 'Réglages', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Authentification du serveur' })).toBeVisible();
    await expect(page.getByText('Nombre total de sessions : 0')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enregistrer' }).first()).toBeVisible();
  });
});
