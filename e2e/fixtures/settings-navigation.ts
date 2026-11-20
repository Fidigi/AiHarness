import { expect, type Locator, type Page } from './test-budget';

export async function closeSettings(page: Page, { discardDrafts = false }: { discardDrafts?: boolean } = {}): Promise<void> {
  await page.locator('.settings-dialog-header button').click();
  if (discardDrafts) {
    const confirmation = page.getByRole('alertdialog', { name: /^(Discard unsaved Settings edits\?|Abandonner les modifications non enregistrées des paramètres \?)$/u });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: /^(Discard edits|Abandonner les modifications)$/u }).click();
  }
  await expect(page.locator('.settings-dialog')).toHaveCount(0);
}

/** Explicitly admit a full-document reload that intentionally retires dirty Settings. */
export async function reloadSettingsDiscardingDrafts(page: Page): Promise<void> {
  await Promise.all([
    page.waitForEvent('dialog').then(async dialog => { expect(dialog.type()).toBe('beforeunload'); await dialog.accept(); }),
    page.reload(),
  ]);
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

/** Inspect a registry entry without installing, updating or reading skill instructions. */
export async function selectRegistryEntry(page: Page, id: string): Promise<void> {
  await selectSettingsCategory(page, 'skills');
  const registry = page.locator('.skill-registry');
  if (await registry.getAttribute('open') === null) { await registry.locator('summary').focus(); await registry.locator('summary').click(); }
  const back = registry.getByRole('button', { name: /^(Back to Agent Skills registry|Retour au registre Agent Skills)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = registry.getByRole('navigation', { name: /^(Browse Agent Skills registry|Parcourir le registre Agent Skills)$/u });
  const code = page.getByText(id, { exact: true }).and(page.locator('code'));
  await navigation.getByRole('button').filter({ has: code }).click();
}

/** Inspect one custom definition without changing the shared editor or active model. */
export async function selectCustomModel(page: Page, key: string): Promise<void> {
  await selectModelSettings(page, 'custom-models');
  const section = page.locator('#custom-models');
  const back = section.getByRole('button', { name: /^(Back to custom models|Retour aux modèles personnalisés)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = section.getByRole('navigation', { name: /^(Custom models|Modèles personnalisés)$/u });
  const code = page.getByText(key, { exact: true }).and(page.locator('code'));
  await navigation.getByRole('button').filter({ has: code }).click();
}

/** Browse catalogue metadata without selecting the active model or changing enablement. */
export async function selectCatalogueModel(page: Page, providerName: string, modelId: string): Promise<void> {
  await selectModelSettings(page, 'model');
  const catalog = page.locator('#model .model-catalog');
  if (await catalog.getAttribute('open') === null) { await catalog.locator('summary').focus(); await catalog.locator('summary').click(); }
  const back = catalog.getByRole('button', { name: /^(Back to model catalogue|Retour au catalogue de modèles)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = catalog.getByRole('navigation', { name: /^(Manage model catalogue|Gérer le catalogue de modèles)$/u });
  const code = page.getByText(modelId, { exact: true }).and(page.locator('code'));
  await navigation.getByRole('group', { name: providerName, exact: true }).getByRole('button').filter({ has: code }).click();
}

/** Choose a fresh connection descriptor; selecting metadata never starts its operations. */
export async function selectProviderConnection(page: Page, group: 'builtin' | 'custom', id: string): Promise<void> {
  await selectModelSettings(page, 'provider-lifecycle');
  const back = page.getByRole('button', { name: /^(Back to provider connections|Retour aux connexions fournisseurs)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = page.locator('#provider-lifecycle').getByRole('navigation', { name: /^(Provider connections|Connexions fournisseurs)$/u });
  const name = group === 'builtin' ? /^(Built-in providers|Fournisseurs intégrés)$/u : /^(Custom providers|Fournisseurs personnalisés)$/u;
  const code = page.getByText(id, { exact: true }).and(page.locator('code'));
  await navigation.getByRole('group', { name }).getByRole('button').filter({ has: code }).click();
}

/** Inspect a built-in credential row without changing the active provider. */
export async function selectProviderCredential(page: Page, name: string): Promise<void> {
  await selectModelSettings(page, 'providers');
  const back = page.getByRole('button', { name: /^(Back to provider credentials|Retour aux identifiants fournisseurs)$/u });
  if (await back.isVisible()) await back.click();
  const navigation = page.locator('#providers').getByRole('navigation', { name: /^(Provider credentials|Identifiants fournisseurs)$/u });
  await navigation.getByRole('button', { name, exact: true }).click();
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
