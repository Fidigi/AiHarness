import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

async function expectAccessible(page: Page, context?: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map(node => node.target.join(' ')),
  })), context).toEqual([]);
}

test.describe('Accessibilité des parcours majeurs', () => {
  test('la connexion est accessible au clavier et sans violation en clair/sombre', async ({ page }) => {
    await installMockApi(page, {
      authRequired: true,
      authToken: 'accessible-token',
      sessions: [mockSession('protected', 'Protected accessible session')],
    });
    await page.goto('/chat/protected');
    const token = page.getByLabel('Access token');
    await expect(token).toBeFocused();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await expectAccessible(page, 'login (light)');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expectAccessible(page, 'login (dark)');
    await token.fill('accessible-token');
    await token.press('Enter');
    await expect(token).toHaveCount(0);
    await expect(page.getByText('Protected accessible session', { exact: true }).first()).toBeVisible();
  });

  test('chat, explorer et réglages ne présentent aucune violation WCAG automatisable', async ({ page }) => {
    const session = mockSession('accessible', 'Accessible session', [
      { role: 'user', content: 'Inspect the project' },
      { role: 'assistant', content: '# Result\n\nA safe [external link](https://example.com).\n\n- Item one\n- Item two' },
    ]);
    await installMockApi(page, { sessions: [session] });
    await page.goto('/chat/accessible');
    await expect(page.getByPlaceholder(/Type your message/)).toBeVisible();
    await expectAccessible(page, 'chat and workspace explorer (light)');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expectAccessible(page, 'chat and workspace explorer (dark)');

    await page.goto('/settings#appearance');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByText('Manage model catalogue').click();
    await expect(page.getByLabel('Filter models or providers')).toBeVisible();
    await expect(page.getByLabel('Filter skills or sources')).toBeVisible();
    await expect(page.getByLabel('Filter packages')).toBeVisible();
    await expect(page.getByLabel('Filter profiles')).toBeVisible();
    await expectAccessible(page, 'settings, model/skill/plugin catalogues and child agents (dark)');
    await page.getByRole('button', { name: 'Create profile' }).click();
    await expect(page.getByRole('dialog', { name: 'Create profile' })).toBeVisible();
    await expectAccessible(page, 'child-agent profile dialog (dark)');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await expectAccessible(page, 'settings (light)');
  });

  test('le suivi des agents enfants reste accessible en clair et sombre', async ({ page }) => {
    const parent = mockSession('accessible-parent', 'Accessible parent');
    await installMockApi(page, {
      sessions: [parent],
      subagentRuns: [{
        id: 'accessible-run', parentSessionId: parent.id, childSessionId: 'accessible-child',
        workspaceId: 'workspace-e2e', profileId: 'explore', profileName: 'Explore', task: 'Inspect accessibly',
        provider: 'mock', status: 'completed', phase: 'completed', background: true, attention: true,
        turn: 1, maxTurns: 8, startedAt: '2025-01-01T12:00:00.000Z', completedAt: '2025-01-01T12:00:01.000Z',
      }],
    });
    await page.goto(`/chat/${parent.id}`);
    await page.getByRole('button', { name: 'Open child agents (1)' }).click();
    await expectAccessible(page, 'child-agent panel (light)');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expectAccessible(page, 'child-agent panel (dark)');
  });

  test('piège puis restaure le focus de la palette et respecte Escape', async ({ page }) => {
    await installMockApi(page, { sessions: [mockSession('focus', 'Focus session')] });
    await page.goto('/chat/focus');
    const opener = page.getByRole('button', { name: 'New chat' });
    await opener.focus();
    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    const search = dialog.getByRole('textbox', { name: /Search commands/ });
    await expect(search).toBeFocused();
    await expectAccessible(page, 'command palette (light)');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expectAccessible(page, 'command palette (dark)');

    const lastOption = dialog.getByRole('option').last();
    await lastOption.focus();
    await page.keyboard.press('Tab');
    await expect(search).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('piège et restaure le focus des interactions d’extension déclaratives', async ({ page }) => {
    await installMockApi(page, {
      sessions: [mockSession('extension-a11y', 'Extension accessibility')], holdAgentRun: true,
      extensionInteraction: {
        id: 'a11y-interaction', kind: 'custom', title: 'Accessible approval', message: 'Review the request.',
        createdAt: '2025-01-01T12:00:00.000Z', fields: [
          { name: 'choice', label: 'Choice', type: 'select', required: true, options: [{ value: 'yes', label: 'Yes' }] },
          { name: 'notes', label: 'Notes', type: 'textarea' },
        ],
      },
    });
    await page.goto('/chat/extension-a11y');
    await page.getByPlaceholder(/Type your message/).fill('Open approval');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await send.click();
    const dialog = page.getByRole('dialog', { name: 'Accessible approval' });
    await expect(dialog.getByLabel('Choice')).toBeFocused();
    await expectAccessible(page, 'extension interaction (light)');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expectAccessible(page, 'extension interaction (dark)');
    await dialog.getByRole('button', { name: 'Submit' }).focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Choice')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByPlaceholder(/Type your message/)).toBeFocused();
  });

  test('valide également la surface terminal chargée à la demande', async ({ page }) => {
    await installMockApi(page, { sessions: [mockSession('terminal-a11y', 'Terminal accessibility')] });
    await page.goto('/chat/terminal-a11y');
    await page.getByRole('button', { name: 'Open workspace terminal' }).click();
    const terminal = page.getByRole('region', { name: 'Terminal' });
    await expect(terminal.locator('.xterm-screen')).toBeVisible();
    await expectAccessible(page, 'terminal');
  });

  test('masque le tiroir mobile au clavier et neutralise les animations réduites', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installMockApi(page, { sessions: [mockSession('mobile-a11y', 'Mobile accessibility')] });
    await page.goto('/chat/mobile-a11y');

    const toggle = page.getByRole('button', { name: 'Toggle navigation' });
    await toggle.click();
    const sidebar = page.getByRole('dialog', { name: 'Main navigation' });
    await expect(sidebar).toBeVisible();
    await expectAccessible(page, 'mobile drawer');
    expect(await sidebar.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
    await page.keyboard.press('Escape');
    await expect(sidebar).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });
});
