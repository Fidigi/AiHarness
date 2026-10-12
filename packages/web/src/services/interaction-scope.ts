export function interactionViewKey(
  workspaceId: string | undefined,
  cwd: string | undefined,
  sessionId: string | undefined,
  routeKey: string,
  address?: { pathname: string; search: string; hash: string },
): string {
  return JSON.stringify(address ? [workspaceId, cwd, sessionId, routeKey, address.pathname, address.search, address.hash]
    : [workspaceId, cwd, sessionId, routeKey]);
}

export function interactionEpochKey(view: string, runId: string | undefined): string {
  return JSON.stringify([view, runId]);
}

/** Address equality is not lifetime equality: Back can restore the same key. */
export class InteractionViewLifetime {
  private view?: string;
  private generation = 0n;
  enter(view: string): string {
    if (this.view !== view) { this.view = view; this.generation++; }
    return JSON.stringify([view, this.generation.toString()]);
  }
}
