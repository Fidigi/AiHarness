import type { AgentRunSnapshot, SidebarState } from '@ai-harness/core';
import type { StoredSession } from '../store/session-store.js';

/** Related forks share branchId; independent clones remain their own families. */
export const sidebarFamilyId = (session: { id: string; branchId?: string }): string => session.branchId || session.id;

/** Archive is presentation, never Stop/delete or permission to hide actionable work. */
export function organisedSessions(sessions: StoredSession[], runs: Record<string, AgentRunSnapshot>, state: SidebarState | undefined,
  archived: boolean, selected?: string): StoredSession[] {
  const families = new Map(state?.families.map(item => [item.id, item]));
  const actionable = new Set(sessions.filter(session => session.id === selected || session.draft || session.attention
    || (Object.hasOwn(runs, session.id) && !['completed', 'failed', 'stopped'].includes(runs[session.id]!.phase))).map(sidebarFamilyId));
  return sessions.filter(session => archived || !families.get(sidebarFamilyId(session))?.archived || actionable.has(sidebarFamilyId(session)))
    .sort((a, b) => Number(!!families.get(sidebarFamilyId(b))?.pinned) - Number(!!families.get(sidebarFamilyId(a))?.pinned));
}

export const organisationMessages = (locale: string) => locale.startsWith('fr') ? {
  title: 'Organiser la navigation', manage: 'Sélectionner les familles', selected: 'familles sélectionnées', select: 'Sélectionner la famille',
  pin: 'Épingler', unpin: 'Désépingler', archive: 'Archiver', restore: 'Désarchiver', show: 'Inclure les archives',
  undo: 'Annuler l’organisation', reload: 'Actualiser l’organisation', error: 'Organisation indisponible. Actualisez avant de réessayer.',
  conflict: 'L’organisation a changé ou l’annulation a expiré. État rechargé ; sélectionnez à nouveau.',
  projects: 'Organiser les projets', name: 'Nom du projet', save: 'Enregistrer le nom', reset: 'Nom d’origine', up: 'Monter le projet', down: 'Descendre le projet',
  pinned: 'Épinglée', archived: 'Archivée',
} : {
  title: 'Organise navigation', manage: 'Select families', selected: 'families selected', select: 'Select family',
  pin: 'Pin', unpin: 'Unpin', archive: 'Archive', restore: 'Unarchive', show: 'Include archived',
  undo: 'Undo organisation', reload: 'Refresh organisation', error: 'Organisation unavailable. Refresh before trying again.',
  conflict: 'Organisation changed or undo expired. State reloaded; select again.',
  projects: 'Organise projects', name: 'Project display name', save: 'Save display name', reset: 'Original name', up: 'Move project up', down: 'Move project down',
  pinned: 'Pinned', archived: 'Archived',
};
