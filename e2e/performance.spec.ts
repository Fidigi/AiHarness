import { expect, test } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

const longMessages = Array.from({ length: 320 }, (_, index) => ({
  role: index % 2 ? 'assistant' as const : 'user' as const,
  content: `Performance message ${index + 1}: ${'bounded content '.repeat(8)}`,
}));

test.describe('Budgets et longues conversations', () => {
  test('virtualise une conversation longue et restaure sa vue bornée avant le réseau', async ({ page }) => {
    const longSession = mockSession('long', 'Long session', longMessages);
    longSession.providerConfig = { type: 'mock', model: 'mock-model', apiKey: 'must-not-reach-session-storage' };
    await installMockApi(page, { sessions: [longSession] });
    await page.goto('/chat/long?cwd=%2Fworkspace#long-message-101');

    const target = page.locator('#long-message-101');
    await expect(target).toBeVisible();
    await expect(page.locator('.messages-container[data-virtualized="true"]')).toBeVisible();
    expect(await page.locator('.message').count()).toBeLessThan(45);
    expect(await page.locator('.virtual-message-list').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(5_000);

    // Let the bounded per-tab cache flush, then make every session request slower than the assertion window.
    const cachedViews = () => page.evaluate(() => JSON.stringify(Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, index) => {
        const key = sessionStorage.key(index) ?? '';
        return [key, sessionStorage.getItem(key) ?? ''];
      }),
    )));
    await expect.poll(cachedViews).toContain('long-message-101');
    expect(await cachedViews()).not.toContain('must-not-reach-session-storage');
    await page.route('**/api/sessions**', async route => {
      await new Promise(resolve => setTimeout(resolve, 4_000));
      await route.fallback();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#long-message-101')).toBeVisible({ timeout: 2_500 });
    expect(await page.locator('.message').count()).toBeLessThan(45);
  });

  test('ne charge le lourd client terminal qu’à sa première ouverture', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', request => requested.push(request.url()));
    await installMockApi(page, { sessions: [mockSession('empty', 'Empty')] });
    await page.goto('/chat/empty');
    await expect(page.getByPlaceholder(/Type your message/)).toBeVisible();
    await page.waitForTimeout(150);
    expect(requested.some(url => url.includes('TerminalPanel') || url.includes('@xterm'))).toBe(false);

    await page.getByRole('button', { name: 'Open workspace terminal' }).click();
    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    expect(requested.some(url => url.includes('TerminalPanel') || url.includes('@xterm'))).toBe(true);
  });
});
