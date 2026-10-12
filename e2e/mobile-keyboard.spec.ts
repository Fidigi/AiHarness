import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';
import { mcpStateInventory } from './fixtures/mcp';

// Match both Vite's dev filename and its exact fingerprinted production asset.
// Keep JS URL-module requests separate by resource type at each interception.
const MOBILE_STYLESHEET_URL = /\/mobile-keyboard(?:-[\w-]+)?\.css(?:[?#]|$)/u;

test('mobile stylesheet matching covers dev and production without unrelated assets', () => {
  for (const url of ['http://localhost:3080/src/hooks/mobile-keyboard.css', 'http://localhost:3080/assets/mobile-keyboard-Biz3w2xO.css', 'http://localhost:3080/assets/mobile-keyboard-AB_cd-01.css?v=1']) expect(MOBILE_STYLESHEET_URL.test(url)).toBe(true);
  for (const url of ['http://localhost:3080/assets/index.css', 'http://localhost:3080/assets/mobile-keyboard.js', 'http://localhost:3080/assets/mobile-keyboard.css.map', 'http://localhost:3080/assets/not-mobile-keyboard.css']) expect(MOBILE_STYLESHEET_URL.test(url)).toBe(false);
});

// This controls browser signals, NOT a native Android/iOS keyboard or Safari UI.
// Every assertion below exercises actual ChatView/Settings, never a test component.
interface ViewportSignals { height: number; width: number; scale: number; offsetTop: number }
interface KeyboardDriver {
  set(values: Partial<ViewportSignals>, event?: string): void;
  listeners: number;
}

declare global {
  interface Window { __mobileKeyboard: KeyboardDriver }
}

async function installViewportSignals(page: Page): Promise<void> {
  const size = page.viewportSize();
  if (!size) throw new Error('These mobile keyboard tests require a bounded viewport.');
  await page.addInitScript(size => {
    class ControlledViewport extends EventTarget {
      height = size.height;
      width = size.width;
      scale = 1;
      offsetTop = 0;
      offsetLeft = 0;
      pageTop = 0;
      pageLeft = 0;
      listeners = 0;
      override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
        super.addEventListener(...args); this.listeners++;
      }
      override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
        super.removeEventListener(...args); this.listeners--;
      }
    }
    const viewport = new ControlledViewport();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.__mobileKeyboard = {
      set(values, event = 'resize') { Object.assign(viewport, values); viewport.dispatchEvent(new Event(event)); },
      get listeners() { return viewport.listeners; },
    };
  }, size);
}

async function openNewChatFromRoot(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  await expect(page.locator('.workspace-button small')).not.toBeEmpty();
  const warning = page.getByRole('button', { name: /Project not trusted/i });
  if (await warning.isVisible()) {
    await warning.click();
    const dialog = page.getByRole('alertdialog', { name: 'Trust this project?' });
    await dialog.getByRole('button', { name: 'Trust project', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
}

async function signals(page: Page, values: Partial<ViewportSignals>, event = 'resize'): Promise<void> {
  await page.evaluate(({ values, event }) => window.__mobileKeyboard.set(values, event), { values, event });
  // Flush the coalesced measurement and React commit, not a guessed keyboard delay.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function capture(page: Page, name: string, selector = '.chat-view'): Promise<void> {
  await settle(page);
  await expect(page.locator(selector)).toHaveScreenshot(name, {
    animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
  });
  // Retain the current run's actual pixels for individual read-only inspection.
  await page.locator(selector).screenshot({ path: test.info().outputPath(name), animations: 'disabled', caret: 'hide' });
}

for (const scenario of [
  { name: 'desktop-light', width: 1440, mobile: false, theme: 'light' },
  { name: 'desktop-dark', width: 1440, mobile: false, theme: 'dark' },
  { name: 'mobile-light', width: 390, mobile: true, theme: 'light' },
  { name: 'mobile-dark', width: 390, mobile: true, theme: 'dark' },
] as const) {
  test.describe(scenario.name, () => {
    test.use({ viewport: { width: scenario.width, height: 844 }, isMobile: scenario.mobile, hasTouch: scenario.mobile });
    test('keyboard signals preserve chat controls and MCP settings', async ({ page }) => {
      await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
        version: 4, theme, lastSettingsSection: 'mcp',
      })), scenario.theme);
      await installViewportSignals(page);
      const api = await installMockApi(page, {
        sessions: [mockSession('mobile-keyboard', 'Mobile keyboard', [
          { role: 'user', content: 'Keep the mobile composer usable.' },
          { role: 'assistant', content: 'Send, attachments and MCP navigation remain available.' },
        ])],
        mcpConfig: mcpStateInventory(), holdAgentRun: true,
      });
      await page.goto('/chat/mobile-keyboard?cwd=%2Fworkspace');
      const chat = page.locator('.chat-view');
      const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
      await composer.fill('Keyboard layout check');
      await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
      await expect(page.getByRole('combobox', { name: 'Select the model', exact: true })).toBeVisible();
      await capture(page, `keyboard-expanded-${scenario.name}.png`);

      // Toolbar movement and scroll-only panning are not keyboard detection.
      await signals(page, { height: 720, offsetTop: 64 });
      await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
      await signals(page, { offsetTop: 80 }, 'scroll');
      await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
      await signals(page, { scale: 2, width: scenario.width / 2, height: 422 });
      await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
      // Zoom plus extra height loss is distinguishable from pinch alone.
      await signals(page, { scale: 1.3, width: scenario.width / 1.3, height: 350, offsetTop: 0 });
      await expect(chat).toHaveAttribute('data-mobile-keyboard', String(scenario.mobile));
      await signals(page, { scale: 1, width: scenario.width, height: 844, offsetTop: 0 });
      await signals(page, { height: 480, offsetTop: 12 });
      await expect(chat).toHaveAttribute('data-mobile-keyboard', String(scenario.mobile));
      if (scenario.mobile) {
        await expect(composer).toBeFocused();
        await expect(page.getByRole('combobox', { name: 'Select the model', exact: true })).toBeHidden();
        await expect(chat.locator('.composer-setting-scopes')).toBeHidden();
        await expect(chat.locator('.mobile-chat-actions')).toBeHidden();
        await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
        await expect(page.locator('button').and(page.getByRole('button', { name: 'Add images', exact: true }))).toBeVisible();
        const form = await chat.locator('.input-container').boundingBox();
        expect(form).not.toBeNull();
        expect(form!.y + form!.height).toBeLessThanOrEqual(493);
        expect(await composer.evaluate(element => Number.parseFloat(getComputedStyle(element.parentElement!).paddingBottom))).toBeGreaterThanOrEqual(12);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
        await capture(page, `keyboard-collapsed-${scenario.name}.png`);
        const accessibility = await new AxeBuilder({ page }).include('.input-container')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(accessibility.violations).toEqual([]);

        // The focused model field must never be hidden by chrome collapse.
        await signals(page, { height: 844, offsetTop: 0 });
        const model = page.getByRole('combobox', { name: 'Select the model', exact: true });
        await model.focus(); await signals(page, { height: 480 });
        await expect(model).toBeVisible(); await expect(model).toBeFocused();
        await composer.focus();
      }
      // Active Queue/Stop controls are retained, and /mcp is local navigation.
      await composer.press('Enter');
      await expect(page.getByRole('button', { name: 'Stop model', exact: true })).toBeVisible();
      await composer.fill('Queued keyboard check');
      await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Queue mode', exact: true })).toBeVisible();
      await composer.fill('/mcp'); await page.getByRole('button', { name: 'Queue', exact: true }).click();
      await expect(page).toHaveURL(/\/settings#mcp$/);
      await expect(chat).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.__mobileKeyboard.listeners)).toBe(0);
      expect(api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST')).toHaveLength(1);
      expect(api.requests.some(request => request.path.endsWith('/stop') || request.path.endsWith('/queue'))).toBe(false);
      // CSS is chat-local; MCP paste and administration stay focusable/scrollable.
      if (scenario.mobile) await page.setViewportSize({ width: scenario.width, height: 480 });
      await page.locator('.mcp-import-panel > summary').click();
      const paste = page.getByRole('textbox', { name: 'MCP server text', exact: true });
      await paste.fill('https://docs.example.test/mcp');
      await expect(paste).toBeFocused();
      await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
      await capture(page, `keyboard-mcp-${scenario.name}.png`, '.mcp-import-panel');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await page.goto('/chat/mobile-keyboard?cwd=%2Fworkspace');
      await expect.poll(() => page.evaluate(() => window.__mobileKeyboard.listeners)).toBe(2);
    });
  });
}

test.describe('lazy stylesheet lifecycle in real ChatView', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const outcome of ['ready', 'blur', 'unmount', 'failed'] as const) {
    test(`delayed mobile styles ${outcome} never publish stale compact layout`, async ({ page }) => {
      await installViewportSignals(page);
      await installMockApi(page, { sessions: [mockSession('styles', 'Lazy styles')] });
      let requested = 0;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route(MOBILE_STYLESHEET_URL, async route => {
        // Vite's URL module is JS; only hold the actual stylesheet request.
        if (route.request().resourceType() !== 'stylesheet') { await route.continue(); return; }
        requested++;
        await held;
        if (outcome === 'failed') await route.abort('failed');
        else await route.continue();
      });
      await page.goto('/chat/styles?cwd=%2Fworkspace');
      const chat = page.locator('.chat-view');
      const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
      await composer.fill('Keep focus and geometry current while styles load.');
      await signals(page, { height: 710 }); expect(requested).toBe(0);
      await signals(page, { height: 480 });
      await expect.poll(() => requested).toBe(1);
      await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
      await expect(page.getByRole('combobox', { name: 'Select the model', exact: true })).toBeVisible();
      await expect(composer).toBeFocused();
      await signals(page, { height: 430, offsetTop: 17 });
      // Removing a link cancels ownership, not necessarily Chromium's network
      // fetch. Wait for either terminal event, then check DOM/state/focus below.
      const complete = new Promise<void>(resolve => {
        const done = (request: Request) => {
          if (request.resourceType() !== 'stylesheet' || !MOBILE_STYLESHEET_URL.test(request.url())) return;
          page.off('requestfailed', done); page.off('requestfinished', done); resolve();
        };
        page.on('requestfailed', done); page.on('requestfinished', done);
      });
      if (outcome === 'blur') {
        await composer.evaluate(element => element.blur());
        // Flush the observer's coalesced focusout measurement before releasing
        // the held stylesheet. A late network finish must not reinstall it.
        await signals(page, {}, 'scroll');
        await expect(page.locator('link[rel="stylesheet"][href*="/mobile-keyboard"]')).toHaveCount(0);
      }
      if (outcome === 'unmount') {
        await composer.fill('/mcp'); await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page).toHaveURL(/\/settings#mcp$/);
        await expect(chat).toHaveCount(0);
      }
      release(); await complete;
      if (outcome === 'ready') {
        await expect(chat).toHaveAttribute('data-mobile-keyboard', 'true');
        const loadedUrl = await page.locator('link[rel="stylesheet"][href*="/mobile-keyboard"]').getAttribute('href');
        expect(loadedUrl).not.toBeNull(); expect(MOBILE_STYLESHEET_URL.test(loadedUrl!)).toBe(true);
        await expect(chat).toHaveCSS('height', '430px'); await expect(chat).toHaveCSS('top', '17px');
        await expect(composer).toBeFocused();
        await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
      } else if (outcome !== 'unmount') {
        await signals(page, { height: 420 });
        await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
        await expect(page.getByRole('combobox', { name: 'Select the model', exact: true })).toBeVisible();
        if (outcome === 'failed') {
          await expect(composer).toBeFocused(); expect(requested).toBe(1);
          await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
        } else await expect(composer).not.toBeFocused();
      }
      if (outcome !== 'ready') {
        await expect(page.locator('link[rel="stylesheet"][href*="/mobile-keyboard"]')).toHaveCount(0);
      }
      if (outcome === 'unmount') {
        await expect.poll(() => page.evaluate(() => window.__mobileKeyboard.listeners)).toBe(0);
        await page.locator('.mcp-import-panel > summary').click();
        const paste = page.getByRole('textbox', { name: 'MCP server text', exact: true });
        await paste.fill('https://docs.example.test/mcp'); await expect(paste).toBeFocused();
      }
    });
  }
});

test.describe('real product and disposable server', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('rotation, focus and closing signals use an orientation-specific baseline', async ({ page }) => {
    await installViewportSignals(page);
    await openNewChatFromRoot(page);
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    const chat = page.locator('.chat-view');
    await composer.fill('Rotation check');
    await signals(page, { height: 480 });
    await expect(chat).toHaveAttribute('data-mobile-keyboard', 'true');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await signals(page, { width: 844, height: 220 });
    await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
    await signals(page, { height: 200 });
    await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
    await composer.evaluate(element => element.blur());
    await signals(page, { height: 390 });
    await composer.focus(); await signals(page, { height: 210 });
    await expect(chat).toHaveAttribute('data-mobile-keyboard', 'true');
    await composer.evaluate(element => { (element as HTMLTextAreaElement).readOnly = true; });
    await signals(page, { height: 210 });
    await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
    await composer.evaluate(element => { (element as HTMLTextAreaElement).readOnly = false; element.setAttribute('inputmode', 'none'); });
    await signals(page, { height: 210 });
    await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
  });
  test('integrated keyboard response does not require intercepted API fixtures', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme: 'light',
    })));
    await installViewportSignals(page);
    await openNewChatFromRoot(page);
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.fill('Native keyboard signals are simulated, not an OS keyboard.');
    await signals(page, { height: 470 });
    await expect(page.locator('.chat-view')).toHaveAttribute('data-mobile-keyboard', 'true');
    await expect(composer).toBeFocused();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expect(page.locator('button').and(page.getByRole('button', { name: 'Add images', exact: true }))).toBeVisible();
    const form = await page.locator('.input-container').boundingBox();
    expect(form).not.toBeNull();
    expect(form!.y + form!.height).toBeLessThanOrEqual(470);
    await capture(page, 'keyboard-live-root-mobile-light.png');
    await signals(page, { height: 844 });
    await expect(page.locator('.chat-view')).toHaveAttribute('data-mobile-keyboard', 'false');
    await composer.fill('/mcp'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page).toHaveURL(/\/settings#mcp$/);
    await expect.poll(() => page.evaluate(() => window.__mobileKeyboard.listeners)).toBe(0);
    await page.setViewportSize({ width: 390, height: 480 });
    await page.locator('.mcp-import-panel > summary').click();
    const paste = page.getByRole('textbox', { name: 'MCP server text', exact: true });
    await expect(paste).toBeVisible();
    await paste.fill('https://docs.example.test/mcp');
    await expect(paste).toBeFocused();
    const preview = page.getByRole('button', { name: 'Preview', exact: true });
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toBeInViewport();
    await expect(paste).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const panel = page.locator('.mcp-import-panel');
    await panel.scrollIntoViewIfNeeded();
    // Real server sections above this panel vary between isolated CI shards.
    // Normalize only the capture's fractional pixel origin, not its dimensions,
    // typography, controls or focus. Keep the original golden and 2% tolerance.
    const previousTranslate = await panel.evaluate(element => {
      const previous = element.style.translate;
      const top = element.getBoundingClientRect().top;
      element.style.translate = `0px ${Math.round(top) - top}px`;
      return previous;
    });
    try {
      await capture(page, 'keyboard-live-mcp-mobile-light.png', '.mcp-import-panel');
    } finally {
      await panel.evaluate((element, previous) => { element.style.translate = previous; }, previousTranslate);
    }
  });
});

// Additional reviewer guards use the accepted singular extensionRequest wire.
// Original six journeys / twelve captures and four asset cases remain intact.
test.describe('exact accepted eager interaction fields', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const kind of ['input', 'editor', 'custom-input', 'custom-textarea'] as const) {
    test(`keyboard focus includes original eager ${kind} field`, async ({ page }) => {
      await installViewportSignals(page);
      await installMockApi(page, {
        sessions: [mockSession('plain-field', 'Plain field')], holdAgentRun: true,
        extensionInteraction: {
          id: 'plain-field-request', kind: kind.startsWith('custom') ? 'custom' : kind as 'input' | 'editor',
          title: 'Plain DOM approval', createdAt: '2025-01-01T12:00:00.000Z',
          ...(kind.startsWith('custom') ? { fields: [{ name: 'plain', label: 'Plain editable field', type: kind === 'custom-input' ? 'text' as const : 'textarea' as const }] } : {}),
        },
      });
      await page.goto('/chat/plain-field?cwd=%2Fworkspace');
      const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
      await composer.fill('Open accepted eager approval');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Plain DOM approval' });
      const editable = dialog.getByRole('textbox');
      await editable.fill('Original plain DOM field remains editable');
      await signals(page, { height: 480 });
      await expect(page.locator('.chat-view')).toHaveAttribute('data-mobile-keyboard', 'true');
      await expect(editable).toBeFocused(); await expect(editable).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
      await signals(page, { height: 844 });
      await expect(page.locator('.chat-view')).toHaveAttribute('data-mobile-keyboard', 'false');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0); await expect(composer).toBeFocused();
    });
  }
});

test.describe('exact mobile session lifetime', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('pending real stylesheet ownership retires on same-component new chat navigation', async ({ page }) => {
    await installViewportSignals(page);
    await installMockApi(page, { sessions: [mockSession('retire', 'Retire styles')] });
    const releases: Array<() => void> = [];
    await page.route(MOBILE_STYLESHEET_URL, async route => {
      if (route.request().resourceType() !== 'stylesheet') { await route.continue(); return; }
      await new Promise<void>(resolve => releases.push(resolve)); await route.continue();
    });
    await page.goto('/chat/retire?cwd=%2Fworkspace');
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.fill('Pending old session styles'); await signals(page, { height: 480 });
    await expect.poll(() => releases.length).toBe(1);
    await page.evaluate(() => { (window as unknown as { oldMobileLink: Element | null }).oldMobileLink = document.querySelector('link[rel="stylesheet"][href*="/mobile-keyboard"]'); });
    await page.keyboard.press('Control+Shift+O');
    await expect(page).toHaveURL(/\/chat\/draft/);
    await expect.poll(() => page.evaluate(() => (window as unknown as { oldMobileLink: Element }).oldMobileLink.isConnected)).toBe(false);
    releases[0]!(); await signals(page, { height: 430, offsetTop: 19 });
    await expect(page.locator('.chat-view')).toHaveAttribute('data-mobile-keyboard', 'false');
    for (const release of releases) release();
  });
});

test.describe('exact compact composer and retry guards', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('failed asset retries only after a closed sample and fresh eligible focus, then cleans document styles', async ({ page }) => {
    await installViewportSignals(page);
    await installMockApi(page, { sessions: [mockSession('retry-styles', 'Retry styles')] });
    let requested = 0;
    await page.route(MOBILE_STYLESHEET_URL, async route => {
      if (route.request().resourceType() !== 'stylesheet') { await route.continue(); return; }
      requested++; if (requested === 1) await route.abort('failed'); else await route.continue();
    });
    await page.goto('/chat/retry-styles?cwd=%2Fworkspace');
    const before = await page.evaluate(() => [document.documentElement.className, document.documentElement.getAttribute('style'), document.body.className, document.body.getAttribute('style')]);
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    const chat = page.locator('.chat-view');
    await composer.fill('Explicit retry intent'); await signals(page, { height: 480 });
    await expect.poll(() => requested).toBe(1);
    await expect(page.locator('link[rel="stylesheet"][href*="/mobile-keyboard"]')).toHaveCount(0);
    for (const height of [440, 450, 460, 470]) await signals(page, { height });
    expect(requested).toBe(1); await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false');
    await composer.evaluate(element => element.blur()); await signals(page, { height: 844 });
    await composer.focus(); await signals(page, { height: 480 });
    await expect(chat).toHaveAttribute('data-mobile-keyboard', 'true'); expect(requested).toBe(2);
    await composer.evaluate(element => element.blur()); await signals(page, { height: 844 });
    await expect(chat).toHaveAttribute('data-mobile-keyboard', 'false'); await expect(chat).not.toHaveAttribute('style', /--mobile-keyboard/);
    await composer.fill('/mcp'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page).toHaveURL(/\/settings#mcp$/);
    await expect(page.locator('link[rel="stylesheet"][href*="/mobile-keyboard"]')).toHaveCount(0);
    expect(await page.evaluate(() => [document.documentElement.className, document.documentElement.getAttribute('style'), document.body.className, document.body.getAttribute('style')])).toEqual(before);
  });
  test('compact Mod+Enter keeps newline and IME, attachment submission and actual Stop available', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, sendMode: 'mod-enter' })));
    await installViewportSignals(page);
    const api = await installMockApi(page, { sessions: [mockSession('compact-send', 'Compact send')], holdAgentRun: true });
    await page.goto('/chat/compact-send?cwd=%2Fworkspace');
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.fill('Line one'); await signals(page, { height: 480 });
    await expect(page.locator('.chat-view')).toHaveAttribute('data-mobile-keyboard', 'true');
    await composer.press('Enter'); await expect(composer).toHaveValue('Line one\n');
    await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true });
    await expect(composer).toHaveValue('Line one\n');
    expect(api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST')).toHaveLength(0);
    await page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'compact.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
    await expect(page.getByRole('img', { name: 'compact.png' })).toBeVisible();
    await expect(page.locator('button').and(page.getByRole('button', { name: 'Add images', exact: true }))).toBeVisible();
    await composer.press('Control+Enter');
    await expect(page.getByRole('button', { name: 'Stop model', exact: true })).toBeVisible();
    expect(api.requests.find(request => request.path === '/api/agent/runs' && request.method === 'POST')?.body).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ type: 'image', name: 'compact.png' })]) });
    await page.getByRole('button', { name: 'Stop model', exact: true }).click();
    await expect.poll(() => api.requests.filter(request => request.path.endsWith('/stop') && request.method === 'POST').length).toBe(1);
    await expect(page.getByRole('button', { name: 'Stop model', exact: true })).toBeHidden();
  });
});
