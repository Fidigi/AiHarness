import type { ReactNode } from 'react';

export default function AnsiOutput({ content }: { content: string }) {
  const colors: Record<number, string> = {
    30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
    90: 'bright-black', 91: 'bright-red', 92: 'bright-green', 93: 'bright-yellow', 94: 'bright-blue',
    95: 'bright-magenta', 96: 'bright-cyan', 97: 'bright-white',
  };
  let color = '';
  let bold = false;
  let cursor = 0;
  const segments: ReactNode[] = [];
  for (const match of content.matchAll(/\u001b\[([0-9;]*)m/g)) {
    if (match.index! > cursor) segments.push(<span key={cursor} className={[color && `ansi-${color}`, bold && 'ansi-bold'].filter(Boolean).join(' ')}>{content.slice(cursor, match.index)}</span>);
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) { color = ''; bold = false; }
      else if (code === 1) bold = true;
      else if (colors[code]) color = colors[code];
    }
    cursor = match.index! + match[0].length;
  }
  if (cursor < content.length) segments.push(<span key={cursor} className={[color && `ansi-${color}`, bold && 'ansi-bold'].filter(Boolean).join(' ')}>{content.slice(cursor)}</span>);
  return <pre className="tool-output ansi-output">{segments}</pre>;
}
