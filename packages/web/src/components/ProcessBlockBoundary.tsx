import { Component, Suspense, lazy, type ReactNode } from 'react';
import type { TranslationFunction } from '../i18n/types';
import { useI18n } from '../hooks/useI18n';
import { toolProgressMessages } from './tool-progress-messages';

export interface ProcessBlockProps {
  className: string; summary: string; content: string; fullContent?: string;
  truncated?: boolean; filename: string; defaultOpen?: boolean; error?: boolean;
  t: TranslationFunction;
  openFile(path: string, line?: number): void;
}
const Block = lazy(() => import('./ProcessBlock'));
function Fallback({ props, failed = false }: { props: ProcessBlockProps; failed?: boolean }) {
  const { locale } = useI18n();
  return <>
    {failed && <p role="status">{toolProgressMessages(locale).failedLoad}</p>}
    <pre aria-busy={!failed}>{(failed ? props.fullContent ?? props.content : props.content).slice(0, failed ? undefined : 8_000)}</pre>
  </>;
}
class LoadBoundary extends Component<{ value: ProcessBlockProps; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render() { return this.state.failed ? <Fallback props={this.props.value} failed /> : this.props.children; }
}
/** Native nonblank text survives pending/cached-failed controls. Never suspends
 * chat, composer, tool activity or interaction authority. No focus calls. */
export default function ProcessBlockBoundary(props: ProcessBlockProps) {
  // Native disclosure identity/open/focus survives optional child allocation.
  return <details className={`${props.className}${props.error ? ' error' : ''}`} open={props.defaultOpen}>
    <summary>{props.summary}{props.truncated && <span className="truncated-badge">{props.t('chat.truncated')}</span>}</summary>
    <LoadBoundary value={props}><Suspense fallback={<Fallback props={props} />}><Block {...props} /></Suspense></LoadBoundary>
  </details>;
}
