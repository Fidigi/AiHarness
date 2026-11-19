import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';
import { expectContrast } from './fixtures/contrast';

async function expectAccessible(page: Page, context?: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map(node => node.target.join(' ')),
  })), context).toEqual([]);
  for (const icon of await page.locator('svg.ui-icon:visible').all()) {
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon).toHaveAttribute('focusable', 'false');
  }
  const controls = page.locator('button:visible:has(> svg.ui-icon), a:visible:has(> svg.ui-icon)');
  for (const control of await controls.all()) {
    if (await control.evaluate(element => Boolean(element.closest('[inert], [aria-hidden="true"]')))) continue;
    await expect(control).toHaveAccessibleName(/\S/);
    const bounds = await control.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(24);
    expect(bounds?.height).toBeGreaterThanOrEqual(24);
  }
}

async function expectChatControlsToFit(page: Page): Promise<void> {
  await expect(page.locator('.composer-controls input[list="model-suggestions"]')).toBeVisible();
  const controls = page.locator('.chat-toolbar :is(button, a):visible, .composer-controls :is(input:not([type="file"]), select, button):visible, .composer-setting-scopes > :is(details, span):visible');
  await expect.poll(() => controls.evaluateAll(elements => elements.flatMap(element => {
    const bounds = element.getBoundingClientRect(), main = element.closest('.main-content')!.getBoundingClientRect();
    const unreadableModel = element.matches('[list="model-suggestions"]') && bounds.width < 160;
    return unreadableModel || bounds.left < main.left || bounds.right > main.right
      ? [{ name: element.getAttribute('aria-label') || element.textContent?.trim(), left: bounds.left, right: bounds.right, width: bounds.width, mainRight: main.right }]
      : [];
  }))).toEqual([]);
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
    await installMockApi(page, { sessions: [session], workspaceFiles: [{ path: 'accessible.md', content: '# Accessible reader' }] });
    await page.goto('/chat/accessible');
    await expect(page.getByPlaceholder(/Type your message/)).toBeVisible();
    await expectAccessible(page, 'chat and workspace explorer (light)');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expectAccessible(page, 'chat and workspace explorer (dark)');
    const explorer = page.getByRole('region', { name: 'Workspace explorer' });
    await explorer.getByRole('button', { name: 'File options', exact: true }).click();
    await expectAccessible(page, 'file options (dark)');
    await page.keyboard.press('Escape');
    await explorer.getByRole('button', { name: 'Upload files', exact: true }).click();
    await expectAccessible(page, 'file upload policy (dark)');
    await page.keyboard.press('Escape');
    await explorer.getByRole('button', { name: 'accessible.md', exact: true }).click();
    await page.getByRole('button', { name: 'Maximize file viewer', exact: true }).click();
    await expectAccessible(page, 'fullscreen reader (dark)');
    await page.keyboard.press('Escape');

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
    await expect(opener.locator('svg.ui-icon')).toBeVisible();
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

  for (const locale of ['en', 'fr'] as const) {
    test(`icon hints preserve keyboard focus, translated names and mode states: ${locale}`, async ({ page }) => {
      await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
        version: 4, theme, filesOpen: true, sidebarVisible: true,
      })), locale === 'en' ? 'light' : 'dark');
      await installMockApi(page, { sessions: [mockSession('hints', 'Icon hints')],
        workspaceFiles: [{ path: 'hint.md', content: '# Hint' }, { path: 'binary.bin', content: '', binary: true }] });
      await page.goto('/chat/hints');
      await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption(locale);
      const language = page.getByRole('combobox', { name: locale === 'en' ? 'Language' : 'Langue', exact: true });
      const newChat = page.getByRole('button', { name: locale === 'en' ? 'New chat' : 'Nouvelle conversation', exact: true });
      const hint = page.locator('.icon-control-hint');
      await language.focus(); await page.keyboard.press('Tab');
      await expect(newChat).toBeFocused();
      await expect(hint).toHaveText(await newChat.getAttribute('aria-label') as string);
      await expect(hint).toBeInViewport({ ratio: 1 });
      await expectContrast(hint.locator('span'));
      await expectContrast(hint.locator('span'), 'borderTopColor', 3);
      await expectAccessible(page, `keyboard hint (${locale})`);
      await hint.hover(); await expect(hint).toBeVisible();
      await hint.click(); await expect(newChat).toBeFocused();
      await expect(page).toHaveURL(/\/chat\/hints$/);
      await page.keyboard.press('Escape');
      await expect(hint).toHaveCount(0); await expect(newChat).toBeFocused();

      await page.locator('.file-name').filter({ hasText: 'hint.md' }).click();
      const reader = page.getByRole('complementary', { name: locale === 'en' ? 'File reader' : 'Lecteur de fichiers' });
      const source = reader.getByRole('button', { name: 'Source', exact: true });
      const preview = reader.getByRole('button', { name: locale === 'en' ? 'Preview' : 'Aperçu', exact: true });
      await expectChatControlsToFit(page);
      await expect(source).toHaveAttribute('aria-pressed', 'true');
      await preview.click();
      await expect(preview).toHaveAttribute('aria-pressed', 'true');
      await expect(source).toHaveAttribute('aria-pressed', 'false');
      await reader.locator('.viewer-path').focus(); await page.keyboard.press('Tab');
      const maximize = reader.getByRole('button', { name: locale === 'en' ? 'Maximize file viewer' : 'Agrandir le viewer', exact: true });
      await expect(maximize).toBeFocused(); await expect(hint).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(reader.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(reader.getByRole('dialog')).toHaveCount(0); await expect(maximize).toBeFocused();

      await reader.getByRole('link', { name: locale === 'en' ? 'Download' : 'Télécharger', exact: true }).focus();
      await page.keyboard.press('Tab');
      const terminal = page.getByRole('button', { name: locale === 'en' ? 'Open workspace terminal' : 'Ouvrir le terminal du workspace', exact: true });
      await expect(terminal).toBeFocused();
      await expect(hint).toHaveText(await terminal.getAttribute('aria-label') as string);
      await expect(hint).toBeInViewport({ ratio: 1 });
      const box = (await hint.boundingBox())!, target = (await terminal.boundingBox())!;
      expect(box.y + box.height <= target.y || box.y >= target.y + target.height).toBe(true);
      await test.info().attach(`icon-hint-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
      await page.locator('.file-name').filter({ hasText: 'binary.bin' }).click();
      const copy = reader.getByRole('button', { name: locale === 'en' ? 'Copy' : 'Copier', exact: true });
      await expect(copy).toBeDisabled(); await expect(copy).toHaveCSS('opacity', '0.6');
      const explorer = page.locator('.workspace-explorer');
      const files = explorer.getByRole('button', { name: locale === 'en' ? 'Files' : 'Fichiers', exact: true });
      const changes = explorer.getByRole('button', { name: locale === 'en' ? /^Changes/ : /^Modifications/ });
      await expect(files).toHaveAttribute('aria-pressed', 'true');
      await changes.click(); await expect(changes).toHaveAttribute('aria-pressed', 'true');
      await expect(files).toHaveAttribute('aria-pressed', 'false'); await files.click();
      const refresh = explorer.getByRole('button', { name: locale === 'en' ? 'Refresh files' : 'Actualiser les fichiers', exact: true });
      const resting = await refresh.evaluate(element => getComputedStyle(element).backgroundColor);
      await refresh.hover(); await expect(hint).toHaveText(await refresh.getAttribute('aria-label') as string);
      await expect(refresh).not.toHaveCSS('background-color', resting);
      await expectContrast(refresh, 'color', 3);
      await hint.hover(); await expect(hint).toBeVisible(); await refresh.hover();
      await page.mouse.down();
      try { await expect(refresh).toHaveCSS('box-shadow', /inset/); }
      finally { await page.mouse.up(); }
      await page.mouse.move(600, 200); await expect(hint).toHaveCount(0);
      await expectAccessible(page, `icon utilities (${locale})`);
      await page.setViewportSize({ width: 960, height: 720 });
      await expectChatControlsToFit(page);
      await reader.locator('.viewer-path').focus(); await page.keyboard.press('Tab');
      await expect(hint).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(hint).toHaveCount(0);
    });
  }
});
