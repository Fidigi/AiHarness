import type { Session, WorkspaceDescriptor } from '@ai-harness/core';

export interface DisplayedSessionCopyTarget {
  readonly sessionId: string;
  readonly entryId: string;
  readonly cwd: string;
  readonly workspaceId: string;
}

/** Capture the actual displayed journal identity, never infer it from message
 * order, a later request, draft IDs or a child-looking name. No trust grant. */
export function captureDisplayedSessionCopyTarget(
  source: Pick<Session, 'id' | 'activeLeafId' | 'cwd' | 'metadata'> & { draft?: boolean },
  workspace: WorkspaceDescriptor | null,
  unavailable = false,
): Readonly<DisplayedSessionCopyTarget> | null {
  if (!workspace || unavailable || source.draft || source.metadata?.subagent === true
    || !source.id || !source.activeLeafId || source.cwd !== workspace.cwd) return null;
  return Object.freeze({ sessionId: source.id, entryId: source.activeLeafId, cwd: workspace.cwd, workspaceId: workspace.id });
}
