import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from './test-budget';
import { installMockApi, mockSession } from './mock-api';

/** Genuine range/scroll control; no patched native methods or fake geometry. */
export async function selectionAnchorControl(page: Page, built = false): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', contentWidth: 1000, fontSize: 16,
    filesOpen: false, sidebarVisible: true, selectionActions: true, sound: false,
  })));
  const text = 'Owned selection stays attached to this paragraph.';
  const content = Array.from({ length: 32 }, (_, index) => index === 16 ? text : `History paragraph ${index}: enough native scroll space for the owned selection.`).join('\n\n');
  const api = await installMockApi(page, { sessions: [mockSession('selection-anchor', 'Selection anchor', [
    { role: 'user', content: 'Read this history.' }, { role: 'assistant', content },
  ])] });
  await page.goto('/chat/selection-anchor');
  const paragraph = page.locator('.message.assistant .message-content p').filter({ hasText: text });
  await expect(paragraph).toHaveCount(1);
  await paragraph.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await paragraph.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await paragraph.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    element.closest('.messages-container')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const toolbar = page.getByRole('toolbar', { name: 'Selected text actions' });
  await expect(toolbar).toBeVisible();
  const button = toolbar.getByRole('button', { name: 'Ask here', exact: true });
  await button.focus(); await expect(button).toBeFocused();
  const before = await page.evaluate(() => {
    const range = window.getSelection()!.getRangeAt(0), bar = document.querySelector<HTMLElement>('.selection-actions')!;
    return { rangeTop: range.getBoundingClientRect().top, barBottom: bar.getBoundingClientRect().bottom };
  });
  expect(before.rangeTop - before.barBottom).toBeGreaterThanOrEqual(7);
  expect(before.rangeTop - before.barBottom).toBeLessThanOrEqual(9);
  const scrollStart = await page.locator('.messages-container').evaluate(async element => {
    const before = element.scrollTop; element.scrollTop = before + 40;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return before;
  });
  // Two frames are not a scroll-settlement guarantee. Observe the same single
  // scroll until it meets the original movement requirement; never reapply it.
  await expect.poll(() => page.locator('.messages-container').evaluate((element, before) =>
    element.scrollTop - before, scrollStart)).toBeGreaterThanOrEqual(39);
  await expect.poll(async () => page.evaluate(() => {
    const range = window.getSelection()!.getRangeAt(0), bar = document.querySelector<HTMLElement>('.selection-actions')!;
    const gap = range.getBoundingClientRect().top - bar.getBoundingClientRect().bottom;
    return gap >= 7 && gap <= 9;
  })).toBe(true);
  await expect(button).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(text);
  expect(api.requests.filter(request => ['/api/agent/runs', '/api/agent/messages'].includes(request.path))).toEqual([]);
  const axe = await new AxeBuilder({ page }).include('.selection-actions').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations).toEqual([]);
  if (built) expect(await page.evaluate(() => performance.getEntriesByType('resource')
    .some(entry => /\/assets\/SelectionActions-[^/]+\.js$/u.test(entry.name)))).toBe(true);
  // Native action still quotes the captured text; disposing its nodes withdraws the next capture.
  await button.click();
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toHaveValue(`> ${text}\n\n`);
  await expect(toolbar).toHaveCount(0);
  await paragraph.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    element.closest('.messages-container')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(toolbar).toBeVisible();
  await paragraph.evaluate(element => element.remove());
  await expect(toolbar).toHaveCount(0);
}
