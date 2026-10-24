import { lazy, Suspense, type ComponentType } from 'react';
import type { MarkdownContentProps } from './MarkdownContentRenderer';

function PlainContent(props: MarkdownContentProps & { busy?: boolean }) {
  return props.compact ? <span>{props.content}</span>
    : <div className="markdown-content markdown-loading" aria-busy={props.busy}>{props.content}</div>;
}
const MarkdownContentRenderer = lazy<ComponentType<MarkdownContentProps>>(() => import('./MarkdownContentRenderer').catch(() => ({ default: PlainContent })));

/** Lazy boundary keeps Markdown, KaTeX and diagram engines out of the initial application chunk. */
export default function MarkdownContent(props: MarkdownContentProps) {
  return <Suspense fallback={<PlainContent {...props} busy />}>
    <MarkdownContentRenderer {...props} />
  </Suspense>;
}
