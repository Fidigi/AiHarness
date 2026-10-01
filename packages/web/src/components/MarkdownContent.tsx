import { lazy, Suspense } from 'react';

const MarkdownContentRenderer = lazy(() => import('./MarkdownContentRenderer'));

/** Lazy boundary keeps Markdown, KaTeX and diagram engines out of the initial application chunk. */
export default function MarkdownContent({ content }: { content: string }) {
  return <Suspense fallback={<div className="markdown-content markdown-loading" aria-busy="true">{content}</div>}>
    <MarkdownContentRenderer content={content} />
  </Suspense>;
}
