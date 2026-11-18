import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  ProjectTrustPromptChoice,
  ProjectTrustPromptRequest,
} from '@ai-harness/core';

/** Backward-compatible CLI import; decisions and resolution are shared with Web through Core. */
export {
  inspectProjectTrustResources,
  ProjectTrustManager,
  resolveProjectTrust,
} from '@ai-harness/core';
export type {
  ProjectTrustDecision,
  ProjectTrustDecisionEntry,
  ProjectTrustDefault,
  ProjectTrustInspection,
  ProjectTrustPromptChoice,
  ProjectTrustPromptRequest,
  ProjectTrustResource,
  ProjectTrustStatus,
  ProjectTrustUpdate,
  ResolvedProjectTrust,
  ResolveProjectTrustOptions,
} from '@ai-harness/core';

function resourceLabel(request: ProjectTrustPromptRequest): string {
  const visible = request.status.resources.slice(0, 8).map(resource => {
    const safety = resource.safeKind ? '' : ' [unsafe link or file kind]';
    return `  - ${resource.relativePath}${safety}`;
  });
  if (request.status.resources.length > visible.length || request.status.truncated) visible.push('  - …');
  return visible.join('\n');
}

/** Minimal startup adapter; all decision precedence and persistence remain in Core. */
export async function promptForProjectTrust(
  request: ProjectTrustPromptRequest,
  streams: { input?: Readable; output?: Writable } = {},
): Promise<ProjectTrustPromptChoice | undefined> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const choices: Array<{ key: string; label: string; value: ProjectTrustPromptChoice }> = [
    { key: '1', label: 'Trust this folder (save)', value: 'trust' as const },
    ...(request.parentPath ? [{
      key: '2',
      label: `Trust parent folder ${request.parentPath} (save, inherited)`,
      value: 'trust-parent' as const,
    }] : []),
    { key: '3', label: 'Trust for this process only', value: 'trust-session' as const },
    { key: '4', label: 'Do not trust this folder (save refusal)', value: 'refuse' as const },
    { key: '5', label: 'Do not trust for this process only', value: 'refuse-session' as const },
  ];
  output.write(`${[
    'Project-controlled resources require a trust decision:',
    request.status.cwd,
    resourceLabel(request),
    '',
    ...choices.map(choice => `  ${choice.key}. ${choice.label}`),
    '',
  ].join('\n')}\n`);

  const terminal = readline.createInterface({ input, output, terminal: Boolean((input as NodeJS.ReadStream).isTTY) });
  try {
    const answer = await new Promise<string | undefined>(resolve => {
      terminal.question('Select an option [5]: ', value => resolve(value.trim() || '5'));
      terminal.once('close', () => resolve(undefined));
    });
    return choices.find(choice => choice.key === answer)?.value;
  } finally {
    terminal.close();
  }
}
