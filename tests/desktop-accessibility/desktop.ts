import { chromium, expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { moduleSpoke } from '../../.docker/accessibility/evidence.mjs';

const execute = promisify(execFile);
const root = '/tmp/desktop-accessibility';
const orca = `${root}/orca-debug.log`, speech = `${root}/speech-log/speech-dispatcher.log`;
type Mark = { orca: number; speech: number };

export class Desktop {
  constructor(readonly page: Page, readonly info: TestInfo) {}
  mark(): Mark {
    return { orca: readFileSync(orca, 'utf8').length, speech: readFileSync(speech, 'utf8').length };
  }
  async spoken(mark: Mark, phrase: string): Promise<void> {
    await expect.poll(() => ({
      orca: readFileSync(orca, 'utf8').slice(mark.orca).split('\n')
        .some(line => line.includes('SPEECH OUTPUT:') && line.includes(phrase)),
      module: moduleSpoke(readFileSync(speech, 'utf8').slice(mark.speech), phrase),
    }), { message: `Fresh actual Orca/espeak announcement: ${phrase}` }).toEqual({ orca: true, module: true });
  }
  async queryButton(name: string): Promise<void> {
    // DOM focus can precede Orca's own queued AT-SPI focus update. Query only
    // after the reader has processed that target, and stop earlier long speech.
    await expect.poll(() => readFileSync(orca, 'utf8').split('\n')
      .filter(line => line.includes('EVENT MANAGER: locusOfFocus:')).at(-1)
      ?.includes(`[push button | ${name}]`)).toBe(true);
    await this.key('Control_L');
    const mark = this.mark();
    await this.key('KP_Enter');
    await this.spoken(mark, `${name} push button`);
  }
  async key(...keys: string[]): Promise<void> {
    await execute('xdotool', ['key', '--clearmodifiers', ...keys], { timeout: 5000 });
  }
  async type(text: string): Promise<void> {
    await execute('xdotool', ['type', '--clearmodifiers', '--delay', '1', text], { timeout: 5000 });
  }
  async activate(): Promise<void> {
    const { stdout } = await execute('xdotool', ['search', '--onlyvisible', '--class', 'chromium'], { timeout: 5000 });
    const windows = stdout.trim().split('\n');
    expect(windows, 'Only the dedicated test browser may own native input').toHaveLength(1);
    await execute('xdotool', ['windowactivate', '--sync', windows[0]!], { timeout: 5000 });
  }
  async clickContent(locator: Locator): Promise<void> {
    await this.activate();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    // Map CSS target geometry to the actual native window. Scale is used only
    // for pointer coordinates; native chrome/AT-SPI independently proves zoom.
    const window = await this.page.evaluate(() => ({ x: screenX, y: screenY,
      chrome: outerHeight - innerHeight * devicePixelRatio, scale: devicePixelRatio }));
    // The move/click requests share X's ordered stream. --sync would wait for
    // motion forever when a reload leaves the pointer at the same coordinates.
    await execute('xdotool', ['mousemove', String(Math.round(window.x + (box!.x + box!.width / 2) * window.scale)),
      String(Math.round(window.y + window.chrome + (box!.y + box!.height / 2) * window.scale)), 'click', '1'], { timeout: 5000 });
  }
  async capture(name: string): Promise<void> {
    const file = this.info.outputPath(`${name}.png`);
    mkdirSync(path.dirname(file), { recursive: true });
    await execute('scrot', [file], { timeout: 5000 });
    await this.info.attach(name, { path: file, contentType: 'image/png' });
  }
  async zoom200(): Promise<void> {
    const mark = this.mark();
    await this.key('ctrl+0');
    await execute('xdotool', ['key', '--clearmodifiers', '--repeat', '5', '--delay', '150', 'ctrl+plus'], { timeout: 5000 });
    await this.spoken(mark, 'Zoom: 200%');
    await this.key('alt+f');
    try {
      const state = JSON.parse((await execute('/usr/bin/python3', ['.docker/accessibility/native-zoom.py'], { timeout: 5000 })).stdout);
      expect(state).toMatchObject({ nativeZoom: 'Zoom: 200%', nativeZoomMenu: true });
      writeFileSync(this.info.outputPath('native-zoom.json'), JSON.stringify(state, null, 2));
      await this.capture('native-zoom-menu');
    } finally { await this.key('Escape'); }
    // Do not race the native menu's dismissal with the next web keystroke.
    await expect.poll(async () => JSON.parse((await execute('/usr/bin/python3',
      ['.docker/accessibility/native-zoom.py'], { timeout: 5000 })).stdout).nativeZoomMenu).toBe(false);
  }
}

export const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({}, use, info) => {
    const context = await chromium.launchPersistentContext(`/tmp/accessibility-profiles/${info.testId}`, {
      executablePath: '/usr/bin/chromium', headless: false, viewport: null,
      baseURL: 'http://127.0.0.1:3080',
      args: ['--force-renderer-accessibility', '--window-size=1280,900', '--lang=en-US'],
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    try { await use(new Desktop(context.pages()[0]!, info)); }
    finally {
      try { await context.tracing.stop(info.status !== info.expectedStatus ? { path: info.outputPath('trace.zip') } : {}); }
      finally { await context.close(); }
    }
  },
});
export { expect };
