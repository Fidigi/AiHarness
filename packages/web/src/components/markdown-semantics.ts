import type { Root, Content, Parent, Link } from 'mdast';
import type { Extension } from 'micromark-util-types';
import type { Plugin, PluggableList } from 'unified';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/** Reject price pairs before math tokenization can consume emphasis or later formulas. */
export const remarkCurrencyMath: Plugin = function () {
  remarkMath.call(this);
  const extension = (this.data() as { micromarkExtensions?: Extension[] }).micromarkExtensions?.at(-1);
  const entry = extension?.text?.[36];
  for (const construct of Array.isArray(entry) ? entry : entry ? [entry] : []) {
    if (construct.name !== 'mathText') continue;
    const tokenize = construct.tokenize;
    construct.tokenize = function (effects, ok, nok) {
      const start = this.now();
      return tokenize.call(this, effects, code => {
        const value = this.sliceSerialize({ start, end: this.now() });
        if (value.startsWith('$') && !value.startsWith('$$')) {
          const body = value.slice(1, -1);
          const amount = /^\s*[+-]?(?:\d|\.\d)/.test(body);
          const nextAmount = code !== null && code >= 48 && code <= 57;
          const unevenPadding = /^\s/.test(body) !== /\s$/.test(body);
          if (amount && (nextAmount || unevenPadding)) return nok(code);
        }
        return ok(code);
      }, nok);
    };
  }
};

const cjkBoundary = /[、。〈-】〔-〛！（），：；？‘’“”–—…·～〜]/;

export function remarkCjkAutolinks() {
  return (tree: Root, file: { value: unknown }): void => {
    const source = String(file.value);
    const visit = (parent: Root | Parent): void => {
      const children = parent.children as Content[];
      for (let index = 0; index < children.length; index++) {
        const node = children[index]!;
        if (node.type === 'link') {
          const link: Link = node;
          const text = link.children.length === 1 && link.children[0]?.type === 'text' ? link.children[0] : undefined;
          const start = link.position?.start.offset;
          const end = link.position?.end.offset;
          // Source identity distinguishes literals from explicit Markdown links.
          if (text && start !== undefined && end !== undefined && !link.title
            && source.slice(start, end) === text.value && link.url.endsWith(text.value)) {
            const cut = text.value.search(cjkBoundary);
            if (cut > 0) {
              const tail = text.value.slice(cut);
              link.url = link.url.slice(0, link.url.length - tail.length);
              text.value = text.value.slice(0, cut);
              children.splice(index + 1, 0, { type: 'text', value: tail });
            }
          }
        }
        if ('children' in node) visit(node as Parent);
      }
    };
    visit(tree);
  };
}

type TextNode = { type: string; value?: string; children?: TextNode[]; data?: { hName: string } };
const rawTextOpen = /^<(?:iframe|noembed|noframes|noscript|plaintext|script|style|textarea|title|xmp)(?=[\s/>]|$)/i;
function hasRawText(node: TextNode): boolean {
  return node.type === 'html' && rawTextOpen.test(node.value ?? '') || !!node.children?.some(hasRawText);
}

/** Optional user-line preservation, including tight lists, without double hard breaks. */
export function remarkKeepLineBreaks() {
  return (tree: TextNode): void => {
    const visit = (parent: TextNode): void => {
      if (!parent.children) return;
      if (['paragraph', 'heading', 'tableCell'].includes(parent.type) && hasRawText(parent)) return;
      parent.children = parent.children.flatMap(node => {
        if (node.type === 'break') return [{ type: 'lineBreak', data: { hName: 'br' } }];
        if (node.type === 'text') return (node.value ?? '').split(/[ \t]*(?:\r\n|\r|\n)[ \t]*/).flatMap((value, index) => [
          ...(index ? [{ type: 'lineBreak', data: { hName: 'br' } }] : []),
          ...(value ? [{ type: 'text', value }] : []),
        ]);
        visit(node);
        return [node];
      });
    };
    visit(tree);
  };
}

export const markdownRemarkPlugins: PluggableList = [[remarkGfm, { singleTilde: false }], remarkCurrencyMath, remarkCjkAutolinks];

/** Normalize detached display formulas without rewriting code, raw HTML, or sibling blocks. */
export function normalizeMarkdownMath(source: string): string {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // File preview and conversation surfaces hide the same initial YAML metadata.
  const lines = normalized.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').split('\n');
  const result: string[] = [];
  let fence = '';
  let rawTag = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (rawTag) {
      result.push(line);
      if (new RegExp(`</${rawTag}\\s*>`, 'i').test(line)) rawTag = '';
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = '';
      result.push(line);
      continue;
    }
    const raw = /<(code|pre|script|style|textarea|title|xmp)\b/i.exec(line);
    if (raw) {
      if (!new RegExp(`</${raw[1]}\\s*>`, 'i').test(line.slice(raw.index + raw[0].length))) rawTag = raw[1]!;
      result.push(line);
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line) || line.includes('`')) { result.push(line); continue; }
    const single = /^( {0,3})(?:\$\$(.+)\$\$|\\\[(.+)\\\])[ \t]*$/.exec(line);
    if (single) {
      const math = (single[2] ?? single[3] ?? '').trim();
      result.push(`${single[1]}$$`, `${single[1]}${math}`, `${single[1]}$$`);
      continue;
    }
    const opening = /^( {0,3})(\$\$|\\\[)(.*)$/.exec(line);
    if (opening) {
      const indent = opening[1]!;
      const closing = opening[2] === '$$' ? /^(.*?)\$\$[ \t]*$/ : /^(.*?)\\\][ \t]*$/;
      let end = i + 1;
      let found = false;
      for (; end < lines.length; end++) {
        const candidate = lines[end]!;
        if (/^\s*(?:[-+*]|\d+[.)])\s|^ {0,3}(?:#{1,6}\s|>|`{3,}|~{3,}|\\\[)|<(?:code|pre|script|style)\b/.test(candidate)) break;
        if (candidate.startsWith(indent) && closing.test(candidate) && !closing.exec(candidate)![1]!.includes('$$')) { found = true; break; }
        if (/^ {0,3}\$\$\S/.test(candidate)) break;
      }
      if (found && !opening[3]!.includes('$$')) {
        result.push(`${indent}$$`);
        const content = [...(opening[3]!.trim() ? [opening[3]!] : []), ...lines.slice(i + 1, end), closing.exec(lines[end]!)![1]!];
        for (const value of content) if (value.trim()) result.push(value.startsWith(indent) ? value : indent + value);
        result.push(`${indent}$$`);
        i = end;
        continue;
      }
    }
    // Avoid interpreting link destinations, URLs, paths and HTML as LaTeX delimiters.
    result.push(/\]\s*\(|<(?:!--|\/?[a-z])|\b(?:https?|file|mailto):|\b[a-z]:\\/i.test(line) ? line
      : line.replace(/(^|[^\\])\\\(([^`\r\n$]+?)\\\)/g, (_match, prefix: string, math: string) => `${prefix}$${math}$`));
  }
  return result.join('\n');
}

/** Noninteractive minimap text uses the same parser, currency and autolink semantics. */
export function markdownPreviewText(content: string, maxLength = 160): string {
  const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkCurrencyMath).use(remarkCjkAutolinks);
  const source = normalizeMarkdownMath(content);
  const tree = processor.runSync(processor.parse(source), { value: source }) as Root;
  const text = (node: TextNode): string => {
    if (node.type === 'html') return '';
    if (node.type === 'image') return (node as TextNode & { alt?: string }).alt ?? '';
    if (node.value !== undefined) return node.value;
    const separator = ['root', 'list', 'listItem', 'blockquote'].includes(node.type) ? ' ' : '';
    return node.children?.map(text).join(separator) ?? '';
  };
  return text(tree as TextNode).replace(/\s+/g, ' ').trim().slice(0, Math.max(0, maxLength));
}
