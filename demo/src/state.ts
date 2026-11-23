import { freshSessions, initialFiles, message, models, type DemoSession } from './fixtures';

export const MAX_SESSIONS = 12;
export const MAX_MESSAGES = 80;
export const MAX_PROMPT = 2000;
export const welcomeEdit = 'Welcome to your community garden!';

export function previewEdit(files: Record<string, string>): Record<string, string> {
  return { ...files, 'README.md': initialFiles['README.md']!.replace('Welcome, gardener!', welcomeEdit) };
}

export function gitDiff(files: Record<string, string>): string {
  return files['README.md'] === initialFiles['README.md'] ? 'Working tree clean (synthetic workspace).' :
    'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -3,5 +3,5 @@\n A synthetic community garden dashboard.\n \n-Welcome, gardener!\n+Welcome to your community garden!\n \n ## Development';
}

/** No evaluator, filesystem, fetch, socket or subprocess. Match complete commands only. */
export function terminalReply(command: string, files: Record<string, string>): string {
  switch (command.trim()) {
    case 'help': return 'Synthetic terminal. Supported commands: help, pwd, ls, cat README.md, git status, git diff, npm test. No shell or processes are started.';
    case 'pwd': return '/demo/garden-board (virtual path only)';
    case 'ls': return Object.keys(files).join('\n');
    case 'cat README.md': return files['README.md']!;
    case 'git diff': return gitDiff(files);
    case 'git status': return files['README.md'] === initialFiles['README.md'] ? 'On branch demo/welcome\nWorking tree clean (synthetic).' : 'On branch demo/welcome\nChanges not staged:\n  modified: README.md (browser memory only)';
    case 'npm test': return 'Fixture replay · no test runner started\n✓ watering day is visible\n1 synthetic test passed';
    default: return 'Not executed. This static demo accepts only the exact commands listed by help; it has no real terminal.';
  }
}

export function simulatedTurn(prompt: string, session: DemoSession, files: Record<string, string>, enabled: string[], id: string) {
  const input = prompt.trim().slice(0, MAX_PROMPT);
  if (!input) return session;
  const additions = [message(`${id}-user`, 'user', input)];
  if (enabled.includes('read')) additions.push(message(`${id}-read`, 'tool', files['README.md']!, 'read'));
  if (enabled.includes('bash')) additions.push(message(`${id}-bash`, 'tool', terminalReply('npm test', files), 'bash'));
  additions.push(message(`${id}-answer`, 'assistant', session.model === models[1]!.key
    ? '## Documentation walkthrough\n\nThe fixture README explains the garden board. A friendly welcome and a short development section make a useful start.\n\n**Simulated response:** this fixed answer does not interpret your prompt. Use Preview welcome edit to inspect an in-memory change.'
    : `## Workspace walkthrough\n\n${enabled.includes('read') ? 'Read the synthetic README successfully.' : 'The read tool is disabled; no file result was added.'}\n\nThe garden card keeps its watering date readable. Inspect Files, then run \`npm test\` in the synthetic terminal.\n\n**Simulated response:** a deterministic fixture, not AI inference. Your prompt stays in this tab’s memory.`));
  return { ...session, messages: [...session.messages, ...additions].slice(-MAX_MESSAGES) };
}

export function freshState() { return { sessions: freshSessions(), files: { ...initialFiles } }; }
