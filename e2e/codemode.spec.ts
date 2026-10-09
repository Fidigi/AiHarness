import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { CodemodeCall, ToolSettings } from '@ai-harness/core';
import { installMockApi, mockSession } from './fixtures/mock-api';

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
    await expect(tools.locator('.tool-settings-list label').filter({ hasText: 'write' })).toContainText('Disabled by the read-only preset.');
    await expect(tools).toContainText('Discovery is not authorization');
    await expect(tools).toContainText('32 MiB');
    await accessible(page, '#tools', scenario.width);
    await tools.scrollIntoViewIfNeeded();
    const bottomRow = await tools.locator('.tool-settings-list label').last().boundingBox();
    expect(bottomRow).not.toBeNull();
    expect(bottomRow!.y + bottomRow!.height).toBeLessThanOrEqual(1400);
    await expect(tools).toHaveScreenshot(`codemode-settings-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    await tools.getByLabel('Scope').selectOption('global');
    await expect(tools.getByLabel('Code mode activation')).toHaveValue('automatic');
    await expect(tools.getByLabel('Tool presentation')).toHaveValue('on');
    await tools.getByLabel('Scope').selectOption('project');
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
  await expect(page.locator('#tools').getByRole('status')).toContainText('execution disabled');
  await expect(page.getByLabel('Code mode activation')).toBeDisabled();
  await expect(page.locator('.tool-settings-list label').filter({ hasText: 'codemode' }).locator('input')).toBeDisabled();
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
