import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixtures/test-budget';
import { installTerminalControls } from './fixtures/terminal-controls';

async function open(page: Page, locale = 'en') {
  await page.goto('/');
  await page.getByRole('button', { name: locale === 'fr' ? 'Ouvrir le terminal du workspace' : 'Open workspace terminal', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Terminal', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('native terminal touch controls', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('sends actual touch modifiers and application cursors through the native HTTP owner to a real PTY', async ({ page }) => {
    const workspaceResponse = await page.request.get('/api/workspaces/default'); expect(workspaceResponse.status()).toBe(200);
    const workspace = await workspaceResponse.json() as { cwd: string };
    // Explicit fixture consent through the unchanged administrator/trust route, not a browser permission grant.
    const trust = await page.request.post('/api/workspaces/trust', { data: { cwd: workspace.cwd, confirm: true } });
    expect(trust.status()).toBe(200);
    await page.goto('/'); await expect(page.locator('.workspace-button small')).not.toBeEmpty();
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/terminals' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open workspace terminal', exact: true }).click();
    const response = await created; expect(response.status()).toBe(201);
    const snapshot = await response.json() as { id: string }; expect(typeof snapshot.id).toBe('string');
    try {
      const panel = page.getByRole('region', { name: 'Terminal', exact: true });
      const code = 'process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?1hKEY_"+"PROBE_READY\\r\\n");process.stdin.on("data",b=>{console.log("KEY_HEX="+b.toString("hex"));if(b.equals(Buffer.from([4])))process.exit(0)})';
      // Explicit fixture setup through the unchanged public, trust-gated input route.
      const setup = await page.request.post(`/api/terminals/${encodeURIComponent(snapshot.id)}/input`, { data: { data: `node -e '${code}'\r` } });
      expect(setup.status()).toBe(200);
      await expect(panel.locator('.xterm-rows')).toContainText('KEY_PROBE_READY');
      const keys = panel.getByRole('group', { name: 'Terminal extra keys' });
      await panel.locator('.xterm-helper-textarea').focus();
      await keys.getByRole('button', { name: 'CTRL', exact: true }).tap(); await page.keyboard.type('c');
      await expect(panel.locator('.xterm-rows')).toContainText('KEY_HEX=03');
      await page.keyboard.type('c'); await expect(panel.locator('.xterm-rows')).toContainText('KEY_HEX=63');
      await keys.getByRole('button', { name: 'Up', exact: true }).tap();
      await expect(panel.locator('.xterm-rows')).toContainText('KEY_HEX=1b4f41');
      await panel.getByLabel('Terminal theme', { exact: true }).selectOption('light');
      await expect(panel.locator('.xterm-rows')).toContainText('KEY_HEX=1b4f41');
      await panel.locator('.xterm-helper-textarea').focus();
      await keys.getByRole('button', { name: 'ALT', exact: true }).tap(); await page.keyboard.type('x');
      await expect(panel.locator('.xterm-rows')).toContainText('KEY_HEX=1b78');
      await page.keyboard.type('x'); await expect(panel.locator('.xterm-rows')).toContainText('KEY_HEX=78');
      await panel.locator('.xterm-helper-textarea').focus(); await keys.getByRole('button', { name: 'CTRL', exact: true }).tap(); await page.keyboard.type('d');
      await expect(panel.locator('.xterm-rows')).toContainText('KEY_HEX=04');
    } finally {
      const removed = await page.request.delete(`/api/terminals/${encodeURIComponent(snapshot.id)}`);
      expect(removed.status()).toBe(200);
    }
  });
  test('owns one-shot modifiers and cursor modes without blurring the terminal or duplicating touch input', async ({ page }) => {
    const f = await installTerminalControls(page);
    const panel = await open(page);
    await expect(panel.locator('.xterm-rows')).toContainText('TERMINAL_CONTROLS_READY');
    const keys = panel.getByRole('group', { name: 'Terminal extra keys' });
    const textarea = panel.locator('.xterm-helper-textarea');
    await textarea.focus(); await expect(textarea).toBeFocused();
    await keys.getByRole('button', { name: 'CTRL', exact: true }).tap();
    await expect(keys.getByRole('button', { name: 'CTRL', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(textarea).toBeFocused();
    await page.keyboard.type('c');
    await expect.poll(() => [...f.input]).toEqual(['\x03']);
    await expect(keys.getByRole('button', { name: 'CTRL', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type('c');
    await keys.getByRole('button', { name: 'ALT', exact: true }).tap();
    await page.keyboard.type('x'); await page.keyboard.type('x');
    await keys.getByRole('button', { name: 'Up', exact: true }).tap();
    await expect.poll(() => [...f.input]).toEqual(['\x03', 'c', '\x1bx', 'x', '\x1b[A']);
    f.applicationCursor(true); await expect(panel.locator('.xterm-rows')).toContainText('APP_CURSOR_ON');
    await keys.getByRole('button', { name: 'Up', exact: true }).tap();
    await keys.getByRole('button', { name: 'CTRL', exact: true }).tap();
    await keys.getByRole('button', { name: 'ALT', exact: true }).tap();
    await keys.getByRole('button', { name: 'Left', exact: true }).tap();
    await keys.getByRole('button', { name: 'TAB', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect.poll(() => f.input.slice(-3)).toEqual(['\x1bOA', '\x1b[1;7D', '\t']);
    await expect(keys.getByRole('button', { name: 'CTRL', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(keys.getByRole('button', { name: 'ALT', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(f.counts().created).toBe(1); expect(f.counts().deleted).toBe(0);
  });

  test('disables pending/disconnected/exited input and clears stale one-shot intent on recovery', async ({ page }) => {
    const f = await installTerminalControls(page, true);
    const panel = await open(page), keys = panel.getByRole('group', { name: 'Terminal extra keys' });
    await expect(keys.getByRole('button', { name: 'CTRL', exact: true })).toBeDisabled();
    f.release(); await expect(keys.getByRole('button', { name: 'CTRL', exact: true })).toBeEnabled();
    await keys.getByRole('button', { name: 'CTRL', exact: true }).tap(); f.disconnect(true);
    await expect(panel.getByRole('alert')).toContainText('Terminal connection unavailable');
    await expect(keys.getByRole('button', { name: 'CTRL', exact: true })).toBeDisabled();
    await expect(keys.getByRole('button', { name: 'CTRL', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await panel.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('x'); expect(f.input).toEqual([]);
    f.disconnect(false); await expect(keys.getByRole('button', { name: 'CTRL', exact: true })).toBeEnabled();
    await panel.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('x');
    await expect.poll(() => [...f.input]).toEqual(['x']);
    f.exit(); await expect(keys.getByRole('button', { name: 'Up', exact: true })).toBeDisabled();
    await page.keyboard.type('z'); expect(f.input).toEqual(['x']);
    expect(f.counts().created).toBe(1);
  });

  test('keeps the same live xterm through terminal-only theme changes and viewport/keyboard geometry', async ({ page }) => {
    const f = await installTerminalControls(page); const panel = await open(page);
    await expect(panel.locator('.xterm-rows')).toContainText('TERMINAL_CONTROLS_READY');
    await panel.locator('.xterm').evaluate(node => node.setAttribute('data-owned-terminal', 'original'));
    const appTheme = await page.locator('html').getAttribute('data-theme');
    await panel.getByLabel('Terminal theme', { exact: true }).selectOption('light');
    await expect(panel.locator('.terminal-surface')).toHaveAttribute('data-terminal-theme', 'light');
    await expect(panel.locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
    await expect(panel.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
    await expect(panel.locator('.xterm')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
    await expect(page.locator('html')).toHaveAttribute('data-theme', appTheme!);
    await expect(panel.locator('.xterm[data-owned-terminal="original"]')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 570 });
    await expect(panel.locator('.xterm[data-owned-terminal="original"]')).toHaveCount(1);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(panel.getByRole('group', { name: 'Terminal extra keys' })).toHaveCount(0);
    await expect(panel.locator('.xterm[data-owned-terminal="original"]')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByRole('group', { name: 'Terminal extra keys' })).toBeVisible();
    await panel.getByLabel('Terminal theme', { exact: true }).selectOption('dark');
    await expect(panel.locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(17, 24, 39)');
    await expect(panel.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgb(17, 24, 39)');
    await expect(panel.locator('.xterm')).toHaveCSS('background-color', 'rgb(17, 24, 39)');
    await expect(panel.locator('.xterm-rows')).toContainText('TERMINAL_CONTROLS_READY');
    expect(f.counts().created).toBe(1); expect(f.counts().deleted).toBe(0);
  });
});

test('optional denied storage and genuine peer storage events do not restart a terminal', async ({ page, context }) => {
  const f = await installTerminalControls(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key === 'ai-harness-terminal-theme-v1') throw new DOMException('Optional storage denied', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  const panel = await open(page);
  await expect(panel.locator('.xterm-rows')).toContainText('TERMINAL_CONTROLS_READY');
  await panel.getByLabel('Terminal theme', { exact: true }).selectOption('light');
  await expect(panel.locator('.terminal-surface')).toHaveAttribute('data-terminal-theme', 'light');
  await panel.getByRole('button', { name: 'Hide terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Open workspace terminal', exact: true }).click();
  await expect(panel.getByLabel('Terminal theme', { exact: true })).toHaveValue('light');
  await panel.locator('.xterm').evaluate(node => node.setAttribute('data-owned-terminal', 'peer-witness'));
  const peer = await context.newPage();
  try {
    await peer.route('**/terminal-theme-peer', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Storage peer fixture</title>' }));
    await peer.goto(new URL('/terminal-theme-peer', page.url()).href);
    await peer.evaluate(() => localStorage.setItem('ai-harness-terminal-theme-v1', 'dark'));
    await expect(panel.getByLabel('Terminal theme', { exact: true })).toHaveValue('dark');
    await expect(panel.locator('.xterm[data-owned-terminal="peer-witness"]')).toHaveCount(1);
    expect(f.counts().created).toBe(1); expect(f.counts().deleted).toBe(0);
  } finally { await peer.close(); }
});

for (const scene of [
  { locale: 'en', app: 'light', terminal: 'dark', width: 390, height: 844, touch: true },
  { locale: 'fr', app: 'dark', terminal: 'light', width: 390, height: 844, touch: true },
  { locale: 'en', app: 'dark', terminal: 'light', width: 1440, height: 1000, touch: false },
  { locale: 'fr', app: 'light', terminal: 'dark', width: 1440, height: 1000, touch: false },
] as const) {
  test.describe(`${scene.locale} terminal ${scene.terminal} ${scene.width}`, () => {
    test.use({ viewport: { width: scene.width, height: scene.height }, hasTouch: scene.touch, isMobile: scene.touch });
    test('independent native terminal presentation, persistence, contrast and focus', async ({ page }) => {
      const f = await installTerminalControls(page);
      await page.addInitScript(({ locale, app }) => {
        localStorage.setItem('ai-harness-locale', locale);
        localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: app, filesOpen: false }));
      }, scene);
      const panel = await open(page, scene.locale);
      await expect(panel.locator('.xterm-rows')).toContainText('TERMINAL_CONTROLS_READY');
      const label = scene.locale === 'fr' ? 'Thème du terminal' : 'Terminal theme';
      await panel.getByLabel(label, { exact: true }).selectOption(scene.terminal);
      await expect(panel.locator('.terminal-surface')).toHaveAttribute('data-terminal-theme', scene.terminal);
      const background = scene.terminal === 'light' ? 'rgb(248, 250, 252)' : 'rgb(17, 24, 39)';
      for (const selector of ['.xterm-viewport', '.xterm', '.xterm-scrollable-element']) {
        await expect(panel.locator(selector)).toHaveCSS('background-color', background);
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', scene.app);
      await expect(panel.locator('.terminal-extra-keys')).toHaveCount(scene.touch ? 1 : 0);
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const result = await new AxeBuilder({ page }).include('.terminal-panel').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(result.violations).toEqual([]);
      await panel.locator('.xterm-helper-textarea').focus();
      await expect(panel).toHaveScreenshot(`terminal-controls-${scene.locale}-${scene.terminal}-${scene.width}.png`);
      await page.reload();
      const restored = page.getByRole('region', { name: 'Terminal', exact: true });
      await expect(restored.getByLabel(label, { exact: true })).toHaveValue(scene.terminal);
      await expect(restored.locator('.terminal-surface')).toHaveAttribute('data-terminal-theme', scene.terminal);
      expect(f.counts().created).toBe(1); expect(f.counts().deleted).toBe(0);
    });
  });
}
