import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useI18n } from '../hooks/useI18n';
import { filePreviewMessages } from './file-preview-messages';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const { locale } = useI18n();
  const copy = filePreviewMessages(locale);
  const canvas = useRef<HTMLCanvasElement>(null);
  const loadingTask = useRef<ReturnType<typeof getDocument> | undefined>(undefined);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setFailed(false); setPdf(undefined); setPage(1);
    // Data only: no URL/range fetch, XFA, scripts, annotation/form/link layer or
    // external font/CMap resources. One owned worker is destroyed on retirement.
    const task = getDocument({ data: bytes.slice(),
      enableXfa: false, useWorkerFetch: false, disableFontFace: true,
      useSystemFonts: true, maxImageSize: 2_000_000, stopAtErrors: true });
    loadingTask.current = task;
    const timer = window.setTimeout(() => { if (current) { setFailed(true); void task.destroy().catch(() => undefined); } }, 12_000);
    void task.promise.then(value => {
      if (!current) return;
      if (value.numPages > 100) { setFailed(true); void task.destroy().catch(() => undefined); }
      else setPdf(value);
    }, () => { if (current) setFailed(true); }).finally(() => window.clearTimeout(timer));
    return () => { current = false; window.clearTimeout(timer); void task.destroy().catch(() => undefined); };
  }, [bytes]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let current = true;
    let render: RenderTask | undefined;
    setBusy(true); setText('');
    const timer = window.setTimeout(() => { if (current) { setFailed(true); render?.cancel(); void loadingTask.current?.destroy().catch(() => undefined); } }, 8_000);
    void (async () => {
      try {
        const value = await pdf.getPage(page);
        if (!current || !canvas.current) return;
        const base = value.getViewport({ scale: 1 });
        if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error('Invalid page');
        const scale = Math.min(1.5, 1400 / base.width, 1800 / base.height, Math.sqrt(2_000_000 / (base.width * base.height)));
        const viewport = value.getViewport({ scale });
        const node = canvas.current;
        node.width = Math.max(1, Math.floor(viewport.width)); node.height = Math.max(1, Math.floor(viewport.height));
        render = value.render({ canvas: node, viewport, annotationMode: 0 });
        await render.promise;
        const content = await value.getTextContent();
        if (!current) return;
        let plain = '';
        for (const item of content.items) {
          if ('str' in item) plain += item.str + (item.hasEOL ? '\n' : ' ');
          if (plain.length > 200_000) throw new Error('Page text limit');
        }
        setText(plain); setBusy(false); value.cleanup();
      } catch { if (current) setFailed(true); }
      finally { window.clearTimeout(timer); }
    })();
    return () => { current = false; window.clearTimeout(timer); render?.cancel(); };
  }, [pdf, page]);
  if (failed) return <p className="panel-error" role="alert">{copy.failed}</p>;
  return <section className="pdf-preview" aria-label="PDF">
    <div className="pdf-controls">
      <button onClick={() => setPage(value => value - 1)} disabled={busy || page <= 1}>{copy.previous}</button>
      <span>{copy.page} {page} / {pdf?.numPages ?? '—'}</span>
      <button onClick={() => setPage(value => value + 1)} disabled={busy || !pdf || page >= pdf.numPages}>{copy.next}</button>
    </div>
    {busy && <p role="status">{copy.previewLoading}</p>}
    <canvas ref={canvas} role="img" aria-label={`${copy.page} ${page}`} hidden={busy} />
    {!busy && <details><summary>{copy.pageText}</summary><pre>{text || copy.empty}</pre></details>}
  </section>;
}
