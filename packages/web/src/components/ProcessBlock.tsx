import { Fragment, useState } from 'react';
import type { Message } from '@ai-harness/core';
import type { ProcessBlockProps } from './ProcessBlockBoundary';
import AnsiOutput from './AnsiOutput';

const PROCESS_PREVIEW_LENGTH = 8_000;
export default function ProcessBlock({ content, fullContent, truncated, filename, t, openFile }: ProcessBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const complete = fullContent ?? content;
  const long = truncated === true || complete.length > PROCESS_PREVIEW_LENGTH;
  const visible = expanded
    ? complete
    : content.length > PROCESS_PREVIEW_LENGTH ? `${content.slice(0, PROCESS_PREVIEW_LENGTH)}\n…` : content;
  const copy = async () => {
    await navigator.clipboard?.writeText(complete);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return <>
    <div className="process-block-actions" role="toolbar" aria-label={t('chat.blockActions')}>
      <button type="button" onClick={() => void copy()}>{copied ? t('chat.copied') : t('common.copy')}</button>
      {long && <button type="button" onClick={() => setExpanded(value => !value)}>
        {expanded ? t('chat.collapseOutput') : t('chat.expandOutput')}
      </button>}
      {long && <button type="button" onClick={() => downloadText(complete, filename)}>{t('common.download')}</button>}
    </div>
    {/\u001b\[[0-9;]*m/.test(visible) ? <AnsiOutput content={visible} /> : <ToolOutput content={visible} openFile={openFile} />}
  </>;
}
function downloadText(content: string, rawFilename: string): void {
  const filename = rawFilename.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 160) || 'output.txt';
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function FilesWritten({ blocks, t, openFile }: Pick<ProcessBlockProps, 't' | 'openFile'> & { blocks: NonNullable<Message['blocks']> }) {
  const files = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const candidate = value.trim().replace(/(?:[:#]L?\d+)$/i, '');
    if (/^(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+ -]+\.[a-z0-9]+$/i.test(candidate)) files.add(candidate);
  };
  for (const block of blocks) {
    if (block.type === 'tool_call' && /(?:write|edit|patch|create|save)/i.test(block.name)) {
      if (!block.input || typeof block.input !== 'object') continue;
      for (const [key, value] of Object.entries(block.input)) {
        if (/(?:path|file|target|destination)/i.test(key)) add(value);
      }
    } else if (block.type === 'tool_result' && /(?:write|edit|patch|create|save)/i.test(block.name ?? '')) {
      const pattern = /((?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+ -]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|html|py|rb|rs|go|java|kt|sh|bash|yml|yaml|toml))(?:[:#]L?(\d+))?/gi;
      for (const match of block.content.matchAll(pattern)) add(match[1]);
    }
  }
  return files.size ? <div className="files-written" aria-label={t('chat.filesWritten')}>
    <strong>{t('chat.filesWritten')}</strong>
    {[...files].map(file => <button key={file} onClick={() => openFile(file)}>{file}</button>)}
  </div> : null;
}

function ToolOutput({ content, openFile }: Pick<ProcessBlockProps, 'content' | 'openFile'>) {
  const pathPattern = /((?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+ -]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|html|py|rb|rs|go|java|kt|sh|bash|yml|yaml|toml))(?:[:#]L?(\d+))?/gi;
  return <pre className="tool-output">{content.split(pathPattern).map((part, index, values) => {
    if (index % 3 !== 1) return index % 3 === 2 ? null : <Fragment key={index}>{part}</Fragment>;
    const line = values[index + 1] ? Number(values[index + 1]) : undefined;
    return <button key={index} onClick={() => openFile(part, line)}>{part}{line ? `:${line}` : ''}</button>;
  })}</pre>;
}
