/** Server-owned Web presentation only; never conversation/context authority. */
export interface SidebarState {
  version: 1;
  revision: string;
  families: Array<{ id: string; pinned: boolean; archived: boolean }>;
  /** Ordered canonical workspace paths; a missing name uses the native basename. */
  projects: Array<{ cwd: string; name?: string }>;
}

export type SidebarChange =
  | { kind: 'families'; ids: string[]; pinned?: boolean; archived?: boolean }
  | { kind: 'project'; cwd: string; name: string | null }
  | { kind: 'move-project'; cwd: string; before: string | null };

export interface SidebarMutationResult {
  state: SidebarState;
  /** Short-lived, server-only snapshot; undo refuses any intervening revision. */
  undoToken?: string;
}
