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

    await expect(page).toHaveURL(/\/chat\/session-one$/);
    await expect(page.locator('.message.user')).toContainText('Question déjà enregistrée');
    await expect(page.locator('.message.assistant')).toContainText('Réponse déjà enregistrée');
    await expect(page.getByPlaceholder(/Type your message/)).toBeEnabled();
  });

  test('crée une session distante avant d’ouvrir le chat', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'New chat' }).click();

    await expect(page).toHaveURL(/\/chat\/e2e-session-1$/);
    await expect(page.getByRole('button', { name: 'Untitled' })).toBeVisible();
    await expect.poll(() => api.requests.filter((request) => (
      request.method === 'POST' && request.path === '/api/sessions'
    )).length).toBe(1);

    const createRequest = api.requests.find((request) => (
      request.method === 'POST' && request.path === '/api/sessions'
    ));
    expect(createRequest?.body).toEqual({});
  });

  test('ne change pas de route si la création distante échoue', async ({ page }) => {
    const api = await installMockApi(page, { createSessionError: true });
    await page.goto('/');

    await page.getByRole('button', { name: 'New chat' }).click();

    await expect.poll(() => api.requests.filter((request) => (
      request.method === 'POST' && request.path === '/api/sessions'
    )).length).toBe(1);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Welcome to AiHarness' })).toBeVisible();
  });
});
