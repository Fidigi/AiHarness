import type { SubagentRunSnapshot } from '@ai-harness/core';
import { expect, test } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';

const run = (parent: string, status: SubagentRunSnapshot['status'] = 'running'): SubagentRunSnapshot => ({
  id: `child-${parent}`, parentSessionId: parent, childSessionId: `history-${parent}`, profileId: 'general',
  profileName: parent, task: `task-${parent}`, provider: 'mock', status, phase: status, background: true,
  attention: status === 'completed', turn: 1, maxTurns: 8, startedAt: '2026-10-24T12:00:00Z',
});
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

test('retires a held parent poll on actual in-app navigation', async ({ page }) => {
  const a = mockSession('parent-a', 'First parent'), b = mockSession('parent-b', 'Second parent');
  await installMockApi(page, { sessions: [a, b], subagentRuns: [run(b.id)] });
  const held = barrier(), entered = barrier();
  await page.route('**/api/subagents/runs?parentSessionId=parent-a', async route => {
    entered.release(); await held.promise;
    await route.fulfill({ json: [run(a.id)] }).catch(() => undefined);
  });
  try {
    await page.goto('/chat/parent-a'); await entered.promise;
    await page.locator('a.session-main').filter({ hasText: 'Second parent' }).click();
    await expect(page).toHaveURL(/\/chat\/parent-b/);
    await expect(page.locator('.subagent-toggle-count')).toHaveText('1');
    await page.locator('.subagent-toggle').click();
    await expect(page.locator('.subagent-panel')).toContainText('task-parent-b');
    await page.evaluate(() => {
      const values: boolean[] = []; (window as unknown as { staleChildren: boolean[] }).staleChildren = values;
      new MutationObserver(() => values.push(document.querySelector('.subagent-panel')!.textContent!.includes('task-parent-a')))
        .observe(document.querySelector('.subagent-panel')!, { childList: true, subtree: true, characterData: true });
    });
    const next = page.waitForResponse(response => response.url().includes('/api/subagents/runs?parentSessionId=parent-b'));
    held.release(); await next;
    expect(await page.evaluate(() => (window as unknown as { staleChildren: boolean[] }).staleChildren)).not.toContain(true);
    await expect(page.locator('.subagent-panel')).not.toContainText('task-parent-a');
    await expect(page.locator('.subagent-panel')).toContainText('task-parent-b');
  } finally { held.release(); }
});

test('withdraws late stop diagnostics after session replacement without retrying writes', async ({ page }) => {
  const a = mockSession('parent-a', 'First parent'), b = mockSession('parent-b', 'Second parent');
  await installMockApi(page, { sessions: [a, b], subagentRuns: [run(a.id), run(b.id)] });
  const held = barrier(), entered = barrier(); let writes = 0;
  await page.route('**/api/subagents/runs/child-parent-a/stop', async route => {
    writes++; entered.release(); await held.promise;
    await route.fulfill({ status: 503, json: { error: 'PRIVATE_RETIRED_CHILD_DIAGNOSTIC' } }).catch(() => undefined);
  });
  try {
    await page.goto('/chat/parent-a'); await expect(page.locator('.subagent-toggle-count')).toHaveText('1');
    await page.locator('.subagent-toggle').click();
    await page.getByRole('button', { name: 'Stop child agent', exact: true }).click(); await entered.promise;
    await page.locator('a.session-main').filter({ hasText: 'Second parent' }).click();
    await expect(page.locator('.subagent-toggle-count')).toHaveText('1'); await page.locator('.subagent-toggle').click();
    await expect(page.locator('.subagent-panel')).toContainText('task-parent-b');
    await page.evaluate(() => {
      const values: boolean[] = []; (window as unknown as { retiredDiagnostics: boolean[] }).retiredDiagnostics = values;
      new MutationObserver(() => values.push(document.querySelector('.subagent-panel')!.textContent!.includes('PRIVATE_RETIRED_CHILD_DIAGNOSTIC')))
        .observe(document.querySelector('.subagent-panel')!, { childList: true, subtree: true, characterData: true });
    });
    const next = page.waitForResponse(response => response.url().includes('/api/subagents/runs?parentSessionId=parent-b'));
    held.release(); await next;
    expect(await page.evaluate(() => (window as unknown as { retiredDiagnostics: boolean[] }).retiredDiagnostics)).not.toContain(true);
    await expect(page.locator('.subagent-panel [role=alert]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('PRIVATE_RETIRED_CHILD_DIAGNOSTIC'); expect(writes).toBe(1);
  } finally { held.release(); }
});

test('a late Stop acknowledgment cannot resurrect a child already observed settled', async ({ page }) => {
  const parent = mockSession('parent-a', 'First parent'), active = run(parent.id);
  const api = await installMockApi(page, { sessions: [parent], subagentRuns: [active] });
  const held = barrier(), entered = barrier();
  await page.route('**/api/subagents/runs/child-parent-a/stop', async route => {
    api.subagentRuns[0] = { ...active, status: 'stopped', phase: 'stopped' };
    entered.release(); await held.promise;
    await route.fulfill({ json: { ...active, phase: 'stopping' } });
  });
  try {
    await page.goto('/chat/parent-a'); await expect(page.locator('.subagent-toggle-count')).toHaveText('1');
    await page.locator('.subagent-toggle').click();
    await page.getByRole('button', { name: 'Stop child agent', exact: true }).click(); await entered.promise;
    await expect(page.locator('.subagent-run.stopped')).toHaveCount(1);
    await page.evaluate(() => {
      const values: boolean[] = []; (window as unknown as { resurrectedChild: boolean[] }).resurrectedChild = values;
      new MutationObserver(() => values.push(document.querySelector('.subagent-run')!.classList.contains('running')))
        .observe(document.querySelector('.subagent-run')!, { attributes: true, attributeFilter: ['class'] });
    });
    const next = page.waitForResponse(response => response.url().includes('/api/subagents/runs?parentSessionId=parent-a'));
    held.release(); await next;
    expect(await page.evaluate(() => (window as unknown as { resurrectedChild: boolean[] }).resurrectedChild)).not.toContain(true);
    await expect(page.getByRole('button', { name: 'Stop child agent', exact: true })).toHaveCount(0);
  } finally { held.release(); }
});

test('does not restore acknowledged attention from an older admitted poll', async ({ page }) => {
  const parent = mockSession('parent-a', 'First parent'), completed = run(parent.id, 'completed');
  await installMockApi(page, { sessions: [parent], subagentRuns: [completed] });
  await page.goto('/chat/parent-a'); await expect(page.locator('.subagent-toggle-count')).toHaveText('1');
  const held = barrier(), entered = barrier(); let first = true;
  await page.route('**/api/subagents/runs?parentSessionId=parent-a', async route => {
    if (!first) return route.fallback(); first = false; entered.release(); await held.promise;
    await route.fulfill({ json: [completed] });
  });
  try {
    await entered.promise; await page.locator('.subagent-toggle').click();
    await expect(page.locator('.subagent-toggle')).not.toHaveClass(/attention/);
    await page.evaluate(() => {
      const values: boolean[] = []; (window as unknown as { attentionHistory: boolean[] }).attentionHistory = values;
      new MutationObserver(() => values.push(document.querySelector('.subagent-toggle')!.classList.contains('attention')))
        .observe(document.querySelector('.subagent-toggle')!, { attributes: true, attributeFilter: ['class'] });
    });
    const nextPoll = page.waitForResponse(response => response.url().includes('/api/subagents/runs?parentSessionId=parent-a'));
    held.release(); await nextPoll;
    await page.waitForResponse(response => response.url().includes('/api/subagents/runs?parentSessionId=parent-a'));
    await expect(page.locator('.subagent-toggle')).not.toHaveClass(/attention/);
    expect(await page.evaluate(() => (window as unknown as { attentionHistory: boolean[] }).attentionHistory)).not.toContain(true);
  } finally { held.release(); }
});
