import { expect, type Page } from './test-budget';

export async function closeSettings(page: Page): Promise<void> {
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0);
}

const names = {
  general: /^(General|Général)$/u,
  models: /^(Models|Modèles)$/u,
  skills: /^(Skills|Compétences)$/u,
  tools: /^(Tools|Outils)$/u,
  plugins: /^Plugins$/u,
  subagents: /^(Child agents|Agents enfants)$/u,
  mcp: /^MCP$/u,
};

/** Exercise the presented desktop navigation or native mobile category picker. */
export async function selectSettingsCategory(page: Page, category: keyof typeof names): Promise<void> {
  await expect(page.locator('.settings-dialog')).toBeVisible();
  const picker = page.locator('.settings-category-picker select');
  if (await picker.isVisible()) {
    if (await picker.inputValue() !== category) await picker.selectOption(category);
    await expect(picker).toHaveValue(category);
  } else {
    const link = page.locator('.settings-categories').getByRole('link', { name: names[category] });
    if (await link.getAttribute('aria-current') !== 'page') await link.click();
    await expect(link).toHaveAttribute('aria-current', 'page');
  }
}
