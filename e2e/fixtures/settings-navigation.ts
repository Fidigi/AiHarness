import { expect, type Locator, type Page } from './test-budget';

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

const generalNames = {
  appearance: /^(Appearance|Apparence)$/u,
  behavior: /^(Behavior|Comportement)$/u,
  notifications: /^Notifications$/u,
  authentication: /^(Access|Accès)$/u,
  about: /^(About|À propos)$/u,
};

/** Follow the contextual list, including the explicit mobile Back view. */
export async function selectGeneralSettings(page: Page, panel: keyof typeof generalNames): Promise<void> {
  await selectSettingsCategory(page, 'general');
  const back = page.getByRole('button', { name: /^(Back to General settings|Retour aux paramètres généraux)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = page.getByRole('navigation', { name: /^(General settings|Paramètres généraux)$/u });
  await navigation.getByRole('link', { name: generalNames[panel] }).click();
}

const modelNames = {
  providers: /^(AI Provider|Provider IA)$/u,
  'provider-lifecycle': /^(Provider connections and custom providers|Connexions fournisseur et fournisseurs personnalisés)$/u,
  model: /^(Model|Modèle)$/u,
  'custom-models': /^(Custom models|Modèles personnalisés)$/u,
};

export async function selectModelSettings(page: Page, panel: keyof typeof modelNames): Promise<void> {
  await selectSettingsCategory(page, 'models');
  const back = page.getByRole('button', { name: /^(Back to Model settings|Retour aux paramètres des modèles)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = page.getByRole('navigation', { name: /^(Model settings|Paramètres des modèles)$/u });
  await navigation.getByRole('link', { name: modelNames[panel] }).click();
}

/** Metadata selection is separate from the explicit instruction-read action. */
export async function selectInstalledSkill(page: Page, name: string): Promise<void> {
  await selectSettingsCategory(page, 'skills');
  const back = page.getByRole('button', { name: /^(Back to skills|Retour aux compétences)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = page.locator('#skills').getByRole('navigation', { name: /^(Skills|Compétences)$/u });
  await navigation.getByRole('button', { name, exact: true }).click();
}

export async function selectSettingsTool(page: Page, name: string): Promise<void> {
  await selectSettingsCategory(page, 'tools');
  const back = page.getByRole('button', { name: /^(Back to tools|Retour aux outils)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = page.getByRole('navigation', { name: /^(Tools and presets|Outils et préréglages)$/u });
  await navigation.getByRole('button', { name, exact: true }).click();
}

/** Choose a profile through the visible contextual list, never its hidden actions. */
export async function selectSubagentProfile(page: Page, name: string): Promise<void> {
  await selectSettingsCategory(page, 'subagents');
  const back = page.getByRole('button', { name: /^(Back to profiles|Retour aux profils)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = page.locator('#subagents').getByRole('navigation', { name: /^(Sub-agents|Sous-agents)$/u });
  await navigation.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).click();
}

/** Reveal package rows and their scoped batch controls through the actual Back view. */
export async function showPluginPackages(page: Page): Promise<Locator> {
  await selectSettingsCategory(page, 'plugins');
  await expect(page.locator('#plugins .plugin-catalog-footer')).toBeVisible();
  const back = page.getByRole('button', { name: /^(Back to plugins|Retour aux plugins)$/u });
  if (await back.isVisible()) await back.click();
  return page.locator('#plugins').getByRole('navigation', { name: /^(Plugins and packages|Plugins et packages)$/u });
}

export async function selectPluginPackage(page: Page, scope: 'global' | 'project', name: string): Promise<void> {
  const navigation = await showPluginPackages(page);
  const group = navigation.getByRole('group', { name: scope === 'global' ? /^(Global|Globale)$/u : /^(Project|Projet)$/u });
  await group.getByRole('button', { name, exact: true }).click();
}

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
