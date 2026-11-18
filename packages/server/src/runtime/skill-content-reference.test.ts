import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillContentReference } from './skill-content-reference.js';
const main=path.resolve('/registered/kit/SKILL.md'),base=path.dirname(main);
describe('skill-relative Markdown data, never a workspace/URL capability',()=>{
  it.each([
    ['guide.md','SKILL.md','guide.md'],['docs/intro.md','SKILL.md','docs/intro.md'],
    ['../other.md','docs/intro.md','other.md'],['./next.markdown','docs/intro.md','docs/next.markdown'],
    ['space%20file.md#part%20one','SKILL.md','space file.md'],['%E9%9B%AA.md','SKILL.md','雪.md'],
    ['__proto__.md','SKILL.md','__proto__.md'],['..notes.md','SKILL.md','..notes.md'],
    ['%252e%252e/note.md','SKILL.md','%2e%2e/note.md'],
  ])('resolves %s from %s only within the declaring source', (href,from,expected)=>{
    const value=skillContentReference(main,href,from);expect(value.relativePath).toBe(expected);expect(value.absolutePath).toBe(path.join(base,expected));
    expect(value.fragment).toBe(href.includes('#')?'part one':undefined);
  });
  it.each(['','../outside.md','docs/../../outside.md','/etc/secret.md','%2fetc%2fsecret.md','//foreign.test/a.md',
    'https://foreign.test/a.md','file:///etc/secret.md','javascript:alert(1)','data:text/plain,secret.md',
    'guide.md?token=private','..\\outside.md','%2e%2e%2foutside.md','%00doc.md','secret.json','%zz',
    'C:/secret.md','C:\\secret.md','#local','folder/'])('refuses %s without any file/network action',href=>{
    expect(()=>skillContentReference(main,href)).toThrow('Skill Markdown reference is invalid.');
  });
  it.each(['../outside.md','/absolute.md','docs/../SKILL.md','docs\\intro.md','docs//intro.md'])('does not trust a substituted current document %s',from=>{
    expect(()=>skillContentReference(main,'next.md',from)).toThrow('Skill Markdown reference is invalid.');
  });
  it('never executes a caller serializer/coercion while refusing a non-string target',()=>{
    let calls=0;const hostile={toString(){calls++;return 'outside.md';}};
    expect(()=>skillContentReference(main,hostile as unknown as string)).toThrow('Skill Markdown reference is invalid.');expect(calls).toBe(0);
  });
});
