import { expect, test, reserveReadBudget } from './fixtures/test-budget';
import AxeBuilder from '@axe-core/playwright';
import { subagentServer } from '../tests/fixtures/web06-subagents';

for (const scene of [
  { locale: 'en', theme: 'light', width: 1280 }, { locale: 'fr', theme: 'dark', width: 1280 },
  { locale: 'en', theme: 'dark', width: 390 }, { locale: 'fr', theme: 'light', width: 390 },
] as const) {
  test.describe(`native child lifecycle ${scene.locale}/${scene.theme}/${scene.width}`, () => {
    test.use({ viewport: { width: scene.width, height: 900 }, hasTouch: scene.width === 390, isMobile: scene.width === 390 });
    test('delegates sync/background, stops, notifies, acknowledges and opens durable linked history', async ({ page }) => {
      test.setTimeout(60_000);
      const f = await subagentServer(), fr = scene.locale === 'fr';
      const json = async (url: string, body?: unknown) => {
        const response = await f.request(url, body === undefined ? 'GET' : 'POST', body);
        expect(response.ok).toBe(true); return response.json();
      };
      try {
        await f.trustAndLoad();
        expect((await page.request.post(f.base() + '/api/auth/login', { data: { token: f.admin } })).status()).toBe(200);
        await reserveReadBudget(page.request, f.base());
        await page.addInitScript(scene => {
          localStorage.setItem('ai-harness-locale', scene.locale);
          localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: scene.theme, filesOpen: false, sidebarVisible: false, sound: false }));
        }, scene);
        const parent = await json('/api/agent/runs', { cwd: f.cwd, provider: 'mock', input: 'delegate:sync', maxRetries: 0 });
        const id = parent.session.id;
        await page.goto(`${f.base()}/chat/${id}?cwd=${encodeURIComponent(f.cwd)}`);
        await expect(page.locator('.message.assistant').last()).toContainText('CHILD_RESULT_é😀', { timeout: 10_000 });
        const toggle = page.locator('.subagent-toggle');
        await expect(toggle.locator('.subagent-toggle-count')).toHaveText('1');
        await expect(toggle).toHaveClass(/attention/);
        await expect(page.locator('.status-center')).toContainText(fr ? 'est terminé' : 'child agent completed');
        await toggle.click();
        const panel = page.locator('.subagent-panel');
        await expect(panel.locator('.subagent-run.completed')).toHaveCount(1);
        await expect.poll(async () => (await json(`/api/subagents/runs?parentSessionId=${id}`)).every((run: { attention: boolean }) => !run.attention)).toBe(true);
        const sync = (await json(`/api/subagents/runs?parentSessionId=${id}`))[0];
        expect(f.frames.filter(frame => frame.sessionId === sync.childSessionId)).toHaveLength(1);
        await panel.getByRole('button', { name: fr ? 'Ouvrir le détail' : 'Open details', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/chat/${sync.childSessionId}`));
        await expect(page.locator('.message.assistant').last()).toContainText('CHILD_RESULT_é😀');
        await page.getByRole('button', { name: fr ? 'Revenir à l’agent parent' : 'Back to parent agent' }).click();
        await expect(page).toHaveURL(new RegExp(`/chat/${id}`));
        await json('/api/agent/runs', { sessionId: id, cwd: f.cwd, provider: 'mock', input: 'delegate:background', maxRetries: 0 });
        await expect.poll(async () => (await json(`/api/subagents/runs?parentSessionId=${id}`)).length).toBe(2);
        const held = (await json(`/api/subagents/runs?parentSessionId=${id}`)).find((run: { background: boolean }) => run.background)!;
        await expect.poll(() => f.frames.some(frame => frame.sessionId === held.childSessionId && frame.tools.includes('wait_child'))).toBe(true);
        // The background child's lifetime is independent of its completed parent turn and page reload.
        await expect.poll(async () => (await json(`/api/agent/sessions/${id}/state`)).run.phase).toBe('completed');
        await page.reload();
        await expect(toggle.locator('.subagent-toggle-count')).toHaveText('2');
        await toggle.click();
        await panel.locator('.subagent-run.running').getByRole('button', { name: fr ? 'Arrêter l’agent enfant' : 'Stop child agent', exact: true }).click();
        await expect(panel.locator('.subagent-run.stopped')).toHaveCount(1, { timeout: 10_000 });
        const failed = await json('/api/subagents/runs', { parentSessionId: id, profileId: 'general', provider: 'mock', task: 'child:fail', background: true });
        await expect.poll(async () => (await json(`/api/subagents/runs/${failed.id}`)).status, { timeout: 10_000 }).toBe('failed');
        await expect(panel.locator('.subagent-run.failed')).toHaveCount(1, { timeout: 10_000 });
        await expect(page.locator('.status-center')).toContainText(fr ? 'requiert votre attention' : 'needs attention', { timeout: 10_000 });
        await toggle.click(); await toggle.click();
        await expect.poll(async () => (await json(`/api/subagents/runs?parentSessionId=${id}`)).every((run: { attention: boolean }) => !run.attention)).toBe(true);
        await expect(panel.locator('.subagent-run')).toHaveCount(3);
        const canonical = await json('/api/subagents/runs');
        expect(canonical).toHaveLength(3);
        for (const run of canonical) {
          expect(f.frames.filter(frame => frame.sessionId === run.childSessionId).every(frame => frame.input === run.task)).toBe(true);
        }
        await expect(panel.locator('.subagent-run > p:first-of-type')).toHaveText(['child:fail', 'child:hold', 'child:done']);
        await expect(toggle).not.toHaveClass(/attention/);
        const dismiss = page.locator('.status-center .status-notice button');
        const notices = await dismiss.count();
        for (let index = 0; index < notices; index++) await dismiss.first().click();
        await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
        await page.evaluate(() => document.fonts.ready);
        expect((await new AxeBuilder({ page }).include('.subagent-panel').analyze()).violations).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        // Keep transient hover paint and fractional outside pixels out of the panel capture.
        await page.mouse.move(0, 0);
        await panel.evaluate(element => {
          const rect = element.getBoundingClientRect();
          element.style.translate = `${Math.ceil(rect.x) - rect.x}px ${Math.ceil(rect.y) - rect.y}px`;
        });
        await expect(panel).toHaveScreenshot(`children-${scene.locale}-${scene.theme}-${scene.width}.png`, {
          style: 'body * { visibility: hidden !important; } .subagent-panel, .subagent-panel * { visibility: visible !important; }',
        });
        if (scene.locale === 'en' && scene.width === 1280) {
          await page.goto(`${f.base()}/settings?cwd=${encodeURIComponent(f.cwd)}#subagents`);
          const settings = page.locator('#subagents');
          await expect(settings.locator('.subagent-profile-card')).toHaveCount(3);
          await settings.locator('.subagent-profile-card').filter({ hasText: 'General purpose' }).getByRole('button', { name: 'Duplicate', exact: true }).click();
          const copy = settings.locator('.subagent-profile-card').filter({ hasText: 'General purpose copy' });
          await copy.getByRole('button', { name: 'Edit', exact: true }).click();
          const editor = settings.getByRole('dialog');
          await editor.getByLabel('Model', { exact: true }).fill('mock-model');
          await editor.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('low');
          await editor.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(editor).toHaveCount(0);
          await copy.getByRole('button', { name: 'Edit', exact: true }).click();
          await editor.getByLabel('Model', { exact: true }).fill('');
          await editor.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('');
          await editor.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(editor).toHaveCount(0);
          const saved = await json(`/api/subagents/settings?cwd=${encodeURIComponent(f.cwd)}&scope=project`);
          expect(saved.profiles.find((profile: { name: string }) => profile.name === 'General purpose copy')).toMatchObject({ tools: [], skills: [], extensions: [] });
          const custom = saved.profiles.find((profile: { name: string }) => profile.name === 'General purpose copy');
          expect(custom.model).toBeUndefined(); expect(custom.thinking).toBeUndefined();
          expect((await json('/api/subagents/settings?scope=global')).profiles).toHaveLength(3);
          page.once('dialog', dialog => dialog.accept());
          await copy.getByRole('button', { name: 'Delete', exact: true }).click();
          await expect(settings.locator('.subagent-profile-card')).toHaveCount(3);
        }
        // A cold Server keeps journals, not stale process-local run/attention records.
        await page.goto('about:blank'); await f.restart();
        expect((await page.request.post(f.base() + '/api/auth/login', { data: { token: f.admin } })).status()).toBe(200);
        await reserveReadBudget(page.request, f.base());
        await page.goto(`${f.base()}/chat/${sync.childSessionId}?cwd=${encodeURIComponent(f.cwd)}`);
        await expect(page.locator('.message.assistant').last()).toContainText('CHILD_RESULT_é😀');
        await expect(page.getByRole('button', { name: fr ? 'Revenir à l’agent parent' : 'Back to parent agent' })).toBeVisible();
        expect(await json('/api/subagents/runs')).toEqual([]);
      } finally { await page.goto('about:blank').catch(() => undefined); await f.close(); }
    });
  });
}

test('a refused real child-panel asset stays local and preserves the composer', async ({ page }) => {
  const f = await subagentServer();
  try {
    await f.trustAndLoad();
    expect((await page.request.post(f.base() + '/api/auth/login', { data: { token: f.admin } })).status()).toBe(200);
    await reserveReadBudget(page.request, f.base());
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    let refused = 0;
    await page.route('**/assets/SubagentPanel-*.js', route => { refused++; return route.abort(); });
    const response = await f.request('/api/sessions', 'POST', { cwd: f.cwd, title: 'Panel asset owner' });
    const parent = await response.json(); expect(response.status).toBe(201);
    await page.goto(`${f.base()}/chat/${parent.id}?cwd=${encodeURIComponent(f.cwd)}`);
    await expect(page.getByRole('alert')).toContainText('Child-agent status is unavailable.');
    expect(refused).toBeGreaterThan(0);
    await page.getByPlaceholder(/Type your message/).fill('Keep my unsent delegation question');
    await expect(page.getByPlaceholder(/Type your message/)).toHaveValue('Keep my unsent delegation question');
    expect(await f.request('/api/subagents/runs').then(response => response.json())).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => undefined); await f.close(); }
});
