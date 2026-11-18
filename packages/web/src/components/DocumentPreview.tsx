import { useEffect, useState, type ComponentType } from 'react';
import { useI18n } from '../hooks/useI18n';
import { readDocumentPreview, type DocumentPreviewData } from '../services/document-preview';
import { filePreviewMessages } from './file-preview-messages';

export default function DocumentPreview({ cwd, path }: { cwd: string; path: string }) {
  const { locale } = useI18n();
  const copy = filePreviewMessages(locale);
  const [data, setData] = useState<DocumentPreviewData>();
  const [Pdf, setPdf] = useState<ComponentType<{ bytes: Uint8Array }>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setFailed(false);
    const timer = window.setTimeout(() => { controller.abort(); setFailed(true); }, 15_000);
    void (async () => {
      try {
        const result = await readDocumentPreview(cwd, path, controller.signal);
        const module = result.kind === 'pdf' ? await import('./PdfPreview') : undefined;
        if (controller.signal.aborted) return;
        if (module) setPdf(() => module.default);
        setData(result);
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { window.clearTimeout(timer); }
    })();
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [cwd, path]);
  if (failed) return <p className="panel-error" role="alert">{copy.failed}</p>;
  if (!data) return <p className="panel-empty" role="status">{copy.previewLoading}</p>;
  if (data.kind === 'pdf') return Pdf ? <Pdf bytes={data.bytes} /> : null;
  return <section className="docx-preview" aria-label={copy.docx}><p>{copy.docx}</p><pre>{data.text || copy.empty}</pre></section>;
}
