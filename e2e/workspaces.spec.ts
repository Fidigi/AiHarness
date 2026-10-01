import { expect, test } from '@playwright/test';
import { installMockApi } from './fixtures/mock-api';

test.describe('Workspaces et worktrees', () => {
  test('parcourt, annule et restaure un workspace partageable sans créer de session', async ({ page }) => {
    const api = await installMockApi(page, {
      workspaceBrowse: {
        '/workspace/project': {
          cwd: '/workspace/project',
          parent: '/workspace',
          entries: [{ name: 'src', path: '/workspace/project/src', isDirectory: true, isSymbolicLink: false }],
        },
      },
    });
    await page.goto('/');
    await expect(page.locator('.workspace-button small')).not.toBeEmpty();

    await page.locator('.workspace-button').click();
    const picker = page.locator('.directory-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute('aria-labelledby', 'workspace-picker-title');
    const path = picker.getByLabel('Workspace path');
    await expect(path).toBeFocused();

    await path.fill('~/project');
    await picker.getByRole('button', { name: 'Browse' }).click();
    await expect(path).toHaveValue('/workspace/project');
    await expect(picker.getByRole('button', { name: '📁 src' })).toBeVisible();
    await picker.getByRole('button', { name: 'Parent directory' }).click();
    await expect(path).toHaveValue('/workspace');

    await path.fill('/workspace/project');
    await picker.getByRole('button', { name: 'Browse' }).click();
    await picker.getByRole('button', { name: 'Use this workspace' }).click();
    await expect(page).toHaveURL(/\?cwd=%2Fworkspace%2Fproject$/);
    await expect(page.locator('.workspace-button')).toContainText('project');
    expect(api.requests.some(request => request.method === 'POST' && request.path === '/api/sessions')).toBe(false);

    await page.locator('.workspace-button').click();
    await expect(page.getByLabel('Recent workspaces')).toContainText('/workspace/project');
    await expect(page.getByLabel('Recent workspaces')).toContainText('/workspace');
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await expect(picker).toBeHidden();
    await expect(page).toHaveURL(/\?cwd=%2Fworkspace%2Fproject$/);
  });

  test('isole les brouillons et le modèle actif entre workspaces puis les restaure', async ({ page }) => {
    await installMockApi(page, {
      workspaceBrowse: {
        '/workspace': { cwd: '/workspace', entries: [{ name: 'project', path: '/workspace/project', isDirectory: true, isSymbolicLink: false }] },
        '/workspace/project': { cwd: '/workspace/project', parent: '/workspace', entries: [{ name: 'project-marker', path: '/workspace/project/project-marker', isDirectory: true, isSymbolicLink: false }] },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByPlaceholder(/Type your message/).fill('Draft from the root workspace');
    await page.getByLabel('Select the model').fill('root-workspace-model');

    const chooseWorkspace = async (cwd: string) => {
      await page.locator('.workspace-button').click();
      const picker = page.locator('.directory-picker');
      if (cwd.endsWith('/project')) {
        await expect(picker.getByRole('button', { name: '📁 project' })).toBeVisible();
        await picker.getByRole('button', { name: '📁 project' }).click();
        await expect(picker.getByRole('button', { name: '📁 project-marker' })).toBeVisible();
      } else {
        await expect(picker.getByRole('button', { name: '📁 project-marker' })).toBeVisible();
        await picker.getByRole('button', { name: 'Parent directory' }).click();
        await expect(picker.getByRole('button', { name: '📁 project' })).toBeVisible();
      }
      await expect(picker.getByLabel('Workspace path')).toHaveValue(cwd);
      await picker.getByRole('button', { name: 'Use this workspace' }).click();
    };
    await chooseWorkspace('/workspace/project');
    await expect(page).toHaveURL(/cwd=%2Fworkspace%2Fproject/);
    await expect(page.getByText('Draft from the root workspace')).toHaveCount(0);

    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByLabel('Select the model')).toHaveValue('');
    await expect(page.getByLabel('Select the model')).toHaveAttribute('placeholder', /mock-model/);
    await page.getByPlaceholder(/Type your message/).fill('Draft from the project workspace');
    await page.getByLabel('Select the model').fill('project-workspace-model');

    await chooseWorkspace('/workspace');
    await expect(page).toHaveURL(/cwd=%2Fworkspace/);
    await expect(page.getByPlaceholder(/Type your message/)).toHaveValue('Draft from the root workspace');
    await expect(page.getByLabel('Select the model')).toHaveValue('root-workspace-model');

    await chooseWorkspace('/workspace/project');
    await expect(page.getByPlaceholder(/Type your message/)).toHaveValue('Draft from the project workspace');
    await expect(page.getByLabel('Select the model')).toHaveValue('project-workspace-model');
  });

  test('recharge le catalogue de plugins par workspace sans conserver les packages projet précédents', async ({ page }) => {
    await installMockApi(page, {
      workspaceBrowse: {
        '/workspace': { cwd: '/workspace', entries: [{ name: 'project', path: '/workspace/project', isDirectory: true, isSymbolicLink: false }] },
        '/workspace/project': { cwd: '/workspace/project', parent: '/workspace', entries: [] },
      },
    });
    await page.goto('/settings#plugins');
    const plugins = page.locator('#plugins');
    await expect(plugins.locator('.plugin-card').filter({ hasText: 'workspace-kit' })).toBeVisible();
    await expect(plugins.locator('.plugin-card').filter({ hasText: '@aiharness/review-kit' })).toBeVisible();

    await page.locator('.workspace-button').click();
    const picker = page.locator('.directory-picker');
    await picker.getByRole('button', { name: '📁 project' }).click();
    await picker.getByRole('button', { name: 'Use this workspace' }).click();
    await expect(page).toHaveURL(/cwd=%2Fworkspace%2Fproject/);
    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(plugins.locator('.plugin-card').filter({ hasText: 'workspace-kit' })).toHaveCount(0);
    await expect(plugins.locator('.plugin-card').filter({ hasText: '@aiharness/review-kit' })).toBeVisible();
    await expect(plugins.locator('fieldset[data-scope="standalone"]')).not.toContainText('workspace-banner');

    await page.locator('.workspace-button').click();
    await picker.getByRole('button', { name: 'Parent directory' }).click();
    await picker.getByRole('button', { name: 'Use this workspace' }).click();
    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(plugins.locator('.plugin-card').filter({ hasText: 'workspace-kit' })).toBeVisible();
  });

  test('bascule, crée et retire des worktrees avec confirmation', async ({ page }) => {
    const api = await installMockApi(page, {
      worktrees: [
        { path: '/workspace', branch: 'main', bare: false, detached: false },
        { path: '/workspace-existing', branch: 'feature/existing', bare: false, detached: false },
      ],
    });
    await page.goto('/');

    const worktree = page.getByRole('combobox', { name: 'Git worktree' });
    await expect(worktree.locator('option')).toHaveCount(2);
    await worktree.selectOption('/workspace-existing');
    await expect(page).toHaveURL(/\?cwd=%2Fworkspace-existing$/);

    await page.getByRole('button', { name: 'Create a worktree' }).click();
    await page.getByPlaceholder('Destination path').fill('/workspace-new');
    await page.getByPlaceholder('Branch name').fill('feature/new');
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page).toHaveURL(/\?cwd=%2Fworkspace-new$/);
    expect(api.requests.find(request => request.method === 'POST' && request.path === '/api/workspaces/worktrees')?.body)
      .toMatchObject({ cwd: '/workspace-existing', path: '/workspace-new', branch: 'feature/new', createBranch: true });

    await page.getByRole('button', { name: 'Create a worktree' }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: /feature\/existing/ }).click();
    await expect.poll(() => api.worktrees.some(item => item.path === '/workspace-existing')).toBe(false);
    expect(api.requests.find(request => request.method === 'DELETE' && request.path === '/api/workspaces/worktrees')?.body)
      .toMatchObject({ cwd: '/workspace-new', path: '/workspace-existing', confirm: true });
  });
});
