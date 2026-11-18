export interface MarkdownTextareaEdit { start: number; end: number; text: string }

/** Return a newline edit only in a real list, never in a fence or a selection. */
export function getMarkdownListContinuation(value: string, start: number, end: number): MarkdownTextareaEdit | null {
  if (start !== end || start < 0 || end > value.length) return null;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const nextNewline = value.indexOf('\n', start);
  const lineEnd = nextNewline < 0 ? value.length : nextNewline;
  const line = value.slice(lineStart, lineEnd);
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return null;
  let fence = '';
  for (const previous of value.slice(0, lineStart).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(previous)?.[1];
    if (!marker) continue;
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length && previous.trim() === marker) fence = '';
  }
  if (fence) return null;
  const bullet = /^([ \t]*)([-+*])([ \t]+)(?:\[[ xX]\](?:[ \t]+|$))?/.exec(line);
  const numbered = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(?:\[[ xX]\](?:[ \t]+|$))?/.exec(line)
    ?? /^([ \t]*)(\d{1,3})(、)([ \t]*)/.exec(line);
  const match = bullet ?? numbered;
  if (!match || start - lineStart < match[0].length) return null;
  if (!line.slice(match[0].length).trim()) return { start: lineStart, end: lineEnd, text: '' };
  const indent = match[1]!;
  const marker = bullet ? bullet[2]! : `${String(Number(numbered![2]) + 1).padStart(numbered![2]!.length, '0')}${numbered![3]}`;
  const spacing = bullet ? bullet[3]! : numbered![4]!;
  const task = /\[[ xX]\]/.test(match[0]);
  return { start, end, text: `\n${indent}${marker}${spacing}${task ? '[ ] ' : ''}` };
}
