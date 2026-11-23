import type { WorkspaceDescriptor } from '@ai-harness/core';
import { validateWorkspace } from '../services/api';
import { useSessionStore } from './session-store';

/** Settings-only canonical reread. The store retains the private admission epoch. */
export async function refreshWorkspacePresentation(
  workspace: WorkspaceDescriptor,
  current: () => boolean,
  invalidateCatalogues: () => void,
  persist: (workspace: WorkspaceDescriptor, recent: WorkspaceDescriptor[]) => void,
): Promise<void> {
  if (!current()) return;
  const refreshed = await validateWorkspace(workspace.cwd);
  if (!current() || !refreshed.success || !refreshed.data) return;
  const store = useSessionStore.getState();
  const recent = [refreshed.data, ...store.recentWorkspaces.filter(item => item.cwd !== refreshed.data!.cwd)].slice(0, 8);
  const authorityChanged = refreshed.data.id !== workspace.id || refreshed.data.cwd !== workspace.cwd
    || refreshed.data.trusted !== workspace.trusted || refreshed.data.operationTrusted !== workspace.operationTrusted;
  if (authorityChanged) {
    // Withdraw stale catalogues in the same publication as the descriptor,
    // before any awaited read or old in-flight catalogue may publish.
    invalidateCatalogues();
    useSessionStore.setState(state => ({ workspace: refreshed.data, workspaceUnavailable: false, recentWorkspaces: recent,
      providers: { ...state.providers, catalog: undefined, catalogError: undefined, catalogLoading: true },
      skills: { catalog: undefined, loading: true } }));
  } else useSessionStore.setState({ workspace: refreshed.data, workspaceUnavailable: false, recentWorkspaces: recent });
  persist(refreshed.data, recent);
  if (authorityChanged) await Promise.all([store.hydrateModelCatalog(true), store.hydrateSkillCatalog(true)]);
}
