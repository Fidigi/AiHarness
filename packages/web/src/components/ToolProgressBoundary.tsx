import { Component, Suspense, lazy, type ReactNode } from 'react';
import type { ToolProgressSnapshot } from '@ai-harness/core';
import { normalizeToolProgress } from './tool-progress-state';
import { useI18n } from '../hooks/useI18n';
import { toolProgressMessages } from './tool-progress-messages';

const Card = lazy(() => import('./ToolProgressCard'));

function Fallback({ progress, failed = false }: { progress: ToolProgressSnapshot; failed?: boolean }) {
  const { locale } = useI18n();
  const copy = toolProgressMessages(locale);
  return <section className="session-info" aria-label={`${copy.label}: ${progress.toolName}`} aria-busy={!failed}>
    <strong>{progress.toolName} · {copy.status[progress.status]}</strong>
    <p>{copy.duration}: {(progress.durationMs / 1_000).toFixed(2)}s</p>
    <p role="status">{failed ? copy.failedLoad : copy.loading}</p>
    <pre>{progress.content || copy.empty}</pre>
  </section>;
}
class LoadBoundary extends Component<{ progress: ToolProgressSnapshot; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render() { return this.state.failed ? <Fallback progress={this.props.progress} failed /> : this.props.children; }
}

/** Eager, CSS-free gate. Neither the card nor its scoped styles load for old tools
 * or invalid/unknown metadata. No focus calls, dialogs or editable controls. */
export default function ToolProgressBoundary({ value, toolCallId, toolName, terminal = false }: {
  value: unknown; toolCallId: string; toolName: string; terminal?: boolean;
}) {
  const progress = normalizeToolProgress(value, toolCallId, toolName);
  if (!progress || (terminal ? progress.status === 'running' : progress.status !== 'running')) return null;
  return <LoadBoundary key={toolCallId} progress={progress}>
    <Suspense fallback={<Fallback progress={progress} />}><Card progress={progress} /></Suspense>
  </LoadBoundary>;
}
