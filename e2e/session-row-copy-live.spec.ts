import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures/test-budget';
import { action, menuName, fixture, openNavigation, openMenu, assertCopy } from './fixtures/session-row-copy';

test.describe.configure({ timeout: 60_000 });
for (const scenario of [
  { locale: 'en', theme: 'light', width: 1440 }, { locale: 'en', theme: 'dark', width: 390 },
  { locale: 'fr', theme: 'dark', width: 1440 }, { locale: 'fr', theme: 'light', width: 390 },
]) test(`${scenario.locale}/${scenario.theme}/${scenario.width}: real row copy captures non-message leaf, retains source and native keyboard/menu ownership`, async ({ page }) => {
  const f = await fixture(page, scenario.locale, scenario.theme, scenario.width, true);
  try {
    const { invoker, item } = await openMenu(f, page); await expect(item).toBeFocused();
    const menu = page.getByRole('menu', { name: menuName });
    const origin = await menu.evaluate(element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y]; });
    expect(origin).toEqual(origin.map(value => Math.round(value)));
    const beforeCapture = await page.evaluate(() => ({ now: Date.now(), perf: performance.now() }));
    expect(beforeCapture.now).toBe(f.presentationTime);
    await expect(menu).toHaveScreenshot(`row-copy-menu-${scenario.locale}-${scenario.theme}-${scenario.width}.png`);
    const afterCapture = await page.evaluate(() => ({ now: Date.now(), perf: performance.now() }));
    expect(afterCapture.now).toBe(f.presentationTime); expect(afterCapture.perf).toBeGreaterThan(beforeCapture.perf);
    // Screenshot animation finishing must not conceal an origin captured mid-slide.
    expect(await menu.evaluate(element => element.getBoundingClientRect().right))
      .toBeCloseTo(await invoker.evaluate(element => element.getBoundingClientRect().right), 0);
    const accessibility = await new AxeBuilder({ page }).include('.sidebar').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.keyboard.press('Escape'); await expect(item).not.toBeVisible(); await expect(invoker).toBeFocused();
    await page.keyboard.press('Enter'); await expect(item).toBeVisible();
    const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/sessions/${f.source.id}/clone`);
    await item.click(); const actual = await response; expect(actual.status()).toBe(201);
    const copy = await actual.json() as { id: string };
    await expect(page).toHaveURL(new RegExp(`/chat/${copy.id}\\?cwd=`));
    expect(new URL(page.url()).searchParams.get('cwd')).toBe(f.cwd); expect(new URL(page.url()).searchParams.has('token')).toBe(false); expect(new URL(page.url()).hash).toBe('');
    await expect(page.getByRole('log')).toContainText('ROW_FIRST_BODY'); await expect(page.getByRole('log')).not.toContainText('ROW_LATER_BODY');
    await assertCopy(f, copy.id); expect(await readFile(f.file)).toEqual(f.bytes);
    expect(f.mutations).toEqual([{ pathname: `/api/sessions/${f.source.id}/clone`, body: { entryId: f.target, expectedCwd: f.cwd } }]); expect(f.quota).toEqual([]);
    await page.reload(); await expect(page.getByRole('log')).toContainText('ROW_FIRST_BODY'); await assertCopy(f, copy.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  } finally { await f.cleanup(); }
});

test('real canonical child/empty saved/draft rows refuse UI intent without a clone write', async ({ page }) => {
  const f = await fixture(page);
  try {
    const child = await f.writer.create({ title: 'ROW_CHILD', cwd: f.cwd, workspaceId: f.probe.workspaceId, metadata: { subagent: true } });
    await f.writer.addMessage(child.id, { role: 'user', content: 'Child body' });
    const empty = await f.writer.create({ title: 'ROW_EMPTY', cwd: f.cwd, workspaceId: f.probe.workspaceId });
    for (const id of [child.id, empty.id]) expect((await page.request.get(`/api/sessions/${id}`)).status()).toBe(200);
    await page.reload(); await expect(page.getByRole('log')).toContainText('ROW_VIEW_BODY'); await openNavigation(page);
    for (const title of ['ROW_CHILD', 'ROW_EMPTY']) {
      const row = page.locator('.sidebar-nav .session-row').filter({ has: page.locator('a.session-main', { hasText: title }) });
      await row.getByRole('link', { name: new RegExp(title) }).first().focus(); await row.getByRole('button', { name: menuName }).click();
      await expect(page.getByRole('menuitem', { name: action })).toBeDisabled(); await page.keyboard.press('Escape');
    }
    await page.locator('.sidebar-header .sidebar-actions > button').click(); await openNavigation(page);
    const draft = page.locator('.sidebar-nav button.session-main'); await expect(draft).toHaveCount(1); await draft.focus();
    await draft.locator('..').getByRole('button', { name: menuName }).click(); await expect(page.getByRole('menuitem', { name: action })).toBeDisabled();
    expect(f.mutations.filter(item => item.pathname.endsWith('/clone'))).toEqual([]); expect(f.quota).toEqual([]);
    const denied = await page.request.post(`/api/sessions/${child.id}/clone`, { data: { entryId: child.activeLeafId, expectedCwd: f.cwd } }); expect(denied.status()).toBe(409);
    expect(await readFile(f.file)).toEqual(f.bytes);
  } finally { await f.cleanup(); }
});

test('captures row entry before transport await and never substitutes a later source leaf/current page', async ({ page }) => {
  const f = await fixture(page); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let body: unknown;
  await page.route(`**/api/sessions/${f.source.id}/clone`, async route => { body = route.request().postDataJSON(); await gate; await route.continue(); });
  try {
    const { item } = await openMenu(f, page); await item.click();
    await expect.poll(() => body).toEqual({ entryId: f.target, expectedCwd: f.cwd });
    const added = await page.request.post(`/api/sessions/${f.source.id}/messages`, { data: { role: 'assistant', content: 'ROW_AFTER_AWAIT' } }); expect(added.status()).toBe(201);
    const bytes = await readFile(f.file); const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/sessions/${f.source.id}/clone`);
    release(); const actual = await response; expect(actual.status()).toBe(201); const copy = await actual.json() as { id: string };
    await expect(page).toHaveURL(new RegExp(`/chat/${copy.id}\\?cwd=`)); await assertCopy(f, copy.id);
    expect(JSON.stringify(await f.store.getSessionSnapshot(copy.id))).not.toContain('ROW_AFTER_AWAIT'); expect(await readFile(f.file)).toEqual(bytes); expect(f.quota).toEqual([]);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await f.cleanup(); }
});

for (const change of ['session', 'workspace'] as const) test(`real admitted late response cannot steal newer${change} navigation`, async ({ page }) => {
  const f = await fixture(page); let release!: () => void, written: string | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const extra: string[] = [], forwarding: string[] = [];
  await page.route(`**/api/sessions/${f.source.id}/clone`, async route => {
    // Forward the exact authenticated native response. No status/body/headers,
    // Origin/auth/CSRF repairs, fabricated API data or alternate source lookup.
    const response = await route.fetch(); expect(response.status()).toBe(201);
    written = (await response.json() as { id: string }).id; await gate;
    try { await route.fulfill({ response }); } catch (error) { forwarding.push(String(error)); }
  });
  try {
    const otherCwd = change === 'workspace' ? await mkdtemp(path.join(process.cwd(), 'e2e', '.row-copy-new-view-')) : f.cwd;
    if (change === 'workspace') { extra.push(otherCwd); expect((await page.request.post('/api/workspaces/trust', { data: { cwd: otherCwd, confirm: true } })).status()).toBe(200); }
    const made = await page.request.post('/api/sessions', { data: { cwd: otherCwd, title: 'ROW_NEW_VIEW' } }); expect(made.status()).toBe(201); const other = await made.json() as { id: string };
    expect((await page.request.post(`/api/sessions/${other.id}/messages`, { data: { role: 'user', content: 'ROW_NEW_VIEW_BODY' } })).status()).toBe(201);
    await page.reload(); await expect(page.getByRole('log')).toContainText('ROW_VIEW_BODY'); await openNavigation(page);
    await page.evaluate(() => Reflect.set(window, '__rowCopyDocument', 'same-native-document'));
    const { item } = await openMenu(f, page); await item.click(); await expect.poll(() => written).toBeTruthy(); const id = written!;
    if (change === 'workspace') {
      await mkdir(path.join(f.cwd, 'row-picker-ready'));
      await page.locator('.workspace-button').click();
      const picker = page.locator('.directory-picker'); await expect(picker).toBeVisible();
      await expect(picker.getByRole('button', { name: 'row-picker-ready', exact: true })).toBeVisible();
      await picker.getByRole('combobox', { name: 'Workspace path', exact: true }).fill(otherCwd); await picker.locator('footer button.primary').click();
      await expect(page.locator('.workspace-button small')).toContainText(otherCwd); await openNavigation(page);
    }
    await page.locator('.sidebar-nav a.session-main').filter({ hasText: 'ROW_NEW_VIEW' }).click();
    await expect(page.getByRole('log')).toContainText('ROW_NEW_VIEW_BODY');
    expect(await page.evaluate(() => Reflect.get(window, '__rowCopyDocument'))).toBe('same-native-document');
    const current = page.url(); release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page).toHaveURL(current); await expect(page.getByRole('log')).toContainText('ROW_NEW_VIEW_BODY');
    await assertCopy(f, id); expect(await readFile(f.file)).toEqual(f.bytes); expect(f.quota).toEqual([]);
    expect(forwarding.every(message => /cancelled|canceled|closed|disposed|already handled|not found/i.test(message)), JSON.stringify(forwarding).slice(0, 2_048)).toBe(true);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await f.cleanup(extra); }
});

// Credentialful active-upstream case belongs to the existing encrypted
// tool-progress runtime, not a repaired standard-server authentication setup.
