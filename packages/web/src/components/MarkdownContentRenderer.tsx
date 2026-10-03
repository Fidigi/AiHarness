import DOMPurify from 'dompurify';
import { Fragment, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n } from '../hooks/useI18n';

const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
  },
};

function plainText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(plainText).join('');
  if (isValidElement<{ children?: ReactNode }>(value)) return plainText(value.props.children);
  return '';
}

function slug(value: ReactNode): string {
  return plainText(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
}

function openWorkspaceFile(reference: string): void {
  window.dispatchEvent(new CustomEvent('aih-show-files'));
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('aih-open-file', { detail: reference })), 0);
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  if (!/^(?:[cm]?[jt]sx?|typescript|javascript|python|ruby|rust|go|java|kotlin|shell|bash|json|css|scss|html)$/.test(language)) return <>{code}</>;
  const pattern = /(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|class|interface|type|import|export|from|return|if|else|for|while|async|await|def|fn|struct|impl|package|public|private|true|false|null|None)\b|\b\d+(?:\.\d+)?\b)/gm;
  return <>{code.split(pattern).filter(Boolean).map((token, index) => {
    const className = /^(?:\/\/|#)/.test(token) ? 'syntax-comment'
      : /^(?:"|'|`)/.test(token) ? 'syntax-string'
        : /^\d/.test(token) ? 'syntax-number' : 'syntax-keyword';
    return <span className={className} key={index}>{token}</span>;
  })}</>;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return <div className="code-container">
    <header><span>{language || 'text'}</span><button onClick={() => {
      void navigator.clipboard?.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }}>{copied ? t('chat.copied') : t('chat.copy')}</button></header>
    <pre className={`code-block language-${language || 'text'}`}><code><HighlightedCode code={code} language={language} /></code></pre>
  </div>;
}

const UNSAFE_MERMAID_DIRECTIVE = /^\s*(?:click\b|classDef\b|class\s|style\s|linkStyle\b|%%\{)/i;

function MermaidBlock({ source }: { source: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const block = useRef<HTMLDivElement>(null);
  useFocusTrap(expanded, block, () => setExpanded(false));

  useEffect(() => {
    let current = true;
    setSvg('');
    setError('');
    if (source.length > 100_000) {
      setError(t('chat.mermaidTooLarge'));
      return () => { current = false; };
    }
    const safeSource = source.split('\n').filter(line => !UNSAFE_MERMAID_DIRECTIVE.test(line)).join('\n');
    void import('beautiful-mermaid').then(async module => {
      const rendered = await module.renderMermaidSVGAsync(safeSource, {
        bg: '#f8f9fc', fg: '#172033', accent: '#e94560', line: '#465a85',
        border: '#465a85', surface: '#e8eefb', transparent: false,
      });
      if (!current) return;
      const hardenedSvg = rendered.replace(/@import[^;]*;|url\([^)]*\)/gi, '');
      const sanitized = DOMPurify.sanitize(hardenedSvg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
      });
      setSvg(String(sanitized));
    }).catch(reason => {
      if (current) setError(reason instanceof Error ? reason.message : t('chat.mermaidFailed'));
    });
    return () => { current = false; };
  }, [source, t]);

  const download = () => {
    const value = svg || source;
    const url = URL.createObjectURL(new Blob([value], { type: svg ? 'image/svg+xml' : 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = svg ? 'diagram.svg' : 'diagram.mmd';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <div ref={block} className={`mermaid-block ${expanded ? 'expanded' : ''}`}
    {...(expanded ? { role: 'dialog', 'aria-modal': true, 'aria-label': t('chat.mermaidDiagram'), tabIndex: -1 } : {})}>
    <header><span>Mermaid</span><button data-autofocus={expanded || undefined} aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? t('common.close') : t('chat.zoom')}</button>
      <button onClick={download}>{t('files.download')}</button></header>
    <div className="mermaid-preview" role="img" aria-label={t('chat.mermaidDiagram')} aria-busy={!svg && !error}>
      {svg && <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
      {!svg && !error && <span role="status">{t('common.loading')}…</span>}
      {error && <p className="mermaid-error" role="alert">{error}</p>}
    </div>
    <details><summary>{t('files.source')}</summary><pre>{source}</pre></details>
  </div>;
}

function Heading({ level, children }: { level: 1 | 2 | 3 | 4 | 5 | 6; children?: ReactNode }) {
  const id = slug(children);
  if (level === 1) return <h1 id={id}>{children}</h1>;
  if (level === 2) return <h2 id={id}>{children}</h2>;
  if (level === 3) return <h3 id={id}>{children}</h3>;
  if (level === 4) return <h4 id={id}>{children}</h4>;
  if (level === 5) return <h5 id={id}>{children}</h5>;
  return <h6 id={id}>{children}</h6>;
}

const components: Components = {
  h1: ({ children }) => <Heading level={1}>{children}</Heading>,
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  h5: ({ children }) => <Heading level={5}>{children}</Heading>,
  h6: ({ children }) => <Heading level={6}>{children}</Heading>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const code = String(children).replace(/\n$/, '');
    const language = /(?:^|\s)language-([\w+-]+)/.exec(className ?? '')?.[1]?.toLocaleLowerCase() ?? '';
    if (!language && !String(children).includes('\n')) return <code className="inline-code">{children}</code>;
    return language === 'mermaid' ? <MermaidBlock source={code} /> : <CodeBlock code={code} language={language} />;
  },
  table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
  a: ({ href, children }) => {
    if (href?.toLocaleLowerCase().startsWith('file:')) return <a href={href} onClick={event => {
      event.preventDefault();
      openWorkspaceFile(href.slice(5));
    }}>{children}</a>;
    if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    return href ? <a href={href}>{children}</a> : <span>{children}</span>;
  },
  img: ({ src, alt }) => {
    if (typeof src === 'string' && src.startsWith('data:image/')) return <img src={src} alt={alt || ''} loading="lazy" />;
    if (typeof src === 'string' && /^https?:\/\//i.test(src)) {
      return <a href={src} target="_blank" rel="noopener noreferrer">{alt || src}</a>;
    }
    return <Fragment>{alt || ''}</Fragment>;
  },
};

export default function MarkdownContentRenderer({ content }: { content: string }) {
  return <div className="markdown-content">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeSanitize, sanitizeSchema], [rehypeKatex, { strict: 'warn', trust: false }]]}
      components={components}
      urlTransform={url => /^file:/i.test(url) ? url : defaultUrlTransform(url)}
    >{content}</ReactMarkdown>
  </div>;
}
