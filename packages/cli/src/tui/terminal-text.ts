/** Filter only untrusted text boundaries, never completed styled frames. Stateful
 * streams discard split OSC/CSI/DCS/APC sequences without buffering their bodies. */
export class TerminalTextFilter {
  private state: 'text' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'text';
  private sequence = '';
  constructor(private readonly allowSgr = false) {}

  push(value: string): string {
    let output = '';
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (this.state === 'stringEscape') {
        this.state = char === '\\' ? 'text' : 'string';
        continue;
      }
      if (this.state === 'string') {
        if (char === '\x07' || char === '\u009c') this.state = 'text';
        else if (char === '\x1b') this.state = 'stringEscape';
        continue;
      }
      if (this.state === 'escape') {
        this.sequence = '';
        if (char === '[') this.state = 'csi';
        else if (']P^_X'.includes(char)) this.state = 'string';
        else if (code >= 0x30 && code <= 0x7e) this.state = 'text';
        continue;
      }
      if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          if (this.allowSgr && char === 'm' && /^[\d;:]*$/.test(this.sequence)) {
            output += `\x1b[${this.sequence}m`;
          }
          this.state = 'text';
        } else if (this.sequence.length < 128) this.sequence += char;
        continue;
      }
      if (char === '\x1b') this.state = 'escape';
      else if (char === '\u009b') { this.state = 'csi'; this.sequence = ''; }
      else if ('\u0090\u009d\u009e\u009f\u0098'.includes(char)) this.state = 'string';
      else if (char === '\n' || char === '\t' || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)
        && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069))) output += char;
    }
    return output;
  }
}

export function terminalText(value: string, allowSgr = false): string {
  return new TerminalTextFilter(allowSgr).push(value);
}

const SGR = /\x1b\[[\d;:]*m/g;
export function plainTerminalText(value: string): string { return value.replace(SGR, ''); }

function cellWidth(char: string): number {
  const code = char.codePointAt(0)!;
  if (/\p{Mark}/u.test(char) || code === 0x200d || code === 0xfe0f) return 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f)
    || (code >= 0xff01 && code <= 0xff60) || code >= 0x1f300) ? 2 : 1;
}
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Conventional narrow-ambiguous terminal widths, not an emulator/font probe.
 * Scan each cluster once with constant auxiliary space: combining runs have no
 * length cap and must never become a spread argument list. Segmentation itself
 * is delegated to ICU; we make no worst-case complexity claim for ICU. */
function graphemeWidth(text: string): number {
  let width = 0;
  let regional = 0;
  let pictographic = false;
  let emojiPresentation = false;
  let vs16 = false;
  let keycap = false;
  const keycapBase = /^[0-9#*]/.test(text);
  for (const char of text) {
    const code = char.codePointAt(0)!;
    width = Math.max(width, cellWidth(char));
    if (code >= 0x1f1e6 && code <= 0x1f1ff) regional++;
    else if (/\p{Emoji_Presentation}/u.test(char)) emojiPresentation = true;
    if (/\p{Extended_Pictographic}/u.test(char)) pictographic = true;
    if (code === 0xfe0f) vs16 = true;
    if (code === 0x20e3 && keycapBase) keycap = true;
  }
  return regional === 2 || keycap || emojiPresentation || (vs16 && pictographic) ? 2 : width;
}
export function terminalWidth(text: string): number {
  let width = 0;
  for (const { segment } of segments.segment(plainTerminalText(text))) width += graphemeWidth(segment);
  return width;
}
export function clipTerminalText(text: string, width: number): string {
  let result = '';
  let used = 0;
  // Preserve trusted SGR while clipping by terminal cells rather than UTF-16 units.
  for (const token of text.split(/(\x1b\[[\d;:]*m)/)) {
    if (/^\x1b\[[\d;:]*m$/.test(token)) { result += token; continue; }
    for (const { segment } of segments.segment(token)) {
      const cells = graphemeWidth(segment);
      if (used + cells > width) return result + (text.includes('\x1b[') ? '\x1b[0m' : '');
      result += segment;
      used += cells;
    }
  }
  return result;
}
/** Grapheme-safe horizontal editor tail; one segmentation pass, no repeated clipping. */
export function tailTerminalText(text: string, width: number): string {
  if (width <= 0) return '';
  const parts = Array.from(segments.segment(text), item => item.segment);
  let cells = 0;
  let start = parts.length;
  while (start > 0) {
    const next = graphemeWidth(parts[start - 1]!);
    if (cells + next > width) break;
    cells += next;
    start--;
  }
  return parts.slice(start).join('');
}

export function wrapTerminalText(text: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = [];
  for (const source of text.replace(/\t/g, '    ').split('\n')) {
    let line = '';
    let used = 0;
    for (const { segment } of segments.segment(source)) {
      const cells = graphemeWidth(segment);
      if (used + cells > width && line) { lines.push(line); line = ''; used = 0; }
      if (cells > width) { line += '?'; used++; }
      else { line += segment; used += cells; }
    }
    lines.push(line);
  }
  return lines;
}
