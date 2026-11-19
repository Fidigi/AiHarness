import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  PluginCatalog,
  PluginPackageInfo,
  PluginResourceKind,
  PluginScope,
  PluginUpdateResult,
} from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import {
  checkPluginUpdates,
  getPluginCatalog,
  mutatePlugin,
  reloadPluginResources,
  setPluginsEnabled,
  type PluginMutationAction,
} from '../services/api';
import { useSessionStore } from '../store/session-store';
import { useSettingsScope } from '../store/use-settings-scope';
import { settingsAdminMessage } from './settings-admin-messages';
import { readSettingsNavigation, writeSettingsNavigation } from '../store/settings-navigation';
import { pluginSettingsMessage } from './plugin-settings-messages';

function normalizedSource(value: string): string {
  return value.trim();
}

function resourceLabel(kind: PluginResourceKind, count: number): string {
  const labels: Record<PluginResourceKind, [string, string]> = {
    extension: ['extension', 'extensions'],
    skill: ['skill', 'skills'],
    prompt: ['prompt', 'prompts'],
    theme: ['theme', 'themes'],
  };
  return `${count} ${labels[kind][count === 1 ? 0 : 1]}`;
}

function packageSummary(pkg: PluginPackageInfo): string {
  return ([
    ['extension', pkg.counts.extensions],
    ['skill', pkg.counts.skills],
    ['prompt', pkg.counts.prompts],
    ['theme', pkg.counts.themes],
  ] as Array<[PluginResourceKind, number]>)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => resourceLabel(kind, count))
    .join(' · ');
}

export function PluginSettings({ presented }: { presented: boolean }) {
  const { t, locale } = useI18n();
  const epoch = useRef(0);
  const workspace = useSessionStore(state => state.workspace);
  const [selection, setSelection] = useState(() => readSettingsNavigation(workspace?.cwd).positions.plugins);
  const [overview, setOverview] = useState(!selection?.selection);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 959px)').matches);
  const navigationRef = useRef<HTMLElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const navigationFocus = useRef(false);
  const detailPrefix = useId();
  useEffect(() => {
    const media = window.matchMedia('(max-width: 959px)');
    const changed = () => {
      if (media.matches && detailRef.current?.contains(document.activeElement)) setOverview(false);
      setMobile(media.matches);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    if (!navigationFocus.current) return;
    navigationFocus.current = false;
    if (!presented) return;
    if (overview) {
      const choice = navigationRef.current?.querySelector<HTMLElement>('[aria-current="true"]:not(:disabled)');
      (choice ?? navigationRef.current)?.focus();
    } else if (mobile) backRef.current?.focus();
  }, [mobile, overview, presented, selection]);
  const selectPackage = (pkg: PluginPackageInfo) => {
    const next = { group: pkg.scope, selection: pkg.key };
    setSelection(next);
    setOverview(false);
    const current = readSettingsNavigation(workspace?.cwd);
    writeSettingsNavigation(workspace?.cwd, { ...current, section: 'plugins',
      positions: { ...current.positions, plugins: next } });
  };
  const activeSessionId = useSessionStore(state => {
    const session = state.sessions.find(item => item.id === state.activeSessionId);
    return session && !session.draft ? session.id : undefined;
  });
  const hydrateSkillCatalog = useSessionStore(state => state.hydrateSkillCatalog);
  const [catalog, setCatalog] = useState<PluginCatalog>();
  const [source, setSource] = useState('');
  const [scope, setScope] = useSettingsScope('plugins', 'global');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [messageWarning, setMessageWarning] = useState(false);
  const [batchFailures, setBatchFailures] = useState<Array<{ key: string; label: string; reason: string }>>([]);
  const [reloadPending, setReloadPending] = useState(false);
  const [updates, setUpdates] = useState<Record<string, PluginUpdateResult>>({});

  const context = { cwd: workspace?.cwd, projectId: workspace?.id };
  const availableUpdates = Object.values(updates).filter(item => item.state === 'update-available');
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visiblePackages = useMemo(() => (catalog?.packages ?? []).filter(pkg => !normalizedFilter
    || pkg.source.toLocaleLowerCase().includes(normalizedFilter)
    || pkg.packageName?.toLocaleLowerCase().includes(normalizedFilter)
    || pkg.description?.toLocaleLowerCase().includes(normalizedFilter)), [catalog?.packages, normalizedFilter]);
  const groups = (['project', 'global'] as PluginScope[]).map(groupScope => ({
    scope: groupScope, packages: visiblePackages.filter(pkg => pkg.scope === groupScope),
  })).filter(group => group.packages.length > 0);
  const matches = selection?.selection ? visiblePackages.filter(pkg => pkg.scope === selection.group && pkg.key === selection.selection) : [];
  const selected = selection?.selection ? matches.length === 1 ? matches[0] : undefined : groups[0]?.packages[0];

  const load = async (refresh = false) => {
    const generation = epoch.current;
    setBusy(refresh ? 'refresh' : 'load');
    setError(undefined);
    const result = await getPluginCatalog(context.cwd, context.projectId, refresh);
    if (generation !== epoch.current) return;
    if (result.success && result.data) setCatalog(result.data);
    else { setCatalog(undefined); setError(t('settings.plugins.loadFailed')); }
    setBusy(undefined);
  };

  useEffect(() => {
    ++epoch.current;
    setCatalog(undefined);
    setUpdates({});
    setError(undefined);
    setMessage(undefined);
    setMessageWarning(false);
    setBatchFailures([]);
    setReloadPending(false);
    void load();
    return () => { ++epoch.current; };
  }, [workspace?.id, workspace?.cwd]);

  const reconcileFailure = async (generation: number) => {
    const canonical = await getPluginCatalog(context.cwd, context.projectId, true);
    if (generation !== epoch.current) return;
    const readable = canonical.success && canonical.data;
    setCatalog(readable || undefined);
    setError(settingsAdminMessage(locale, readable ? 'saveFailed' : 'readbackFailed'));
    setReloadPending(true);
    if (readable) await hydrateSkillCatalog(true);
  };

  const runAction = async (
    action: PluginMutationAction,
    pkg?: PluginPackageInfo,
  ) => {
    if (pkg) selectPackage(pkg);
    const actionKey = `${action}:${pkg?.key ?? 'all'}`;
    const generation = epoch.current;
    setBusy(actionKey);
    setError(undefined);
    setMessage(undefined);
    setMessageWarning(false);
    setBatchFailures([]);
    if (pkg && (action === 'enable' || action === 'disable')) {
      const enabled = action === 'enable';
      setCatalog(current => current ? {
        ...current,
        packages: current.packages.map(item => item.key === pkg.key
          ? { ...item, enabled, status: enabled ? 'active' : 'disabled' }
          : item),
      } : current);
    }
    const result = await mutatePlugin({
      action,
      ...context,
      ...(pkg ? { key: pkg.key, scope: pkg.scope } : {}),
    });
    if (generation !== epoch.current) return;
    if (result.success && result.data) {
      setCatalog(result.data);
      if (action === 'remove' || action === 'update') {
        setUpdates(current => {
          const next = { ...current };
          if (pkg) delete next[pkg.key];
          else for (const key of Object.keys(next)) delete next[key];
          return next;
        });
      }
      setMessage(t(`settings.plugins.action.${action}`));
      await hydrateSkillCatalog(true);
    } else await reconcileFailure(generation);
    if (generation === epoch.current) setBusy(undefined);
  };

  const runGroupAction = async (groupScope: PluginScope, enabled: boolean, packages: PluginPackageInfo[]) => {
    const targets = packages.filter(pkg => pkg.enabled !== enabled);
    if (targets.length === 0) return;
    const actionKey = `batch:${groupScope}:${enabled ? 'enable' : 'disable'}`;
    const generation = epoch.current;
    setBusy(actionKey);
    setError(undefined);
    setMessage(undefined);
    setMessageWarning(false);
    setBatchFailures([]);
    const result = await setPluginsEnabled({
      ...context,
      changes: targets.map(pkg => ({ key: pkg.key, scope: pkg.scope, enabled })),
    });
    if (generation !== epoch.current) return;
    if (result.success && result.data) {
      const changed = result.data.outcomes.filter(outcome => outcome.state === 'changed').length;
      const unchanged = result.data.outcomes.filter(outcome => outcome.state === 'unchanged').length;
      const failedOutcomes = result.data.outcomes.filter(outcome => outcome.state === 'failed');
      const failed = failedOutcomes.length;
      const labels = new Map(packages.map(pkg => [pkg.key, pkg.packageName || pkg.source]));
      setCatalog(result.data.catalog);
      setMessage(t('settings.plugins.batchResult', { changed, unchanged, failed }));
      setMessageWarning(failed > 0);
      setBatchFailures(failedOutcomes.map(outcome => ({
        key: `${outcome.scope}:${outcome.key}`,
        label: labels.get(outcome.key) ?? outcome.key,
        reason: t(`settings.plugins.batchFailure.${outcome.code ?? 'unknown'}`),
      })));
      setReloadPending(current => current || result.data!.reloadRequired);
      if (changed > 0) await hydrateSkillCatalog(true);
    } else await reconcileFailure(generation);
    if (generation === epoch.current) setBusy(undefined);
  };

  const install = async () => {
    const normalized = normalizedSource(source);
    if (!normalized || !catalog) return;
    const generation = epoch.current;
    setSource(normalized);
    setBusy('install');
    setError(undefined);
    setMessage(undefined);
    setMessageWarning(false);
    setBatchFailures([]);
    const result = await mutatePlugin({ action: 'install', source: normalized, scope, ...context });
    if (generation !== epoch.current) return;
    if (result.success && result.data) {
      setCatalog(result.data);
      setSource('');
      setMessage(t('settings.plugins.action.install'));
      await hydrateSkillCatalog(true);
    } else await reconcileFailure(generation);
    if (generation === epoch.current) setBusy(undefined);
  };

  const check = async (pkg?: PluginPackageInfo) => {
    if (pkg) selectPackage(pkg);
    const generation = epoch.current;
    setBusy(`check:${pkg?.key ?? 'all'}`);
    setError(undefined);
    setMessage(undefined);
    setMessageWarning(false);
    setBatchFailures([]);
    const result = await checkPluginUpdates({
      ...context,
      ...(pkg ? { key: pkg.key, scope: pkg.scope } : {}),
    });
    if (generation !== epoch.current) return;
    if (result.success && result.data) {
      setUpdates(current => ({
        ...current,
        ...Object.fromEntries(result.data!.map(update => [update.key, update])),
      }));
      setMessage(t('settings.plugins.checkComplete'));
    } else setError(result.error || t('settings.plugins.checkFailed'));
    setBusy(undefined);
  };

  const reload = async () => {
    const generation = epoch.current;
    setBusy('reload');
    setError(undefined);
    setMessage(undefined);
    setMessageWarning(false);
    setBatchFailures([]);
    const result = await reloadPluginResources({ ...context, ...(activeSessionId ? { sessionId: activeSessionId } : {}) });
    if (generation !== epoch.current) return;
    if (result.success && result.data) {
      setCatalog(result.data.catalog);
      setMessage(result.data.reload.message);
      setReloadPending(false);
      await hydrateSkillCatalog(true);
    } else await reconcileFailure(generation);
    if (generation === epoch.current) setBusy(undefined);
  };

  return (
    <section className="settings-section plugin-settings" id="plugins">
      <div className="plugin-settings-heading">
        <div>
          <h3>{t('settings.plugins.title')}</h3>
          <p className="settings-help">{t('settings.plugins.help')}</p>
        </div>
        {catalog && <span className="plugin-generation">{t('settings.plugins.generation', { generation: catalog.generation })}</span>}
      </div>

      {catalog && !catalog.projectResourcesLoaded && (
        <p className="status-warning plugin-trust-notice" role="status">{t('settings.plugins.untrustedProject')}</p>
      )}

      <div className="plugin-install-panel">
        <label className="plugin-source-field">
          <span>{t('settings.plugins.source')}</span>
          <input
            value={source}
            aria-label={t('settings.plugins.source')}
            placeholder="npm:@scope/package"
            spellCheck={false}
            onChange={event => setSource(event.target.value)}
            onBlur={event => setSource(normalizedSource(event.currentTarget.value))}
            onKeyDown={event => {
              if (event.key === 'Enter' && source.trim() && !busy) void install();
            }}
          />
        </label>
        <label>
          <span>{t('settings.plugins.scope')}</span>
          <select value={scope} aria-label={t('settings.plugins.scope')}
            onChange={event => setScope(event.target.value as PluginScope)}>
            <option value="global">{t('settings.plugins.scope.global')}</option>
            <option value="project" disabled={catalog ? !catalog.projectTrusted : !(workspace?.operationTrusted ?? workspace?.trusted)}>
              {t('settings.plugins.scope.project')}
            </option>
          </select>
        </label>
        <button type="button" className="primary" disabled={Boolean(busy) || !catalog || !source.trim()} onClick={() => void install()}>
          {busy === 'install' ? t('settings.plugins.installing') : t('settings.plugins.install')}
        </button>
        <small>{t('settings.plugins.sourceHint')}</small>
      </div>

      <div className="plugin-toolbar">
        <label>
          <span>{t('settings.plugins.filter')}</span>
          <input type="search" value={filter} aria-label={t('settings.plugins.filter')}
            onChange={event => setFilter(event.target.value)} />
        </label>
        <div className="plugin-toolbar-actions">
          <button type="button" disabled={Boolean(busy) || !(catalog?.packages.some(pkg => pkg.canCheckForUpdates))}
            onClick={() => void check()}>
            {busy === 'check:all' ? t('settings.plugins.checking') : t('settings.plugins.checkAll')}
          </button>
          {availableUpdates.length > 0 && (
            <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void runAction('update')}>
              {busy === 'update:all'
                ? t('settings.plugins.updating')
                : t('settings.plugins.updateAll', { count: availableUpdates.length })}
            </button>
          )}
          <button type="button" disabled={Boolean(busy) || !catalog} onClick={() => void reload()}>
            {busy === 'reload' ? t('settings.plugins.reloading') : t('settings.plugins.reload')}
          </button>
          <button type="button" disabled={Boolean(busy)} onClick={() => void load(true)}>
            {busy === 'refresh' ? t('common.loading') : t('settings.plugins.refresh')}
          </button>
        </div>
      </div>

      <div className="plugin-feedback" aria-live="polite">
        {error && <p role="alert" className="status-warning">{error}</p>}
        {!error && message && <p role={messageWarning ? 'alert' : undefined}
          className={messageWarning ? 'status-warning' : 'status-success'}>{message}</p>}
        {!error && batchFailures.length > 0 && <ul className="plugin-batch-failures">
          {batchFailures.map(failure => <li key={failure.key}><strong>{failure.label}:</strong> {failure.reason}</li>)}
        </ul>}
        {reloadPending && <p role="status" className="status-warning">{t('settings.plugins.reloadPending')}</p>}
      </div>

      {!catalog && busy === 'load' && <p role="status">{t('common.loading')}…</p>}
      {catalog && visiblePackages.length === 0 && catalog.standaloneExtensions.length === 0 && (
        <p className="plugin-empty">{t('settings.plugins.empty')}</p>
      )}

      {selection?.selection && !selected && catalog && <p role="status" className="settings-help">
        {pluginSettingsMessage(locale, 'unavailable')}
      </p>}
      <div className="plugin-context">
        <nav ref={navigationRef} tabIndex={-1} aria-label={t('settings.plugins.title')}
          hidden={mobile && !overview && Boolean(selected)}>
        {groups.map(({ scope: groupScope, packages: group }) => {
          const enableCount = group.filter(pkg => !pkg.enabled).length;
          const disableCount = group.filter(pkg => pkg.enabled).length;
          return (
            <fieldset key={groupScope}>
              <legend>{t(`settings.plugins.scope.${groupScope}`)}</legend>
              <div className="plugin-group-actions" role="group"
                aria-label={t('settings.plugins.groupActions', { scope: t(`settings.plugins.scope.${groupScope}`) })}>
                <button type="button" disabled={Boolean(busy) || enableCount === 0}
                  title={settingsAdminMessage(locale, 'filteredHelp')}
                  onClick={() => void runGroupAction(groupScope, true, group)}>
                  {busy === `batch:${groupScope}:enable`
                    ? t('common.loading')
                    : t('settings.plugins.enableAll', { count: enableCount })}
                </button>
                <button type="button" disabled={Boolean(busy) || disableCount === 0}
                  title={settingsAdminMessage(locale, 'filteredHelp')}
                  onClick={() => void runGroupAction(groupScope, false, group)}>
                  {busy === `batch:${groupScope}:disable`
                    ? t('common.loading')
                    : t('settings.plugins.disableAll', { count: disableCount })}
                </button>
              </div>
              {group.map((pkg, index) => <button key={pkg.key} type="button" className="plugin-context-choice" disabled={Boolean(busy)}
                aria-label={pkg.packageName || pkg.source} aria-current={pkg === selected ? 'true' : undefined}
                aria-expanded={pkg === selected && (!mobile || !overview)} aria-controls={`${detailPrefix}-${groupScope}-${index}`}
                aria-describedby={`${detailPrefix}-${groupScope}-${index}-state`}
                onClick={() => { navigationFocus.current = mobile; selectPackage(pkg); }}>
                <strong>{pkg.packageName || pkg.source}</strong>
                <small id={`${detailPrefix}-${groupScope}-${index}-state`}>{pkg.source} · {t(`settings.plugins.status.${pkg.status}`)}</small>
              </button>)}
            </fieldset>
          );
        })}
        </nav>
        <div ref={detailRef} className="plugin-context-detail" hidden={mobile && (overview || !selected)}>
          <button ref={backRef} type="button" className="plugin-context-back" hidden={!mobile}
            onClick={() => { navigationFocus.current = true; setOverview(true); }}>{pluginSettingsMessage(locale, 'back')}</button>
          <div className="plugin-groups">
          {groups.map(({ scope: groupScope, packages: group }) => (
            <fieldset key={groupScope} data-scope={groupScope} data-settings-group={groupScope} hidden={selected?.scope !== groupScope}>
              <legend>{t(`settings.plugins.scope.${groupScope}`)}</legend>
              {group.map((pkg, index) => {
                const update = updates[pkg.key];
                const packageBusy = busy?.endsWith(pkg.key) || false;
                return (
                  <article className={`plugin-card status-${pkg.status}`} key={pkg.key} data-settings-selection={pkg.key}
                    aria-label={pkg.packageName || pkg.source} id={`${detailPrefix}-${groupScope}-${index}`} hidden={pkg !== selected}>
                    <header>
                      <div className="plugin-identity">
                        <div>
                          <span className={`plugin-status-dot status-${pkg.status}`} aria-hidden="true" />
                          <strong>{pkg.packageName || pkg.source}</strong>
                          <small className="plugin-scope-tag">{pkg.scope}</small>
                        </div>
                        <code title={pkg.source}>{pkg.source}</code>
                        {pkg.description && <span>{pkg.description}</span>}
                      </div>
                      <div className="plugin-actions">
                        {pkg.canCheckForUpdates && (
                          <button type="button" disabled={Boolean(busy)}
                            aria-label={t('settings.plugins.checkOne', { plugin: pkg.packageName || pkg.source })}
                            onClick={() => void (update?.state === 'update-available' ? runAction('update', pkg) : check(pkg))}>
                            {busy === `check:${pkg.key}` ? t('settings.plugins.checking')
                              : busy === `update:${pkg.key}` ? t('settings.plugins.updating')
                                : update?.state === 'update-available' ? t('settings.plugins.update')
                                  : t('settings.plugins.check')}
                          </button>
                        )}
                        <label className="plugin-toggle">
                          <input type="checkbox" checked={pkg.enabled} disabled={Boolean(busy) || (!pkg.trusted && !pkg.enabled)}
                            aria-label={t('settings.plugins.toggle', { plugin: pkg.packageName || pkg.source })}
                            onChange={() => void runAction(pkg.enabled ? 'disable' : 'enable', pkg)} />
                          <span>{pkg.enabled ? t('settings.plugins.enabled') : t('settings.plugins.disabled')}</span>
                        </label>
                        <button type="button" className="danger" disabled={Boolean(busy)}
                          onClick={() => {
                            if (window.confirm(t('settings.plugins.removeConfirm', { plugin: pkg.packageName || pkg.source }))) {
                              void runAction('remove', pkg);
                            }
                          }}>
                          {busy === `remove:${pkg.key}` ? t('settings.plugins.removing') : t('settings.plugins.remove')}
                        </button>
                      </div>
                    </header>
                    <div className="plugin-meta">
                      <span className={`plugin-state status-${pkg.status}`}>{t(`settings.plugins.status.${pkg.status}`)}</span>
                      <span>{t('settings.plugins.version', { version: pkg.version || t('settings.plugins.unknown') })}</span>
                      <span>{packageSummary(pkg) || t('settings.plugins.noResources')}</span>
                      {pkg.restartRequired && <span className="plugin-restart">{t('settings.plugins.restartRequired')}</span>}
                      {packageBusy && <span>{t('common.loading')}…</span>}
                    </div>
                    {update && (
                      <p className={`plugin-update-state state-${update.state}`}>
                        {update.state === 'update-available'
                          ? t('settings.plugins.updateAvailable', { version: update.availableVersion || '?' })
                          : update.state === 'up-to-date' ? t('settings.plugins.upToDate')
                            : update.message || t(`settings.plugins.updateState.${update.state}`)}
                      </p>
                    )}
                    {(pkg.resources.length > 0 || pkg.diagnostics.length > 0) && (
                      <details className="plugin-resources">
                        <summary>{t('settings.plugins.details')}</summary>
                        {(['extension', 'skill', 'prompt', 'theme'] as PluginResourceKind[]).map(kind => {
                          const resources = pkg.resources.filter(resource => resource.kind === kind);
                          if (resources.length === 0) return null;
                          return <div key={kind} className="plugin-resource-group">
                            <strong>{resourceLabel(kind, resources.length)}</strong>
                            {resources.map(resource => <code key={`${kind}:${resource.relativePath}`} title={resource.path}>
                              {resource.relativePath}
                            </code>)}
                          </div>;
                        })}
                        {pkg.diagnostics.map(diagnostic => (
                          <p key={`${diagnostic.code}:${diagnostic.message}`} className="status-warning">
                            <code>{diagnostic.code}</code> — {diagnostic.message}
                          </p>
                        ))}
                      </details>
                    )}
                  </article>
                );
              })}
            </fieldset>
          ))}
          </div>
        </div>
      </div>

      <div className="plugin-groups">
        {catalog && catalog.standaloneExtensions.length > 0 && (
          <fieldset data-scope="standalone">
            <legend>{t('settings.plugins.standalone')}</legend>
            <div className="plugin-standalone-list">
              {catalog.standaloneExtensions.map(extension => (
                <div key={`${extension.scope}:${extension.path}`}>
                  <span className="plugin-status-dot status-active" aria-hidden="true" />
                  <strong>{extension.name}</strong>
                  <small className="plugin-scope-tag">{extension.scope}</small>
                  <code>{extension.path}</code>
                </div>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      {catalog && (
        <footer className="plugin-catalog-footer">
          <span>{t('settings.plugins.totals', {
            extensions: catalog.totals.extensions,
            skills: catalog.totals.skills,
            prompts: catalog.totals.prompts,
            themes: catalog.totals.themes,
          })}</span>
          {catalog.diagnostics.length > 0 && (
            <details>
              <summary>{t('settings.plugins.diagnostics', { count: catalog.diagnostics.length })}</summary>
              {catalog.diagnostics.map((diagnostic, index) => (
                <p key={`${diagnostic.code}:${index}`}><code>{diagnostic.code}</code> — {diagnostic.message}</p>
              ))}
            </details>
          )}
        </footer>
      )}
    </section>
  );
}
