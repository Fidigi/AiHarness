import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test, reserveReadBudget } from './fixtures/test-budget';

for (const scene of [{ locale: 'en', width: 1280 }, { locale: 'fr', width: 390 }] as const) {
  test.describe(`native PTY lifetime ${scene.locale}/${scene.width}`, () => {
    test.use({ viewport: { width: scene.width, height: 900 }, hasTouch: scene.width === 390, isMobile: scene.width === 390 });
    test('owns Unicode paste, reconnect, exit, expired IDs and independent workspace restoration', async ({ page, context }) => {
      test.setTimeout(60_000);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-web05-browser-'));
      const cwd = path.join(root, 'first'), other = path.join(root, 'second');
      await mkdir(cwd); await mkdir(other);
      await mkdir(path.join(cwd, 'first-picker-ready')); await mkdir(path.join(other, 'second-picker-ready'));
      const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
      const previous = names.map(name => process.env[name]);
      process.env.AI_HARNESS_AUTH_TOKEN = 'web05-browser-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'web05-browser-admin';
      process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
      let release = () => {};
      const fr = scene.locale === 'fr';
      try {
        for (const folder of [cwd, other]) await writeFile(path.join(folder, 'AGENTS.md'), 'Explicit fixture trust.');
        const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), defaultCwd: cwd,
          allowedRoots: [root], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
        const base = `http://127.0.0.1:${server.port}`;
        expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'web05-browser-admin' } })).status()).toBe(200);
        await reserveReadBudget(page.request, base);
        for (const folder of [cwd, other]) expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd: folder, confirm: true } })).status()).toBe(200);
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
        await page.addInitScript(locale => {
          localStorage.setItem('ai-harness-locale', locale);
          localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: 'dark', filesOpen: false, sound: false }));
        }, scene.locale);
        const cursors: number[] = [], inputs: string[] = [], created: string[] = [];
        page.on('request', request => {
          const url = new URL(request.url());
          if (/\/api\/terminals\/[^/]+\/events$/.test(url.pathname)) cursors.push(Number(url.searchParams.get('after')));
          if (/\/api\/terminals\/[^/]+\/input$/.test(url.pathname)) inputs.push((request.postDataJSON() as { data: string }).data);
        });
        page.on('response', async response => {
          if (new URL(response.url()).pathname === '/api/terminals' && response.request().method() === 'POST' && response.status() === 201)
            created.push((await response.json() as { id: string }).id);
        });
        await page.goto(`${base}/?cwd=${encodeURIComponent(cwd)}`);
        await expect(page.locator('.workspace-button small')).toContainText(cwd);
        const openName = fr ? 'Ouvrir le terminal du workspace' : 'Open workspace terminal';
        await page.getByRole('button', { name: openName, exact: true }).click();
        const panel = page.getByRole('region', { name: 'Terminal', exact: true });
        await expect(panel.locator('.xterm-rows')).toContainText(/[$#]/);
        await expect.poll(() => created.length).toBe(1); const id = created[0];
        const resultFile = path.join(cwd, 'paste.json');
        const text = 'é😀漢字'.repeat(3_000);
        const framed = Buffer.from('\x1b[200~' + text + '\x1b[201~');
        const code = `const fs=require("node:fs"),c=require("node:crypto");process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004hPTY_"+"READY\\r\\n");let all=Buffer.alloc(0);process.stdin.on("data",b=>{if(b.length===1&&b[0]===4)process.exit(7);if(b.toString()==="t"){process.stdout.write("\\r\\nTAIL_"+"OFFLINE\\r\\n");return}all=Buffer.concat([all,b]);if(all.length>=${framed.length}){fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({bytes:all.length,sha:c.createHash("sha256").update(all).digest("hex")}));process.stdout.write("\\r\\nPASTE_"+"OK_é😀漢字\\r\\n")}})`;
        expect((await page.request.post(`${base}/api/terminals/${id}/input`, { data: { data: `exec node -e '${code}'\r` } })).status()).toBe(200);
        await expect(panel.locator('.xterm-rows')).toContainText('PTY_READY');
        await page.evaluate(value => navigator.clipboard.writeText(value), text);
        const textarea = panel.locator('.xterm-helper-textarea'); await textarea.focus();
        await textarea.press('Control+Shift+V');
        await expect.poll(async () => JSON.parse(await readFile(resultFile, 'utf8').catch(() => '{}'))).toEqual({ bytes: framed.length, sha: createHash('sha256').update(framed).digest('hex') });
        await expect(panel.locator('.xterm-rows')).toContainText('PASTE_OK_é😀漢字');
        expect(inputs.filter(value => value.includes(text))).toEqual([framed.toString()]);
        const beforeOversize = inputs.length;
        await page.evaluate(value => navigator.clipboard.writeText(value), text + text);
        await textarea.focus(); await textarea.press('Control+Shift+V');
        await expect(panel.getByRole('alert')).toContainText(fr ? 'Saisie trop volumineuse' : 'Input too large');
        expect(inputs).toHaveLength(beforeOversize);
        await context.setOffline(true);
        expect((await page.request.post(`${base}/api/terminals/${id}/input`, { data: { data: 't' } })).status()).toBe(200);
        await context.setOffline(false);
        await expect(panel.locator('.xterm-rows')).toContainText('TAIL_OFFLINE');
        await expect.poll(() => cursors.some(value => value > 0)).toBe(true);
        expect(await panel.locator('.xterm-rows').innerText().then(value => value.split('TAIL_OFFLINE').length - 1)).toBe(1);
        await textarea.focus();
        if (fr) {
          await panel.getByRole('button', { name: 'CTRL', exact: true }).tap(); await page.keyboard.type('d');
        } else await textarea.press('Control+d');
        await expect(panel.locator('header small')).toContainText('exit 7');
        expect((await page.request.get(`${base}/api/terminals/${id}`)).status()).toBe(200);

        let secondId: string;
        if (!fr) {
          let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
          const held = new Promise<void>(resolve => { release = resolve; });
          await page.route('**/api/terminals', async route => {
            if (route.request().method() !== 'POST') return route.fallback();
            const response = await route.fetch(); secondId = (await response.json() as { id: string }).id;
            entered(); await held; try { await route.fulfill({ response }); } catch { /* Original view retired. */ }
          });
          await panel.getByRole('button', { name: 'New terminal', exact: true }).click(); await pending;
          // Retire a genuine admitted response while the same React app changes workspace.
          await page.locator('.workspace-button').click();
          const targetPicker = page.locator('.directory-picker');
          await expect(targetPicker.getByRole('button', { name: 'first-picker-ready', exact: true })).toBeVisible();
          await targetPicker.getByLabel('Workspace path', { exact: true }).fill(other);
          await expect(targetPicker.getByLabel('Workspace path', { exact: true })).toHaveValue(other);
          await targetPicker.getByRole('button', { name: 'Use this workspace', exact: true }).click();
          await expect(page.locator('.workspace-button small')).toContainText(other);
          release(); await page.unroute('**/api/terminals');
          await expect(page.locator('.workspace-button small')).toContainText(other);
          await expect(panel).toHaveCount(0);
          await page.getByRole('button', { name: openName, exact: true }).click();
          await expect(panel.locator('header nav > div')).toHaveCount(1);
          const secondList = await page.request.get(`${base}/api/terminals?cwd=${encodeURIComponent(other)}`).then(response => response.json());
          expect(secondList).toHaveLength(1); expect(secondList[0].cwd).toBe(other);
          await page.locator('.workspace-button').click();
          const picker = page.locator('.directory-picker');
          await expect(picker.getByRole('button', { name: 'second-picker-ready', exact: true })).toBeVisible();
          await picker.getByLabel('Workspace path', { exact: true }).fill(cwd);
          await expect(picker.getByLabel('Workspace path', { exact: true })).toHaveValue(cwd);
          await picker.getByRole('button', { name: 'Use this workspace', exact: true }).click();
          await expect(panel.locator('header nav > div')).toHaveCount(2);
          await panel.getByRole('button', { name: 'Terminal 2', exact: true }).click();
          await expect(panel.locator('.xterm-rows')).toContainText(/[$#]/);
        } else {
          const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/terminals' && response.request().method() === 'POST');
          await panel.getByRole('button', { name: 'Nouveau terminal', exact: true }).click();
          secondId = (await (await response).json() as { id: string }).id;
          await expect(panel.locator('.xterm-rows')).toContainText(/[$#]/);
        }
        const count = created.length;
        expect((await page.request.delete(`${base}/api/terminals/${secondId!}`)).status()).toBe(200);
        await expect(panel.getByRole('alert')).toContainText(fr ? 'Ce terminal n’est plus disponible' : 'This terminal is no longer available');
        expect(created).toHaveLength(count);
        expect((await page.request.get(`${base}/api/terminals/${secondId!}`)).status()).toBe(404);
        // Reload keeps the retained exited ID, but does not silently replace the removed one.
        await page.reload(); await expect(panel.locator('header nav > div')).toHaveCount(1);
        expect(created).toHaveLength(count);
        expect((await page.request.delete(`${base}/api/terminals/${id}`)).status()).toBe(200);
        await page.reload(); await expect(panel.locator('header nav > div')).toHaveCount(0);
        await expect(panel.getByRole('alert')).toContainText(fr ? 'Ce terminal n’est plus disponible' : 'This terminal is no longer available');
        expect(created).toHaveLength(count);
        await panel.locator('.terminal-add').click();
        await expect(panel.locator('header nav > div')).toHaveCount(1);
        await expect.poll(() => created.length).toBe(count + 1);
      } finally {
        release(); await context.setOffline(false); await page.goto('about:blank').catch(() => undefined);
        await stop(); await rm(root, { recursive: true, force: true });
        names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]);
      }
    });
  });
}
