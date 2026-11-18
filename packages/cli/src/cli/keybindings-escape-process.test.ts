import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const escapeModule = pathToFileURL(fileURLToPath(new URL('../../dist/tui/terminal-escape.js', import.meta.url))).href;
const gateModule = pathToFileURL(fileURLToPath(new URL('../../dist/utils/keypress-gate.js', import.meta.url))).href;

describe('actual root gate and native decoded Escape ownership', () => {
  for (const mode of ['regular', 'fullscreen'] as const) {
    it(`${mode}: decoded Escape plus Enter remains follow-up inside the unchanged native grace`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-keybinding-escape-'));
      const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), probe = path.join(root, 'probe.mjs');
      const blocked = path.join(root, 'blocked'), decoded = path.join(root, 'decoded'), permit = path.join(root, 'permit');
      const capture = path.join(root, 'capture.jsonl'), ends = path.join(root, 'ends.txt'), keys = path.join(root, 'keys.jsonl');
      await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark' }));
      // Observe the existing public method after it actually arms its timer. No timer,
      // parser deadline, key event or application callback is replaced or accelerated.
      await writeFile(probe, `import{appendFileSync,existsSync,writeFileSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';import{TerminalEscapeSequence}from${JSON.stringify(escapeModule)};import{KeypressFilteredInput}from${JSON.stringify(gateModule)};
        export default api=>{let calls=0;const proto=TerminalEscapeSequence.prototype,previous=proto.deferEscape;
          const inputProto=KeypressFilteredInput.prototype,previousEmit=inputProto.emit;
          const emit=function(...args){const key=args[2];if(args[0]==='keypress'&&key?.name==='escape')appendFileSync(${JSON.stringify(keys)},JSON.stringify({name:key.name,sequence:key.sequence,meta:!!key.meta,ctrl:!!key.ctrl,shift:!!key.shift})+'\\n');return previousEmit.apply(this,args);};inputProto.emit=emit;
          const wrapped=function(...args){const result=previous.apply(this,args);writeFileSync(${JSON.stringify(decoded)},'armed');return result;};proto.deferEscape=wrapped;
          api.before('before:provider',async data=>{appendFileSync(${JSON.stringify(capture)},JSON.stringify(data.messages.filter(x=>x.role==='user').map(x=>x.content))+'\\n');
            if(++calls===1){writeFileSync(${JSON.stringify(blocked)},'waiting');const deadline=Date.now()+5000;while(!existsSync(${JSON.stringify(permit)})){if(Date.now()>deadline)throw Error('Probe hold expired.');await delay(5);}}});
          api.on('agent:end',()=>{setImmediate(()=>appendFileSync(${JSON.stringify(ends)},'end\\n'));});
          return()=>{if(proto.deferEscape===wrapped)proto.deferEscape=previous;if(inputProto.emit===emit)inputProto.emit=previousEmit;};};`);
      const terminal = spawnPty(process.execPath, [cli, '--approve', '--no-session', '--no-extensions', '-e', probe, '--model', 'mock/mock-model', '--tui-mode', mode, '--name', 'split-probe'], {
        cwd, cols: 140, rows: 35, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
          AI_HARNESS_KEYBINDINGS: '', AI_HARNESS_EXTENSIONS: '', AI_HARNESS_OFFLINE: '1', AI_HARNESS_THEME: 'dark', NO_COLOR: '1', TERM: 'xterm-256color' },
      });
      let output = ''; let exited: { exitCode: number; signal?: number } | undefined;
      terminal.onData(value => { output += value; }); terminal.onExit(value => { exited = value; });
      const visible = () => stripVTControlCharacters(output);
      try {
        await vi.waitFor(() => expect(visible()).toContain('split-probe: '), { timeout: 10_000 });
        terminal.write('first\r'); await vi.waitFor(async () => expect(await readFile(blocked, 'utf8')).toBe('waiting'), { timeout: 10_000 });
        terminal.write('second\u001b');
        await vi.waitFor(async () => expect(await readFile(decoded, 'utf8')).toBe('armed'), { timeout: 10_000 });
        const offset = output.length; terminal.write('\r');
        await vi.waitFor(() => expect(stripVTControlCharacters(output.slice(offset))).toContain('en file · 1]'), { timeout: 10_000 });
        expect(stripVTControlCharacters(output.slice(offset))).toContain('[Follow-up en file · 1]');
        await writeFile(permit, 'continue');
        await vi.waitFor(async () => expect((await readFile(ends, 'utf8')).split('\n').slice(0, -1)).toHaveLength(2), { timeout: 10_000 });
        terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
        expect((await readFile(capture, 'utf8')).split('\n').slice(0, -1).map(line => JSON.parse(line))).toEqual([['first'], ['first', 'second']]);
        const decodedKeys = (await readFile(keys, 'utf8')).split('\n').slice(0, -1).map(line => JSON.parse(line));
        expect(decodedKeys).toHaveLength(1); expect(decodedKeys[0]).toMatchObject({ name: 'escape', sequence: '\u001b', ctrl: false, shift: false });
      } finally {
        try {
          await writeFile(permit, 'continue');
          if (!exited) { terminal.kill(); await vi.waitFor(() => expect(exited).toBeDefined(), { timeout: 5000 }); }
        } finally {
          if (process.env.AIH_KEYBINDING_EVIDENCE_DIR) {
            const target = path.join(process.env.AIH_KEYBINDING_EVIDENCE_DIR, path.basename(root) + '-' + mode);
            await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'terminal.raw.txt'), output);
            await writeFile(path.join(target, 'terminal.plain.txt'), visible()); await writeFile(path.join(target, 'exit.json'), JSON.stringify(exited ?? { notYetObserved: true }));
            for (const file of [capture, ends, probe, keys]) { try { await writeFile(path.join(target, path.basename(file)), await readFile(file)); } catch { /* Missing evidence remains missing. */ } }
          }
          await rm(root, { recursive: true, force: true });
        }
      }
    }, 30_000);
  }
});
