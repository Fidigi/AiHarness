import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixtures/test-budget';
import type { CodemodeCall, ToolSettings } from '@ai-harness/core';
import { installMockApi, mockSession } from './fixtures/mock-api';
import { selectGeneralSettings, selectSettingsCategory, selectSettingsTool } from './fixtures/settings-navigation';
import { expectContrast } from './fixtures/contrast';

function sandboxSettings(): ToolSettings {
  return { scope: 'project', source: 'workspace-e2e', preset: 'default', powershellAvailable: false, powershellEnabled: false,
    codemode: { enabled: false, mode: 'on', inlineBudget: 3000, selfTest: { state: 'passed', engine: 'QuickJS' } },
    tools: [
      { name: 'read', description: 'Read a workspace file', extensionId: 'builtin:workspace-tools', enabled: true, available: true },
      { name: 'write', description: 'Write a workspace file', extensionId: 'builtin:workspace-tools', enabled: true, available: true },
      { name: 'codemode', description: 'Bounded QuickJS scripts with authorized nested tools', extensionId: 'builtin:codemode', enabled: true, available: true, disabledReason: 'automatic' },
      { name: 'tool_search', description: 'Discover eligible metadata; never grants permission', extensionId: 'builtin:tool-search', enabled: true, available: true, disabledReason: 'automatic' },
      { name: 'powershell', description: 'Run PowerShell', extensionId: 'builtin:workspace-tools', enabled: false, available: false, unavailableReason: 'Windows only' },
    ] };
}

for (const scenario of [
  { width: 1280, locale: 'en', theme: 'light' },
  { width: 1280, locale: 'fr', theme: 'dark' },
  { width: 390, locale: 'en', theme: 'light' },
  { width: 390, locale: 'fr', theme: 'dark' },
] as const) test(`Tools contextual selection is scoped and never executes tools: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scenario.width, height: 844 });
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
  }, scenario);
  const api = await installMockApi(page, { toolSettings: sandboxSettings() });
  await page.goto('/settings#tools');
  const navigation = page.getByRole('navigation', { name: /^(Tools and presets|Outils et préréglages)$/u });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('button')).toHaveCount(5);
  const choice = navigation.getByRole('button', { name: 'write', exact: true });
  await choice.focus(); await choice.press('Enter');
  const detail = page.locator('.tool-context-detail');
  await expect(detail.getByRole('checkbox')).toHaveCount(1);
  await expect(detail.getByRole('checkbox')).toHaveAccessibleName(/write/u);
  await expect(detail).toContainText('Write a workspace file');
  const selectedMetadata = page.getByRole('button', { name: 'write', exact: true, includeHidden: true });
  await expect(selectedMetadata).toHaveAttribute('aria-current', 'true');
  await expect(selectedMetadata).toHaveAttribute('aria-expanded', 'true');
  await expect(selectedMetadata).toHaveCSS('border-left-width', '3px');
  await expect(page.locator('.codemode-settings')).toBeHidden();
  const back = page.getByRole('button', { name: /^(Back to tools|Retour aux outils)$/u });
  if (scenario.width < 960) {
    await expect(back).toBeFocused();
    await back.press('Enter');
    for (const control of [choice, back]) {
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS('outline-style', 'solid');
      await expectContrast(control, 'outlineColor', 3);
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const clearance = await control.evaluate(element => {
        const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
        const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
        const owners = [element.closest('nav') ?? element.closest('.tool-context-detail')!, element.closest('.settings-view')!];
        return Math.min(...owners.flatMap(owner => {
          const clip = owner.getBoundingClientRect();
          return [bounds.left - clip.left, clip.right - bounds.right, bounds.top - clip.top, clip.bottom - bounds.bottom];
        })) - extent;
      });
      expect(clearance).toBeGreaterThanOrEqual(-0.1);
      if (control === choice) await choice.press('Enter');
    }
  } else {
    const list = (await navigation.boundingBox())!, content = (await detail.boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(content.x);
  }
  await selectGeneralSettings(page, 'appearance');
  await selectSettingsCategory(page, 'tools');
  await expect(detail).toContainText('Write a workspace file');
  await page.reload();
  await expect(detail).toContainText('Write a workspace file');
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('ai-harness-settings-navigation-v1')!));
  expect(stored.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions.tools)
    .toEqual({ group: 'project', selection: 'write' });
  await selectSettingsTool(page, 'codemode');
  await expect(page.locator('.codemode-settings')).toBeVisible();
  expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await accessible(page, '#tools', scenario.width);
  const codeCapture = testInfo.outputPath(`tools-codemode-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: codeCapture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('tools-codemode', { path: codeCapture, contentType: 'image/png' });
  await selectSettingsTool(page, 'write');
  const scopeControl = page.locator('#tools').getByRole('combobox', { name: /^(Scope|Portée)$/u });
  await scopeControl.focus();
  await scopeControl.selectOption('global');
  await expect(navigation.getByRole('button', { name: 'read', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(scopeControl).toBeFocused();
  await expect(choice).not.toHaveAttribute('aria-current', 'true');
  await navigation.getByRole('button', { name: 'powershell', exact: true }).click();
  await expect(detail).toContainText('Windows only');
  await expect(detail.getByRole('checkbox')).toBeDisabled();
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  await accessible(page, '#tools', scenario.width);
  const capture = testInfo.outputPath(`tools-context-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('tools-context', { path: capture, contentType: 'image/png' });

  await selectSettingsTool(page, 'write');
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/tools', async route => {
    if (route.request().method() === 'PATCH') { entered(); await held; }
    await route.fallback();
  });
  try {
    // The controlled value stays canonical while this write is held; no optimistic toggle is required.
    await detail.getByRole('checkbox').focus();
    await detail.getByRole('checkbox').press('Space');
    await pending;
    if (scenario.width < 960) {
      await back.focus(); await back.press('Enter');
      await expect(navigation).toBeFocused();
      await expect(navigation.getByRole('button', { name: 'write', exact: true })).toBeDisabled();
      const pendingCapture = testInfo.outputPath(`tools-pending-${scenario.width}-${scenario.locale}.png`);
      await page.screenshot({ path: pendingCapture, animations: 'disabled', caret: 'hide' });
      await testInfo.attach('tools-pending-focus', { path: pendingCapture, contentType: 'image/png' });
    }
  } finally { release(); }
  await expect(selectedMetadata).toBeEnabled();
  await expect.poll(() => api.requests.filter(request => request.path === '/api/tools' && request.method === 'PATCH').at(-1)?.body)
    .toMatchObject({ enabledTools: ['read', 'codemode', 'tool_search'], toolPreset: 'default', powershellEnabled: false,
      codemodeEnabled: false, codemodeMode: 'on', codemodeInlineBudget: 3000 });
  const body = api.requests.filter(request => request.path === '/api/tools' && request.method === 'PATCH').at(-1)!.body;
  expect(body).not.toHaveProperty('projectId');
  expect(body).not.toHaveProperty('cwd');
  await selectSettingsTool(page, 'write');
  await expect(detail.getByRole('checkbox')).not.toBeChecked();
  if (scenario.width > 959) {
    await selectSettingsTool(page, 'write');
    const scope = page.locator('#tools').getByRole('combobox', { name: /^(Scope|Portée)$/u });
    await scope.focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(back).toBeVisible();
    await expect(scope).toBeFocused();
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await expect(back).toBeHidden();
    await expect(scope).toBeFocused();
  }
  // A fresh missing explicit choice cannot silently borrow another tool or scope.
  const longName = 'fixture_read_workspace_metadata_with_an_explicit_long_tool_name_and_preserved_authorization';
  await page.route('**/api/tools', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    ...sandboxSettings(), scope: 'global', source: 'global', tools: [
      ...sandboxSettings().tools.filter(tool => tool.name !== 'write'),
      { name: longName, description: 'Read fixture metadata', extensionId: 'fixture:contextual-tools', enabled: true, available: true },
    ],
  }) }));
  await page.reload();
  await expect(navigation).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /selected tool is unavailable|L’outil sélectionné/u })).toBeVisible();
  await expect(page.locator('.tool-context-detail').getByRole('checkbox')).toHaveCount(0);
  await navigation.getByRole('button', { name: longName, exact: true }).click();
  await expect(detail).toContainText(longName);
  const toolBounds = await detail.locator('.tool-settings-list > div:visible').boundingBox();
  const detailBounds = await detail.boundingBox();
  expect(toolBounds!.x + toolBounds!.width).toBeLessThanOrEqual(detailBounds!.x + detailBounds!.width + 0.1);
  expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const longCapture = testInfo.outputPath(`tools-long-name-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: longCapture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('tools-long-name', { path: longCapture, contentType: 'image/png' });
  expect(api.requests.some(request => request.path.includes('execute') || request.path === '/api/agent/runs')).toBe(false);
});

async function accessible(page: Page, selector: string, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const result = await new AxeBuilder({ page }).include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
}

for (const scenario of [
  { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'desktop-light', width: 1440, theme: 'light' },
  { name: 'mobile-dark', width: 390, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' },
] as const) {
  test(`${scenario.name} Code mode saves scoped settings, displays limits and disabled reasons`, async ({ page }) => {
    // A tall viewport keeps the entire settings section inside its scrollport.
    await page.setViewportSize({ width: scenario.width, height: 1400 });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme, lastSettingsSection: 'tools',
    })), scenario.theme);
    const api = await installMockApi(page, { toolSettings: sandboxSettings() });
    await page.goto('/settings#tools');
    const tools = page.locator('#tools');
    await selectSettingsTool(page, 'codemode');
    await expect(tools.getByRole('status')).toContainText('Sandbox self-test passed');
    await tools.getByLabel('Scope').selectOption('project');
    await tools.getByLabel('Code mode activation').selectOption('on');
    await expect(tools.getByLabel('Code mode activation')).toHaveValue('on');
    await tools.getByLabel('Tool presentation').selectOption('only');
    await expect(tools.getByLabel('Tool presentation')).toHaveValue('only');
    const budget = tools.getByLabel('Inline declaration budget (estimated tokens)');
    await budget.fill('500'); await budget.press('Tab');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/tools' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ projectId: 'workspace-e2e', cwd: '/workspace', codemodeEnabled: true, codemodeMode: 'only', codemodeInlineBudget: 500 });
    await tools.getByLabel('Default tool preset').selectOption('read-only');
    await selectSettingsTool(page, 'write');
    await expect(tools.locator('.tool-settings-list label:visible').filter({ hasText: 'write' })).toContainText('Disabled by the read-only preset.');
    await selectSettingsTool(page, 'codemode');
    await expect(tools.locator('.codemode-settings')).toBeVisible();
    await expect(tools).toContainText('Discovery is not authorization');
    await expect(tools).toContainText('32 MiB');
    await accessible(page, '#tools', scenario.width);
    await tools.scrollIntoViewIfNeeded();
    const bottomRow = await tools.locator('.tool-settings-list > div:visible').boundingBox();
    expect(bottomRow).not.toBeNull();
    expect(bottomRow!.y + bottomRow!.height).toBeLessThanOrEqual(1400);
    await expect(tools).toHaveScreenshot(`codemode-settings-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    await tools.getByLabel('Scope').selectOption('global');
    await selectSettingsTool(page, 'codemode');
    await expect(tools.getByLabel('Code mode activation')).toHaveValue('automatic');
    await expect(tools.getByLabel('Tool presentation')).toHaveValue('on');
    await tools.getByLabel('Scope').selectOption('project');
    await selectSettingsTool(page, 'codemode');
    await expect(tools.getByLabel('Tool presentation')).toHaveValue('only');
    await expect(budget).toHaveValue('500');
    const gets = api.requests.filter(request => request.path === '/api/tools' && request.method === 'GET').length;
    await page.reload();
    await expect(page.locator('#tools').getByRole('status')).toContainText('Sandbox self-test passed');
    expect(api.requests.filter(request => request.path === '/api/tools' && request.method === 'GET').length).toBeGreaterThan(gets);
    expect(api.requests.some(request => request.path.includes('execute') || request.path === '/api/agent/runs')).toBe(false);
  });

  test(`${scenario.name} nested code card restores script, calls, omitted count and authoritative cost`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 1400 });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme })), scenario.theme);
    const session = mockSession('nested-card', 'Nested code mode');
    const code = 'const results = await Promise.all([tools.read({path:"README.md"}), models.classify({model:"classifier",input:"safe",labels:["safe","unsafe"]})]); text(results);';
    const calls: CodemodeCall[] = Array.from({ length: 14 }, (_, i) => ({ id: `outer:${i + 1}`, parentId: 'outer',
      name: i === 0 ? 'mcp__documentation__read_reference_with_long_name' : i === 1 ? 'classifier' : 'read',
      kind: i === 1 ? 'classifier' : 'tool', state: i === 3 ? 'failed' : 'completed', isError: i === 3,
      durationMs: 20 + i, ...(i === 1 ? { usage: { totalTokens: 12, costUsd: 0.002 } } : {}) }));
    session.messages = [
      { id: 'script-call', role: 'assistant', content: '', timestamp: '2025-01-01T12:00:00Z',
        toolCalls: [{ id: 'outer', name: 'codemode', input: { code } }], blocks: [{ type: 'tool_call', id: 'outer', name: 'codemode', input: { code } }] },
      { id: 'script-result', role: 'tool', name: 'codemode', toolCallId: 'outer', content: 'Script completed\n["reference", {"label":"safe"}]',
        timestamp: '2025-01-01T12:00:01Z', usage: { totalTokens: 12, costUsd: 0.002 },
        blocks: [{ type: 'tool_result', name: 'codemode', toolCallId: 'outer', content: 'Script completed\n["reference", {"label":"safe"}]' }],
        metadata: { codemode: { engine: 'QuickJS', parentId: 'outer', durationMs: 420, nestedCalls: calls,
          costComplete: true, usage: { totalTokens: 12, costUsd: 0.002 } } } },
    ];
    await installMockApi(page, { sessions: [session] });
    await page.goto('/chat/nested-card');
    const card = page.getByRole('region', { name: 'Code mode · QuickJS' });
    await expect(card).toContainText('2 more calls omitted');
    await expect(card).toContainText('Cost: $0.002000');
    await expect(card.locator('li')).toHaveCount(12);
    await card.getByText('Script', { exact: true }).click();
    await expect(card).toContainText('models.classify');
    await accessible(page, '.codemode-card', scenario.width);
    await card.scrollIntoViewIfNeeded();
    const bounds = await card.boundingBox();
    const scrollport = await page.locator('.messages-container').boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(scrollport!.y + scrollport!.height + 1);
    await expect(card).toHaveScreenshot(`codemode-nested-card-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    await page.reload();
    await expect(page.getByRole('region', { name: 'Code mode · QuickJS' })).toContainText('Cost: $0.002000');
    await expect(page.locator('.message.tool')).toHaveCount(1); // No nested top-level results on replay.
  });
}

test('failed sandbox health is visible and cannot activate execution from Settings', async ({ page }) => {
  const settings = sandboxSettings();
  settings.codemode!.selfTest.state = 'failed';
  settings.tools.find(tool => tool.name === 'codemode')!.available = false;
  settings.tools.find(tool => tool.name === 'codemode')!.disabledReason = 'sandbox-unavailable';
  const api = await installMockApi(page, { toolSettings: settings });
  await page.goto('/settings#tools');
  await selectSettingsTool(page, 'codemode');
  await expect(page.locator('#tools').getByRole('status')).toContainText('execution disabled');
  await expect(page.getByLabel('Code mode activation')).toBeDisabled();
  await expect(page.locator('.tool-settings-list label:visible').filter({ hasText: 'codemode' }).locator('input')).toBeDisabled();
  expect(api.requests.some(request => request.method === 'PATCH')).toBe(false);
});

test('live nested snapshot and child controls survive dynamic presets, reload and navigation', async ({ page }) => {
  const child = { id: 'child-control', parentSessionId: 'nested-live', childSessionId: 'child-session', profileId: 'review',
    profileName: 'Retained reviewer', task: 'Review safely', background: true, status: 'running' as const, phase: 'streaming',
    turn: 1, maxTurns: 5, attention: false, provider: 'mock', startedAt: '2025-01-01T12:00:00Z' };
  const api = await installMockApi(page, { sessions: [mockSession('nested-live', 'Live nested')], holdAgentRun: true,
    subagentRuns: [child], capabilities: { systemPrompt: '', tools: [{ name: 'codemode', description: 'Only code', parameters: {}, extensionId: 'builtin:codemode' }] } });
  await page.goto('/chat/nested-live');
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.fill('Run'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  api.setRunPhase('nested-live', 'tool', { activeTool: { id: 'live-outer', name: 'codemode', input: { code: 'await tools.read({});' },
    startedAt: '2025-01-01T12:00:00Z', nestedCalls: [{ id: 'live-outer:1', parentId: 'live-outer', kind: 'tool', name: 'read', state: 'running', isError: false }] } });
  const card = page.getByRole('region', { name: 'Code mode · QuickJS' });
  await expect(card.getByRole('list', { name: 'Nested calls' })).toContainText('read');
  await expect(page.getByRole('status').filter({ hasText: 'Running tool: codemode' })).toBeVisible();
  await page.getByRole('button', { name: 'Open child agents (1)' }).click();
  const panel = page.getByRole('complementary', { name: 'Child agents', exact: true });
  await expect(panel).toContainText('Retained reviewer');
  for (const preset of ['read-only', 'chat-only', 'default']) {
    await page.getByRole('combobox', { name: 'Tool preset', exact: true }).selectOption(preset);
    await expect(panel).toContainText('Retained reviewer');
    await expect(card.getByRole('list')).toContainText('read');
  }
  await composer.fill('/reload'); await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(() => api.requests.some(request => request.path === '/api/agent/reload')).toBe(true);
  await expect(panel).toContainText('Retained reviewer');
  await page.goto('/settings#tools');
  await page.goto('/chat/nested-live');
  await expect(card.getByRole('list')).toContainText('read');
  await page.reload();
  await expect(card.getByRole('list')).toContainText('read');
  await page.getByRole('button', { name: 'Open child agents (1)' }).click();
  await expect(panel).toContainText('Retained reviewer');
  await panel.getByRole('button', { name: 'Stop child agent', exact: true }).click();
  await expect(panel).toContainText('stopped');
  await page.getByRole('button', { name: 'Stop tool', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop tool', exact: true })).toHaveCount(0);
  await expect(card).toHaveCount(0);
  expect(api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST')).toHaveLength(1);
});
