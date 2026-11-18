import type { Readable } from 'node:stream';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { SaxesParser } from 'saxes';

export class DocumentPreviewError extends Error {
  constructor(readonly code: 'FILE_PREVIEW_INVALID' | 'FILE_PREVIEW_LIMIT') { super(code); }
}
const invalid = () => new DocumentPreviewError('FILE_PREVIEW_INVALID');
const limit = () => new DocumentPreviewError('FILE_PREVIEW_LIMIT');
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 200_000;
const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);

// Read exactly one in-memory member. Never extract paths, relationships, media,
// macros, external entities or embedded documents. Actual inflation is bounded,
// independently of the untrusted ZIP directory's advertised size.
export async function docxPreview(bytes: Buffer): Promise<string> {
  if (bytes.length > MAX_XML_BYTES) throw limit();
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
      (error, value) => error || !value ? reject(invalid()) : resolve(value));
  });
  try {
    const entry = await new Promise<Entry>((resolve, reject) => {
      if (zip.entryCount > 512) { reject(limit()); return; }
      let main: Entry | undefined;
      zip.on('error', () => reject(invalid()));
      zip.on('entry', (value: Entry) => {
        if (value.fileName === 'word/document.xml') {
          if (main) { reject(invalid()); return; }
          main = value;
        }
        zip.readEntry();
      });
      zip.on('end', () => main ? resolve(main) : reject(invalid()));
      zip.readEntry();
    });
    if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw invalid();
    if (entry.uncompressedSize > MAX_XML_BYTES || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100) throw limit();
    const stream = await new Promise<Readable>((resolve, reject) => {
      zip.openReadStream(entry, (error, value) => error || !value ? reject(invalid()) : resolve(value));
    });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_XML_BYTES) throw limit();
        chunks.push(chunk);
      }
    } finally { stream.destroy(); }
    return wordText(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    throw error instanceof DocumentPreviewError ? error : invalid();
  } finally { zip.close(); }
}

function wordText(xml: string): string {
  const parser = new SaxesParser({ xmlns: true });
  const parts: string[] = [];
  let length = 0, depth = 0, elements = 0, textDepth = 0;
  const append = (value: string) => {
    length += value.length;
    if (length > MAX_TEXT) throw limit();
    parts.push(value);
  };
  parser.on('doctype', () => { throw invalid(); });
  parser.on('error', () => { throw invalid(); });
  parser.on('opentag', tag => {
    depth++; elements++;
    if (depth > 64 || elements > 50_000) throw limit();
    if (elements === 1 && (tag.local !== 'document' || !WORD.has(tag.uri))) throw invalid();
    if (!WORD.has(tag.uri)) return;
    if (tag.local === 't') textDepth = depth;
    else if (tag.local === 'tab') append('\t');
    else if (tag.local === 'br' || tag.local === 'cr') append('\n');
  });
  parser.on('text', text => { if (textDepth) append(text); });
  parser.on('cdata', text => { if (textDepth) append(text); });
  parser.on('closetag', tag => {
    if (depth === textDepth) textDepth = 0;
    if (WORD.has(tag.uri) && tag.local === 'p') append('\n');
    depth--;
  });
  parser.write(xml).close();
  if (!elements) throw invalid();
  return parts.join('').trimEnd();
}
