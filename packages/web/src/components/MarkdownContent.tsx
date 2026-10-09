import { lazy, Suspense } from 'react';
import type { MarkdownContentProps } from './MarkdownContentRenderer';

const MarkdownContentRenderer = lazy(() => import('./MarkdownContentRenderer'));

/** Lazy boundary keeps Markdown, KaTeX and diagram engines out of the initial application chunk. */
export default function MarkdownContent(props: MarkdownContentProps) {
  return <Suspense fallback={props.compact
    ? <span aria-busy="true" />
    : <div className="markdown-content markdown-loading" aria-busy="true">{props.content}</div>}>
    <MarkdownContentRenderer {...props} />
  </Suspense>;
}
