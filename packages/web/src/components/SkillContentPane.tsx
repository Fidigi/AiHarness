import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillContent } from '@ai-harness/core';
import { getSkillContent } from '../services/skill-content';
import { useI18n } from '../hooks/useI18n';
import MarkdownContent from './MarkdownContent';
import './skill-content-messages';

/** Volatile detail state belongs to one selected source/workspace lifetime. */
export function SkillContentPane({ skillKey, name, cwd, projectId, onClose }: {
  skillKey: string; name: string; cwd?: string; projectId?: string; onClose: () => void;
}) {
  const { t } = useI18n();
  const [content, setContent] = useState<SkillContent>();
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const request = useRef<{ epoch: number; controller?: AbortController }>({ epoch: 0 });
  const pane = useRef<HTMLDivElement>(null);
  const load = useCallback(async (href?: string, from?: string) => {
    request.current.controller?.abort();
    const controller = new AbortController(), epoch = ++request.current.epoch;
    request.current.controller = controller;
    setBusy(true); setFailed(false);
    const result = await getSkillContent({ key: skillKey, cwd, projectId, href, from }, controller.signal);
    if (controller.signal.aborted || epoch !== request.current.epoch) return;
    setBusy(false);
    if (result.success && result.data) setContent(result.data);
    else setFailed(true);
  }, [skillKey, cwd, projectId]);
  useEffect(() => {
    setContent(undefined); void load();
    return () => { request.current.epoch++; request.current.controller?.abort(); };
  }, [load]);
  const localAnchor = useCallback((fragment: string) => {
    let id: string;
    try { id = decodeURIComponent(fragment); } catch { return; }
    [...pane.current?.querySelectorAll<HTMLElement>('[id]') ?? []].find(element => element.id === id)?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const reference = useCallback((href: string) => {
    if (href.startsWith('#')) { localAnchor(href.slice(1)); return; }
    void load(href, content?.relativePath);
  }, [content?.relativePath, load, localAnchor]);
  useEffect(() => { if (content?.fragment) localAnchor(encodeURIComponent(content.fragment)); }, [content, localAnchor]);
  return <section id="skill-content-detail" className="skill-content-pane" aria-label={t('settings.skills.instructions', { skill: name })}>
    <header><h4>{t('settings.skills.instructions', { skill: name })}</h4>
      <button type="button" onClick={onClose}>{t('common.close')}</button></header>
    <div className="skill-content-toolbar"><code>{content?.relativePath ?? ''}</code>
      <button type="button" disabled={busy} onClick={() => void load()}>{t('settings.skills.mainInstructions')}</button></div>
    {busy && <p role="status">{t('common.loading')}…</p>}
    {failed && <p role="alert">{t('settings.skills.contentUnavailable')}</p>}
    <div ref={pane} className="skill-content-document" aria-busy={busy} tabIndex={0}>
      {content && <MarkdownContent content={content.markdown} onReference={reference} />}
    </div>
  </section>;
}
