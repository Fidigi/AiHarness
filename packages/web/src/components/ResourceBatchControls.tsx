import { useEffect, useRef, useState } from 'react';
import type { ResourceEnableChange, ResourceEnableOutcome } from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import { useSessionStore } from '../store/session-store';
import { updateModelBatch, updateSkillBatch } from '../services/resource-batches';
import './resource-batches.css';

const copy = {
  en: { enable: 'Enable displayed', disable: 'Disable displayed', help: 'Only changed displayed rows are saved. Hidden rows and other groups are preserved.',
    changed: 'changed', unchanged: 'unchanged', failed: 'failed', saving: 'Saving displayed rows…', limit: 'Filter this group to at most 500 changed rows.',
    PROJECT_TRUST_REQUIRED: 'Project approval required', UNKNOWN_RESOURCE: 'Resource no longer available',
    INVALID_SKILL_DOCUMENT: 'Invalid skill Markdown', SKILL_WRITE_FAILED: 'Skill could not be written',
    SKILL_ROLLBACK_FAILED: 'External changes prevented rollback. Refresh before retrying.',
    error: 'Batch could not be saved. Refresh before retrying.' },
  fr: { enable: 'Activer les éléments affichés', disable: 'Désactiver les éléments affichés', help: 'Seules les lignes affichées modifiées sont enregistrées. Les lignes masquées et les autres groupes sont conservés.',
    changed: 'modifié', unchanged: 'inchangé', failed: 'échec', saving: 'Enregistrement des lignes affichées…', limit: 'Filtrez ce groupe à 500 lignes modifiées maximum.',
    PROJECT_TRUST_REQUIRED: 'Approbation du projet requise', UNKNOWN_RESOURCE: 'Ressource indisponible',
    INVALID_SKILL_DOCUMENT: 'Markdown du skill invalide', SKILL_WRITE_FAILED: 'Écriture du skill impossible',
    SKILL_ROLLBACK_FAILED: 'Des modifications externes empêchent le retour arrière. Actualisez avant de réessayer.',
    error: 'Le lot n’a pas pu être enregistré. Actualisez avant de réessayer.' },
};

export function useResourceBatches() {
  const workspaceId = useSessionStore(state => state.workspace?.id);
  const workspaceCwd = useSessionStore(state => state.workspace?.cwd);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const [reports, setReports] = useState<{ models?: ResourceEnableOutcome[]; skills?: ResourceEnableOutcome[] }>({});
  const [errors, setErrors] = useState<{ models?: boolean; skills?: boolean }>({});
  useEffect(() => {
    generation.current++; setReports({}); setErrors({});
    // Retire this Settings lifetime, even when the next mount uses the same workspace.
    return () => { generation.current++; };
  }, [workspaceId, workspaceCwd]);
  const save = async (kind: 'models' | 'skills', changes: ResourceEnableChange[]): Promise<void> => {
    if (lock.current || !changes.length || changes.length > 500) return;
    lock.current = true; setBusy(true);
    const currentGeneration = generation.current;
    const workspace = useSessionStore.getState().workspace;
    setReports(previous => ({ ...previous, [kind]: undefined }));
    setErrors(previous => ({ ...previous, [kind]: false }));
    try {
      const result = kind === 'models'
        ? await updateModelBatch(changes, workspace?.id)
        : await updateSkillBatch(changes, workspace?.cwd, workspace?.id);
      const currentWorkspace = useSessionStore.getState().workspace;
      if (currentGeneration !== generation.current || currentWorkspace?.id !== workspace?.id || currentWorkspace?.cwd !== workspace?.cwd) return;
      if (kind === 'models') {
        const catalog = (result as Awaited<ReturnType<typeof updateModelBatch>>).catalog;
        useSessionStore.setState(state => ({ providers: { ...state.providers, catalog, catalogError: undefined } }));
      } else {
        const catalog = (result as Awaited<ReturnType<typeof updateSkillBatch>>).catalog;
        useSessionStore.setState({ skills: { catalog, error: undefined } });
      }
      setReports(previous => ({ ...previous, [kind]: result.outcomes }));
    } catch {
      const currentWorkspace = useSessionStore.getState().workspace;
      if (currentGeneration !== generation.current || currentWorkspace?.id !== workspace?.id || currentWorkspace?.cwd !== workspace?.cwd) return;
      setErrors(previous => ({ ...previous, [kind]: true }));
      // A transport failure may follow a durable commit. Reconcile, not rollback.
      const store = useSessionStore.getState();
      await (kind === 'models' ? store.hydrateModelCatalog(true) : store.hydrateSkillCatalog(true));
    } finally { lock.current = false; setBusy(false); }
  };
  return { busy, reports, errors, save };
}

export function ResourceGroupButtons({ rows, disabled, group, save }: {
  rows: { key: string; enabled: boolean }[]; disabled: boolean; group: string;
  save: (changes: ResourceEnableChange[]) => Promise<void>;
}) {
  const { locale } = useI18n();
  const text = copy[locale === 'fr' ? 'fr' : 'en'];
  const changes = (enabled: boolean) => rows.filter(row => row.enabled !== enabled).map(row => ({ key: row.key, enabled }));
  return <div className="resource-group-actions" role="group" aria-label={group}>
    {[true, false].map(enabled => {
      const targets = changes(enabled);
      return <button key={String(enabled)} type="button" disabled={disabled || !targets.length || targets.length > 500}
        title={targets.length > 500 ? text.limit : text.help} onClick={() => void save(targets)}>
        {enabled ? text.enable : text.disable}
      </button>;
    })}
  </div>;
}

export function ResourceBatchReport({ busy, outcomes, error, names }: {
  busy: boolean; outcomes?: ResourceEnableOutcome[]; error?: boolean; names: Map<string, string>;
}) {
  const { locale } = useI18n();
  const text = copy[locale === 'fr' ? 'fr' : 'en'];
  return <div className="resource-batch-report" aria-live="polite">
    <p className="settings-help">{text.help}</p>
    {busy && <p role="status">{text.saving}</p>}
    {error && <p role="alert">{text.error}</p>}
    {outcomes && <ul aria-label={locale === 'fr' ? 'Résultats du lot' : 'Batch outcomes'}>{outcomes.map(outcome =>
      <li key={outcome.key} className={outcome.status === 'failed' ? 'status-warning' : undefined}>
        {names.get(outcome.key) ?? outcome.key}: {text[outcome.status]}
        {outcome.code && <> — {text[outcome.code as keyof typeof text] ?? outcome.code}</>}
      </li>)}</ul>}
  </div>;
}
