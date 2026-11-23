import { apiFetch } from './api';

export type DocumentPreviewData = { kind: 'pdf'; bytes: Uint8Array } | { kind: 'docx'; text: string };

export async function readDocumentPreview(cwd: string, path: string, signal: AbortSignal): Promise<DocumentPreviewData> {
  const response = await apiFetch(`/api/files/preview?${new URLSearchParams({ cwd, path })}`, { signal });
  if (!response.ok || !response.body) throw new Error('Preview unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Preview limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (response.headers.get('Content-Type')?.split(';')[0] === 'application/pdf') return { kind: 'pdf', bytes };
  const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (data && typeof data === 'object' && 'kind' in data && data.kind === 'docx'
    && 'text' in data && typeof data.text === 'string' && data.text.length <= 200_000) return { kind: 'docx', text: data.text };
  throw new Error('Preview unavailable');
}
