import { test } from './fixtures/test-budget';
import { selectionAnchorControl } from './fixtures/selection-anchor';

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${viewport.name} selection actions follow their genuine live range after viewport scroll without taking focus`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await selectionAnchorControl(page);
  });
}
