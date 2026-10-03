import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SubagentConfiguration, SubagentProfile } from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import {
  createSubagentProfile,
  deleteSubagentProfile,
  duplicateSubagentProfile,
  getSubagentConfiguration,
  updateSubagentProfile,
  updateSubagentSettings,
} from '../services/api';
import { useSessionStore } from '../store/session-store';

interface EditorValue {
  /** Existing profile id; present means update mode. */
  id?: string;
  identifier: string;
  name: string;
  description: string;
  instructions: string;
  kind: SubagentProfile['kind'];
  enabled: boolean;
  tools: string;
  skills: string;
  extensions: string;
  model: string;
  thinking: NonNullable<SubagentProfile['thinking']> | '';
  maxTurns: number;
  inheritContext: boolean;
  background: boolean;
}

function editorValue(profile?: SubagentProfile): EditorValue {
  return {
    id: profile?.id,
    identifier: profile?.id ?? '',
    name: profile?.name ?? '',
    description: profile?.description ?? '',
    instructions: profile?.instructions ?? '',
    kind: profile?.kind ?? 'custom',
    enabled: profile?.enabled ?? true,
    tools: profile?.tools.join(', ') ?? '',
    skills: profile?.skills.join(', ') ?? '',
    extensions: profile?.extensions.join(', ') ?? '',
    model: profile?.model ?? '',
    thinking: profile?.thinking ?? '',
    maxTurns: profile?.maxTurns ?? 8,
    inheritContext: profile?.inheritContext ?? true,
    background: profile?.background ?? true,
  };
}

function list(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
}

export function SubagentSettings() {
  const { t } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const [configuration, setConfiguration] = useState<SubagentConfiguration>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [editor, setEditor] = useState<EditorValue>();
  const [targetScope, setTargetScope] = useState<'global' | 'project'>('project');
  const scope = [
    workspace?.cwd,
    targetScope === 'project' ? workspace?.id : undefined,
    targetScope,
  ] as const;

  const load = async () => {
    setLoading(true);
    setError('');
    const result = await getSubagentConfiguration(...scope);
    if (result.success) setConfiguration(result.data);
    else setError(result.error || t('subagents.loadError'));
    setLoading(false);
  };

  useEffect(() => { void load(); }, [workspace?.id, targetScope]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return (configuration?.profiles ?? []).filter(profile => !query
      || profile.name.toLocaleLowerCase().includes(query)
      || profile.description.toLocaleLowerCase().includes(query)
      || profile.kind.includes(query));
  }, [configuration?.profiles, filter]);

  const apply = async (operation: Promise<{ success: boolean; data?: SubagentConfiguration; error?: string }>) => {
    setLoading(true);
    setError('');
    const result = await operation;
    if (result.success && result.data) setConfiguration(result.data);
    else setError(result.error || t('subagents.saveError'));
    setLoading(false);
    return result.success;
  };

  const saveEditor = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const profile = {
      ...(!editor.id && editor.identifier.trim() ? { id: editor.identifier.trim() } : {}),
      name: editor.name,
      description: editor.description,
      instructions: editor.instructions,
      kind: editor.kind,
      enabled: editor.enabled,
      tools: list(editor.tools),
      skills: list(editor.skills),
      extensions: list(editor.extensions),
      ...(editor.model.trim() ? { model: editor.model.trim() } : { model: undefined }),
      ...(editor.thinking ? { thinking: editor.thinking } : { thinking: undefined }),
      maxTurns: editor.maxTurns,
      inheritContext: editor.inheritContext,
      background: editor.background,
    };
    const success = editor.id
      ? await apply(updateSubagentProfile(editor.id, profile, ...scope))
      : await apply(createSubagentProfile(profile, ...scope));
    if (success) setEditor(undefined);
  };

  return (
    <section className="settings-section" id="subagents">
      <h3>{t('subagents.title')}</h3>
      <p className="settings-help">{t('subagents.help')}</p>
      {configuration && (
        <div className="subagent-engine-settings">
          <label className="subagent-scope-control">
            <span>{t('subagents.targetScope')}</span>
            <select value={targetScope} disabled={loading} onChange={event => {
              setEditor(undefined);
              setTargetScope(event.target.value as 'global' | 'project');
            }}>
              <option value="project">{t('subagents.scope.project')}</option>
              <option value="global">{t('subagents.scope.global')}</option>
            </select>
          </label>
          <label className="subagent-concurrency-control">
            <span>{t('subagents.concurrency')}</span>
            <input type="number" min="1" max="16" value={configuration.maxConcurrency} disabled={loading}
              onChange={event => void apply(updateSubagentSettings({ maxConcurrency: Number(event.target.value) }, ...scope))} />
          </label>
          <label className="subagent-engine-toggle">
            <input type="checkbox" checked={configuration.engineEnabled} disabled={loading}
              onChange={event => void apply(updateSubagentSettings({ engineEnabled: event.target.checked }, ...scope))} />
            {t('subagents.engine')}
          </label>
          <small>{t('subagents.scope', { scope: configuration.scope, source: configuration.source })}</small>
        </div>
      )}
      <div className="subagent-toolbar">
        <label>
          <span>{t('subagents.filter')}</span>
          <input type="search" value={filter} onChange={event => setFilter(event.target.value)} />
        </label>
        <button type="button" disabled={loading} onClick={() => setEditor(editorValue())}>{t('subagents.create')}</button>
        <button type="button" disabled={loading} onClick={() => void load()}>{t('common.refresh')}</button>
      </div>
      {loading && <p role="status">{t('common.loading')}…</p>}
      {error && <p role="alert" className="status-warning">{error}</p>}

      {editor && (
        <form className="subagent-profile-editor" role="dialog" aria-labelledby="subagent-editor-title"
          onSubmit={event => void saveEditor(event)}>
          <h4 id="subagent-editor-title">{editor.id ? t('subagents.edit') : t('subagents.create')}</h4>
          <div className="subagent-editor-grid">
            <label>{t('subagents.id')}<input maxLength={80} pattern="[a-z][a-z0-9_-]{0,79}"
              disabled={Boolean(editor.id)} value={editor.identifier}
              placeholder={t('subagents.autoId')}
              onChange={event => setEditor({ ...editor, identifier: event.target.value })} /></label>
            <label>{t('subagents.name')}<input required maxLength={120} value={editor.name}
              onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
            <label>{t('subagents.kind')}<select value={editor.kind}
              onChange={event => setEditor({ ...editor, kind: event.target.value as SubagentProfile['kind'] })}>
              {(['explore', 'general', 'plan', 'custom'] as const).map(kind => (
                <option key={kind} value={kind}>{t(`subagents.kind.${kind}`)}</option>
              ))}
            </select></label>
            <label className="wide">{t('subagents.description')}<input required maxLength={1000} value={editor.description}
              onChange={event => setEditor({ ...editor, description: event.target.value })} /></label>
            <label className="wide">{t('subagents.instructions')}<textarea required rows={5} maxLength={100000} value={editor.instructions}
              onChange={event => setEditor({ ...editor, instructions: event.target.value })} /></label>
            <label>{t('subagents.tools')}<input value={editor.tools}
              onChange={event => setEditor({ ...editor, tools: event.target.value })} placeholder={t('subagents.inheritAll')} /></label>
            <label>{t('subagents.skills')}<input value={editor.skills}
              onChange={event => setEditor({ ...editor, skills: event.target.value })} placeholder={t('subagents.inheritAll')} /></label>
            <label>{t('subagents.extensions')}<input value={editor.extensions}
              onChange={event => setEditor({ ...editor, extensions: event.target.value })} placeholder={t('subagents.inheritAll')} /></label>
            <label>{t('subagents.model')}<input value={editor.model}
              onChange={event => setEditor({ ...editor, model: event.target.value })} placeholder={t('chat.setting.auto')} /></label>
            <label>{t('subagents.thinking')}<select value={editor.thinking}
              onChange={event => setEditor({ ...editor, thinking: event.target.value as EditorValue['thinking'] })}>
              <option value="">{t('chat.setting.auto')}</option>
              {['off', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level}>{level}</option>)}
            </select></label>
            <label>{t('subagents.maxTurns')}<input type="number" min="1" max="32" value={editor.maxTurns}
              onChange={event => setEditor({ ...editor, maxTurns: Number(event.target.value) })} /></label>
          </div>
          <div className="subagent-editor-options">
            <label><input type="checkbox" checked={editor.enabled}
              onChange={event => setEditor({ ...editor, enabled: event.target.checked })} />{t('subagents.profileEnabled')}</label>
            <label><input type="checkbox" checked={editor.inheritContext}
              onChange={event => setEditor({ ...editor, inheritContext: event.target.checked })} />{t('subagents.inheritContext')}</label>
            <label><input type="checkbox" checked={editor.background}
              onChange={event => setEditor({ ...editor, background: event.target.checked })} />{t('subagents.background')}</label>
          </div>
          <footer>
            <button type="button" onClick={() => setEditor(undefined)}>{t('common.cancel')}</button>
            <button className="primary" type="submit" disabled={loading}>{t('common.save')}</button>
          </footer>
        </form>
      )}

      <div className="subagent-profile-list">
        {visible.map(profile => (
          <article key={profile.id} className="subagent-profile-card" data-kind={profile.kind}>
            <header>
              <div><strong>{profile.name}</strong><small>{profile.id}</small></div>
              <span>{t(`subagents.kind.${profile.kind}`)}{profile.builtIn ? ` · ${t('subagents.builtIn')}` : ''}</span>
            </header>
            <p>{profile.description}</p>
            <dl>
              <dt>{t('subagents.maxTurns')}</dt><dd>{profile.maxTurns}</dd>
              <dt>{t('subagents.model')}</dt><dd>{profile.model || t('chat.setting.auto')}</dd>
              <dt>{t('subagents.tools')}</dt><dd>{profile.tools.length ? profile.tools.join(', ') : t('subagents.inheritAll')}</dd>
              <dt>{t('subagents.skills')}</dt><dd>{profile.skills.length ? profile.skills.join(', ') : t('subagents.inheritAll')}</dd>
            </dl>
            <footer>
              <label><input type="checkbox" checked={profile.enabled} disabled={loading}
                aria-label={t('subagents.toggleProfile', { profile: profile.name })}
                onChange={event => void apply(updateSubagentProfile(profile.id, { enabled: event.target.checked }, ...scope))} />
                {t('subagents.profileEnabled')}</label>
              <button type="button" onClick={() => setEditor(editorValue(profile))}>{t('common.edit')}</button>
              <button type="button" disabled={loading}
                onClick={() => void apply(duplicateSubagentProfile(profile.id, ...scope))}>{t('subagents.duplicate')}</button>
              {!profile.builtIn && <button type="button" disabled={loading}
                onClick={() => window.confirm(t('subagents.deleteConfirm', { profile: profile.name }))
                  && void apply(deleteSubagentProfile(profile.id, ...scope))}>{t('common.delete')}</button>}
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}
