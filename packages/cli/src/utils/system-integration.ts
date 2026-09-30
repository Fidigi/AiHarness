import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

function runWithInput(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
    child.stdin.end(input);
  });
}

/** Copies text through native platform tools, with OSC 52 as terminal fallback. */
export async function copyToClipboard(text: string): Promise<string | undefined> {
  const candidates: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
      ? [['clip', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
          ['clip.exe', []],
        ];

  for (const [command, args] of candidates) {
    if (await runWithInput(command, args, text)) return command;
  }
  if (process.stdout.isTTY) {
    process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`);
    return 'OSC 52';
  }
  return undefined;
}

/** Opens $VISUAL/$EDITOR with a temporary markdown draft and returns its content. */
export async function editInExternalEditor(initialContent = ''): Promise<string | undefined> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new Error('Définissez $VISUAL ou $EDITOR pour utiliser l’éditeur externe.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-editor-'));
  const filePath = path.join(directory, 'message.md');
  await writeFile(filePath, initialContent, { mode: 0o600 });

  try {
    const [command, ...args] = splitCommand(editor);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command, [...args, filePath], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (exitCode !== 0) throw new Error(`L’éditeur externe s’est terminé avec le code ${exitCode}.`);
    const content = (await readFile(filePath, 'utf8')).trimEnd();
    return content || undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Minimal shell-like splitting for editor commands with quoted arguments. */
export function splitCommand(command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map(part => part.replace(/^(['"])(.*)\1$/, '$2'));
}
