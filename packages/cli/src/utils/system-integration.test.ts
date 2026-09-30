import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { editInExternalEditor, splitCommand } from './system-integration';

const originalEditor = process.env.EDITOR;
const directories: string[] = [];

afterEach(async () => {
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
  delete process.env.VISUAL;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('system integrations', () => {
  it('splits quoted editor commands', () => {
    expect(splitCommand('code --wait "profile name"')).toEqual(['code', '--wait', 'profile name']);
  });

  it('round-trips content through the configured external editor', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-editor-test-'));
    directories.push(directory);
    const script = path.join(directory, 'editor.mjs');
    await writeFile(script, "import { appendFile } from 'fs/promises'; await appendFile(process.argv[2], '\\nmodifié');");
    process.env.EDITOR = `${process.execPath} ${script}`;

    await expect(editInExternalEditor('initial')).resolves.toBe('initial\nmodifié');
  });

  it('requires an editor configuration', async () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    await expect(editInExternalEditor('draft')).rejects.toThrow('$VISUAL');
  });
});
