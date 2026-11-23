import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import MarkdownContentRenderer from './MarkdownContentRenderer';
import { I18nProvider } from '../hooks/useI18n';
function render(content:string,onReference?: (href:string)=>void,compact=false):string {
  return renderToStaticMarkup(createElement(I18nProvider,null,createElement(MarkdownContentRenderer,{content,onReference,compact})));
}
describe('opt-in Markdown document actions',()=>{
  it('turns relative, file and hash references into explicit non-navigation buttons, without calling them during rendering',()=>{
    const action=vi.fn(),html=render('[Guide](docs/intro.md) [Local](#intro) [File](file:secret.md)',action);
    expect(html.match(/class="markdown-reference"/g)).toHaveLength(3);expect(html).not.toContain('href=');expect(action).not.toHaveBeenCalled();
  });
  it('preserves external links as explicit isolated browser links, never authenticated API destinations',()=>{
    const html=render('[External](https://example.invalid/guide.md)',vi.fn());
    expect(html).toContain('href="https://example.invalid/guide.md" target="_blank" rel="noopener noreferrer"');expect(html).not.toContain('markdown-reference');
  });
  it('still refuses executable HTML and unsafe protocols in document mode',()=>{
    const html=render('[Bad](javascript:alert(1))\n\n<script>SHOULD_NOT_EXECUTE</script>\n\n**Visible**',vi.fn());
    expect(html).not.toMatch(/javascript:|<script|SHOULD_NOT_EXECUTE/);expect(html).toContain('<strong>Visible</strong>');
  });
  it('leaves ordinary and compact Markdown contracts unchanged unless explicitly opted in',()=>{
    const source='[Guide](docs/intro.md) [Local](#intro)';
    expect(render(source)).toContain('href="docs/intro.md"');expect(render(source)).toContain('href="#intro"');
    expect(render(source,vi.fn(),true)).not.toMatch(/<button|<a /);
  });
});
