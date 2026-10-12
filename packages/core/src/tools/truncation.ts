export const DEFAULT_TOOL_MAX_LINES = 2_000;
export const DEFAULT_TOOL_MAX_BYTES = 50 * 1024;
export const DEFAULT_GREP_LINE_LENGTH = 500;

export interface ToolTruncation {
  content: string;
  truncated: boolean;
  truncatedBy?: 'lines' | 'bytes';
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit?: boolean;
  partialLine?: boolean;
}

function linesOf(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function utf8Suffix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export function truncateToolHead(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): ToolTruncation {
  const maxLines = options.maxLines ?? DEFAULT_TOOL_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_TOOL_MAX_BYTES;
  const lines = linesOf(content);
  const totalBytes = Buffer.byteLength(content, 'utf8');
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      totalLines: lines.length,
      totalBytes,
      outputLines: lines.length,
      outputBytes: totalBytes,
    };
  }

  if (lines.length > 0 && Buffer.byteLength(lines[0], 'utf8') > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines: lines.length,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
    };
  }

  const selected: string[] = [];
  let outputBytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (const line of lines) {
    if (selected.length >= maxLines) break;
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    selected.push(line);
    outputBytes += lineBytes;
  }

  const output = selected.join('\n');
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    totalBytes,
    outputLines: selected.length,
    outputBytes: Buffer.byteLength(output, 'utf8'),
  };
}

export function truncateToolTail(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): ToolTruncation {
  const maxLines = options.maxLines ?? DEFAULT_TOOL_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_TOOL_MAX_BYTES;
  const lines = linesOf(content);
  const totalBytes = Buffer.byteLength(content, 'utf8');
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      totalLines: lines.length,
      totalBytes,
      outputLines: lines.length,
      outputBytes: totalBytes,
    };
  }

  const selected: string[] = [];
  let outputBytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  let partialLine = false;
  for (let index = lines.length - 1; index >= 0 && selected.length < maxLines; index--) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      if (selected.length === 0) {
        selected.unshift(utf8Suffix(line, maxBytes));
        partialLine = true;
      }
      break;
    }
    selected.unshift(line);
    outputBytes += lineBytes;
  }

  const output = selected.join('\n');
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    totalBytes,
    outputLines: selected.length,
    outputBytes: Buffer.byteLength(output, 'utf8'),
    partialLine,
  };
}

export function truncateToolLine(
  line: string,
  maxLength = DEFAULT_GREP_LINE_LENGTH,
): { content: string; truncated: boolean } {
  if (line.length <= maxLength) return { content: line, truncated: false };
  return { content: `${line.slice(0, maxLength)}… [truncated]`, truncated: true };
}

export function truncateToolBytes(value: string, maxBytes: number): string {
  return utf8Prefix(value, maxBytes);
}

export function formatToolBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
