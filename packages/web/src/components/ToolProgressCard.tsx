import type { ToolProgressSnapshot } from '@ai-harness/core';
import { toolProgressDetailsText } from './tool-progress-state';
import { useI18n } from '../hooks/useI18n';
import { toolProgressMessages } from './tool-progress-messages';
import './tool-progress-card.css';

export interface ToolProgressCardProps { progress: ToolProgressSnapshot }

/** Plain text only: this is not Markdown, a widget renderer or an accounting card. */
export default function ToolProgressCard({ progress }: ToolProgressCardProps) {
  const { locale } = useI18n();
  const copy = toolProgressMessages(locale);
  const reported = toolProgressDetailsText(progress);
  return <section className="generic-tool-progress" aria-label={`${copy.label}: ${progress.toolName}`} data-status={progress.status}>
    <header><strong>{progress.toolName}</strong><span>{copy.status[progress.status]}</span>
      <small>{copy.duration}: {(progress.durationMs / 1_000).toFixed(2)}s</small></header>
    <p className="generic-tool-progress-context">{copy.phase} {progress.sequence}</p>
    <pre className="generic-tool-progress-content">{progress.content || (progress.status === 'running' ? copy.waiting : copy.empty)}</pre>
    {reported && <details><summary>{copy.details}</summary>
      <p>{copy.disclaimer}</p><pre>{reported}</pre></details>}
    {(progress.truncated || progress.omittedUpdates > 0) && <p className="generic-tool-progress-context">
      {progress.truncated && copy.truncated}{progress.truncated && progress.omittedUpdates > 0 && ' '}
      {progress.omittedUpdates > 0 && `${progress.omittedUpdates} ${progress.omittedUpdates === 1 ? copy.omittedOne : copy.omitted}`}</p>}
  </section>;
}
