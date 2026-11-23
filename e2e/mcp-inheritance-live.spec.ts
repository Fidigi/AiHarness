import AxeBuilder from '@axe-core/playwright';
import { access, lstat, readFile } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures/test-budget';
import { nativeMcpInheritance } from './fixtures/mcp-inheritance';
import { selectMcpServer } from './fixtures/mcp-navigation';

const locales = {
  en: { scope: 'Project configuration', region: 'Server details:', exposure: 'Tool exposure for', perTool: 'Per-tool exposure overrides',
    test: 'Test shared', replaces: 'replaces the global entry',
    fields: 'A targetless project override may only set enabled, exposure, and toolExposure.',
    orphan: 'A targetless project override requires a valid readable global server with the same name.' },
  fr: { scope: 'Configuration du projet', region: 'Détails du serveur :', exposure: 'Exposition des outils pour', perTool: 'Surcharges d’exposition par outil',
    test: 'Tester shared', replaces: 'remplace l’entrée globale',
    fields: 'Une surcharge de projet sans cible ne peut définir que enabled, exposure et toolExposure.',
    orphan: 'Une surcharge de projet sans cible nécessite un serveur global valide et lisible de même nom.' },
} as const;
async function appearance(page: Page, locale: 'en' | 'fr') {
  await page.addInitScript(locale => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: locale === 'en' ? 'light' : 'dark', filesOpen: false, lastSettingsSection: 'mcp' }));
  }, locale);
}
async function showDetails(page: Page, locale: 'en' | 'fr') {
  await selectMcpServer(page, 'project', 'shared');
  const messages = locales[locale];
  const card = page.locator('#mcp').getByRole('region', { name: `${messages.region} ${messages.scope} / shared`, exact: true }).locator('..');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.mcp-server-detail')).toBeVisible();
  return card;
}
for (const locale of ['en', 'fr'] as const) {
  test.describe(`${locale} native inherited MCP controls`, () => {
    test.use({ viewport: locale === 'en' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }, hasTouch: locale === 'fr', isMobile: locale === 'fr' });
    test('uses the actual static Web/HTTP owner for inherited Test and raw project-only writes', async ({ page }) => {
      await appearance(page, locale); const f = await nativeMcpInheritance(page.request), messages = locales[locale];
      try {
        await page.goto(f.base + '/settings#mcp');
        const card = await showDetails(page, locale);
        await expect(card.getByRole('combobox', { name: `${messages.exposure} shared`, exact: true })).toHaveValue('direct');
        await expect(card).toContainText(messages.replaces);
        const inventory = await f.inventory();
        expect(inventory.status).toBe(200); expect(inventory.headers['cache-control']).toBe('no-store');
        expect(inventory.data.servers.find(server => server.scope === 'project')).toMatchObject({ valid: true, inheritsGlobal: true, enabled: true, exposure: 'direct' });
        expect(inventory.data.servers.find(server => server.scope === 'global')).toMatchObject({ shadowedByProject: true });
        expect(await readFile(f.globalFile, 'utf8')).toBe(f.globalBytes); expect(await f.local()).toEqual({ version: 1, mcpServers: { shared: f.controls } });
        await expect(access(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(f.starts)).rejects.toMatchObject({ code: 'ENOENT' });
        const testing = page.waitForResponse(response => response.url() === f.base + '/api/mcp/test' && response.request().method() === 'POST');
        await card.getByRole('button', { name: messages.test, exact: true }).click();
        const tested = await testing; expect(tested.status()).toBe(200); expect(tested.headers()['cache-control']).toBe('no-store');
        const result = await tested.json(); expect(result.result.state).toBe('connected');
        const startupBytes = await readFile(f.starts, 'utf8');
        const processes = startupBytes.trim().split('\n').map(line => JSON.parse(line) as { pid: number });
        expect(processes).toHaveLength(1); expect(Number.isInteger(processes[0].pid) && processes[0].pid > 0).toBe(true);
        expect(result.result.tools.map((tool: { name: string; exposure: string }) => [tool.name, tool.exposure])).toEqual([['lookup', 'direct'], ['mutate', 'hidden']]);
        await expect(card.locator('.mcp-test-summary .status-success')).toBeVisible();
        await card.getByText(messages.perTool, { exact: true }).click();
        const lookup = card.getByRole('combobox', { name: `${messages.exposure} shared / lookup`, exact: true });
        await expect(lookup).toHaveValue('direct'); await expect(card.getByRole('combobox', { name: `${messages.exposure} shared / mutate`, exact: true })).toHaveValue('hidden');
        const changing = page.waitForResponse(response => response.url() === f.base + '/api/mcp/actions' && response.request().method() === 'POST');
        await lookup.selectOption('codemode'); const changed = await changing; expect(changed.status()).toBe(200);
        expect(changed.request().postDataJSON()).toMatchObject({ action: 'set-exposure', scope: 'project', name: 'shared', tool: 'lookup', exposure: 'codemode', cwd: f.cwd });
        await expect(lookup).toHaveValue('codemode'); await expect(lookup).toBeFocused();
        await expect(card.locator('.mcp-test-summary')).toHaveCount(0);
        expect(await f.local()).toEqual({ version: 1, mcpServers: { shared: { ...f.controls, toolExposure: { '*': 'hidden', lookup: 'codemode' } } } });
        const info = await lstat(f.projectFile); expect(info.nlink).toBe(1); expect(info.mode & 0o777).toBe(0o640);
        expect(await readFile(f.globalFile, 'utf8')).toBe(f.globalBytes); await expect(access(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(f.starts, 'utf8')).toBe(startupBytes);
        await expect(page.locator('body')).not.toContainText('GLOBAL_INHERITANCE_BROWSER_PRIVATE');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const axe = await new AxeBuilder({ page }).include('#mcp').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze(); expect(axe.violations).toEqual([]);
        // Missing exposure in both files is native direct, never a silent codemode migration.
        await f.setOmittedExposure(); await page.reload();
        const defaultCard = await showDetails(page, locale);
        const exposure = defaultCard.getByRole('combobox', { name: `${messages.exposure} shared`, exact: true });
        await expect(exposure).toHaveValue('direct');
        await expect(exposure).toHaveAccessibleDescription(locale === 'en'
          ? /Missing exposure defaults to direct.*allowlists, exclusions and read-only checks/
          : /Sans exposition définie.*listes autorisées, exclusions et contrôles de lecture seule/);
        const baseline = JSON.parse(await readFile(f.globalFile, 'utf8'));
        expect(baseline.mcpServers.shared).not.toHaveProperty('exposure');
        for (const mode of ['codemode', 'deferred', 'hidden', 'direct']) {
          const saving = page.waitForResponse(response => response.url() === f.base + '/api/mcp/actions' && response.request().method() === 'POST');
          await exposure.selectOption(mode); const saved = await saving;
          expect(saved.status()).toBe(200);
          expect(saved.request().postDataJSON()).toMatchObject({ action: 'set-exposure', scope: 'project', name: 'shared', exposure: mode });
          await expect(exposure).toHaveValue(mode);
          expect(await f.local()).toEqual({ version: 1, mcpServers: { shared: { enabled: true, exposure: mode } } });
        }
        expect(JSON.parse(await readFile(f.globalFile, 'utf8'))).toEqual(baseline);
        expect(await readFile(f.starts, 'utf8')).toBe(startupBytes);
        await expect(access(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
        await page.reload(); await expect((await showDetails(page, locale)).getByRole('combobox', { name: `${messages.exposure} shared`, exact: true })).toHaveValue('direct');
      } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
    });

    test('renders actual value-free override/orphan diagnostics without offering transport actions', async ({ page }) => {
      await appearance(page, locale); const f = await nativeMcpInheritance(page.request), messages = locales[locale];
      const writes: string[] = [];
      page.on('request', request => { if (request.url().startsWith(f.base + '/api/mcp/') && request.method() !== 'GET') writes.push(new URL(request.url()).pathname); });
      try {
        await f.setInvalid(); await page.goto(f.base + '/settings#mcp');
        let card = await showDetails(page, locale);
        await expect(card.locator('.mcp-diagnostics')).toHaveText(messages.fields);
        await expect(card.getByRole('button', { name: messages.test, exact: true })).toHaveCount(0);
        const invalid = await f.inventory(); expect(invalid.data.servers.find(server => server.scope === 'project')).toMatchObject({ valid: false, problemReasons: ['override-fields'] });
        await expect(page.locator('body')).not.toContainText('PRIVATE_PROJECT_REDIRECT');
        expect(await readFile(f.globalFile, 'utf8')).toBe(f.globalBytes);
        await f.setOrphan(); await page.reload(); card = await showDetails(page, locale);
        await expect(card.locator('.mcp-diagnostics')).toHaveText(messages.orphan);
        await expect(card.getByRole('button', { name: messages.test, exact: true })).toHaveCount(0);
        const orphan = await f.inventory(); expect(orphan.data.servers.find(server => server.scope === 'project')).toMatchObject({ valid: false, problemReasons: ['orphan-override'] });
        expect(writes).toEqual([]); await expect(access(f.log)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(f.starts)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(page.locator('body')).not.toContainText('GLOBAL_INHERITANCE_BROWSER_PRIVATE');
      } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
    });
  });
}
