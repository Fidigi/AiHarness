import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/test-budget';
import { fixture, openMenu, openNavigation, assertCopy } from './fixtures/session-row-copy';

test.describe.configure({ timeout: 60_000 });
for (const reopen of [false, true]) test(`closing native mobile Sidebar retires an admitted row copy${reopen ? ' even after reopening' : ' without stealing composer focus'}`, async ({ page }) => {
  const f = await fixture(page, 'en', 'dark', 390);
  let release!: () => void, written: string | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const forwarding: string[] = [];
  await page.route(`**/api/sessions/${f.source.id}/clone`, async route => {
    const response = await route.fetch(); expect(response.status()).toBe(201);
    written = (await response.json() as { id: string }).id;
    await gate;
    try { await route.fulfill({ response }); } catch (error) { forwarding.push(String(error)); }
  });
  try {
    const original = page.url();
    const { item } = await openMenu(f, page); await item.click();
    await expect.poll(() => written).toBeTruthy(); const id = written!;
    // First Escape closes only the popover; second closes its actual Sidebar owner.
    await page.keyboard.press('Escape'); await expect(item).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
    await expect(page.locator('.mobile-menu')).toHaveAttribute('aria-expanded', 'false');
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.fill('ROW_NEWER_UNSENT_DRAFT'); await composer.focus();
    if (reopen) { await openNavigation(page); await expect(page.locator('.sidebar')).not.toHaveAttribute('inert', ''); }
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page).toHaveURL(original); await expect(composer).toHaveValue('ROW_NEWER_UNSENT_DRAFT');
    if (!reopen) await expect(composer).toBeFocused();
    else {
      const { item: again } = await openMenu(f, page); await expect(again).toBeEnabled();
      await page.keyboard.press('Escape');
    }
    // The native write was already admitted: withdrawal is not rollback.
    await assertCopy(f, id); expect(await readFile(f.file)).toEqual(f.bytes); expect(f.quota).toEqual([]);
    expect(forwarding.every(message => /cancelled|canceled|closed|disposed|already handled|not found/i.test(message)), forwarding.join('\n').slice(0, 2048)).toBe(true);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await f.cleanup(); }
});
