import { describe, expect, it } from 'vitest';
import { docxPreview } from './docx-preview.js';
import { documentZip, wordDocument, docxDocument } from '../../../../tests/fixtures/web04-documents.js';

describe('bounded text-only DOCX', () => {
  it('reads literal Word text, tabs, breaks and paragraphs; does not interpret external relationships or markup', async () => {
    expect(await docxPreview(docxDocument())).toBe('Read-only DOCX <script>literal</script>');
    expect(await docxPreview(documentZip([['word/document.xml', wordDocument('<w:p><w:r><w:t>A &amp; B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p><w:p><w:r><w:t>E</w:t></w:r></w:p>')]], true)))
      .toBe('A & B\tC\nD\nE');
  });
  it.each([
    Buffer.from('not a zip'), documentZip([['other.xml', wordDocument()]]),
    documentZip([['word/document.xml', '<wrong/>']]),
    documentZip([['word/document.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + wordDocument('<w:p><w:r><w:t>&e;</w:t></w:r></w:p>')]]),
    documentZip([['word/document.xml', wordDocument()], ['word/document.xml', wordDocument()]]),
  ])('refuses invalid, missing, duplicate or entity-bearing documents', async bytes => {
    await expect(docxPreview(bytes)).rejects.toMatchObject({ code: 'FILE_PREVIEW_INVALID' });
  });
  it('rejects forged directory sizes before accepting actual inflated bytes', async () => {
    const bytes = documentZip([['word/document.xml', wordDocument('A'.repeat(1_000_000))]], true);
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(1, directory + 24); bytes.writeUInt32LE(1, 22);
    await expect(docxPreview(bytes)).rejects.toMatchObject({ code: 'FILE_PREVIEW_INVALID' });
  });
  it.each([
    Buffer.alloc(2 * 1024 * 1024 + 1),
    documentZip(Array.from({ length: 513 }, (_, i) => [`${i}.xml`, ''])),
    documentZip([['word/document.xml', wordDocument('<w:p><w:r><w:t>' + 'A'.repeat(200_001) + '</w:t></w:r></w:p>')]]),
    documentZip([['word/document.xml', wordDocument('<w:p>'.repeat(65) + '</w:p>'.repeat(65))]]),
    documentZip([['word/document.xml', wordDocument('A'.repeat(1_000_000))]], true),
  ])('refuses input, archive, text, depth and compression amplification limits', async bytes => {
    await expect(docxPreview(bytes)).rejects.toMatchObject({ code: 'FILE_PREVIEW_LIMIT' });
  });
});
