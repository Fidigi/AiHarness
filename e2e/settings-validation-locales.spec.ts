import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures/test-budget.js';
import { installMockApi } from './fixtures/mock-api.js';
import { mcpStateInventory } from './fixtures/mcp.js';
import { describeMcpConfigEntry, type McpEntryProblemReason } from '../packages/core/src/mcp/config-inventory.js';

const cases: Array<[McpEntryProblemReason, string, unknown, string]> = [
  ['entry-shape', 'shape', 42, 'L’entrée du serveur doit être un objet.'],
  ['server-name', 'bad\u202ename', { command: 'node' }, 'Le nom du serveur est vide, trop long ou contient des caractères masqués.'],
  ['unsupported-properties', 'properties', { command: 'node', extra: 'PRIVATE-LITERAL' }, 'L’entrée du serveur contient des propriétés non prises en charge.'],
  ['target', 'target', {}, 'L’entrée du serveur doit définir exactement une commande ou une URL.'],
  ['command', 'command', { command: '' }, 'La commande doit être une chaîne bornée non vide.'],
  ['url', 'url', { url: 'ftp://example.test/PRIVATE-LITERAL' }, 'L’URL doit être une URL HTTP ou HTTPS de longueur bornée.'],
  ['transport', 'transport', { command: 'node', type: 'bad' }, 'Ce type de transport n’est pas pris en charge.'],
  ['stdio-transport', 'stdio-type', { command: 'node', type: 'http' }, 'Le type de transport ne correspond pas au transport par commande.'],
  ['http-transport', 'http-type', { url: 'https://example.test', type: 'stdio' }, 'Le type de transport ne correspond pas au transport par URL.'],
  ['args', 'args', { command: 'node', args: [17] }, 'Les arguments doivent être un tableau borné de chaînes.'],
  ['cwd', 'cwd', { command: 'node', cwd: 17 }, 'Le dossier de travail doit être une chaîne bornée.'],
  ['description', 'description', { command: 'node', description: 17 }, 'La description doit être une chaîne bornée.'],
  ['env', 'env', { command: 'node', env: { TOKEN: 17 } }, 'Les variables d’environnement doivent former une table bornée de chaînes.'],
  ['headers', 'headers', { url: 'https://example.test', headers: { Authorization: 17 } }, 'Les en-têtes doivent former une table bornée de chaînes.'],
  ['stdio-fields', 'stdio-fields', { command: 'node', headers: {} }, 'Un serveur d’entrée-sortie standard ne peut pas déclarer d’en-têtes HTTP ni de paramètres OAuth.'],
  ['http-fields', 'http-fields', { url: 'https://example.test', env: {} }, 'Un serveur HTTP ne peut pas déclarer d’arguments de commande, de dossier de travail ni d’environnement de processus.'],
  ['enabled', 'enabled', { command: 'node', enabled: 'PRIVATE-LITERAL' }, 'L’état d’activation doit être un booléen.'],
  ['exposure', 'exposure', { command: 'node', exposure: 'PRIVATE-LITERAL' }, 'L’exposition doit être direct, codemode, deferred ou hidden.'],
  ['tool-exposure', 'tool-exposure', { command: 'node', toolExposure: { tool: 'PRIVATE-LITERAL' } }, 'L’exposition par outil doit être une table bornée de noms exacts et de modes d’exposition.'],
  ['oauth', 'oauth', { url: 'https://example.test', oauth: { extra: 'PRIVATE-LITERAL' } }, 'Les paramètres OAuth ne respectent pas le schéma pris en charge.'],
];

for (const locale of ['en', 'fr'] as const) for (const mobile of [false, true]) for (const theme of ['light', 'dark'] as const) {
  test(`typed MCP validation ${locale} ${mobile ? 'mobile' : 'desktop'} ${theme} stays localized and passive`, async ({ page }) => {
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: mobile ? 844 : 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(locale => localStorage.setItem('ai-harness-locale', locale), locale);
    const inventory = mcpStateInventory();
    inventory.files = inventory.files.filter(file => file.scope === 'global').map(file => ({ ...file, problems: [] }));
    inventory.servers = cases.map(([, name, value]) => ({ ...describeMcpConfigEntry(name, value), sourcePath: '/agent/mcp.json' }));
    const legacy = { ...describeMcpConfigEntry('legacy-technical', { command: 'node', enabled: 17 }),
      problems: ['Remote/custom technical detail remains verbatim 012345'], sourcePath: '/agent/mcp.json' };
    delete legacy.problemReasons;
    // Optional presentation metadata from an older/incompatible server must not break legacy details.
    inventory.servers.push(legacy, { ...legacy, name: 'legacy-empty-codes', problemReasons: [] },
      { ...legacy, name: 'legacy-malformed-codes', problemReasons: 'enabled' as unknown as McpEntryProblemReason[] },
      { ...describeMcpConfigEntry('future-code', { command: 'node', enabled: 17 }),
      problemReasons: ['future-reason' as McpEntryProblemReason], problems: ['Unrecognized source detail must not become app copy'], sourcePath: '/agent/mcp.json' });
    const api = await installMockApi(page, { mcpConfig: inventory });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const label = locale === 'fr' ? 'Configuration globale' : 'Global configuration';
    const prefix = locale === 'fr' ? 'Afficher les détails de' : 'Show details for';
    const region = locale === 'fr' ? 'Détails du serveur :' : 'Server details:';
    for (const [reason, name, , french] of cases) {
      const descriptor = inventory.servers.find(server => server.name === (name.includes('\u202e') ? 'bad\\u202ename' : name))!;
      const button = section.getByRole('button', { name: `${prefix} ${label} / ${descriptor.name}`, exact: true });
      await button.click();
      const detail = section.getByRole('region', { name: `${region} ${label} / ${descriptor.name}`, exact: true });
      await expect(detail).toBeVisible();
      const index = descriptor.problemReasons!.indexOf(reason);
      await expect(detail.locator('.mcp-diagnostics')).toContainText(locale === 'fr' ? french : descriptor.problems[index]!);
      if (locale === 'fr') await expect(detail.locator('.mcp-diagnostics')).not.toContainText(descriptor.problems[index]!);
      await expect(button).toBeFocused();
    }
    const selected = section.getByRole('region', { name: `${region} ${label} / oauth`, exact: true });
    await expect(selected).toHaveScreenshot(`typed-mcp-validation-${locale}-${mobile ? 'mobile' : 'desktop'}-${theme}.png`);
    await section.getByRole('button', { name: `${prefix} ${label} / future-code`, exact: true }).click();
    const future = section.getByRole('region', { name: `${region} ${label} / future-code`, exact: true });
    await expect(future).toContainText(locale === 'fr'
      ? 'L’entrée du serveur ne respecte pas le schéma MCP pris en charge.' : 'The server entry does not match the supported MCP schema.');
    await expect(future).not.toContainText('Unrecognized source detail');
    for (const name of ['legacy-technical', 'legacy-empty-codes', 'legacy-malformed-codes']) {
      await section.getByRole('button', { name: `${prefix} ${label} / ${name}`, exact: true }).click();
      await expect(section.getByRole('region', { name: `${region} ${label} / ${name}`, exact: true }))
        .toContainText('Remote/custom technical detail remains verbatim 012345');
    }
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE-LITERAL');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include('#mcp').analyze()).violations).toEqual([]);
    if (!mobile) {
      const language = page.getByRole('combobox', { name: locale === 'fr' ? 'Langue' : 'Language', exact: true });
      await language.focus();
      await language.selectOption(locale === 'fr' ? 'en' : 'fr');
      await expect(page.locator('html')).toHaveAttribute('lang', locale === 'fr' ? 'en' : 'fr');
      await expect(page.getByRole('combobox', { name: locale === 'fr' ? 'Language' : 'Langue', exact: true })).toBeFocused();
      const switchedPrefix = locale === 'fr' ? 'Show details for' : 'Afficher les détails de';
      const switchedLabel = locale === 'fr' ? 'Global configuration' : 'Configuration globale';
      await section.getByRole('button', { name: `${switchedPrefix} ${switchedLabel} / enabled`, exact: true }).click();
      await expect(section.locator('.mcp-server-detail:not([hidden]) .mcp-diagnostics'))
        .toContainText(locale === 'fr' ? 'Enabled must be a boolean.' : 'L’état d’activation doit être un booléen.');
    }
    expect(api.requests.filter(request => request.method !== 'GET' && (request.path.startsWith('/api/mcp') || request.path === '/api/agent/runs'))).toEqual([]);
  });
}
