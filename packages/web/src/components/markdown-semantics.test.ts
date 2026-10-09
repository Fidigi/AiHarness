import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MarkdownContentRenderer from './MarkdownContentRenderer';
import { I18nProvider } from '../hooks/useI18n';
import { markdownPreviewText, normalizeMarkdownMath } from './markdown-semantics';

function render(content: string, keepLineBreaks = false, compact = false): string {
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(MarkdownContentRenderer, { content, keepLineBreaks, compact })));
}

describe('shared Markdown rendering', () => {
  it('keeps price pairs from swallowing emphasis, links or later formulas', () => {
    for (const prices of ['$15+$15', '$20–$30', '$1,200.50 or $900.00', '**$20** and *$6*', 'US$20 / CA$30']) {
      const html = render(prices);
      expect(html).not.toContain('class="katex');
      expect(html.match(/\$/g)).toHaveLength(2);
    }
    const html = render('**Membership — $20/mo**\nWaives the $6 fee. https://example.com/pricing\nPay $30 for $2x + 3$.');
    expect(html).toContain('<strong>Membership — $20/mo</strong>');
    expect(html).toContain('Waives the $6 fee.');
    expect(html).toContain('href="https://example.com/pricing"');
    expect(html.match(/class="katex"/g)).toHaveLength(1);
    expect(html).toContain('2x + 3</annotation>');
  });

  it('still renders real numeric, padded, multiline and double-dollar math', () => {
    for (const math of ['$x+y$', '$2+2=4$', '$20$', '$ x + y $', '$x $', '$ x$', '$x$2', '$x+\ny$', '$$x+y$$']) {
      expect(render(math)).toContain('class="katex"');
      expect(render(math)).not.toContain('katex-error');
    }
    expect(render('\\$20 and \\$6. `$20 + $6`. [price](https://example.com/$20/$6)')).not.toContain('class="katex');
    expect(render('```text\n$20 + $6\n```')).not.toContain('class="katex');
  });

  it('splits literal CJK punctuation but preserves CJK paths and explicit links', () => {
    const html = render('https://example.com/p?q=1&b=2，后面 www.example.com。 https://zh.wikipedia.org/wiki/中文条目');
    expect(html).toContain('href="https://example.com/p?q=1&amp;b=2"');
    expect(html).toContain('</a>，后面');
    expect(html).toContain('href="http://www.example.com"');
    expect(html).toContain('%E4%B8%AD%E6%96%87%E6%9D%A1%E7%9B%AE');
    const explicit = render('[https://example.com/，path](https://example.com/，path)');
    expect(explicit).toContain('href="https://example.com/%EF%BC%8Cpath"');
    expect(render('5~7U × 100~200倍 ~~gone~~')).toContain('5~7U × 100~200倍 <del>gone</del>');
  });

  it('preserves soft breaks only when requested, including headings and tight lists', () => {
    expect(render('one\ntwo')).not.toContain('<br');
    for (const value of ['one\ntwo', 'one\r\ntwo', 'one\rtwo', 'one  \t\n  two']) expect(render(value, true)).toContain('<p>one<br/>two</p>');
    expect(render('1. question\nA. option\nB. option\n2. next', true)).toContain('<li>question<br/>A. option<br/>B. option</li>');
    expect(render('Heading one\nheading two\n===', true)).toContain('Heading one<br/>heading two</h1>');
    expect(render('- outer\n  more\n  - inner\n- next', true)).toContain('outer<br/>more\n<ul>');
    expect(render('- alpha\n\n- beta', true)).not.toContain('<br');
    expect(render('trailing spaces  \nbackslash\\\nend', true)).toContain('trailing spaces<br/>backslash<br/>end');
    expect(render('*one\ntwo* `a b`', true)).toContain('<em>one<br/>two</em>');
    expect(render('```text\nfirst\nsecond\n```', true)).not.toContain('<br');
    expect(render('$$\nx=1\ny=2\n$$', true)).not.toContain('<br');
  });

  it('does not modify raw-text blocks or reintroduce executable HTML', () => {
    for (const content of ['Use <textarea> here\nand a button', 'Set <title>My\nPage</title> first\nthen deploy', 'add <script>a()\nb()</script> next\nreload', 'some *<style>x\ny</style>* then\nnext']) {
      expect(render(content, true)).toBe(render(content));
    }
    const html = render('$20 <img src="x" onerror="alert(1)"> $6 [click](javascript:alert(1))');
    expect(html).not.toMatch(/onerror|javascript:|<script|class="katex/);
    expect(html).toContain('$20');
    expect(html).toContain('$6');
    expect(render('<script>dangerous()</script>\n\nSafe **text**')).toContain('<strong>text</strong>');
    expect(render('$\\\\href{javascript:alert(1)}{click}$')).not.toMatch(/href="javascript:|<script/);
  });

  it('normalizes display formulas in lists without swallowing sibling Markdown', () => {
    const source = '- item:\n  $$x = y\n  z = w$$\n- next';
    expect(normalizeMarkdownMath(source)).toBe('- item:\n  $$\n  x = y\n  z = w\n  $$\n- next');
    expect(render(source)).toContain('<li>next</li>');
    expect(render(source)).not.toContain('katex-error');
    expect(normalizeMarkdownMath('- item:\n  \\[a+b\\]\n- next')).toBe('- item:\n  $$\n  a+b\n  $$\n- next');
    expect(normalizeMarkdownMath('```\n$$a+b$$\n```')).toBe('```\n$$a+b$$\n```');
    expect(normalizeMarkdownMath('<pre>\n$$a+b$$\n</pre>')).toBe('<pre>\n$$a+b$$\n</pre>');
    expect(normalizeMarkdownMath('- first\n  $$x=y\n- second\n  $$z=w$$')).toContain('- first\n  $$x=y\n- second');
    expect(normalizeMarkdownMath('$$x=y\n- sibling $$z=w$$')).toBe('$$x=y\n- sibling $$z=w$$');
  });

  it('projects previews/minimap with the same parser and no interactive markup', () => {
    const source = '**Price: $20/month**\nPlus a $6 fee. Formula: $2 + 2 = 4$. https://a.com，后面';
    expect(markdownPreviewText(source)).toBe('Price: $20/month Plus a $6 fee. Formula: 2 + 2 = 4. https://a.com，后面');
    expect(render(source, false, true)).not.toMatch(/<a |<button|<div|<strong|class="katex/);
    expect(markdownPreviewText('![description](https://example.com/image.png)\n\n`code`')).toBe('description code');
    expect(markdownPreviewText('<script>secret()</script>\n\nSafe')).toBe('Safe');
    expect(markdownPreviewText('abcdef', 3)).toBe('abc');
    const metadata = '---\ntitle: metadata\n---\n# Visible';
    expect(render(metadata)).toContain('Visible</h1>');
    expect(render(metadata)).not.toContain('metadata');
    expect(markdownPreviewText(metadata)).toBe('Visible');
  });
});
