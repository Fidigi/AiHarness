export class DelimitedPreviewError extends Error {
  constructor(readonly reason: 'invalid' | 'limit') { super(reason); }
}

// RFC-style quoting with literal, never evaluated cells. Refuse the entire
// preview on malformed/oversized input instead of silently dropping columns.
export function parseDelimited(input: string, delimiter: ',' | '\t'): string[][] {
  if (input.length > 2 * 1024 * 1024) throw new DelimitedPreviewError('limit');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false, cells = 0;
  const field = () => {
    if (row.length >= 64 || ++cells > 20_000) throw new DelimitedPreviewError('limit');
    row.push(cell); cell = ''; closed = false;
  };
  const record = () => {
    field();
    if (rows.length >= 500) throw new DelimitedPreviewError('limit');
    rows.push(row); row = [];
  };
  const text = input.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const value = text[index];
    if (quoted) {
      if (value === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else cell += value;
    } else if (value === delimiter) field();
    else if (value === '\r' || value === '\n') {
      record();
      if (value === '\r' && text[index + 1] === '\n') index++;
    } else if (value === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || value === '"') throw new DelimitedPreviewError('invalid');
      cell += value;
    }
    if (cell.length > 16_384) throw new DelimitedPreviewError('limit');
  }
  if (quoted) throw new DelimitedPreviewError('invalid');
  if (cell || row.length || closed) record();
  return rows;
}
